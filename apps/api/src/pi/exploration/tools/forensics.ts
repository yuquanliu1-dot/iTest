/**
 * 取证类工具（pi 链路）：sql_probe（只读查库）/ repo_read（只读读码）。
 *
 * - sql_probe：双闸同 legacy——平台侧 assertReadOnlySql 先拦一道，runSql 内部 sqlGuard 再兜一道；
 *   会话级配额（EXPLORATION_MAX_SQL_PROBES）；行封顶走 renderSqlProbeRows（行数/单元格/单行/整块）。
 * - repo_read：通道实现完全复用 createRepoReadChannel（assertInCwd 沙箱 + realpath + rg 超时 +
 *   6000 字符封顶 + 会话级配额都收口在通道里）；仅有代码提交范围的会话才装配。
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
import { logger } from '../../../logger.js';

/** 单次只读取证的等待侧超时（只截断等待，不取消底层查询——只读查询代价可接受）。 */
const SQL_PROBE_TIMEOUT_MS = 10_000;

/** sql_probe 依赖的最小环境形状（resolveEnv 产物的结构子集，便于测试打桩）。 */
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
        return { content: [{ type: 'text', text: 'sql_probe: error query 为空。' }], details: undefined, isError: true };
      }
      // 双闸第一道：只读守卫（写语句直接拒；runSql 内部还有第二道）。
      try {
        assertReadOnlySql(query);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: `sql_probe: error 只读守卫拒绝（${msg.slice(0, 160)}）。只允许 SELECT/WITH 查询。` }],
          details: undefined,
          isError: true,
        };
      }
      if (used >= EXPLORATION_MAX_SQL_PROBES) {
        return {
          content: [{ type: 'text', text: `sql_probe: error 本会话查库次数已用尽（上限 ${EXPLORATION_MAX_SQL_PROBES} 次）。回到页面观察取证，把剩余轮次用在探索上。` }],
          details: undefined,
          isError: true,
        };
      }
      used += 1;
      const entry = deps.env.resolveDb(params.db?.trim() || null);
      if (!entry) {
        const names = deps.dbRefs.map((d) => d.label).join('、') || '（无）';
        return {
          content: [{ type: 'text', text: `sql_probe: error 数据库未命中${params.db ? `「${params.db}」` : '（默认库）'}，可用：${names}。` }],
          details: undefined,
          isError: true,
        };
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
        return { content: [{ type: 'text', text }], details: undefined };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.info({ err: msg.slice(0, 160) }, 'exploration sql probe failed');
        return {
          content: [{ type: 'text', text: `sql_probe: error ${msg.slice(0, 200)}。查表名/字段名不确定时先查元数据（见工具说明）。` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}

export function createRepoReadTool(deps: {
  channel: (req: RepoReadRequest) => Promise<RepoReadResult>;
  /** 有 diff 可看时提示（无提交范围时 diff op 由通道恒拒）。 */
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
        if (!cleanPath) return { content: [{ type: 'text', text: 'repo_read: error read 需要 path。' }], details: undefined, isError: true };
        req = { op: 'read', path: cleanPath, offset, maxLines };
      } else if (params.op === 'grep') {
        if (!cleanPattern) return { content: [{ type: 'text', text: 'repo_read: error grep 需要 pattern。' }], details: undefined, isError: true };
        req = { op: 'grep', pattern: cleanPattern, ...(cleanPath ? { path: cleanPath } : {}), maxLines };
      } else if (params.op === 'ls') {
        req = { op: 'ls', ...(cleanPath ? { path: cleanPath } : {}) };
      } else {
        req = { op: 'diff', ...(cleanPath ? { path: cleanPath } : {}) };
      }
      const r = await deps.channel(req);
      if (!r.ok) {
        return { content: [{ type: 'text', text: `repo_read ${params.op}: error ${r.error}` }], details: undefined, isError: true };
      }
      const head = params.op === 'diff' && deps.hasDiff ? '本次改动 diff：\n' : '';
      return { content: [{ type: 'text', text: `repo_read ${params.op} ${cleanPath ?? ''}: ok\n${head}${r.content}` }], details: undefined };
    },
  });
}
