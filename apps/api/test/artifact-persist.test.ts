import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';

/**
 * 产物落库与格式无关通路：
 *  - 扩展名净化 / MIME 映射（纯函数）
 *  - registerPersistentArtifact 落盘 + 落 ai_thread_artifacts；getArtifact DB 优先
 *  - 「重启」后内存 Map 为空仍能从 DB 读回（下载卡跨会话/跨进程语义的根基）
 *  - 旧 registerArtifact（xmind）30min TTL 语义不回归；过期记录（含发版前旧路径）被拒
 */
let container: StartedPostgreSqlContainer;
let pool: Pool;
let root: string;
let artifacts: typeof import('../src/pi/space/artifacts.js');
/** 所有模块实例的 pg pool（vi.resetModules 会产出孤儿 pool，统一在 afterAll 收口，防 container 停止时连接被硬断抛未捕获异常）。 */
const poolsToClose: Pool[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-artifact-'));
  process.env.PI_DATA_DIR = path.join(root, 'pi-data');
  vi.resetModules();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  poolsToClose.push(pool);
  await pool.query(SCHEMA_SQL);
  artifacts = await import('../src/pi/space/artifacts.js');
  poolsToClose.push((await import('../src/db/client.js')).pool);
});

afterAll(async () => {
  for (const p of poolsToClose) await p.end().catch(() => {});
  await container?.stop();
  await fs.rm(root, { recursive: true, force: true });
});

const SCOPE = { threadId: randomUUID(), versionId: randomUUID(), projectId: randomUUID(), skillName: 'word-test-report', createdByUserId: null as string | null };

describe('扩展名净化与 MIME 映射', () => {
  it('extOfName：小写化、路径剥除、非法回退 bin', () => {
    expect(artifacts.extOfName('报告.docx')).toBe('docx');
    expect(artifacts.extOfName('a.PDF')).toBe('pdf');
    expect(artifacts.extOfName('a.tar.gz')).toBe('gz');
    expect(artifacts.extOfName('noext')).toBe('bin');
    expect(artifacts.extOfName('x.')).toBe('bin');
    expect(artifacts.extOfName('x.中文扩展名')).toBe('bin'); // 非 [a-z0-9] 全剥光
    expect(artifacts.extOfName('evil.docx/../../../etc/passwd')).toBe('bin'); // 只认最后一段
    expect(artifacts.extOfName('x.abcdefghijklmnopqrst')).toBe('bin'); // >10 字符
  });

  it('mimeOfName：常见格式映射；未知扩展名 octet-stream；文本类带 charset', () => {
    expect(artifacts.mimeOfName('报告.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(artifacts.mimeOfName('数据.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(artifacts.mimeOfName('a.csv')).toBe('text/csv; charset=utf-8');
    expect(artifacts.mimeOfName('图.png')).toBe('image/png');
    expect(artifacts.mimeOfName('导出.xmind')).toBe('application/vnd.xmind.workbook');
    expect(artifacts.mimeOfName('x.weird')).toBe('application/octet-stream');
  });
});

describe('registerPersistentArtifact（永久产物）', () => {
  it('落盘 + 落库：DB 行含 name/mime/count/stored_path/skill_name，expiresAt=null', async () => {
    const token = await artifacts.registerPersistentArtifact(Buffer.from('DOCX-CONTENT'), { name: '报告.docx', count: 3 }, SCOPE);
    const row = (await pool.query(
      'SELECT name, mime, size, count, stored_path, skill_name, expires_at, thread_id, version_id, project_id FROM ai_thread_artifacts WHERE token=$1',
      [token],
    )).rows[0];
    expect(row).toBeTruthy();
    expect(row.name).toBe('报告.docx');
    expect(row.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(row.size).toBe(12);
    expect(row.count).toBe(3);
    expect(row.skill_name).toBe('word-test-report');
    expect(row.expires_at).toBeNull(); // 永久有效
    expect(row.thread_id).toBe(SCOPE.threadId);
    // 文件真实落盘，getArtifact 能读回
    const a = await artifacts.getArtifact(token);
    expect(a).not.toBeNull();
    expect(a!.name).toBe('报告.docx');
    expect(a!.expiresAt).toBeNull();
    expect((await artifacts.readArtifactFile(a!)).toString()).toBe('DOCX-CONTENT');
    await fs.access(a!.path); // 文件在
  });

  it('重启后（内存 Map 清空）仍能从 DB 读回——跨进程下载的根基', async () => {
    const token = await artifacts.registerPersistentArtifact(Buffer.from('AFTER-RESTART'), { name: '后缀.xlsx' }, SCOPE);
    // 模拟进程重启：全新模块实例（新内存 Map），同 DB / 同 PI_DATA_DIR。
    vi.resetModules();
    const fresh = await import('../src/pi/space/artifacts.js');
    poolsToClose.push((await import('../src/db/client.js')).pool);
    const a = await fresh.getArtifact(token);
    expect(a).not.toBeNull();
    expect(a!.name).toBe('后缀.xlsx');
    expect(a!.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect((await fresh.readArtifactFile(a!)).toString()).toBe('AFTER-RESTART');
  });

  it('listThreadArtifacts：按线程过滤、新→旧排序、mime 缺省回填', async () => {
    const tid = randomUUID();
    await artifacts.registerPersistentArtifact(Buffer.from('1'), { name: '一.docx' }, { ...SCOPE, threadId: tid });
    await new Promise((r) => setTimeout(r, 10)); // 保证 createdAt 可分序
    await artifacts.registerPersistentArtifact(Buffer.from('2'), { name: '二.csv', mime: 'text/csv; charset=utf-8' }, { ...SCOPE, threadId: tid });
    await artifacts.registerPersistentArtifact(Buffer.from('3'), { name: '别线程.pdf' }, { ...SCOPE, threadId: randomUUID() });
    const list = await artifacts.listThreadArtifacts(tid);
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe('二.csv'); // 新→旧
    expect(list[0]!.mime).toBe('text/csv; charset=utf-8');
    expect(list[1]!.count).toBeNull();
  });
});

describe('旧 registerArtifact（xmind）30min TTL 语义不回归', () => {
  it('注册后立即可下；记录落 .records/<token>.json；mime 固定 xmind', async () => {
    const token = await artifacts.registerArtifact(Buffer.from('XMIND-DATA'), '导出.xmind', 't-legacy');
    const a = await artifacts.getArtifact(token);
    expect(a).not.toBeNull();
    expect(a!.mime).toBe('application/vnd.xmind.workbook');
    expect(a!.expiresAt).not.toBeNull(); // 有期限
    expect(a!.threadId).toBe('t-legacy');
    expect((await artifacts.readArtifactFile(a!)).toString()).toBe('XMIND-DATA');
  });

  it('过期记录（含发版前的旧顶层 .json 路径）→ getArtifact 返回 null 且清理文件', async () => {
    const token = randomUUID();
    // DATA_DIR = PI_DATA_DIR 本身（repo.ts:14），exports 在其直下。
    const exportDir = path.join(root, 'pi-data', 'exports');
    // 旧版记录直接落顶层（发版前形态），验证读取兼容 + 过期拒绝。
    await fs.mkdir(exportDir, { recursive: true });
    await fs.writeFile(path.join(exportDir, `${token}.xmind`), 'OLD');
    await fs.writeFile(
      path.join(exportDir, `${token}.json`),
      JSON.stringify({ path: 'whatever', name: '旧.xmind', mime: 'application/vnd.xmind.workbook', size: 3, expiresAt: Date.now() - 1000, threadId: 't-old' }),
    );
    expect(await artifacts.getArtifact(token)).toBeNull();
    // 文件清理是 void unlink 的 best-effort（不阻塞下载拒绝），轮询等它落地。
    await vi.waitFor(async () => {
      await expect(fs.access(path.join(exportDir, `${token}.xmind`))).rejects.toThrow();
    });
  });

  it('token 非 UUID 直接拒（下载路由的 TOKEN_RE 语义同源）', async () => {
    expect(await artifacts.getArtifact('../etc/passwd')).toBeNull();
    expect(await artifacts.getArtifact('not-a-uuid')).toBeNull();
  });
});
