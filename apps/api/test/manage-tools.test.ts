/**
 * manage_skill / manage_mcp 工具行为测试（直接构造工具闭包调 execute，不经 HTTP）。
 *
 * 覆盖：
 *  - 注册闸门：ctx.manager=true 才注册两个管理工具；false 不注册。
 *  - 防御性 execute guard：manager=false 即使手动调用也返回「无管理员权限」。
 *  - manage_skill：create/list/update(renameTo)/delete、重名 409、slug 非法、缺字段、不存在。
 *  - manage_mcp：create stdio/http、file:// url 拒绝、exposure 白名单、重名 409、
 *    list 仅 global、scoped 行 update/delete 拒绝、kind 切换清列、renameTo、不存在。
 *
 * 与 route 测试共用 SCHEMA_SQL（assistant_skills + assistant_mcp_servers 均带 name UQ）。
 *
 * 隔离要点：PI_DATA_DIR 必须在任何动态 import 之前指到临时目录并 resetModules——
 * skillsStore 的 SKILLS_ROOT 是模块级常量，且 listSkills() 会把磁盘上未登记的目录
 * 当孤儿行返回。不隔离就会读到开发者真实的技能库（且用例之间互相污染）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let dbPool: { end: () => Promise<void> };
let dataDir: string;
let skillsRoot: string;
let buildSpaceTools: (ctx: SpaceToolsContext) => ReturnType<typeof import('../src/pi/space/tools/index.js')['buildSpaceTools']>;
let buildManageSkillTool: (ctx: SpaceToolsContext) => ReturnType<typeof import('../src/pi/space/tools/manageSkill.js')['buildManageSkillTool']>;
let buildManageMcpTool: (ctx: SpaceToolsContext) => ReturnType<typeof import('../src/pi/space/tools/manageMcp.js')['buildManageMcpTool']>;

function makeCtx(over: Partial<SpaceToolsContext> = {}): SpaceToolsContext {
  return {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    repo: { cwd: null, issue: null, noRepo: false },
    emit: () => undefined,
    createdByUserId: randomUUID(),
    manager: false,
    ...over,
  };
}

async function runSkill(ctx: SpaceToolsContext, input: Record<string, unknown>) {
  return buildManageSkillTool(ctx).execute(input);
}
async function runMcp(ctx: SpaceToolsContext, input: Record<string, unknown>) {
  return buildManageMcpTool(ctx).execute(input);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // 必须在动态 import 之前：SKILLS_ROOT 在模块加载时就从 PI_DATA_DIR 解析。
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'itest-mgrtools-'));
  process.env.PI_DATA_DIR = dataDir;
  vi.resetModules();
  const store = await import('../src/pi/space/skillsStore.js');
  skillsRoot = store.SKILLS_ROOT;
  const tools = await import('../src/pi/space/tools/index.js');
  const skill = await import('../src/pi/space/tools/manageSkill.js');
  const mcp = await import('../src/pi/space/tools/manageMcp.js');
  buildSpaceTools = tools.buildSpaceTools;
  buildManageSkillTool = skill.buildManageSkillTool;
  buildManageMcpTool = mcp.buildManageMcpTool;
  dbPool = (await import('../src/db/client.js')).pool;
}, 60_000);

afterAll(async () => {
  await dbPool.end();
  await pool.end();
  await fsp.rm(dataDir, { recursive: true, force: true });
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_skills, assistant_mcp_servers`);
  // 目录也清：create/update/delete 都真实动磁盘，留着会让下一例的 list 看到孤儿行。
  fs.rmSync(skillsRoot, { recursive: true, force: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
});

describe('register 闸门 + 防御 guard', () => {
  it('manager=true 注册 manage_skill + manage_mcp；false 不注册', () => {
    const managerNames = buildSpaceTools(makeCtx({ manager: true })).map((t) => t.name);
    expect(managerNames).toContain('manage_skill');
    expect(managerNames).toContain('manage_mcp');
    const memberNames = buildSpaceTools(makeCtx({ manager: false })).map((t) => t.name);
    expect(memberNames).not.toContain('manage_skill');
    expect(memberNames).not.toContain('manage_mcp');
  });

  it('manager=false 手动调用 execute → 无管理员权限（防御兜底）', async () => {
    const member = makeCtx({ manager: false });
    expect(await runSkill(member, { action: 'list' })).toMatchObject({ ok: false, error: '无管理员权限，不能管理全局技能（需要管理员角色）' });
    expect(await runMcp(member, { action: 'list' })).toMatchObject({ ok: false, error: '无管理员权限，不能管理全局 MCP 服务器（需要管理员角色）' });
  });

  it('参数不合法(action 缺失) → 参数不合法报错', async () => {
    const manager = makeCtx({ manager: true });
    const r = await runSkill(manager, {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('参数不合法');
    const r2 = await runMcp(manager, {});
    expect(r2.ok).toBe(false);
    expect((r2 as { error: string }).error).toContain('参数不合法');
  });
});

describe('manage_skill', () => {
  const c = () => makeCtx({ manager: true });

  it('create/list/update(renameTo)/delete 闭环', async () => {
    const created = await runSkill(c(), { action: 'create', name: 'smoke-check', description: '冒烟' });
    expect(created.ok).toBe(true);
    expect(JSON.parse((created as { data: string }).data)).toMatchObject({ created: 'smoke-check' });

    const list = await runSkill(c(), { action: 'list' });
    const rows = JSON.parse((list as { data: string }).data) as Array<{ name: string; fileCount: number }>;
    expect(rows.map((r) => r.name)).toEqual(['smoke-check']);
    expect(rows[0]!.fileCount).toBe(1); // create 产出的是 SKILL.md 骨架

    // 改名：目录跟着搬
    const renamed = await runSkill(c(), { action: 'update', name: 'smoke-check', renameTo: 'smoke-renamed' });
    expect(renamed.ok).toBe(true);
    expect(JSON.parse((renamed as { data: string }).data)).toMatchObject({ updated: 'smoke-renamed' });
    expect(fs.existsSync(path.join(skillsRoot, 'smoke-renamed', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, 'smoke-check'))).toBe(false);

    // 删除：连目录一起没
    const del = await runSkill(c(), { action: 'delete', name: 'smoke-renamed' });
    expect(del.ok).toBe(true);
    expect(JSON.parse((del as { data: string }).data)).toMatchObject({ deleted: 'smoke-renamed' });
    expect(fs.existsSync(path.join(skillsRoot, 'smoke-renamed'))).toBe(false);
    // 不存在 → 报错
    const missing = await runSkill(c(), { action: 'delete', name: 'smoke-renamed' });
    expect(missing.ok).toBe(false);
    expect((missing as { error: string }).error).toBe('技能不存在: smoke-renamed');
  });

  it('create 缺 name/description → 报错', async () => {
    expect((await runSkill(c(), { action: 'create', description: 'x' })).ok).toBe(false);
    const r = await runSkill(c(), { action: 'create', name: 'a' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('create 需要 name、description');
  });

  it('slug 非法 → 报错', async () => {
    const r = await runSkill(c(), { action: 'create', name: 'Bad_Name', description: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('name 必须是小写 slug');
  });

  it('重名 create / renameTo → 409 报错', async () => {
    await runSkill(c(), { action: 'create', name: 's1', description: 'x' });
    const dup = await runSkill(c(), { action: 'create', name: 's1', description: 'x' });
    expect(dup.ok).toBe(false);
    expect((dup as { error: string }).error).toBe('skill 名称已存在');
    await runSkill(c(), { action: 'create', name: 's2', description: 'x' });
    const clash = await runSkill(c(), { action: 'update', name: 's2', renameTo: 's1' });
    expect(clash.ok).toBe(false);
    expect((clash as { error: string }).error).toBe('skill 名称已存在');
  });

  it('update 只改元数据（description/enabled），不提供文件写入面', async () => {
    await runSkill(c(), { action: 'create', name: 'with-script', description: 'x' });
    // body/scripts 不再是入参——传了也不生效（zod 非严格对象会丢弃未知键）。
    const upd = await runSkill(c(), { action: 'update', name: 'with-script', description: '新描述', enabled: false, body: '# 偷偷改正文' });
    expect(upd.ok).toBe(true);
    const rows = JSON.parse((await runSkill(c(), { action: 'list' }) as { data: string }).data) as Array<{ name: string; description: string; enabled: boolean }>;
    expect(rows[0]).toMatchObject({ name: 'with-script', description: '新描述', enabled: false });
    // 正文没被动：SKILL.md 仍是骨架
    expect(fs.readFileSync(path.join(skillsRoot, 'with-script', 'SKILL.md'), 'utf8')).toContain('name: "with-script"');
    expect(fs.readFileSync(path.join(skillsRoot, 'with-script', 'SKILL.md'), 'utf8')).not.toContain('偷偷改正文');
  });

  it('update 无任何可改字段 → 报错', async () => {
    await runSkill(c(), { action: 'create', name: 'nochange', description: 'x' });
    const r = await runSkill(c(), { action: 'update', name: 'nochange' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('update 至少给一项要改的字段');
  });

  it('list 带出磁盘上未登记的孤儿目录', async () => {
    fs.mkdirSync(path.join(skillsRoot, 'orphan-dir'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'orphan-dir', 'SKILL.md'), 'x');
    const rows = JSON.parse((await runSkill(c(), { action: 'list' }) as { data: string }).data) as Array<{ name: string; unregistered: boolean; id: string | null }>;
    const orphan = rows.find((r) => r.name === 'orphan-dir');
    expect(orphan).toMatchObject({ unregistered: true, id: null });
  });
});

describe('manage_mcp', () => {
  const c = () => makeCtx({ manager: true });

  it('create stdio(command 必填) / http(http(s):// url 必填)', async () => {
    const s = await runMcp(c(), { action: 'create', name: 'stdio-tool', command: 'npx tool' });
    expect(s.ok).toBe(true);
    expect(JSON.parse((s as { data: string }).data)).toMatchObject({ created: 'stdio-tool', kind: 'stdio' });

    const h = await runMcp(c(), { action: 'create', name: 'http-tool', kind: 'http', url: 'https://tool.example.com' });
    expect(h.ok).toBe(true);

    const noCmd = await runMcp(c(), { action: 'create', name: 'no-cmd' });
    expect(noCmd.ok).toBe(false);
    expect((noCmd as { error: string }).error).toBe('kind=stdio 需要 command');

    const badUrl = await runMcp(c(), { action: 'create', name: 'file-tool', kind: 'http', url: 'file:///etc/passwd' });
    expect(badUrl.ok).toBe(false);
    expect((badUrl as { error: string }).error).toBe('kind=http 需要 http(s):// url');
  });

  it('exposure 白名单：oauth → 拒绝', async () => {
    const r = await runMcp(c(), { action: 'create', name: 'bad-exp', command: 'x', exposure: 'oauth' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('exposure 必须是');
  });

  it('重名 create / renameTo → 409 报错', async () => {
    await runMcp(c(), { action: 'create', name: 'mcp-a', command: 'a' });
    const dup = await runMcp(c(), { action: 'create', name: 'mcp-a', command: 'a' });
    expect(dup.ok).toBe(false);
    expect((dup as { error: string }).error).toBe('mcp server 名称已存在');

    await runMcp(c(), { action: 'create', name: 'mcp-b', command: 'b' });
    const clash = await runMcp(c(), { action: 'update', name: 'mcp-b', renameTo: 'mcp-a' });
    expect(clash.ok).toBe(false);
    expect((clash as { error: string }).error).toBe('mcp server 名称已存在');
  });

  it('renameTo 改名；delete 删除；不存在 → 报错', async () => {
    await runMcp(c(), { action: 'create', name: 'orig', command: 'x' });
    const renamed = await runMcp(c(), { action: 'update', name: 'orig', renameTo: 'renamed-http', kind: 'http', url: 'https://x.example.com' });
    expect(renamed.ok).toBe(true);
    expect(JSON.parse((renamed as { data: string }).data)).toMatchObject({ updated: 'renamed-http' });

    const del = await runMcp(c(), { action: 'delete', name: 'renamed-http' });
    expect(del.ok).toBe(true);
    expect(JSON.parse((del as { data: string }).data)).toMatchObject({ deleted: 'renamed-http' });
    expect((await runMcp(c(), { action: 'delete', name: 'renamed-http' }))).toMatchObject({ ok: false, error: '服务器不存在: renamed-http' });
  });

  it('kind 切换 stdio→http 清掉 command 列', async () => {
    await runMcp(c(), { action: 'create', name: 'switch', command: 'npx foo' });
    const upd = await runMcp(c(), { action: 'update', name: 'switch', kind: 'http', url: 'https://s.example.com' });
    expect(upd.ok).toBe(true);
    const row = (await pool.query(`SELECT kind, command, url FROM assistant_mcp_servers WHERE name = 'switch'`)).rows[0];
    expect(row).toMatchObject({ kind: 'http', command: null, url: 'https://s.example.com' });
  });

  it('list 仅 global：scoped 行不进清单，且 update/delete 拒绝(仅 global 可管理)', async () => {
    await runMcp(c(), { action: 'create', name: 'global-server', command: 'x' });
    // 直接落一个 scope=project 行（对话面外的归属）
    await pool.query(
      `INSERT INTO assistant_mcp_servers(name, kind, command, scope, project_id) VALUES ('scoped-server', 'stdio', 'y', 'project', NULL)`,
    );
    const list = JSON.parse((await runMcp(c(), { action: 'list' }) as { data: string }).data) as Array<{ name: string }>;
    expect(list.map((r) => r.name)).toEqual(['global-server']);

    const scopedId = (await pool.query(`SELECT id FROM assistant_mcp_servers WHERE name = 'scoped-server'`)).rows[0]!.id as string;
    const upd = await runMcp(c(), { action: 'update', name: 'scoped-server', enabled: false });
    expect(upd.ok).toBe(false);
    expect((upd as { error: string }).error).toBe('仅 global 级 MCP 服务器可由助手对话管理（project/version 级请走系统设置页）');
    const del = await runMcp(c(), { action: 'delete', name: 'scoped-server' });
    expect(del.ok).toBe(false);
    expect((del as { error: string }).error).toBe('仅 global 级 MCP 服务器可由助手对话管理（project/version 级请走系统设置页）');
    void scopedId;
  });
});