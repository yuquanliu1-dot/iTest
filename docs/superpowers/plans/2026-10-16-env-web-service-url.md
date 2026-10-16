# 环境多 Web 服务与相对 URL 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用例初始导航与中途 navigate 只存相对 URL,执行时由环境对象里的多个 web 服务(scheme/host/port)拼出绝对地址;删除分组 URL 与环境单值 baseUrl。

**Architecture:** web 服务建模为 `environmentObjects` 新 objectType='web'(复用对象 CRUD/isDefault/AI 工具/UI 卡片);`test_cases` 加 `web_service_ref` 列绑定服务;执行链 `EnvCtx` 暴露 `webServices`/`resolveWebOrigin`,runCase 注入 `web_<name>` 变量与 `caseWebOrigin`;存量绝对 URL 由迁移 0040 尽力剥离,运行时绝对直通兼容。

**Tech Stack:** Express + drizzle(pg)+ zod(api);React + Query(web);pnpm workspace;vitest + testcontainers。

**Spec:** `docs/superpowers/specs/2026-10-16-env-web-service-url-design.md`

**关键项目事实(实现者必读):**

- 测试容器的建表 SQL 是**手工维护**的 `apps/api/test/helpers/db.ts` 的 `SCHEMA_SQL`(注释:"与迁移完成后一致的全量建表 SQL,不走迁移")——凡改 schema.ts 必须同步改它,否则 api 测试全红。
- `packages/shared` 改 TS 后必须 `cd packages/shared && npx tsc -p tsconfig.json` 重编译(src/ 下 .js 产物被 git ignore,web/api 测试链接旧产物会假失败/假通过)。
- api 测试命令:`cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/<file>`(需要本地 Docker)。
- 迁移:`cd apps/api && npm run db:generate`(生成 DDL sql)/ `npm run db:migrate`(应用)。当前最新 **0038**。
- `EnvMissing`/`EnvProjectMismatch` 定义于 `apps/api/src/execute/envContext.ts:8-14`;`resolveCaseUrl` 于 `apps/api/src/lib/resolve-url.ts`;navigate dispatch 于 `apps/api/src/execute/cdp.ts:287-294`。
- 每个 task 结束跑 `cd apps/api && npx tsc --noEmit` 保证类型不破。

---

### Task 1: shared DSL 校验放宽(navigate url 三形态)

**Files:**
- Modify: `packages/shared/src/step-dsl.ts:13`
- Test: `packages/shared/test/step-dsl.test.ts`(已存在,追加 describe)

- [ ] **Step 1: 写失败测试**

在 `packages/shared/test/step-dsl.test.ts` 末尾追加(注意先看文件顶部 import 了哪些,补 `NavigateAction`):

```ts
describe('NavigateAction.url 相对/变量形态', () => {
  it('绝对 URL 合法', () => {
    expect(NavigateAction.safeParse({ kind: 'navigate', url: 'https://a.com/x?y=1#z' }).success).toBe(true);
  });
  it('以 / 开头的相对 URL 合法(含 query/hash)', () => {
    expect(NavigateAction.safeParse({ kind: 'navigate', url: '/admin/user?tab=1#sec' }).success).toBe(true);
  });
  it('{{变量}} 打头合法(替换后由运行时判断)', () => {
    expect(NavigateAction.safeParse({ kind: 'navigate', url: '{{web_backend}}/api/x' }).success).toBe(true);
  });
  it('裸文本与 ftp 非法', () => {
    expect(NavigateAction.safeParse({ kind: 'navigate', url: 'admin/user' }).success).toBe(false);
    expect(NavigateAction.safeParse({ kind: 'navigate', url: 'ftp://a.com/x' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/shared && npx vitest run test/step-dsl.test.ts
```
预期:新 describe 两条 FAIL(相对/变量打头被 `z.string().url()` 拒绝)。

- [ ] **Step 3: 实现**

`packages/shared/src/step-dsl.ts:13` 替换:

```ts
/** navigate.url 三形态:绝对 http(s)(外链)/ 相对(以 / 开头,执行时拼用例绑定的 web 服务)/
 *  {{变量}} 打头(如 {{web_backend}}/api/x,替换后再按前两形态判断)。 */
const navigateUrl = z.string().refine(
  (u) => /^https?:\/\//.test(u) || u.startsWith('/') || u.startsWith('{{'),
  { message: 'url 必须是绝对 http(s) 地址、以 / 开头的相对路径,或 {{变量}} 打头' },
);
export const NavigateAction = z.object({ kind: z.literal('navigate'), url: navigateUrl });
```

- [ ] **Step 4: 跑测试确认通过 + 重编译 shared**

```bash
cd packages/shared && npx vitest run test/step-dsl.test.ts && npx tsc -p tsconfig.json
```
预期:全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/step-dsl.ts packages/shared/test/step-dsl.test.ts
git commit -m "feat(shared): navigate.url 放宽三形态——绝对/相对/\{\{变量\}\}打头"
```

---

### Task 2: schema 加列 web_service_ref + 迁移 0039

**Files:**
- Modify: `apps/api/src/db/schema.ts:35-41`(test_cases)
- Create: `apps/api/drizzle/0039_*.sql`(generate 产出)
- Modify: `apps/api/test/helpers/db.ts`(SCHEMA_SQL 的 test_cases CREATE TABLE 行)

- [ ] **Step 1: schema.ts 加列**

`test_cases` 定义中 `url: text('url'),`(schema.ts:40)之后加:

```ts
  /** 用例绑定的 web 服务对象标识(environment_objects objectType='web' 的 payload.name);
   *  空=用环境默认 web 服务。执行时与相对 url 拼绝对地址。 */
  webServiceRef: varchar('web_service_ref', { length: 64 }),
```

- [ ] **Step 2: 生成迁移**

```bash
cd apps/api && npm run db:generate
```
预期:生成 `drizzle/0039_*.sql`,内容仅 `ALTER TABLE "test_cases" ADD COLUMN "web_service_ref" varchar(64);`。若文件名不含 0039 或含其他 DDL,停下来检查 git status 推断原因。

- [ ] **Step 3: 同步 SCHEMA_SQL**

`apps/api/test/helpers/db.ts` 的 test_cases CREATE TABLE(约 line 17)在 `url text,` 后加 `web_service_ref varchar(64),`。

- [ ] **Step 4: 验证 api 测试库可用**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/resolve-url.test.ts
```
预期:PASS(现有用例不受新列影响;Docker 需在跑)。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/ apps/api/test/helpers/db.ts
git commit -m "feat(schema): test_cases 加 web_service_ref 列绑定环境 web 服务(0039)"
```

---

### Task 3: web 环境对象类型(service 校验 + 路由 zod)

**Files:**
- Modify: `apps/api/src/services/environments.service.ts:14,146-198`
- Modify: `apps/api/src/routes/environments.ts:18`
- Test: `apps/api/test/environments.service.test.ts`(已存在,追加)

- [ ] **Step 1: 写失败测试**

在 `apps/api/test/environments.service.test.ts` 追加(先读文件顶部,复用其已有的 env/seed helper 方式;下面按其现有 helper 命名调整):

```ts
describe('web 对象', () => {
  it('可创建 web 对象,name 合法时保存', async () => {
    const obj = await insertEnvironmentObject(envId, {
      objectType: 'web',
      payload: { name: 'backend', scheme: 'https', host: '192.168.1.11', port: 8081 },
      isDefault: true,
    });
    expect(obj.objectType).toBe('web');
    expect((obj.payload as Record<string, unknown>).name).toBe('backend');
  });
  it('同环境 name 重复(不同 label)被拒', async () => {
    await insertEnvironmentObject(envId, { objectType: 'web', payload: { name: 'web', scheme: 'http', host: 'a.com' } });
    await expect(insertEnvironmentObject(envId, {
      objectType: 'web', label: '第二个',
      payload: { name: 'web', scheme: 'http', host: 'b.com' },
    })).rejects.toThrow(/name.*已存在|conflict/i);
  });
  it('name 非法变量名字符被拒', async () => {
    await expect(insertEnvironmentObject(envId, {
      objectType: 'web', payload: { name: '后端', scheme: 'http', host: 'a.com' },
    })).rejects.toThrow(/name/);
  });
  it('host 缺失被拒', async () => {
    await expect(insertEnvironmentObject(envId, {
      objectType: 'web', payload: { name: 'web', scheme: 'http' },
    })).rejects.toThrow(/host/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/environments.service.test.ts
```
预期:新用例 FAIL(objectType 'web' 不在 OBJECT_TYPES / 无校验)。

- [ ] **Step 3: 实现**

`environments.service.ts:14`:

```ts
const OBJECT_TYPES = ['db', 'syslog', 'login', 'web'] as const;
```

文件顶部 import 区加 `import { VAR_NAME_RE } from '@itest/shared';`,并在 `normalizeObjectPayload` 之后新增校验函数,`insertEnvironmentObject` 与 `upsertEnvironmentObject` 的 transaction 内、insert 之前调用:

```ts
/** web 对象 payload 校验:name 可空(空=仅默认服务不可被引用)、合法则须为变量名字符;
 *  scheme http/https(缺省 http);host 必填;port 可空整数。同环境 name 唯一。 */
async function assertWebPayload(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  environmentId: string,
  payload: Record<string, unknown>,
  selfObjectId?: string,
) {
  const name = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null;
  if (name !== null && !VAR_NAME_RE.test(name)) {
    throw new HttpError(400, 'invalid_web_name', 'web 服务 name 只能包含字母、数字、下划线,且以字母或下划线开头');
  }
  if (payload.scheme !== undefined && payload.scheme !== 'http' && payload.scheme !== 'https') {
    throw new HttpError(400, 'invalid_web_scheme', 'web 服务 scheme 只能是 http 或 https');
  }
  if (typeof payload.host !== 'string' || payload.host.trim().length === 0) {
    throw new HttpError(400, 'invalid_web_host', 'web 服务 host 不能为空');
  }
  if (payload.port !== undefined && payload.port !== null && !Number.isInteger(payload.port)) {
    throw new HttpError(400, 'invalid_web_port', 'web 服务 port 必须是整数');
  }
  if (name !== null) {
    const rows = await tx.select({ id: environmentObjects.id }).from(environmentObjects)
      .where(eq(environmentObjects.environmentId, environmentId));
    const dup = rows.some((r) => {
      if (selfObjectId && r.id === selfObjectId) return false;
      const p = r.payload as Record<string, unknown>;
      return p?.name === name;
    });
    if (dup) throw new HttpError(409, 'web_name_conflict', `web 服务 name "${name}" 在该环境已存在`);
  }
}
```

`insertEnvironmentObject` 的 `db.transaction(async (tx) => {` 体首行加:

```ts
    if (input.objectType === 'web') {
      await assertWebPayload(tx, environmentId, input.payload);
    }
```

`upsertEnvironmentObject`:在查 `existing` 之前加同样调用;存在 `existing` 时改为 `await assertWebPayload(tx, environmentId, { ...(existing.payload as Record<string, unknown>), ...input.payload }, existing.id);`(合并后校验)。

`updateEnvironmentObject`(约 :200):payload patch 时同样按合并后校验,`selfObjectId` 传 `objectId`。

`routes/environments.ts:18`:

```ts
const OBJECT_TYPES = ['db', 'syslog', 'login', 'web'] as const;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/environments.service.test.ts && npx tsc --noEmit
```
预期:PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/environments.service.ts apps/api/src/routes/environments.ts apps/api/test/environments.service.test.ts
git commit -m "feat(env): 环境对象新增 web 类型——name/scheme/host/port 校验与同环境 name 唯一"
```

---

### Task 4: EnvCtx webServices / resolveWebOrigin / WebServiceMissing

**Files:**
- Modify: `apps/api/src/execute/envContext.ts:85-95,219-229`
- Test: `apps/api/test/envContext.test.ts`(已存在,追加)

- [ ] **Step 1: 写失败测试**

`envContext.test.ts` 追加(复用文件里现有的建 env/对象 helper;按现有 seed 风格调整 pool.query 参数):

```ts
describe('webServices / resolveWebOrigin', () => {
  it('构建 web 服务列表,resolveWebOrigin 默认取 isDefault', async () => {
    // env 下插两个 web 对象:frontend(isDefault) + backend(命名)
    const ctx = await resolveEnv({ caseEnvId: envId });
    expect(ctx.webServices.map((w) => w.origin).sort()).toEqual([
      'http://192.168.1.10:8080', 'https://192.168.1.11',
    ].sort());
    expect(ctx.resolveWebOrigin()).toBe('http://192.168.1.10:8080');
    expect(ctx.resolveWebOrigin('backend')).toBe('https://192.168.1.11');
  });
  it('ref 不存在抛 WebServiceMissing(带可用清单)', async () => {
    const ctx = await resolveEnv({ caseEnvId: envId });
    expect(() => ctx.resolveWebOrigin('nope')).toThrow(/nope/);
    expect(() => ctx.resolveWebOrigin('nope')).toThrow(WebServiceMissing.prototype.constructor);
  });
  it('环境无 web 对象返回 null;baseUrl 为派生默认 origin', async () => {
    const ctx = await resolveEnv({ caseEnvId: envIdWithoutWeb });
    expect(ctx.resolveWebOrigin()).toBeNull();
    expect(ctx.baseUrl).toBeNull();
  });
  it('默认端口省略:http:80 与 https:443 不带端口', async () => {
    const ctx = await resolveEnv({ caseEnvId: envId });
    const o = ctx.webServices.find((w) => w.name === 'plain')!;
    expect(o.origin).toBe('http://a.com');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/envContext.test.ts
```
预期:FAIL(webServices/resolveWebOrigin 不存在)。

- [ ] **Step 3: 实现**

`envContext.ts` 在 `DecryptError` 类后加:

```ts
export class WebServiceMissing extends Error {
  constructor(message: string) { super(message); this.name = 'WebServiceMissing'; }
}
```

`EnvCtx` interface(85-95)改为:

```ts
export interface WebServiceEntry {
  /** payload.name;null=未命名(仅默认服务,不可被用例引用) */
  name: string | null;
  label: string;
  origin: string;
  isDefault: boolean;
}

export interface EnvCtx {
  envId: string;
  envName: string;
  /** 全部 web 服务对象(environment_objects objectType='web')。 */
  webServices: WebServiceEntry[];
  /** ref 非空按 name 精确匹配(找不到抛 WebServiceMissing);空取 isDefault→最早。
   *  环境无任何 web 对象返回 null。 */
  resolveWebOrigin(ref?: string | null): string | null;
  /** 派生:默认 web 服务 origin(兼容旧消费点)。 */
  readonly baseUrl: string | null;
  db?: { host: string; port: number; database: string; user: string; password: string };
  pool?: QueryPool;
  syslog?: SyslogCtx;
  login?: LoginCtx;
  close(): Promise<void>;
}
```

payload 形状区(97-120)加:

```ts
interface WebPayload {
  name?: string | null;
  scheme?: string | null;
  host?: string | null;
  port?: number | null;
}
```

`resolveEnv` 返回对象(219-229)前构建、返回时携带:

```ts
  // resolveEnv 内、return 之前:
  const webServices: WebServiceEntry[] = objects
    .filter((o) => o.objectType === 'web')
    .map((o) => {
      const p = (o.payload ?? {}) as WebPayload;
      if (!p.host) return null;
      const scheme = p.scheme === 'https' ? 'https' : 'http';
      const port = p.port ?? (scheme === 'https' ? 443 : 80);
      const defaultPort = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
      return {
        name: typeof p.name === 'string' && p.name.length > 0 ? p.name : null,
        label: o.label,
        origin: `${scheme}://${p.host}${defaultPort ? '' : `:${port}`}`,
        isDefault: o.isDefault,
      };
    })
    .filter((w): w is WebServiceEntry => w !== null);
  const namedList = () => webServices.filter((w) => w.name).map((w) => w.name).join('、') || '(无命名服务)';
  const resolveWebOrigin = (ref?: string | null): string | null => {
    if (webServices.length === 0) return null;
    if (ref) {
      const hit = webServices.find((w) => w.name === ref);
      if (!hit) throw new WebServiceMissing(`环境「${env.name}」不存在 web 服务 ${ref},可用:${namedList()}`);
      return hit.origin;
    }
    return (webServices.find((w) => w.isDefault) ?? webServices[0]!).origin;
  };
```

return 对象改为(注意 getter):

```ts
  const ctx: EnvCtx = {
    envId,
    envName: env.name,
    webServices,
    resolveWebOrigin,
    db: dbCfg,
    pool,
    syslog: syslogCfg,
    login: loginCfg,
    async close() {
      if (pool) await pool.end();
    },
  };
  Object.defineProperty(ctx, 'baseUrl', { get: () => resolveWebOrigin() });
  return ctx;
```

TS 注意:`Object.defineProperty` + interface `readonly`——若类型报错,把 interface 中 `baseUrl` 声明为 `readonly baseUrl: string | null` 并用 `defineProperty` 是可行的;若仍报错,改用对象里 `get baseUrl() { return resolveWebOrigin(); }`(对象字面量 getter,TS 认可)——优先后者,更简单:

```ts
  return {
    envId, envName: env.name, webServices, resolveWebOrigin,
    get baseUrl() { return resolveWebOrigin(); },
    db: dbCfg, pool, syslog: syslogCfg, login: loginCfg,
    async close() { if (pool) await pool.end(); },
  } satisfies EnvCtx;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/envContext.test.ts && npx tsc --noEmit
```
预期:PASS(含既有 envContext 用例——baseUrl 语义现在来自 web 对象;若有旧用例直插 base_url 断言 baseUrl,更新该用例为插 web 对象)。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/envContext.ts apps/api/test/envContext.test.ts
git commit -m "feat(env): EnvCtx 暴露 webServices/resolveWebOrigin——baseUrl 派生为默认 web 服务 origin"
```

---

### Task 5: resolve-url 重写(相对拼接 + WebServiceMissing,删分组链)

**Files:**
- Rewrite: `apps/api/src/lib/resolve-url.ts`
- Test: `apps/api/test/resolve-url.test.ts`(重写用例)

- [ ] **Step 1: 重写测试**

`resolve-url.test.ts` 整体替换 describe 内容(保留 beforeAll/beforeEach 骨架与动态 import 方式;`resolveCaseUrl` 的动态解构再解构 `WebServiceMissing`):

```ts
describe('resolveCaseUrl 新解析链', () => {
  const webEnv = async (ref?: string) => {
    // 建默认环境 + 两个 web 对象
    const e = (await pool.query(
      `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1,'默认环境',true) RETURNING id`,
      [projectId])).rows[0]!;
    await pool.query(
      `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES
       ($1,'web','前端','{"name":"frontend","scheme":"http","host":"10.0.0.1","port":8080}',true),
       ($1,'web','后端','{"name":"backend","scheme":"https","host":"10.0.0.2"}',false)`,
      [e.id]);
    return {
      envName: '默认环境',
      webServices: [
        { name: 'frontend', label: '前端', origin: 'http://10.0.0.1:8080', isDefault: true },
        { name: 'backend', label: '后端', origin: 'https://10.0.0.2', isDefault: false },
      ],
      resolveWebOrigin: (r?: string | null) =>
        r === 'backend' ? 'https://10.0.0.2'
        : r ? (() => { throw new WebServiceMissing(`环境「默认环境」不存在 web 服务 ${r}`); })()
        : 'http://10.0.0.1:8080',
    };
  };

  it('绝对 url 直通(不读环境)', async () => {
    const url = await resolveCaseUrl({ url: 'https://case.test/x', groupId }, { envCtx: await webEnv() });
    expect(url).toBe('https://case.test/x');
  });
  it('相对 url 拼默认服务 origin', async () => {
    const url = await resolveCaseUrl({ url: '/admin/user?x=1', groupId }, { envCtx: await webEnv() });
    expect(url).toBe('http://10.0.0.1:8080/admin/user?x=1');
  });
  it('相对 url + webServiceRef 拼指定服务', async () => {
    const url = await resolveCaseUrl({ url: '/api', webServiceRef: 'backend', groupId }, { envCtx: await webEnv() });
    expect(url).toBe('https://10.0.0.2/api');
  });
  it('url 空取默认服务 origin(首页);无环境且不兜底返回 null', async () => {
    expect(await resolveCaseUrl({ url: null, groupId }, { envCtx: await webEnv() })).toBe('http://10.0.0.1:8080');
    expect(await resolveCaseUrl({ url: null, groupId })).toBeNull();
  });
  it('defaultEnvFallback:展示链用 case.defaultEnv/项目默认环境拼', async () => {
    await webEnv();
    const url = await resolveCaseUrl({ url: '/login', groupId }, { defaultEnvFallback: true });
    expect(url).toBe('http://10.0.0.1:8080/login');
  });
  it('环境无 web 服务 + 相对 url → WebServiceMissing', async () => {
    const e = (await pool.query(
      `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1,'空环境',true) RETURNING id`,
      [projectId])).rows[0]!;
    void e;
    await expect(resolveCaseUrl({ url: '/x', groupId }, { defaultEnvFallback: true }))
      .rejects.toThrow(WebServiceMissing.prototype.constructor);
  });
  it('ref 不存在 → WebServiceMissing(默认环境兜底链同样生效)', async () => {
    await webEnv();
    await expect(resolveCaseUrl({ url: '/x', webServiceRef: 'nope', groupId }, { defaultEnvFallback: true }))
      .rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/resolve-url.test.ts
```
预期:FAIL(旧签名无 envCtx/webServiceRef)。

- [ ] **Step 3: 重写 resolve-url.ts**

整文件替换:

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environmentObjects, testEnvironments } from '../db/schema.js';
import { WebServiceMissing, type WebServiceEntry } from '../execute/envContext.js';

/** URL 解析链(2026-10 相对化改造,spec 2026-10-16):
 *  case.url 绝对 → 直通;相对(/开头)→ 环境 web 服务 origin + path;空 → 默认服务 origin。
 *  执行链传 envCtx(已解析环境);录制/展示链 defaultEnvFallback=true,用 case.defaultEnv → 项目默认环境。
 *  分组 defaultUrl 与环境 baseUrl 已删(迁移 0040)。 */

export interface ResolveUrlEnv {
  envName: string;
  webServices: WebServiceEntry[];
  resolveWebOrigin(ref?: string | null): string | null;
}

function webEntriesOf(rows: Array<{ label: string; isDefault: boolean; payload: unknown }>, envName: string): WebServiceEntry[] {
  return rows
    .map((o) => {
      const p = (o.payload ?? {}) as { name?: unknown; scheme?: unknown; host?: unknown; port?: unknown };
      if (typeof p.host !== 'string' || p.host.length === 0) return null;
      const scheme = p.scheme === 'https' ? 'https' : 'http';
      const port = typeof p.port === 'number' ? p.port : (scheme === 'https' ? 443 : 80);
      const defaultPort = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
      void envName;
      return {
        name: typeof p.name === 'string' && p.name.length > 0 ? p.name : null,
        label: o.label,
        origin: `${scheme}://${p.host}${defaultPort ? '' : `:${port}`}`,
        isDefault: o.isDefault,
      };
    })
    .filter((w): w is WebServiceEntry => w !== null);
}

function resolverOf(entries: WebServiceEntry[], envName: string) {
  return (ref?: string | null): string | null => {
    if (entries.length === 0) return null;
    if (ref) {
      const hit = entries.find((w) => w.name === ref);
      if (!hit) {
        const list = entries.filter((w) => w.name).map((w) => w.name).join('、') || '(无命名服务)';
        throw new WebServiceMissing(`环境「${envName}」不存在 web 服务 ${ref},可用:${list}`);
      }
      return hit.origin;
    }
    return (entries.find((w) => w.isDefault) ?? entries[0]!).origin;
  };
}

/** 展示/录制链:case.defaultEnv → 项目默认环境(唯一环境兜底),构建 ResolveUrlEnv。 */
export async function displayWebEnv(caseRow: { defaultEnvId?: string | null; groupId: string }): Promise<ResolveUrlEnv | null> {
  const { groups } = await import('../db/schema.js');
  const g = (await db.select().from(groups).where(eq(groups.id, caseRow.groupId)))[0];
  if (!g) return null;
  let env = caseRow.defaultEnvId
    ? (await db.select().from(testEnvironments).where(eq(testEnvironments.id, caseRow.defaultEnvId)))[0]
    : undefined;
  if (!env) {
    env = (await db.select().from(testEnvironments)
      .where(and(eq(testEnvironments.projectId, g.projectId), eq(testEnvironments.isDefault, true))))[0];
  }
  if (!env) return null;
  const objs = await db.select().from(environmentObjects).where(eq(environmentObjects.environmentId, env.id));
  const entries = webEntriesOf(objs.filter((o) => o.objectType === 'web'), env.name);
  return { envName: env.name, webServices: entries, resolveWebOrigin: resolverOf(entries, env.name) };
}

/** 项目全部环境的 web origin → name 映射(录制 finish 相对化用)。 */
export async function projectWebOrigins(projectId: string): Promise<Map<string, string>> {
  const envs = await db.select({ id: testEnvironments.id }).from(testEnvironments).where(eq(testEnvironments.projectId, projectId));
  if (envs.length === 0) return new Map();
  const objs = await db.select().from(environmentObjects)
    .where(eq(environmentObjects.environmentId, envs[0]!.id));
  const rows = objs.length >= 0
    ? (await db.select().from(environmentObjects)).filter((o) => envs.some((e) => e.id === o.environmentId))
    : [];
  void rows;
  const all = await db.select().from(environmentObjects);
  const map = new Map<string, string>();
  for (const o of all) {
    if (o.objectType !== 'web' || !envs.some((e) => e.id === o.environmentId)) continue;
    const w = webEntriesOf([o], '');
    if (w[0] && !map.has(w[0].origin)) map.set(w[0].origin, w[0].name ?? 'web');
  }
  return map;
}

/** 绝对 URL → { path, ref } 命中项目任一 web origin;未命中返回 null(保留绝对)。 */
export function relativizeUrl(absolute: string, origins: Map<string, string>): { path: string; ref: string } | null {
  if (!/^https?:\/\//.test(absolute)) return null;
  try {
    const u = new URL(absolute);
    const origin = u.origin;
    if (!origins.has(origin)) return null;
    return { path: `${u.pathname}${u.search}${u.hash}`, ref: origins.get(origin)! };
  } catch {
    return null;
  }
}

export async function projectWebOrigins(projectId: string): Promise<Map<string, string>> {
  const envs = await db.select({ id: testEnvironments.id }).from(testEnvironments).where(eq(testEnvironments.projectId, projectId));
  const map = new Map<string, string>();
  if (envs.length === 0) return map;
  const objs = await db.select().from(environmentObjects)
    .where(inArray(environmentObjects.environmentId, envs.map((e) => e.id)));
  for (const o of objs) {
    if (o.objectType !== 'web') continue;
    const w = webEntriesOf([o], '')[0];
    if (w && !map.has(w.origin)) map.set(w.origin, w.name ?? 'web');
  }
  return map;
}

export async function resolveCaseUrl(
  caseRow: { url: string | null; webServiceRef?: string | null; groupId: string; defaultEnvId?: string | null },
  o: { envCtx?: ResolveUrlEnv; defaultEnvFallback?: boolean } = {},
): Promise<string | null> {
  if (caseRow.url && /^https?:\/\//.test(caseRow.url)) return caseRow.url;
  const env = o.envCtx ?? (o.defaultEnvFallback ? await displayWebEnv(caseRow) : undefined);
  if (!env) return null;
  // resolveWebOrigin 对坏 ref 抛 WebServiceMissing(带可用清单);环境无 web 对象返回 null。
  const origin = env.resolveWebOrigin(caseRow.webServiceRef ?? null);
  if (!origin) {
    if (caseRow.url) throw new WebServiceMissing(`环境「${env.envName}」未配置 web 服务,请到项目环境页添加`);
    return null; // 空 url + 无服务:维持 about:blank 开始的现状
  }
  return caseRow.url ? `${origin}${caseRow.url}` : origin;
}
```

(import 里补 `inArray`。)

- [ ] **Step 4: 跑测试确认通过(含编译缺口检查)**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/resolve-url.test.ts && npx tsc --noEmit 2>&1 | head -30
```
预期:测试 PASS。`tsc --noEmit` 此时会报**调用方签名错误**(runCase/loginPrepare/recorder/cases.service 还传旧参数 `{ envBaseUrl }` / `{ defaultEnvFallback }`)——这是预期中间态,后续 Task 6/8/9/10 逐个修复;**本 task 只保证 resolve-url 自身测试绿**(tsc 检查放到 Task 10 完成后归零)。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/resolve-url.ts apps/api/test/resolve-url.test.ts
git commit -m "feat(url): resolveCaseUrl 重写——相对 url 拼环境 web 服务 origin,删分组链"
```

---

### Task 6: runCase 集成(WebServiceMissing 报告 / web_ 注入 / caseWebOrigin)

**Files:**
- Modify: `apps/api/src/execute/runCase.ts:202-320`
- Modify: `apps/api/src/execute/cdp.ts`(ExecContext 类型加 caseWebOrigin)
- Test: `apps/api/test/execute-cdp.test.ts`(追加)

- [ ] **Step 1: 写失败测试**

`execute-cdp.test.ts` 追加(复用现有 seed 结构;参考文件内现有"建环境/跑 case"的 helper):

```ts
describe('相对 url 执行', () => {
  it('相对 url + 环境 web 对象 → goto 拼接地址', async () => {
    // 建默认环境 + web 对象 http://10.0.0.1:8080;case.url='/login'
    // 跑 runCase(或文件内现有的执行 helper),断言报告 passed 且 preflight.currentOrigin==='http://10.0.0.1:8080'
  });
  it('环境无 web 对象 + 相对 url → WebServiceMissing 失败报告', async () => {
    // case.url='/login',环境无 web 对象
    // 断言报告 status='failed',stepResults[0].failureReason==='WebServiceMissing'
  });
});
```

(实现者注:`execute-cdp.test.ts` 已有大量"建 case → 跑执行 → 断言报告"的现成模式,照抄最近的用例骨架,把上面两条语义落成具体代码;断言 `failureReason` 与 `humanMessage` 含"web 服务"。)

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/execute-cdp.test.ts
```
预期:新用例 FAIL(相对 url 被 `/^https?:\/\//` 过滤为 undefined → about:blank / 或 navigation 报错)。

- [ ] **Step 3: 实现 runCase.ts**

3a. `runCase.ts:245-249` 替换为(envCtx 解析 try 块之后):

```ts
  // 初始导航:绝对 url 直通;相对 url 由环境 web 服务拼 origin(spec 2026-10-16)。
  // WebServiceMissing 与 EnvMissing 同呈现:单步失败报告。
  let resolved: string | null = null;
  let caseWebOrigin: string | null = null;
  try {
    resolved = envCtx
      ? await resolveCaseUrl(caseRow, { envCtx })
      : await resolveCaseUrl(caseRow, { defaultEnvFallback: true });
    caseWebOrigin = envCtx ? envCtx.resolveWebOrigin(caseRow.webServiceRef ?? null) : null;
  } catch (e) {
    if (e instanceof WebServiceMissing) {
      const stepResults: ExecStepResult[] = [{
        order: 1, status: 'failed', durationMs: 0,
        error: e.message, failureReason: 'WebServiceMissing', humanMessage: e.message,
      }];
      await db.update(reports)
        .set({ status: 'failed', durationMs: 0, stepResults: stepResults as object, summary: e.message })
        .where(eq(reports.id, reportId));
      if (envCtx) envCtx.close().catch(() => undefined);
      return { reportId, status: 'failed' };
    }
    throw e;
  }
  const targetUrl = resolved && /^https?:\/\//.test(resolved) ? resolved : undefined;
```

(envCtx 为 undefined 的情况:resolveEnv 抛 EnvMissing 已在前面处理,实际到不了这里——保守起见保留分支;`envCtx` resolveWebOrigin 抛 WebServiceMissing 同样被捕获。)

3b. import 行补:`import { WebServiceMissing } from './envContext.js';`(与现有 `resolveEnv` 动态 import 同文件,可静态补)。

3c. web 变量注入:`execCtx` 组装处(约 290-303),`initialVars` 改造:

```ts
  // web_<name> 系统变量:环境 web 服务 origin(覆盖同名数据集变量;web_ 为保留前缀)
  const webVars: Record<string, string> = {};
  for (const w of envCtx?.webServices ?? []) {
    if (w.name) webVars[`web_${w.name}`] = w.origin;
  }
  const initialVars = rowPlan ? { ...rowPlan.vars, ...webVars } : (Object.keys(webVars).length ? webVars : undefined);
```

`execCtx` 里 `...(rowPlan ? { initialVars: rowPlan.vars, ... } : {})` 改为 `...(initialVars ? { initialVars } : {})`;mobile `engineInput` 同样替换(约 325)。

3d. `execCtx` 加字段:

```ts
      ...(caseWebOrigin ? { caseWebOrigin } : {}),
```

3e. `cdp.ts` 的 `ExecContext` interface(定义处,约 line 20-40 区域,搜 `caseUrl: string | null`)加:

```ts
  /** 用例绑定 web 服务的 origin:中途 navigate 相对 url 拼接用;无环境 web 服务时缺省。 */
  caseWebOrigin?: string | null;
```

`webEngine.ts:28`、`mobileEngine.ts:117`、`visionAssert.ts:71`、`cdp.ts:1079` 处把 `caseUrl` 透传的同一对象里补 `caseWebOrigin: input.caseWebOrigin`(搜 `caseUrl:` 逐处对照;engine input 接口同步加可选字段)。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/execute-cdp.test.ts
```
预期:PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/runCase.ts apps/api/src/execute/cdp.ts apps/api/src/execute/webEngine.ts apps/api/src/execute/mobileEngine.ts apps/api/src/execute/visionAssert.ts apps/api/test/execute-cdp.test.ts
git commit -m "feat(execute): 相对 url 执行——WebServiceMissing 失败报告 + web_<name> 变量注入 + caseWebOrigin"
```

---

### Task 7: cdp navigate 相对拼接

**Files:**
- Modify: `apps/api/src/execute/cdp.ts:287-294`
- Test: `apps/api/test/execute-cdp.test.ts`(追加)

- [ ] **Step 1: 写失败测试**

`execute-cdp.test.ts` 追加一条:case 带 navigate 步骤(url=`/second/page`),环境默认 web 对象 `http://10.0.0.1:8080`,断言执行后页面 URL 为 `http://10.0.0.1:8080/second/page`(用现有断言页面/报告的 helper 形态;外站绝对 navigate 的既有用例应继续通过)。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/execute-cdp.test.ts
```
预期:新用例 FAIL(goto '/second/page' 非法 URL)。

- [ ] **Step 3: 实现**

`cdp.ts:287-294` navigate case 替换:

```ts
    case 'navigate': {
      const { value, missing } = substituteVars(action.url, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.url}")`);
      // 相对 url(/开头)拼用例绑定 web 服务 origin;绝对直通;其余形态报错(spec 2026-10-16)。
      const target = value.startsWith('/')
        ? `${ctx.caseWebOrigin ?? ''}${value}`
        : value;
      if (!/^https?:\/\//.test(target)) {
        throw new Error(`invalid-navigate-url: ${target}${value.startsWith('/') ? '(环境未配置 web 服务,无法拼接相对地址)' : ''}`);
      }
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      return;
    }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/execute-cdp.test.ts
```
预期:PASS(含 Task 1 放行的 `{{web_x}}/path` 形态:替换后绝对直通)。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/cdp.ts apps/api/test/execute-cdp.test.ts
git commit -m "feat(execute): navigate 支持相对 url——拼 caseWebOrigin,变量替换后绝对直通"
```

---

### Task 8: loginPrepare loginUrl 相对化

**Files:**
- Modify: `apps/api/src/execute/loginPrepare.ts:35-41,85-95,154-170`

- [ ] **Step 1: 实现(本 task 逻辑薄,既有测试文件覆盖 detectionUrl 链)**

8a. `resolveDetectionUrl`(35-41)保持调用新签名(自动适配):`return resolveCaseUrl(row, { defaultEnvFallback: true });`——row 需带 `webServiceRef`:查询列加 `webServiceRef: testCases.webServiceRef`。

8b. `loginPrepare` opts 加参数:

```ts
    /** 环境默认 web 服务 origin:loginUrl 为相对路径时拼接用。 */
    defaultWebOrigin?: string | null;
```

8c. `autoFillLogin` 的 goto(93-94)替换:

```ts
    if (cred.loginUrl && !URL_LOGIN_HINTS.test(page.url())) {
      const loginTarget = cred.loginUrl.startsWith('/')
        ? `${opts.defaultWebOrigin ?? ''}${cred.loginUrl}`
        : cred.loginUrl;
      if (!/^https?:\/\//.test(loginTarget)) {
        return { status: 'failed', reason: 'auto login: loginUrl is relative but no default web origin' };
      }
      await page.goto(loginTarget, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
```

(autoFillLogin 需要拿到 defaultWebOrigin——把 loginPrepare 的 opts.defaultWebOrigin 作为参数传入 autoFillLogin,或合并进 cfg;选参数传入,函数签名加 `defaultWebOrigin: string | null`。)

8d. 调用方传参:搜 `loginPrepare(` 的调用点(执行计划链路,`runPlan` 相关文件),在 `autoLogin: envCtx.login` 附近补 `defaultWebOrigin: envCtx.resolveWebOrigin()`(envCtx 存在时;不存在传 undefined)。

- [ ] **Step 2: 跑既有 login 测试**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/login-prepare.test.ts 2>/dev/null || TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test -t loginPrepare
```
预期:PASS(detectionUrl 绝对值行为不变;若存在 loginUrl 相对的新行为用例需求,补一条:defaultWebOrigin 传入时 goto 拼接地址——参考文件内既有 autoLogin 用例改 url 为 `/login.html` 并断言无异常即可)。

- [ ] **Step 3: typecheck**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | head -20
```
预期:loginPrepare 相关无新错误(resolve-url 旧调用点此时应已全部适配;若 recorder/cases.service 仍报错属 Task 9/10 范围)。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/execute/loginPrepare.ts
git commit -m "feat(login): loginUrl 支持相对路径——拼环境默认 web 服务 origin"
```

---

### Task 9: recorder finish 相对化

**Files:**
- Modify: `apps/api/src/routes/recorder.ts:117-174`
- Test: `apps/api/test/` 下 recorder finish 相关测试文件(搜 `finish` 定位;若无独立文件,在 `cases.service.test.ts` 附近新建 `recorder-relativize.test.ts` 直接单测 `relativizeUrl`+落库行为)

- [ ] **Step 1: 写失败测试**

新建 `apps/api/test/recorder-relativize.test.ts`(testcontainer 骨架抄 resolve-url.test.ts;直接构造 POST /sessions/:id/finish 不可行——session 在内存,改为单测落库 helper)。本 task 先在 recorder.ts 导出纯函数再测(Step 3 实现);测试:

```ts
import { describe, it, expect } from 'vitest';

describe('relativizeUrl(纯函数,来自 resolve-url)', () => {
  // (由 Task 5 的 resolve-url.ts 导出,这里单测映射行为)
  it('命中 origin 剥离 path 并返回 ref', async () => {
    const { relativizeUrl } = await import('../src/lib/resolve-url.js');
    const m = new Map([['http://a.com:8080', 'frontend']]);
    expect(relativizeUrl('http://a.com:8080/admin/x?y=1#z', m)).toEqual({ path: '/admin/x?y=1#z', ref: 'frontend' });
    expect(relativizeUrl('http://a.com:8080', m)).toEqual({ path: '', ref: 'frontend' });
  });
  it('未命中/非绝对返回 null', async () => {
    const { relativizeUrl } = await import('../src/lib/resolve-url.js');
    const m = new Map([['http://a.com', 'web']]);
    expect(relativizeUrl('https://other.com/x', m)).toBeNull();
    expect(relativizeUrl('/already/rel', m)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认通过(Task 5 已实现 relativizeUrl,此为回归锚点)**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/recorder-relativize.test.ts
```
预期:PASS(若 FAIL 说明 Task 5 实现偏差,先修)。

- [ ] **Step 3: 实现 recorder finish**

`recorder.ts:125-136` 替换:

```ts
  // 初始导航落库:尽力相对化(spec 2026-10-16)。origin 命中项目任一环境 web 服务 → 存相对+绑定;
  // 未命中(外站)保留绝对;已有 case.url 不覆盖。来源:targetUrl > 首步 URL > 解析链兜底。
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, session.caseId)))[0];
  const origins = caseRow
    ? await projectWebOrigins((await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, caseRow.groupId)))[0]!.projectId)
    : new Map<string, string>();
  if (caseRow && !caseRow.url) {
    const firstStepUrl = (session.steps[0] as { url?: string | null } | undefined)?.url ?? null;
    const candidate = session.targetUrl ?? firstStepUrl ?? (await resolveCaseUrl(caseRow, { defaultEnvFallback: true }));
    if (candidate && /^https?:\/\//.test(candidate)) {
      const rel = relativizeUrl(candidate, origins);
      await db.update(testCases).set({
        url: rel ? (rel.path || null) : candidate,
        ...(rel ? { webServiceRef: rel.ref } : {}),
        updatedAt: new Date(),
      }).where(eq(testCases.id, session.caseId));
    }
  }
```

中途 navigate 剥离:`for (const step of mergedSteps)` 循环里,`StepAction.parse(item.action)` 之后、insert 之前加:

```ts
    if (action.kind === 'navigate' && typeof action.url === 'string') {
      const rel = relativizeUrl(action.url, origins);
      if (rel) action.url = rel.path || '/';
    }
```

import 行补:`import { projectWebOrigins, relativizeUrl } from '../lib/resolve-url.js';`(resolveCaseUrl 已 import)与 `groups` schema import。

- [ ] **Step 4: 跑测试 + typecheck**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/recorder-relativize.test.ts && npx tsc --noEmit 2>&1 | head -20
```
预期:PASS;recorder 无类型错。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/recorder.ts apps/api/test/recorder-relativize.test.ts
git commit -m "feat(recorder): finish 落库尽力相对化——初始导航与中途 navigate 命中环境 origin 即剥离"
```

---

### Task 10: cases API 透传 webServiceRef + resolvedUrl 展示链

**Files:**
- Modify: `apps/api/src/routes/cases.ts:20,51`(zod)
- Modify: `apps/api/src/services/cases.service.ts:75,167,296,306`
- Test: `apps/api/test/cases.service.test.ts`(追加)

- [ ] **Step 1: 写失败测试**

`cases.service.test.ts` 追加:

```ts
it('webServiceRef 随 create/patch 透传;resolvedUrl 相对拼接展示', async () => {
  // 建默认环境 + web 对象(origin http://10.0.0.1:8080,name=frontend,isDefault)
  const c = await createCase(projectId, versionId, { groupId, title: 't', url: '/login', webServiceRef: 'frontend' });
  expect(c.webServiceRef).toBe('frontend');
  const detail = await getCase(c.id); // 或对应查询函数
  expect(detail.resolvedUrl).toBe('http://10.0.0.1:8080/login');
});
```

(按文件内现有 create/getCase helper 实名调整。)

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/cases.service.test.ts
```
预期:FAIL(无 webServiceRef 字段)。

- [ ] **Step 3: 实现**

- `routes/cases.ts`:create body zod(约 :20)与 patch body(约 :51)加 `webServiceRef: z.string().max(64).nullable().optional(),`。
- `cases.service.ts`:create 输入类型(:75)与 patch 类型(:167)加 `webServiceRef?: string | null`;insert/update 的 values 里透传(照 `url` 字段的既有写法)。
- `cases.service.ts:296`:`const resolvedUrl = await resolveCaseUrl(row, { defaultEnvFallback: true });`——row 需含 `webServiceRef/defaultEnvId`(select 列表补 `webServiceRef: testCases.webServiceRef`);返回对象加 `webServiceRef: row.webServiceRef ?? null`。
- `searchCasesInVersion`(:306)同 select 补列。

- [ ] **Step 4: 跑测试 + 全量 tsc 归零检查**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/cases.service.test.ts && npx tsc --noEmit 2>&1 | head -20
```
预期:PASS;`tsc --noEmit` 此时应接近归零(剩余只可能是 pi/space 工具与 web 端,分别归 Task 11/12)。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/cases.ts apps/api/src/services/cases.service.ts apps/api/test/cases.service.test.ts
git commit -m "feat(cases): webServiceRef 透传 + resolvedUrl 相对拼接展示"
```

---

### Task 11: AI 工具链适配

**Files:**
- Modify: `apps/api/src/pi/space/tools/environments.ts`(:21,:44,:95-97,:118)
- Modify: `apps/api/src/pi/space/tools/stage-tools.ts:464-466`
- Modify: `apps/api/src/pi/space/stageRoute.ts:152-158`
- Modify: `apps/api/src/pi/space/tools/case-ops-tools.ts:100`
- Modify: `apps/api/src/pi/space/tools/login.ts:81-83`
- Modify: `apps/api/src/pi/space/summary.ts:38-45`
- Test: `apps/api/test/space-tools-environments.test.ts`、`apps/api/test/pi-solidify-case.test.ts`(追加/回归)

- [ ] **Step 1: environments 工具支持 web 对象**

读 `pi/space/tools/environments.ts`,找到 objectType 描述/枚举(约 :21 与 :44)加 `'web'`,并在工具 description 里补一段:

```
web 对象 payload:{"name":"backend"(可选,英文标识,用例可绑定)","scheme":"http|https","host":"1.2.3.4","port":8080(可选)}。
一个环境可有多个 web 服务(如前端+后端在不同主机),其中至多一个 isDefault。
```

测试(`space-tools-environments.test.ts` 追加):

```ts
it('可通过工具创建 web 对象', async () => {
  const r = await callTool('insert_env_object', { /* 按文件内现有调用形态 */ }, { objectType: 'web', payload: { name: 'backend', scheme: 'http', host: '10.0.0.2', port: 8081 } });
  // 断言落库行 objectType='web' 且 payload.name='backend'
});
```

(按文件内现有工具调用 helper 实名改写;核心断言:DB 行存在。)

- [ ] **Step 2: stage-tools 约束文案(:464-466)**

读上下文后把"navigate 的 url 必须是绝对 URL"一类表述替换为:

```
navigate 的 url 优先写相对路径(以 / 开头,执行时自动拼接用例绑定的 web 服务);
跳转到同环境另一个 web 服务时写 {{web_<name>}}/path(如 {{web_backend}}/api/swagger);
仅外部站点才写绝对 URL。case.url 同理只存相对路径。
```

(464 行原文以文件实际为准,保留其余约束。)

- [ ] **Step 3: stageRoute 落库 baseUrl → 默认 web 对象**

读 `stageRoute.ts:152-158`(staged 环境落库处):在 `testEnvironments` insert 之后、返回之前加:

```ts
      if (staged.baseUrl && /^https?:\/\//.test(staged.baseUrl)) {
        try {
          const u = new URL(staged.baseUrl);
          await insertEnvironmentObject(insertedEnvId, {
            objectType: 'web',
            label: '默认 Web',
            payload: {
              name: 'web',
              scheme: u.protocol === 'https:' ? 'https' : 'http',
              host: u.hostname,
              ...(u.port ? { port: Number(u.port) } : {}),
            },
            isDefault: true,
          });
        } catch { /* 尽力而为:解析失败跳过,不阻塞 save */ }
      }
```

(insertEnvironmentObject 从 environments.service.js import;变量名按实际上下文改名。)

- [ ] **Step 4: case-ops 文案与 login 兜底**

- `case-ops-tools.ts:100`:把"case 的「初始化导航 URL」(case.url)回放开始时已由系统执行…"整段更新为相对语义:`case.url 只存相对路径(如 /admin/login),执行时由环境 web 服务拼接;update_case 的 patch.url 传相对;patch.webServiceRef 可指定环境内 web 服务标识(缺省用默认)。`
- `login.ts:81-83`:`envCtx.baseUrl` 兜底逻辑保持(baseUrl 已是派生 getter,无需改;确认 `targetUrl = url || envCtx.login.loginUrl || envCtx.baseUrl` 中 loginUrl 若为相对需拼——改为 `url || (envCtx.login?.loginUrl?.startsWith('/') ? `${envCtx.baseUrl ?? ''}${envCtx.login.loginUrl}` : envCtx.login?.loginUrl) || envCtx.baseUrl || ''`,并保留 :83 的缺 URL 报错)。

- [ ] **Step 5: summary 环境摘要列 web 服务**

`summary.ts:38-45` 环境信息段加一行(按实际拼装方式):

```ts
  ...(env.webServices?.length ? [`web 服务:${env.webServices.map((w) => `${w.name ?? '(默认)'}=${w.origin}`).join(', ')}`] : []),
```

(env 类型来自 EnvCtx;若 summary 只读 baseUrl,改为读 webServices。)

- [ ] **Step 6: 跑 AI 工具测试 + 回归**

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/space-tools-environments.test.ts test/pi-solidify-case.test.ts test/pi-verify-case.test.ts
```
预期:PASS。若有用例断言旧文案/旧 baseUrl 行为,按新语义更新断言(不允许跳过)。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/pi
git commit -m "feat(pi): AI 工具链适配——web 对象创建/staged baseUrl 落库转 web/相对 url 约束文案"
```

---

### Task 12: web UI(client 类型 / 环境页 / 用例页 / 分组页)

**Files:**
- Modify: `apps/web/src/api/client.ts:85,97,632-634,678`
- Modify: `apps/web/src/pages/EnvironmentsPage.tsx`
- Modify: `apps/web/src/pages/CaseDetail.tsx:812-826,1396-1429`
- Modify: `apps/web/src/pages/GroupsPage.tsx:63-64,563,601,610,734-735`

- [ ] **Step 1: client.ts 类型**

- Group 接口(:85 附近)删 `defaultUrl` 字段。
- Environment 接口(:632 附近)删 `baseUrl`;`EnvironmentObject` 不变(payload 动态)。
- environments.create/update 参数(:632-634)删 baseUrl;对象创建参数 objectType 类型改 `'db' | 'syslog' | 'login' | 'web'`(:678 附近)。
- Case 类型加 `webServiceRef?: string | null`;cases.patch 参数加 `webServiceRef?: string | null`。

- [ ] **Step 2: EnvironmentsPage——web 对象表单**

- `EnvFormState`(:22-29)删 `baseUrl` 字段;新建环境按钮(:254)与 saveEnv mutation(:135-141)去掉 baseUrl;环境卡片 header 的 `env.baseUrl` 展示块(:290-294)删除。
- `ObjType`(:31)改 `type ObjType = 'db' | 'syslog' | 'login' | 'web';`
- `ObjFormState`(:32-50)加字段 `webName: string; webScheme: 'http' | 'https';`(host/port 复用现有 host/port);EMPTY_OBJ_FORM 补 `webName: '', webScheme: 'http',`。
- `buildObjectPayload`(:85-97)加分支:

```ts
  if (f.objectType === 'web') {
    return {
      ...(f.webName.trim() ? { name: f.webName.trim() } : {}),
      scheme: f.webScheme,
      host: f.host.trim(),
      ...(f.port.trim() ? { port: Number(f.port) } : {}),
    };
  }
```

- `objectSummary`(:99-108)加分支:`if (o.objectType === 'web') { return [p.scheme, p.host, p.port != null ? String(p.port) : null].filter(Boolean).join('://'); }`(注意 scheme 与 host 之间是 `://`,用 `[`${p.scheme}://${p.host}`, p.port].filter(Boolean).join(':')`)。
- `openObjForm`(:219-240)补 `webName: String(p.name ?? ''), webScheme: p.scheme === 'https' ? 'https' : 'http',`。
- 对象表单 JSX(搜 `objForm.open` 的 Dialog):objectType==='web' 时渲染——name 输入(placeholder "如 backend,可留空")+ scheme 下拉(http/https)+ host + port(复用现有输入框样式);「测试连接」按钮对 web 类型隐藏(testConn mutation :210-217 加 `if (objForm.objectType === 'web') return;` 之类守卫或按钮条件渲染)。
- 对象卡片区的"添加对象"按钮组(搜 db/syslog/login 三个入口,约 :396 附近)加第四个「Web 服务」按钮(globe 图标,若无 globe 用 'link')。

- [ ] **Step 3: CaseDetail——相对 URL + 服务下拉**

- "初始化导航 URL"块(:803-826):展示改为 `caseDetail.url ? (caseDetail.url.startsWith('/') ? '相对 ' + url : url) : '未配置'` + resolvedUrl 原样展示;按钮文案统一「编辑」。
- URL 弹窗(:1396-1429)改造:

```tsx
      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        {/* 标题/结构照旧;urlDraft 改相对输入,新增 webRefDraft */}
        <Input
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          placeholder="/admin/login(相对路径,执行时拼环境 web 服务)"
        />
        <select
          value={webRefDraft}
          onChange={(e) => setWebRefDraft(e.target.value)}
          className="..." /* 复用页面现有 select 样式 */
        >
          <option value="">默认 web 服务</option>
          {webOptions.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
```

- `webOptions` 来源:页面加载 `api.environments.list(projectId)`,取「caseDetail.defaultEnvId 对应环境 ?? 项目 isDefault 环境」的 objects 里 objectType==='web' 的 `payload.name`(非空者);存 state。
- 保存(:1419)改为:

```tsx
                  .patch(id!, {
                    url: urlDraft.trim() ? urlDraft.trim() : null,
                    webServiceRef: webRefDraft || null,
                  })
```

弹窗打开时 `setWebRefDraft(caseDetail.webServiceRef ?? '')`。
- 旧值是绝对 URL 的用例:urlDraft 初始化为原值,占位提示"建议改为相对路径(以 / 开头)";不做强制转换。

- [ ] **Step 4: GroupsPage——删 URL**

- 删 defaultUrl 相关 state(:63-64)、表单字段(:734-735)、列表展示(:601)、新建用例对话框 URL 预填(:563 与 :610 附近,新建用例不再有 URL 输入)。
- `api.groups.create/update` 调用点去 defaultUrl 参数(client.ts 已删类型,TS 会指出所有残留点,逐个清理)。

- [ ] **Step 5: 构建与类型验证**

```bash
cd apps/web && npx tsc --noEmit && npm run build 2>&1 | tail -5
```
预期:无类型错误,build 成功(client.ts 删字段后所有引用点均已清理)。

- [ ] **Step 6: 手工冒烟(有 dev 环境时)**

```bash
# 终端1(带必需环境变量,见记忆 project_dev_env_required_vars):
cd apps/api && ENCRYPTION_KEY=xxx CHROMIUM_PATH=xxx npm run dev
# 终端2:
cd apps/web && npm run dev
```
浏览器验证:环境页建 web 对象(name=frontend)→ 用例页设相对 URL `/login` + 选 frontend → 详情显示拼接绝对地址;分组页无 URL 字段。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 环境页 web 服务对象 + 用例相对 URL/服务下拉 + 分组页去 URL"
```

---

### Task 13: 迁移 0040(数据搬迁 + 删列)+ baseUrl 代码清理

**Files:**
- Modify: `apps/api/src/db/schema.ts`(删 groups.defaultUrl :390、testEnvironments.baseUrl :570)
- Modify: `apps/api/src/services/environments.service.ts`(create/update 去 baseUrl)
- Modify: `apps/api/src/routes/environments.ts`(CreateBody/EnvPatchBody 去 baseUrl)
- Create: `apps/api/drizzle/0040_*.sql`(generate + 手写搬迁段)
- Modify: `apps/api/test/helpers/db.ts`(SCHEMA_SQL 同步删列)

- [ ] **Step 1: schema/service/routes 删 baseUrl**

- schema.ts:删 `defaultUrl: text('default_url'),`(:390)与 baseUrl 行(:569-570 注释+字段)。
- environments.service.ts:`createEnvironment` 输入(:93)与 insert values(:97)去 baseUrl;`updateEnvironment`(:114,:123)去 baseUrl。
- routes/environments.ts:CreateBody(:35)与 EnvPatchBody(:49)删 baseUrl 字段。
- `npx tsc --noEmit` 列出残留引用(可能含 pi 工具 environments.ts 读 env.baseUrl 的展示处),逐个改为读 webServices 或删除。

- [ ] **Step 2: 生成迁移并手写搬迁段**

```bash
cd apps/api && npm run db:generate
```
生成的 0040 sql 只含两条 `ALTER TABLE ... DROP COLUMN`。**手动编辑该文件**,在 DROP 语句**之前**插入:

```sql
-- >>> 数据搬迁(尽力语义;未命中者保留绝对 URL,运行时直通兼容) >>>
-- 0. 临时表:项目 → web origin/name(来自步骤 1 插入的对象)
CREATE TABLE "_mig_web_origins" ("project_id" uuid, "origin" text, "name" text);

-- 1. 每环境插默认 web 对象:base_url 优先,空则取 login 对象 loginUrl 的 origin
INSERT INTO "environment_objects" ("environment_id", "object_type", "label", "payload", "is_default")
SELECT e.id, 'web', '默认 Web',
  jsonb_build_object(
    'name', 'web',
    'scheme', CASE WHEN substring(u from '^https') = 'https' THEN 'https' ELSE 'http' END,
    'host', (regexp_match(u, '^https?://([^:/]+)'))[1],
    'port', NULLIF((regexp_match(u, '^https?://[^:/]+:(\d+)'))[1], '')::int
  ), true
FROM "test_environments" e
CROSS JOIN LATERAL (
  SELECT COALESCE(
    e.base_url,
    (SELECT (lo.payload->>'loginUrl') FROM environment_objects lo
      WHERE lo.environment_id = e.id AND lo.object_type = 'login'
        AND lo.payload->>'loginUrl' ~ '^https?://' LIMIT 1)
  ) AS u
) src
CROSS JOIN LATERAL (SELECT src.u AS u) uu
WHERE uu.u ~ '^https?://'
  AND NOT EXISTS (SELECT 1 FROM environment_objects o
    WHERE o.environment_id = e.id AND o.object_type = 'web');

INSERT INTO "_mig_web_origins" ("project_id", "origin", "name")
SELECT DISTINCT e.project_id,
  (ob.payload->>'scheme') || '://' || (ob.payload->>'host')
    || CASE WHEN ob.payload->>'port' IS NULL THEN '' ELSE ':' || (ob.payload->>'port') END,
  COALESCE(NULLIF(ob.payload->>'name', ''), 'web')
FROM environment_objects ob
JOIN test_environments e ON e.id = ob.environment_id
WHERE ob.object_type = 'web' AND ob.payload->>'host' IS NOT NULL;

-- 2. case.url 尽力剥离(命中项目任一 web origin)
UPDATE test_cases tc SET
  url = NULLIF(regexp_replace(tc.url, '^https?://[^/]+', ''), ''),
  web_service_ref = wo.name
FROM "groups" g, _mig_web_origins wo
WHERE g.id = tc.group_id AND wo.project_id = g.project_id
  AND tc.url ~ '^https?://[^/]+'
  AND (tc.url = wo.origin OR tc.url LIKE wo.origin || '/%');

-- 3. 步骤内 navigate 尽力剥离
UPDATE test_steps ts SET compiled = (
  SELECT jsonb_agg(
    CASE WHEN el->>'kind' = 'navigate' AND (el->>'url') ~ '^https?://[^/]+'
              AND EXISTS (
                SELECT 1 FROM test_cases tc2
                JOIN "groups" g2 ON g2.id = tc2.group_id
                JOIN _mig_web_origins wo ON wo.project_id = g2.project_id
                WHERE tc2.id = ts.case_id
                  AND (el->>'url' = wo.origin OR el->>'url' LIKE wo.origin || '/%')
              )
         THEN jsonb_set(el, '{url}', to_jsonb(NULLIF(regexp_replace(el->>'url', '^https?://[^/]+', ''), '')))
         ELSE el END
    ORDER BY ord)
  FROM jsonb_array_elements(ts.compiled) WITH ORDINALITY AS t(el, ord)
)
WHERE ts.compiled IS NOT NULL AND jsonb_typeof(ts.compiled) = 'array';

DROP TABLE "_mig_web_origins";
-- <<< 数据搬迁结束(以下为 generate 产出的 DROP COLUMN) <<<

ALTER TABLE "groups" DROP COLUMN IF EXISTS "default_url";
ALTER TABLE "test_environments" DROP COLUMN IF EXISTS "base_url";
```

(generate 产出的 DROP 语句保留在文件末尾,与上面手写的 `IF EXISTS` 版本重复时删掉手写版、保留 generate 版即可——两列的 DROP 只能出现一次。)

- [ ] **Step 3: 同步 SCHEMA_SQL**

`test/helpers/db.ts`:groups CREATE TABLE(:15)删 `default_url text,`;test_environments(:43)删 `base_url text,`。

- [ ] **Step 4: 修复受影响测试 + 全量回归**

旧用例里直插 `base_url`/`default_url` 的 SQL(envContext.test.ts、resolve-url 旧断言、cases.service.test.ts:117 等)全部改为插 web 对象:

```sql
INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default)
VALUES ($1, 'web', '默认 Web', '{"name":"web","scheme":"https","host":"env.test"}', true);
```

```bash
cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run 2>&1 | tail -15
```
预期:全部 PASS。

- [ ] **Step 5: 迁移演练(手工,本地 pg 容器)**

```bash
docker run -d --name mig-rehearsal -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
# 取"旧 schema"(含 base_url/default_url 两列、已含 web_service_ref):打开 Task 12 完成时点的
# apps/api/test/helpers/db.ts,复制 SCHEMA_SQL 反引号内的全部 SQL 存到 /tmp/old_schema.sql
# (不要用 sed 提取——反引号会被 shell 当命令替换)。
docker exec -i mig-rehearsal psql -U postgres -c "CREATE DATABASE mig;"
docker exec -i mig-rehearsal psql -U postgres -d mig < /tmp/old_schema.sql
docker exec -i mig-rehearsal psql -U postgres -d mig <<'SQL'
-- fixture:环境 base_url + login 兜底 + 绝对 case + navigate 步骤 + 外站 case
INSERT INTO test_environments(project_id,name,is_default,base_url) SELECT id,'E1',true,'http://10.0.0.1:8080' FROM projects LIMIT 1;
INSERT INTO test_cases(group_id,version_id,url,title) SELECT (SELECT id FROM "groups" LIMIT 1),(SELECT id FROM project_versions LIMIT 1),'http://10.0.0.1:8080/admin/x','内站';
INSERT INTO test_cases(group_id,version_id,url,title) SELECT (SELECT id FROM "groups" LIMIT 1),(SELECT id FROM project_versions LIMIT 1),'https://外站.com/x','外站';
SQL
DATABASE_URL=postgres://postgres:postgres@localhost:55432/mig npm run db:migrate
# 断言:
docker exec -i mig-rehearsal psql -U postgres -d mig -c "SELECT object_type,payload->>'name' nm,payload->>'host' host FROM environment_objects WHERE object_type='web';"
# 期望:nm=web, host=10.0.0.1
docker exec -i mig-rehearsal psql -U postgres -d mig -c "SELECT url,web_service_ref FROM test_cases ORDER BY title;"
# 期望:内站 → /admin/x + web;外站 → 原绝对 + NULL
docker exec -i mig-rehearsal psql -U postgres -d mig -c "SELECT column_name FROM information_schema.columns WHERE table_name IN ('groups','test_environments') AND column_name IN ('default_url','base_url');"
# 期望:0 行
docker rm -f mig-rehearsal
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/drizzle apps/api/test
git commit -m "feat(migration): 0040 数据搬迁——base_url/loginUrl 转默认 web 对象,绝对 url 尽力剥离,删 groups.default_url 与 environments.base_url"
```

---

### Task 14: 全量回归 + 黄金路径手工验证

**Files:** 无新改动(修补则追加 commit)

- [ ] **Step 1: 全仓校验**

```bash
cd packages/shared && npx tsc -p tsconfig.json && cd ../../apps/api && npx tsc --noEmit && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run 2>&1 | tail -8
cd ../web && npx tsc --noEmit && npx vitest run 2>&1 | tail -8
```
预期:三个包 typecheck 干净、测试全绿(web 测试注意 shared 产物已重编译)。

- [ ] **Step 2: 黄金路径手工验证(双环境)**

dev 起服务(同 Task 12 Step 6 命令)。验证清单:

1. 环境页:环境 A 建 web 对象 `frontend=http://10.0.0.1:8080`(默认)+ `backend=http://10.0.0.2:8081`;环境 B 建 `frontend=http://192.168.1.10:8080`(默认)。
2. 用例:url=`/login`,webServiceRef=frontend;步骤含相对 navigate `/second` 与 `{{web_backend}}/api/x`。
3. 用 A 环境计划执行:报告 passed,页面实际访问 10.0.0.1/10.0.0.2。
4. 同用例换 B 环境计划执行:初始导航自动变 192.168.1.10(核心验收点)。
5. 存量绝对 url 用例(若有)执行:行为不变。
6. 环境无 web 服务 + 相对 url:报告失败,humanMessage 含"未配置 web 服务"。

- [ ] **Step 3: 收尾 commit(如有修补)**

```bash
git status --short
# 有改动则:git add -A && git commit -m "fix: 回归修补——<具体内容>"
```

---

## Self-Review 记录

- **Spec 覆盖**:spec 的 8 个改动面(DSL/resolve-url/EnvCtx/runCase/cdp/login/录制/AI/UI/迁移)分别对应 Task 1/5/4/6/7/8/9/11/12/13;spec"错误处理汇总"六行由 Task 6(WebServiceMissing 报告)/7(invalid-navigate)/6(web_ 覆盖)/9(未命中保留)/10(展示链)/全链(绝对直通)落实;spec 测试清单各项分布在对应 task。
- **类型一致性**:`WebServiceEntry`/`ResolveUrlEnv`/`resolveWebOrigin(ref?)`/`caseWebOrigin`/`web_service_ref`↔`webServiceRef` 在 Task 4/5/6/7/10/12 间已对齐;`relativizeUrl`/`projectWebOrigins` 由 Task 5 定义、Task 9 消费。
- **已知风险**:Task 5 完成后 tsc 会暂时报调用方错误(中间态),到 Task 10 归零——按任务顺序执行即可;Task 11/12 的锚点行号来自 2026-10-16 调研,执行时以文件实际内容为准。
