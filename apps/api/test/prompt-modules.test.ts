/** promptModules 单元+DB：frontmatter 剥离/工具文案覆盖/注册表枚举/值解析/幂等插入。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL } from './helpers/db.js';

let pool: Pool;
let tmpDataDir: string;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  tmpDataDir = mkdtempSync(join(tmpdir(), 'itest-pm-'));
  // SKILLS_ROOT = <PI_DATA_DIR>/skills（skillsStore 经 repo.ts 的 DATA_DIR 模块级推导；
  // 本文件对 promptModules 的引用全部是测试内动态 import，求值发生在 beforeAll 之后）
  process.env.PI_DATA_DIR = tmpDataDir;
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_prompt_module_versions, assistant_skills`);
});

describe('stripSkillFrontmatter', () => {
  it('剥 frontmatter 留正文', async () => {
    const { stripSkillFrontmatter } = await import('../src/pi/space/promptModules.js');
    expect(stripSkillFrontmatter('---\nname: "a"\ndescription: "d"\n---\n\n正文')).toBe('正文');
  });
  it('无 frontmatter / 无闭合 原样返回', async () => {
    const { stripSkillFrontmatter } = await import('../src/pi/space/promptModules.js');
    expect(stripSkillFrontmatter('正文')).toBe('正文');
    expect(stripSkillFrontmatter('---\nname: "a"')).toBe('---\nname: "a"');
  });
});

describe('applyToolTextOverrides（纯函数）', () => {
  it('空覆盖表 = no-op；description/guidelines 覆盖生效', async () => {
    const { applyToolTextOverrides, insertPromptModuleVersion } = await import('../src/pi/space/promptModules.js');
    const tools = [{ name: 't1', description: '旧描述', promptGuidelines: ['旧1', '旧2'] }];
    const empty = new Map();
    applyToolTextOverrides(tools, empty);
    expect(tools[0]!.description).toBe('旧描述');

    await insertPromptModuleVersion({ moduleKey: 'tool.t1.description', value: '新描述', source: 'manual_edit' });
    await insertPromptModuleVersion({ moduleKey: 'tool.t1.guidelines', value: '新A\n新B', source: 'manual_edit' });
    const { loadPromptModuleOverrides } = await import('../src/pi/space/promptModules.js');
    const ov = await loadPromptModuleOverrides();
    applyToolTextOverrides(tools, ov);
    expect(tools[0]!.description).toBe('新描述');
    expect(tools[0]!.promptGuidelines).toEqual(['新A', '新B']);
  });
});

describe('listPromptModuleDefs', () => {
  it('主 prompt 三段 + 工具文案（chat/rca 并集）', async () => {
    const { listPromptModuleDefs } = await import('../src/pi/space/promptModules.js');
    const defs = await listPromptModuleDefs();
    const keys = defs.map((d) => d.key);
    expect(keys).toContain('space.style.zh');
    expect(keys).toContain('space.style.en');
    expect(keys).toContain('space.workspace');
    expect(defs.filter((d) => d.group === 'tool').length).toBeGreaterThan(5);
  });

  it('skill 只读组：DB enabled + 磁盘目录存在才出现，defaultValue=去 frontmatter 正文', async () => {
    await pool.query(`INSERT INTO assistant_skills (name, description) VALUES ('demo-skill', '演示')`);
    mkdirSync(join(tmpDataDir, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(tmpDataDir, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: "demo-skill"\ndescription: "演示"\n---\n\n# 演示正文');
    const { listPromptModuleDefs } = await import('../src/pi/space/promptModules.js');
    const def = (await listPromptModuleDefs()).find((d) => d.key === 'skill.demo-skill');
    expect(def).toBeTruthy();
    expect(def!.readonly).toBe(true);
    expect(def!.group).toBe('skill');
    expect(await def!.defaultValue()).toBe('# 演示正文');
  });
});

describe('版本链语义', () => {
  it('当前值=每 key 最大 seq；NULL 行=跟随代码默认（textOverrideOf→undefined）', async () => {
    const { loadPromptModuleOverrides, textOverrideOf, insertPromptModuleVersion } = await import('../src/pi/space/promptModules.js');
    await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: 'A', source: 'manual_edit' });
    await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: 'B', source: 'manual_edit' });
    await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: null, source: 'manual_edit' }); // 恢复默认
    const ov = await loadPromptModuleOverrides();
    expect(ov.get('space.style.zh')!.value).toBeNull();
    expect(textOverrideOf(ov, 'space.style.zh')).toBeUndefined();
  });

  it('insertPromptModuleVersion：sourceRef 重放命中 partial unique → 返回 null 不落行', async () => {
    const { insertPromptModuleVersion } = await import('../src/pi/space/promptModules.js');
    const ref = crypto.randomUUID();
    const s1 = await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: 'x', source: 'solidify_apply', sourceRef: ref });
    const s2 = await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: 'x', source: 'solidify_apply', sourceRef: ref });
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeNull();
  });

  it('loadPromptModuleOverridesSafe：表被 DROP → 空表不抛（会话照常代码默认）', async () => {
    await pool.query(`DROP TABLE assistant_prompt_module_versions`);
    const { loadPromptModuleOverridesSafe } = await import('../src/pi/space/promptModules.js');
    const ov = await loadPromptModuleOverridesSafe();
    expect(ov.size).toBe(0);
    await pool.query(`CREATE TABLE assistant_prompt_module_versions (seq bigserial PRIMARY KEY, module_key varchar(100) NOT NULL, value text, source varchar(20) NOT NULL, source_ref uuid, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamp NOT NULL DEFAULT now())`);
  });
});
