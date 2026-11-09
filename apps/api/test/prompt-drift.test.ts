/**
 * R3 prompt 基线漂移（drift）告警：版本行写入时记录代码默认基线指纹（base_hash），
 * 代码默认演进后据此检测「旧行 shadow 新默认」——改代码默认值发版却不生效的暗坑。
 * 状态：base_hash ≠ 当前指纹 → drift；无指纹（旧版写入）→ unknown；跟随默认行/skill 组不参与。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
}, 60_000);

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_prompt_module_versions`);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

describe('prompt 基线漂移检测', () => {
  it('hashBaseline 稳定且区分不同文本', async () => {
    const { hashBaseline } = await import('../src/pi/space/promptModules.js');
    expect(hashBaseline('abc')).toBe(hashBaseline('abc'));
    expect(hashBaseline('abc')).not.toBe(hashBaseline('abd'));
    expect(hashBaseline('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('insertPromptModuleVersion 自动记录当前代码默认指纹 → 检测无 drift', async () => {
    const { insertPromptModuleVersion, computePromptDrifts, hashBaseline, STYLE_ZH_DEFAULT } = await import('../src/pi/space/promptModules.js');
    const seq = await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: '## DB风格', source: 'manual_edit' });
    expect(seq).not.toBeNull();
    const drifts = await computePromptDrifts();
    expect(drifts.find((d) => d.key === 'space.style.zh')).toBeUndefined();
    const row = (await pool.query(`SELECT base_hash FROM assistant_prompt_module_versions WHERE module_key = 'space.style.zh'`)).rows[0];
    expect(row.base_hash).toBe(hashBaseline(STYLE_ZH_DEFAULT));
  });

  it('覆盖行指纹 ≠ 当前默认 → drift（带溯源字段）', async () => {
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source, base_hash) VALUES ('space.style.zh', '## 旧基线上写的', 'solidify_apply', 'deadbeef')`);
    const { computePromptDrifts } = await import('../src/pi/space/promptModules.js');
    const d = (await computePromptDrifts()).find((x) => x.key === 'space.style.zh');
    expect(d?.status).toBe('drift');
    expect(d?.baseHash).toBe('deadbeef');
    expect(d?.currentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d?.currentHash).not.toBe('deadbeef');
    expect(d?.seq).toBeGreaterThan(0);
    expect(d?.source).toBe('solidify_apply');
    expect(d?.writtenAt).toBeTruthy();
  });

  it('覆盖行无指纹（旧版写入）→ unknown，不误判 drift', async () => {
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.workspace', '## 旧覆盖', 'manual_edit')`);
    const { computePromptDrifts } = await import('../src/pi/space/promptModules.js');
    const d = (await computePromptDrifts()).find((x) => x.key === 'space.workspace');
    expect(d?.status).toBe('unknown');
    expect(d?.baseHash).toBeNull();
    expect(d?.currentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('跟随默认行（value NULL）不产生 drift 条目', async () => {
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source, base_hash) VALUES ('space.style.zh', NULL, 'manual_edit', NULL)`);
    const { computePromptDrifts } = await import('../src/pi/space/promptModules.js');
    expect(await computePromptDrifts()).toHaveLength(0);
  });

  it('显式传 baseHash=null（回滚继承无指纹历史行）不自动补指纹', async () => {
    const { insertPromptModuleVersion } = await import('../src/pi/space/promptModules.js');
    await insertPromptModuleVersion({ moduleKey: 'space.style.zh', value: '## 回滚值', source: 'rollback', baseHash: null });
    const row = (await pool.query(`SELECT base_hash FROM assistant_prompt_module_versions WHERE module_key = 'space.style.zh'`)).rows[0];
    expect(row.base_hash).toBeNull();
  });
});
