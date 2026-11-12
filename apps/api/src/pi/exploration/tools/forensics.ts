/**
 * Forensics tools (pi chain): sql_probe (read-only DB query) / repo_read (read-only code reading).
 *
 * - sql_probe: same double gate as legacy — platform-side assertReadOnlySql intercepts first,
 *   the in-runSql sqlGuard backs it up; session-level quota (EXPLORATION_MAX_SQL_PROBES); row
 *   capping goes through renderSqlProbeRows (row count/cell/single row/whole block).
 * - repo_read: the channel implementation fully reuses createRepoReadChannel (assertInCwd sandbox
 *   + realpath + rg timeout + 6000-char cap + session-level quota all closed inside the channel);
 *   mounted only for sessions with a code commit scope.
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { QueryPool } from '../../../execute/envContext.js';
import { runSql } from '../../../execute/sqlQuery.js';
import { assertReadOnlySql } from '../../../execute/sqlGuard.js';
import { renderSqlProbeRows } from '../../../execute/gates.js';
import { withTimeout } from '../../../execute/explorationShared.js';
import { EXPLORATION_MAX_REPO_READS, EXPLORATION_MAX_SQL_PROBES } from '../../../execute/explorationPrompt.js';
import { SQL_PROBE_MAX_ROWS } from '../../../execute/aiTask.js';
import type { RepoReadRequest, RepoReadResult } from '../../../execute/aiTask.js';
import { toolErr, toolOk } from './result.js';
import { logger } from '../../../logger.js';

/** Wait-side timeout for a single read-only probe (truncates the wait only, does not cancel the underlying query — read-only query cost is acceptable). */
const SQL_PROBE_TIMEOUT_MS = 10_000;

/** Minimal environment shape sql_probe depends on (structural subset of resolveEnv's product, easy to stub in tests). */
export interface SqlProbeEnv {
  resolveDb(ref?: string | null): { label: string; dialect: string } | null;
  resolveDbPool(ref?: string | null): Promise<QueryPool>;
}

export function createSqlProbeTool(deps: { env: SqlProbeEnv; dbRefs: Array<{ label: string; dialect: string }> }) {
  let used = 0;
  return defineTool({
    name: 'sql_probe',
    label: 'sql_probe',
    description: `对被测系统的数据库执行一条只读查询（SELECT/WITH），返回前几行结果。本会话上限 ${EXPLORATION_MAX_SQL_PROBES} 次——先有具体假设再查，不要扫库。`,
    promptGuidelines: [
      '表名/字段名不确定时先查元数据：SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN (\'pg_catalog\',\'information_schema\')',
      '行里的手机号/身份证/密码哈希等敏感值不要写进 finding 描述',
    ],
    parameters: Type.Object({
      query: Type.String({ description: '只读 SQL（SELECT/WITH 开头）' }),
      db: Type.Optional(Type.String({ description: '库名（照抄可用数据库清单；不传查默认库）' })),
      limit: Type.Optional(Type.Number({ description: '返回行数上限，缺省 20' })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const query = params.query.trim();
      if (!query) {
        return toolErr('查询为空', 'sql_probe: error query 为空。');
      }
      // First gate of the double gate: read-only guard (write statements rejected outright; a second gate lives inside runSql).
      try {
        assertReadOnlySql(query);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(
          `只读守卫拒绝（${msg.slice(0, 100)}）`,
          `sql_probe: error 只读守卫拒绝（${msg.slice(0, 160)}）。只允许 SELECT/WITH 查询。`,
        );
      }
      if (used >= EXPLORATION_MAX_SQL_PROBES) {
        return toolErr(
          `查库次数已用尽（上限 ${EXPLORATION_MAX_SQL_PROBES} 次）`,
          `sql_probe: error 本会话查库次数已用尽（上限 ${EXPLORATION_MAX_SQL_PROBES} 次）。回到页面观察取证，把剩余轮次用在探索上。`,
        );
      }
      used += 1;
      const entry = deps.env.resolveDb(params.db?.trim() || null);
      if (!entry) {
        const names = deps.dbRefs.map((d) => d.label).join('、') || '（无）';
        return toolErr(
          `数据库未命中${params.db ? `「${params.db}」` : '（默认库）'}，可用：${names}`,
          `sql_probe: error 数据库未命中${params.db ? `「${params.db}」` : '（默认库）'}，可用：${names}。`,
        );
      }
      try {
        const pool = await deps.env.resolveDbPool(entry.label);
        const limit = Math.min(Math.max(1, Math.round(params.limit ?? SQL_PROBE_MAX_ROWS)), SQL_PROBE_MAX_ROWS);
        const r = await withTimeout(
          runSql({ pool, action: { kind: 'sql', sql: query, params: [], limit }, dbRef: entry.label }),
          SQL_PROBE_TIMEOUT_MS,
          `查询超时（${SQL_PROBE_TIMEOUT_MS / 1000}s 未返回）`,
        );
        const rows = r.rows as Array<Record<string, unknown>>;
        const text = `sql_probe（${entry.label}）：${r.rowCount} 行${r.truncated ? '（已按 limit 截断）' : ''}\n${renderSqlProbeRows(rows, r.rowCount, !!r.truncated)}`;
        // Trail summary = "what was found" (row count + first row); detail stores the raw forensics text (used by a promoted case's expected).
        const first = rows[0] ? Object.entries(rows[0]).slice(0, 3).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(' ') : '';
        return toolOk(
          `${entry.label} 返回 ${r.rowCount} 行${r.truncated ? '（已按 limit 截断）' : ''}${first ? `｜首行 ${first}` : ''}`,
          text,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.info({ err: msg.slice(0, 160) }, 'exploration sql probe failed');
        return toolErr(
          `查询失败：${msg.slice(0, 120)}`,
          `sql_probe: error ${msg.slice(0, 200)}。查表名/字段名不确定时先查元数据（见工具说明）。`,
        );
      }
    },
  });
}

export function createRepoReadTool(deps: {
  channel: (req: RepoReadRequest) => Promise<RepoReadResult>;
  /** Shown when a diff is viewable (with no commit scope the diff op is always rejected by the channel). */
  hasDiff: boolean;
}) {
  return defineTool({
    name: 'repo_read',
    label: 'repo_read',
    description: `只读查看被测系统的源码（read/grep/ls/diff），本会话上限 ${EXPLORATION_MAX_REPO_READS} 次。读码是取证手段不是探索主路径——源码结论仍要回页面验证。`,
    promptGuidelines: ['先 grep 定位再 read 片段，不要按目录乱翻；源码里的密钥/凭据/内部地址不要写进 finding'],
    parameters: Type.Object({
      op: Type.Union([Type.Literal('read'), Type.Literal('grep'), Type.Literal('ls'), Type.Literal('diff')], { description: '操作' }),
      path: Type.Optional(Type.String({ description: '仓库内相对路径（目录或文件）' })),
      pattern: Type.Optional(Type.String({ description: 'grep 搜索词' })),
      maxLines: Type.Optional(Type.Number({ description: 'read/grep 返回行数上限（≤200）' })),
      offset: Type.Optional(Type.Number({ description: 'read 起始行（0 起）' })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const cleanPath = params.path?.trim().slice(0, 300) || undefined;
      const cleanPattern = params.pattern?.trim().slice(0, 200) || undefined;
      const maxLines = Math.min(Math.max(1, Math.round(params.maxLines ?? 200)), 200);
      const offset = Math.max(0, Math.round(params.offset ?? 0));
      let req: RepoReadRequest;
      if (params.op === 'read') {
        if (!cleanPath) return toolErr('read 需要 path', 'repo_read: error read 需要 path。');
        req = { op: 'read', path: cleanPath, offset, maxLines };
      } else if (params.op === 'grep') {
        if (!cleanPattern) return toolErr('grep 需要 pattern', 'repo_read: error grep 需要 pattern。');
        req = { op: 'grep', pattern: cleanPattern, ...(cleanPath ? { path: cleanPath } : {}), maxLines };
      } else if (params.op === 'ls') {
        req = { op: 'ls', ...(cleanPath ? { path: cleanPath } : {}) };
      } else {
        req = { op: 'diff', ...(cleanPath ? { path: cleanPath } : {}) };
      }
      const r = await deps.channel(req);
      if (!r.ok) {
        return toolErr(`读取失败：${r.error.slice(0, 120)}`, `repo_read ${params.op}: error ${r.error}`);
      }
      const head = params.op === 'diff' && deps.hasDiff ? '本次改动 diff：\n' : '';
      return toolOk(
        `${params.op} ${cleanPath ?? ''} 命中 ${r.content.length} 字符`.trim(),
        `repo_read ${params.op} ${cleanPath ?? ''}: ok\n${head}${r.content}`,
      );
    },
  });
}
