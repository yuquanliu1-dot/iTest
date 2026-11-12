import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject, seedProjectInOrg } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { productLinesRoute } = await import('../src/routes/productLines.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/product-lines', productLinesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

async function lineProductLineId(projectId: string): Promise<string | null> {
  const r = await pool.query(`SELECT product_line_id FROM projects WHERE id = $1`, [projectId]);
  return r.rows[0]?.product_line_id ?? null;
}

describe('产品线 CRUD', () => {
  it('建线后出现在列表里', async () => {
    const created = await request(app).post('/api/product-lines').send({ name: 'SOC产品线', description: '基线+局点' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('SOC产品线');

    const list = await request(app).get('/api/product-lines');
    expect(list.status).toBe(200);
    expect(list.body.map((x: { id: string }) => x.id)).toContain(created.body.id);
  });

  it('同组织同名产品线被唯一约束拒绝（500/23505 由 errorHandler 兜住）', async () => {
    const name = `重名-${Date.now()}`;
    const first = await request(app).post('/api/product-lines').send({ name });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/product-lines').send({ name });
    expect(second.status).not.toBe(201);
  });

  it('挂项目后详情能列出，projectIds 覆盖且幂等', async () => {
    const baseline = await seedProject(pool);
    const site = await seedProject(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `挂载-${Date.now()}` });

    const attach = await request(app)
      .post(`/api/product-lines/${line.body.id}/projects`)
      .send({ projectIds: [baseline.projectId, site.projectId] });
    expect(attach.status).toBe(200);
    expect(attach.body.count).toBe(2);

    const detail = await request(app).get(`/api/product-lines/${line.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.projects.map((p: { id: string }) => p.id).sort()).toEqual(
      [baseline.projectId, site.projectId].sort(),
    );

    // Attaching again does not error (idempotent upsert)
    const again = await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [baseline.projectId] });
    expect(again.status).toBe(200);
  });

  it('把项目挂到另一条线后原线只剩剩下的', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `解绑-${Date.now()}` });
    const otherLine = await request(app).post('/api/product-lines').send({ name: `改挂-${Date.now()}` });
    await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [a.projectId, b.projectId] });

    // R2: there is no "remove from line"; flip the direction — attach a to another line.
    const moved = await request(app).post(`/api/product-lines/${otherLine.body.id}/projects`).send({ projectIds: [a.projectId] });
    expect(moved.status).toBe(200);
    expect(await lineProductLineId(a.projectId)).toBe(otherLine.body.id);
    expect(await lineProductLineId(b.projectId)).toBe(line.body.id);
  });

  it('线内仍有项目时删线被拒（409 line_not_empty），空线删成功', async () => {
    const p = await seedProject(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `待删-${Date.now()}` });
    await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [p.projectId] });

    const del = await request(app).delete(`/api/product-lines/${line.body.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('line_not_empty');
    // Project and line both still there
    expect(await lineProductLineId(p.projectId)).toBe(line.body.id);
    expect((await pool.query(`SELECT id FROM product_lines WHERE id = $1`, [line.body.id])).rowCount).toBe(1);

    // Move the project to another line so the original line becomes empty, then it can be deleted
    const otherLine = await request(app).post('/api/product-lines').send({ name: `接管-${Date.now()}` });
    await request(app).post(`/api/product-lines/${otherLine.body.id}/projects`).send({ projectIds: [p.projectId] });
    expect((await request(app).delete(`/api/product-lines/${line.body.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/product-lines/${line.body.id}`)).status).toBe(404);
  });

  it('改名将线更新到新名字', async () => {
    const line = await request(app).post('/api/product-lines').send({ name: `改名前-${Date.now()}` });
    const patched = await request(app).patch(`/api/product-lines/${line.body.id}`).send({ name: '改名后' });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('改名后');
  });

  it('空 projectIds 被拒', async () => {
    const line = await request(app).post('/api/product-lines').send({ name: `空挂-${Date.now()}` });
    const r = await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [] });
    expect(r.status).toBe(400);
  });
});

describe('产品线可见性与跨组织边界', () => {
  it('他组织的产品线访问 404（不泄露存在性）', async () => {
    // Create an org + product line different from the current identity
    const other = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`他组织-${Date.now()}`, `/other-${Date.now()}/`],
    );
    const otherOrgId = other.rows[0]!.id as string;
    const foreign = await pool.query(
      `INSERT INTO product_lines(organization_id, name) VALUES ($1, $2) RETURNING id`,
      [otherOrgId, `外部线-${Date.now()}`],
    );
    const foreignId = foreign.rows[0]!.id as string;

    expect((await request(app).get(`/api/product-lines/${foreignId}`)).status).toBe(404);
    expect((await request(app).patch(`/api/product-lines/${foreignId}`).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/product-lines/${foreignId}`)).status).toBe(404);

    const list = await request(app).get('/api/product-lines');
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(foreignId);
  });

  it('对不可见（他组织）项目挂载 404', async () => {
    const other = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`挂载他组织-${Date.now()}`, `/mount-${Date.now()}/`],
    );
    const otherOrgId = other.rows[0]!.id as string;
    // Another org's project: invisible to the current identity → 404 (visibility applies before the move)
    const foreignProjectId = await seedProjectInOrg(pool, otherOrgId, '他组织项目');
    const line = await request(app).post('/api/product-lines').send({ name: `跨组织挂-${Date.now()}` });
    const r = await request(app)
      .post(`/api/product-lines/${line.body.id}/projects`)
      .send({ projectIds: [foreignProjectId] });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('跨组织可见时挂载 = 搬家：项目组织改写成产品线所属组织', async () => {
    // Build an "other org" that the current identity can see and manages: different name but its path prefix hangs under the seeded org
    const { orgId: seedOrgId, orgPath: seedOrgPath } = await seedOrg(pool);
    const sub = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`兄弟组织-${Date.now()}`, `${seedOrgPath}sub-${Date.now()}/`],
    );
    const subOrgId = sub.rows[0]!.id as string;
    const projectId = await seedProjectInOrg(pool, subOrgId, '兄弟组织项目');
    // Case + tag: after attaching, the tag must migrate to the target org (otherwise case updates get rejected with tag_org_mismatch)
    const g = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`, [projectId]);
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title) VALUES ($1, 'c') RETURNING id`,
      [g.rows[0]!.id],
    );
    const tag = await pool.query(
      `INSERT INTO tags(organization_id, name, color) VALUES ($1, '冒烟', 'ff0000') RETURNING id`,
      [subOrgId],
    );
    const oldTagId = tag.rows[0]!.id as string;
    await pool.query(`INSERT INTO case_tags(case_id, tag_id) VALUES ($1, $2)`, [c.rows[0]!.id, oldTagId]);

    const line = await request(app).post('/api/product-lines').send({ name: `搬家-${Date.now()}` });
    const r = await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [projectId] });
    expect(r.status).toBe(200);

    // R2: projects have no organization_id; "org rewritten" shows up as the line it now hangs on belonging to the seeded org.
    const after = await pool.query(
      `SELECT p.product_line_id, l.organization_id FROM projects p
         JOIN product_lines l ON l.id = p.product_line_id WHERE p.id = $1`,
      [projectId],
    );
    expect(after.rows[0]!.product_line_id).toBe(line.body.id);
    expect(after.rows[0]!.organization_id).toBe(seedOrgId);

    // Tag migrates to the same-named tag under the target org, case_tags points at the new row; the source org's old tag stays in place
    const newTag = await pool.query(`SELECT id FROM tags WHERE organization_id = $1 AND name = '冒烟'`, [seedOrgId]);
    expect(newTag.rowCount).toBe(1);
    const linked = await pool.query(`SELECT tag_id FROM case_tags WHERE case_id = $1`, [c.rows[0]!.id]);
    expect(linked.rows.map((x) => x.tag_id)).toEqual([newTag.rows[0]!.id]);
    const oldStill = await pool.query(`SELECT id FROM tags WHERE id = $1`, [oldTagId]);
    expect(oldStill.rowCount).toBe(1);
  });

  it('已在本线的项目重复挂载幂等（moved=0，不重复搬家）', async () => {
    const p = await seedProject(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `幂等-${Date.now()}` });
    const first = await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [p.projectId] });
    expect(first.body.moved).toBe(1);
    const again = await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [p.projectId] });
    expect(again.status).toBe(200);
    expect(again.body.moved).toBe(0);
  });
});

describe('产品线写操作按所属组织鉴权', () => {
  it('建线可指定归属组织，缺省落在当前激活组织', async () => {
    const { orgId: seedOrgId } = await seedOrg(pool);
    const explicit = await request(app).post('/api/product-lines').send({ name: `指定组织-${Date.now()}`, organizationId: seedOrgId });
    expect(explicit.status).toBe(201);
    expect(explicit.body.organizationId).toBe(seedOrgId);

    const implicit = await request(app).post('/api/product-lines').send({ name: `默认组织-${Date.now()}` });
    expect(implicit.status).toBe(201);
    expect(implicit.body.organizationId).toBe(seedOrgId);
  });

  it('目标组织不是调用者管理的 → 403', async () => {
    const other = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`非管理组织-${Date.now()}`, `/nonmanaged-${Date.now()}/`],
    );
    const r = await request(app)
      .post('/api/product-lines')
      .send({ name: `越权建线-${Date.now()}`, organizationId: other.rows[0]!.id });
    expect(r.status).toBe(403);
  });

  it('目标组织不存在 → 404', async () => {
    const r = await request(app)
      .post('/api/product-lines')
      .send({ name: `幽灵组织-${Date.now()}`, organizationId: '00000000-0000-4000-8000-000000000000' });
    expect(r.status).toBe(404);
  });

  it('可见但非管理的组织下的线 → 改/删/挂载均 403', async () => {
    // Build an org that is "visible but unmanageable": the caller is its **regular member** (visible) but not a manager
    // (managerOrgPaths contains only the seeded org, so isManagerOfOrg is false).
    const { userId, orgPath: seedOrgPath } = await seedOrg(pool);
    const other = await pool.query(
      `INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`,
      [`只读组织-${Date.now()}`, `/readonly-${Date.now()}/`],
    );
    const otherOrgId = other.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, false, true)`,
      [otherOrgId, userId],
    );
    const line = await pool.query(
      `INSERT INTO product_lines(organization_id, name) VALUES ($1, $2) RETURNING id`,
      [otherOrgId, `只读线-${Date.now()}`],
    );
    const lineId = line.rows[0]!.id as string;

    // Reads are allowed (visible)
    expect((await request(app).get(`/api/product-lines/${lineId}`)).status).toBe(200);
    // Writes are all 403
    expect((await request(app).patch(`/api/product-lines/${lineId}`).send({ name: '改名' })).status).toBe(403);
    expect((await request(app).delete(`/api/product-lines/${lineId}`)).status).toBe(403);
    const p = await seedProject(pool);
    expect((await request(app).post(`/api/product-lines/${lineId}/projects`).send({ projectIds: [p.projectId] })).status).toBe(403);
    expect(seedOrgPath).toBeTruthy();
  });
});

describe('产品线移动组织', () => {
  /** Build a sibling org hanging under the seeded org's subtree: the caller is its manager (path prefix matches). */
  async function siblingOrg(tag: string): Promise<string> {
    const { orgPath } = await seedOrg(pool);
    const r = await pool.query(`INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`, [
      `${tag}组织-${Date.now()}`,
      `${orgPath}sub-${Date.now()}/`,
    ]);
    return r.rows[0]!.id as string;
  }

  /** Build an org the caller can see but not manage (path outside the subtree, regular membership only → visible non-manager). */
  async function readonlyOrg(userId: string, tag: string): Promise<string> {
    const r = await pool.query(`INSERT INTO organizations(name, path) VALUES ($1, $2) RETURNING id`, [
      `${tag}只读-${Date.now()}`,
      `/ro-${Date.now()}/`,
    ]);
    const id = r.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO organization_members(organization_id, user_id, is_manager, is_user) VALUES ($1, $2, false, true)`,
      [id, userId],
    );
    return id;
  }

  it('移动到兄弟组织：线与线内项目的组织、标签、分配快照一起改写', async () => {
    const { orgId: seedOrgId, userId } = await seedOrg(pool);
    const targetOrgId = await siblingOrg('搬入');
    const line = await request(app).post('/api/product-lines').send({ name: `整线搬家-${Date.now()}` });

    // The two projects in the line each carry a tag — verifying tag migration really fans out across the whole line, not just the first project
    const caseIds: string[] = [];
    const tagNames: string[] = [];
    for (const [i, name] of ['搬家A', '搬家B'].entries()) {
      const projectId = await seedProjectInOrg(pool, seedOrgId, name);
      const g = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`, [projectId]);
      const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, $2) RETURNING id`, [g.rows[0]!.id, name]);
      caseIds.push(c.rows[0]!.id as string);
      const tagName = `冒烟${i}`;
      tagNames.push(tagName);
      const tag = await pool.query(`INSERT INTO tags(organization_id, name, color) VALUES ($1, $2, 'ff0000') RETURNING id`, [seedOrgId, tagName]);
      await pool.query(`INSERT INTO case_tags(case_id, tag_id) VALUES ($1, $2)`, [c.rows[0]!.id, tag.rows[0]!.id]);
      await request(app).post(`/api/product-lines/${line.body.id}/projects`).send({ projectIds: [projectId] });
      await pool.query(`INSERT INTO project_assignments(project_id, user_id, organization_id) VALUES ($1, $2, $3)`, [
        projectId,
        userId,
        seedOrgId,
      ]);
    }

    const r = await request(app).post(`/api/product-lines/${line.body.id}/move`).send({ organizationId: targetOrgId });
    expect(r.status).toBe(200);
    expect(r.body.projectCount).toBe(2);

    expect((await pool.query(`SELECT organization_id FROM product_lines WHERE id = $1`, [line.body.id])).rows[0]!.organization_id)
      .toBe(targetOrgId);
// R2: a project's org is the line's org — change one column and in-line projects follow automatically (no per-project rewrite).
    const projOrgs = await pool.query(
      `SELECT DISTINCT l.organization_id FROM projects p
         JOIN product_lines l ON l.id = p.product_line_id WHERE p.product_line_id = $1`,
      [line.body.id],
    );
    expect(projOrgs.rows.map((x) => x.organization_id)).toEqual([targetOrgId]);
    const assignOrgs = await pool.query(
      `SELECT DISTINCT pa.organization_id FROM project_assignments pa
         JOIN projects p ON p.id = pa.project_id WHERE p.product_line_id = $1`,
      [line.body.id],
    );
    expect(assignOrgs.rows.map((x) => x.organization_id)).toEqual([targetOrgId]);

    // Both cases' tags each migrate to their same-named tag under the target org (no longer sharing one row)
    for (const [i, caseId] of caseIds.entries()) {
      const newTag = await pool.query(`SELECT id FROM tags WHERE organization_id = $1 AND name = $2`, [targetOrgId, tagNames[i]!]);
      expect(newTag.rowCount).toBe(1);
      const linked = await pool.query(`SELECT tag_id FROM case_tags WHERE case_id = $1`, [caseId]);
      expect(linked.rows.map((x) => x.tag_id)).toEqual([newTag.rows[0]!.id]);
    }
    // The source org's tag rows are not deleted
    for (const tagName of tagNames) {
      expect((await pool.query(`SELECT id FROM tags WHERE organization_id = $1 AND name = $2`, [seedOrgId, tagName])).rowCount).toBe(1);
    }
  });

  it('目标 == 当前组织 → 409 same_org', async () => {
    const { orgId } = await seedOrg(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `原地移动-${Date.now()}` });
    const r = await request(app).post(`/api/product-lines/${line.body.id}/move`).send({ organizationId: orgId });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('same_org');
  });

  it('目标组织已有同名产品线 → 409 line_name_conflict（不是 500）', async () => {
    const name = `重名移动-${Date.now()}`;
    const line = await request(app).post('/api/product-lines').send({ name });
    const targetOrgId = await siblingOrg('撞名');
    await pool.query(`INSERT INTO product_lines(organization_id, name) VALUES ($1, $2)`, [targetOrgId, name]);

    const r = await request(app).post(`/api/product-lines/${line.body.id}/move`).send({ organizationId: targetOrgId });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('line_name_conflict');
  });

  it('目标组织只可见但非管理员 → 403（目标侧闸门）', async () => {
    const { userId } = await seedOrg(pool);
    const line = await request(app).post('/api/product-lines').send({ name: `目标闸门-${Date.now()}` });
    const targetOrgId = await readonlyOrg(userId, '目标侧');
    const r = await request(app).post(`/api/product-lines/${line.body.id}/move`).send({ organizationId: targetOrgId });
    expect(r.status).toBe(403);
  });

  it('源线只可见但非管理员 → 403（源侧闸门）', async () => {
    const { userId } = await seedOrg(pool);
    const sourceOrgId = await readonlyOrg(userId, '源侧');
    const line = await pool.query(
      `INSERT INTO product_lines(organization_id, name) VALUES ($1, $2) RETURNING id`,
      [sourceOrgId, `只读线-${Date.now()}`],
    );
    const targetOrgId = await siblingOrg('接得住');
    // The line is visible (direct membership) but not modifiable
    const r = await request(app)
      .post(`/api/product-lines/${line.rows[0]!.id}/move`)
      .send({ organizationId: targetOrgId });
    expect(r.status).toBe(403);
  });

  it('目标组织不存在 → 404', async () => {
    const line = await request(app).post('/api/product-lines').send({ name: `幽灵目标-${Date.now()}` });
    const r = await request(app)
      .post(`/api/product-lines/${line.body.id}/move`)
      .send({ organizationId: '00000000-0000-4000-8000-000000000000' });
    expect(r.status).toBe(404);
  });
});