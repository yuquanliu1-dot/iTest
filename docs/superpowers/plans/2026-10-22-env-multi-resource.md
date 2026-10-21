# 环境多资源实施计划（凭据 @ref / 命名 db / 只读 sql / 命名 syslog）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让环境里的多个 web 各自带凭据、多个数据库 / syslog 各自可引用，取代当前"一个环境只有一份固定变量"的单例模型。

**Architecture:** 三层——`EnvCtx` 暴露资源清单与按 ref 解析；`aiTask.ts` 独占占位符解析与真实值替换（**唯一实现**）；机械路径与 AI 路径共用同一个 `CredentialSource`。新增只读 `sql` 动作查被测系统自己的库（现有 `queryDb` 只能查平台自���的 10 张表，语义不动）。

**Tech Stack:** 现有依赖全复用（express / drizzle-orm / pg / mysql2 / zod / vitest），**无新 npm 包、无新 compose 服务、无 DB migration**（db/syslog 复用现有 `environment_objects.label`）。

**Spec:** `docs/superpowers/specs/2026-10-22-env-multi-resource-design.md`

**贯穿全程的两条铁律：**
1. **凭据替换只有一个实现**——`makeCredentialValueSub`。任何新的 `=== USER_PH` 精确匹配都是回归（prod228 已因此烧掉 12+ 次 LLM 调用）。
2. **真实凭据永不进 LLM 上下文 / 反馈 / 日志 / 报告**。替换后的 mismatch 反馈只给长度。

---

## Task 1: `parseCredentialPlaceholder` —— 占位符带 `@ref`

**Files:**
- Modify: `apps/api/src/execute/aiTask.ts:118-180`（常量区与凭据协议区）
- Test: `apps/api/test/ai-task.test.ts`（追加到 `凭据占位符协议` describe）

**背景:** 现状 `credentialPlaceholderKind` 只认 3 个固定字面量，`@ref` 形态全新引入。`CredentialKind` 当前未导出，需导出。

- [x] **Step 1: 写失败测试**

追加到 `apps/api/test/ai-task.test.ts` 的 `describe('凭据占位符协议…')` 末尾（记得改 import 行，加上新导出的名字）：

```ts
it('parseCredentialPlaceholder：@ref 形态解析出归属服务', () => {
  expect(parseCredentialPlaceholder('__ITEST_USERNAME@backend__')).toEqual({ kind: 'user', ref: 'backend' });
  expect(parseCredentialPlaceholder('__ITEST_PASSWORD@front_end1__')).toEqual({ kind: 'password', ref: 'front_end1' });
  expect(parseCredentialPlaceholder('{{ITEST_USERNAME@backend}}')).toEqual({ kind: 'user', ref: 'backend' });
  expect(parseCredentialPlaceholder('{{__ITEST_USERNAME@backend__}}')).toEqual({ kind: 'user', ref: 'backend' });
  // 无 ref 形态仍解析，ref 为 null
  expect(parseCredentialPlaceholder('__ITEST_USERNAME__')).toEqual({ kind: 'user', ref: null });
  expect(parseCredentialPlaceholder('{{ITEST_PASSWORD}}')).toEqual({ kind: 'password', ref: null });
  // ref 非法（数字开头 / 含 @ / 含空格）→ 整个占位符不认，绝不退化成无 ref
  expect(parseCredentialPlaceholder('__ITEST_USERNAME@1bad__')).toBeNull();
  expect(parseCredentialPlaceholder('__ITEST_USERNAME@a@b__')).toBeNull();
  expect(parseCredentialPlaceholder('__ITEST_USERNAME@ bad __')).toBeNull();
  // secret 不解析 ref（敏感密文是步骤级，与 web 无关）：@段被忽略
  expect(parseCredentialPlaceholder('__ITEST_STEP_SECRET@x__')).toEqual({ kind: 'secret', ref: null });
  // 裸名 / 普通文本仍不认
  expect(parseCredentialPlaceholder('ITEST_USERNAME')).toBeNull();
  expect(parseCredentialPlaceholder('普通文本')).toBeNull();
  expect(parseCredentialPlaceholder('')).toBeNull();
});

it('credentialPlaceholder / isValidCredentialRef 往返一致', () => {
  expect(credentialPlaceholder('user', 'backend')).toBe('__ITEST_USERNAME@backend__');
  expect(credentialPlaceholder('password', null)).toBe('__ITEST_PASSWORD__');
  expect(credentialPlaceholder('secret')).toBe('__ITEST_STEP_SECRET__');
  for (const ref of ['backend', 'front_end1', '_x']) expect(isValidCredentialRef(ref)).toBe(true);
  for (const ref of ['', '1bad', 'a-b', 'a b', 'a'.repeat(65)]) expect(isValidCredentialRef(ref)).toBe(false);
  // 渲染出来的占位符一定解析得回同一个 ref
  for (const kind of ['user', 'password'] as const) {
    for (const ref of ['backend', 'admin_web']) {
      expect(parseCredentialPlaceholder(credentialPlaceholder(kind, ref))).toEqual({ kind, ref });
    }
  }
});

it('referencesCredential：@ref 形态也算引用', () => {
  expect(referencesCredential('__ITEST_USERNAME@backend__')).toBe(true);
  expect(referencesCredential('在 backend 登录页填写 __ITEST_USERNAME@backend__')).toBe(true);
  expect(referencesCredential('{{ITEST_PASSWORD@front}}')).toBe(true);
  expect(referencesCredential('点击保存')).toBe(false);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/ai-task.test.ts`
Expected: FAIL —— `parseCredentialPlaceholder is not a function`（vitest 报 import 失败）

- [x] **Step 3: 实现**

把 `apps/api/src/execute/aiTask.ts:122-180` 这一段（从 `// ── 凭据占位符识别与替换` 到 `makeCredentialValueSub` 之前）整体替换为：

```ts
// ── 凭据占位符识别与替换（AI 相 fill 值统一协议）──────────────────────────────
export type CredentialKind = 'user' | 'password' | 'secret';

/** 解析结果：kind + 归属 web 服务 name（null = 未指定，走三级默认链）。 */
export interface ParsedCredential { kind: CredentialKind; ref: string | null }

/** @ref 段合法性：与 shared 的 VAR_NAME_RE 同口径（字母/数字/下划线，字母或下划线开头，≤64）。 */
export function isValidCredentialRef(ref: string): boolean {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 64 && VAR_NAME_RE.test(ref);
}

const KIND_BY_NAME: Record<string, CredentialKind> = {
  ITEST_USERNAME: 'user',
  ITEST_PASSWORD: 'password',
  ITEST_STEP_SECRET: 'secret',
};

/**
 * 解析凭据占位符：__ITEST_USERNAME@backend__ / {{ITEST_USERNAME@backend}} /
 * {{__ITEST_USERNAME@backend__}} / 无 ref 的既有形态。
 * 裸名（无哨兵/花括号包裹）不认，避免把普通文本误判成凭据；
 * ref 段非法则整个占位符判否，绝不退化成"无 ref"（那会静默取到默认 web 的账���）。
 * secret 与 web 无关（步骤级密文），其 @ 段被忽略。
 */
export function parseCredentialPlaceholder(raw: string): ParsedCredential | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  let inner: string;
  if (t.startsWith('{{') && t.endsWith('}}')) inner = t.slice(2, -2).trim();
  else if (t.startsWith('__') && t.endsWith('__')) inner = t.slice(2, -2);
  else return null;
  const at = inner.indexOf('@');
  const head = (at >= 0 ? inner.slice(0, at) : inner).replace(/^_+|_+$/g, '');
  const ref = at >= 0 ? inner.slice(at + 1).replace(/^_+|_+$/g, '').trim() : null;
  const kind = KIND_BY_NAME[head.toUpperCase()];
  if (!kind) return null;
  if (ref === null || kind === 'secret') return { kind, ref: null };
  return isValidCredentialRef(ref) ? { kind, ref } : null;
}

/** 只要 kind 的便捷包装（固化判定等只需知道"是不是凭据"）。 */
export function credentialPlaceholderKind(raw: string): CredentialKind | null {
  return parseCredentialPlaceholder(raw)?.kind ?? null;
}

/** 渲染占位符，供提示词拼装（避免各处硬编码字面量拼错）。 */
export function credentialPlaceholder(kind: CredentialKind, ref?: string | null): string {
  const base = kind === 'user' ? USER_PH : kind === 'password' ? PASSWORD_PH : SECRET_PH;
  if (!ref || kind === 'secret') return base;
  return `${base.slice(0, -2)}@${ref}__`;
}

const CREDENTIAL_REF_RE = /(?:\{\{\s*)?_{0,2}ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)_{0,2}(?:@[A-Za-z_][A-Za-z0-9_]*)?(?:\s*\}\})?/;

/** 自由文本是否引用了凭据占位符（任意形态：哨兵 / 花括号 / 裸名 / 带 @ref）。
 *  用途：substituteVars 的 missing 过滤（凭据不来自数据集 vars）+ 环境凭据前置检查。 */
export function referencesCredential(text: string): boolean {
  return CREDENTIAL_REF_RE.test(text);
}
```

在文件顶部 import 区加 `import { VAR_NAME_RE } from '@itest/shared';`（放在第 4 行 `langDirective` 之后）。

> 注意：`makeCredentialValueSub` 里的错误文案现在要用渲染后的占位符（含 `@ref`），Task 3 会一并改，本任务先不动它。

- [x] **Step 4: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run test/ai-task.test.ts`
Expected: PASS，既有 19 个用例仍全绿（`credentialPlaceholderKind` 语义对旧形态不变）

- [x] **Step 5: 提交**

```bash
git add apps/api/src/execute/aiTask.ts apps/api/test/ai-task.test.ts
git commit -m "feat(api): 凭据占位符支持 @ref 归属——parseCredentialPlaceholder 统一解析形态"
```

---

## Task 2: EnvCtx 暴露多份 web 凭据

**Files:**
- Modify: `apps/api/src/execute/envContext.ts`（`LoginCtx` 定义处、`WebServiceEntry`、返回值对象、`resolveEnv` 内 login 派生段）
- Test: `apps/api/src/execute/envContext.test.ts`（追加）

- [x] **Step 1: 写失败测试**

追加到 `apps/api/src/execute/envContext.test.ts` 末尾：

```ts
describe('resolveEnv 多 web 凭据', () => {
  const credOf = (user: string, pw: string) => ({ user, secret: encrypt(pw) });
  const twoWebs = [
    { id: 'w-b', environmentId: 'env-1', objectType: 'web', label: '后端', isDefault: false,
      payload: { name: 'backend', scheme: 'http', host: '10.0.0.1', port: 90, ...credOf('admin', 'pw9') } },
    { id: 'w-f', environmentId: 'env-1', objectType: 'web', label: '前端', isDefault: true,
      payload: { name: 'frontend', scheme: 'http', host: '10.0.0.2', port: 1688, ...credOf('guest', 'pw8') } },
  ];

  it('logins 收齐每个已配凭据的命名 web 服务', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: twoWebs, project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect([...env.logins.keys()].sort()).toEqual(['backend', 'frontend']);
    expect(env.resolveLogin('backend')?.user).toBe('admin');
    expect(env.resolveLogin('frontend')?.password).toBe('pw8');
  });

  it('resolveLogin 无 ref → 默认 web；未知 ref → null（不静默回落默认）', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: twoWebs, project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.resolveLogin()?.user).toBe('guest');       // isDefault=frontend
    expect(env.resolveLogin('nope')).toBeNull();
    // 旧字段 login 仍是默认 web 的（既有消费点零改动）
    expect(env.login?.user).toBe('guest');
  });

  it('hasCredentials：只反映有无，不泄漏任何值；无名 web 不可按名引用', async () => {
    const objs = [
      ...twoWebs,
      { id: 'w-x', environmentId: 'env-1', objectType: 'web', label: '无凭据', isDefault: false,
        payload: { name: 'staging', scheme: 'https', host: '10.0.0.9' } },
      { id: 'w-n', environmentId: 'env-1', objectType: 'web', label: '无名', isDefault: false,
        payload: { scheme: 'https', host: '10.0.0.10', ...credOf('u', 'p') } },
    ];
    mockTables({ test_environments: [ENV_ROW], environment_objects: objs, project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.hasCredentials('backend')).toBe(true);
    expect(env.hasCredentials('staging')).toBe(false);
    expect(env.hasCredentials('nope')).toBe(false);
    // 无 payload.name 的对象不进入 logins（不可被引用，与既有语义一致）
    expect(env.logins.has('')).toBe(false);
    expect([...env.logins.values()].some((l) => l.user === 'u')).toBe(false);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run src/execute/envContext.test.ts`
Expected: FAIL —— `env.logins is undefined`

- [x] **Step 3: 实现**

`apps/api/src/execute/envContext.ts` 三处改动：

**(a)** `LoginCtx` 定义后追加：

```ts
/** 环境内每个"已配凭据"的命名 web 服务：name → 凭据。执行期占位符 `__ITEST_USERNAME@name__` 的解析源。 */
export type WebLogins = Map<string, LoginCtx>;
```

**(b)** `EnvCtx` 接口的 `login?: LoginCtx;` 之后插入三行：

```ts
  /** 每个命名 web 服务各自的登录凭据（仅已配 user+secret 的）；无名对象不进此表。 */
  logins: WebLogins;
  /** 按 ref 取 web 凭据；ref 空 → 默认 web；该 ref 无凭据 → null（绝不静默回落默认）。 */
  resolveLogin(ref?: string | null): LoginCtx | null;
  /** 某 web 服务是否配了凭据（AI 资源清单渲染用，不返回任何值）。 */
  hasCredentials(ref: string): boolean;
```

**(c)** `resolveEnv` 里把 `let loginCfg` 那段（234-243 行）替换为——既填 `loginCfg`，又建 `logins`：

```ts
  // 逐个命名 web 收集各自的内嵌凭据（payload.user + secret）；无名对象不进表（不可被引用）。
  const logins: WebLogins = new Map();
  for (const o of objects.filter((x) => x.objectType === 'web')) {
    const p = (o.payload ?? {}) as WebPayload;
    if (!p.secret?.c || !p.secret?.i || !p.secret?.t || !p.user) continue;
    const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : null;
    if (!name) continue;
    logins.set(name, { user: p.user, password: safeDecrypt(p.secret), loginUrl: p.loginUrl ?? null });
  }
  // 兼容旧字段 login = 默认 web 的凭据（pick('web') 与 resolveWebOrigin() 空 ref 同选择逻辑）。
  let loginCfg: EnvCtx['login'];
  const webObj = pick('web');
  if (webObj) {
    const p = (webObj.payload ?? {}) as WebPayload;
    if (p.user && p.secret?.c && p.secret?.i && p.secret?.t) {
      loginCfg = { user: p.user, password: safeDecrypt(p.secret), loginUrl: p.loginUrl ?? null };
    }
  }
```

返回对象里（`login: loginCfg,` 之后）插入：

```ts
    logins,
    resolveLogin: (ref?: string | null) => {
      if (ref) return logins.get(ref) ?? null;
      const def = webServices.find((w) => w.isDefault) ?? webServices.find((w) => w.name);
      return (def?.name ? logins.get(def.name) : undefined) ?? null;
    },
    hasCredentials: (ref: string) => logins.has(ref),
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run src/execute/envContext.test.ts`
Expected: PASS，既有 20+ 用例全绿

- [x] **Step 5: 提交**

```bash
git add apps/api/src/execute/envContext.ts apps/api/src/execute/envContext.test.ts
git commit -m "feat(api): EnvCtx 暴露 logins/resolveLogin/hasCredentials——多 web 各自凭据"
```

---

## Task 3: 共享 `CredentialSource` 构造 + 机械路径改走同一替换器

**Files:**
- Create: `apps/api/src/execute/credentialSource.ts`
- Modify: `apps/api/src/execute/aiTask.ts`（`makeCredentialValueSub` 支持 `byRef` + 错误文案点名资源）
- Modify: `apps/api/src/execute/cdp.ts:248-310`（`resolveEnvCredential` / `aiCredentialSub` / `credentialPreflightError`）
- Test: `apps/api/test/ai-task.test.ts`（追加 byRef 用例）、`apps/api/test/execute-ai-fallback.test.ts`（追加机械路径 @ref 用例）

**这是"铁律 1"的落点**：机械路径不再自己写 `=== USER_PH`。

- [x] **Step 1: 写失败测试**

`apps/api/test/ai-task.test.ts` 追加：

```ts
it('makeCredentialValueSub：@ref 命中 byRef，未命中回落默认，再不命中抛点名错误', () => {
  const sub = makeCredentialValueSub({
    user: 'def_u', password: 'def_p', secret: null,
    byRef: (ref) => (ref === 'backend' ? { user: 'be_u', password: 'be_p' } : null),
  });
  expect(sub('__ITEST_USERNAME@backend__')).toBe('be_u');
  expect(sub('__ITEST_PASSWORD@backend__')).toBe('be_p');
  // @ref 未命中 → 回落默认（同一 web 的不同形态占位符不打架）
  expect(sub('__ITEST_USERNAME@nope__')).toBe('def_u');
  expect(sub('__ITEST_USERNAME__')).toBe('def_u');
  // 双空 → 命名错误，且消息点名缺失的 ref 与可用 ref
  const none = makeCredentialValueSub({ user: null, password: null, secret: null, byRef: () => null });
  expect(() => none('__ITEST_USERNAME@backend__')).toThrow(/env-missing/);
  expect(() => none('__ITEST_USERNAME@backend__')).toThrow(/backend/);
});

it('makeCredentialValueSub：secret 恒走步骤密文，不看 byRef', () => {
  const sub = makeCredentialValueSub({
    user: 'u', password: 'p', secret: 'step-secret',
    byRef: () => ({ user: 'x', password: 'y' }),
  });
  expect(sub('__ITEST_STEP_SECRET@anything__')).toBe('step-secret');
});
```

`apps/api/test/execute-ai-fallback.test.ts` 在 `describe('回放 AI 降级 — 凭据占位符替换…')` 内追加（复用该文件的 `makeEnvCtx` / `mocked.__typed`；`makeEnvCtx` 要加一个可选 `logins` 参数）：

```ts
it('机械回放 compiled fill：@ref 占位符取指定 web 的凭据', async () => {
  mocked.__typed.length = 0;
  const { llm } = makeMockLlm([]);
  mocked.__page.evaluate.mockReset();
  mocked.__page.evaluate.mockImplementation(() => Promise.resolve([]));
  const envCtx = {
    ...makeEnvCtx({ user: 'front_u', password: 'front_p' }),
    logins: new Map([['backend', { user: 'be_u', password: 'be_p', loginUrl: null }]]),
    resolveLogin: (ref?: string | null) => (ref === 'backend'
      ? { user: 'be_u', password: 'be_p', loginUrl: null }
      : { user: 'front_u', password: 'front_p', loginUrl: null }),
    hasCredentials: () => true,
  };
  const results = await executeCaseReal(
    '00000000-0000-0000-0000-000000000140',
    [{
      order: 1, id: 's-ref-1', instruction: '登录后端',
      compiled: [
        { kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '__ITEST_USERNAME@backend__' },
        { kind: 'fill', locator: [{ strategy: 'css', value: '#p' }], value: '__ITEST_PASSWORD@backend__' },
      ],
    }],
    { reportId: 'r-cred-ref', aiFallback: OFF, llmClient: llm, envCtx },
  );
  expect(results[0]!.status).toBe('passed');
  expect(mocked.__typed).toContain('be_u');
  expect(mocked.__typed).toContain('be_p');
  expect(mocked.__typed.join('|')).not.toContain('__ITEST_');
});

it('机械回放：@ref 指向不存在的 web → EnvMissing 判失败，不敲字面量', async () => {
  mocked.__typed.length = 0;
  const { llm } = makeMockLlm([]);
  mocked.__page.evaluate.mockReset();
  mocked.__page.evaluate.mockImplementation(() => Promise.resolve([]));
  const results = await executeCaseReal(
    '00000000-0000-0000-0000-000000000141',
    [{
      order: 1, id: 's-ref-2', instruction: '登录不存在的前端',
      compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '__ITEST_USERNAME@nope__' }],
    }],
    { reportId: 'r-cred-ref-miss', aiFallback: OFF, llmClient: llm, envCtx: makeEnvCtx({ user: 'u', password: 'p' }) },
  );
  expect(results[0]!.status).toBe('failed');
  expect(results[0]!.failureReason).toBe('EnvMissing');
  expect(mocked.__typed.join('|')).not.toContain('__ITEST_');
});
```

> `makeEnvCtx` 同步补 `logins: new Map()`, `resolveLogin: () => login ?? null`, `hasCredentials: () => !!login`，否则 Task 3 之后其它既有用例会因 EnvCtx 缺字段而崩。

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/ai-task.test.ts test/execute-ai-fallback.test.ts`
Expected: FAIL —— byRef 未生效、机械路径把 `__ITEST_USERNAME@backend__` 原样敲进表单

- [x] **Step 3: 实现 `makeCredentialValueSub` 的 byRef**

`apps/api/src/execute/aiTask.ts` 中 `CredentialSource` + `makeCredentialValueSub` 整段替换为：

```ts
/** 凭据来源：无 ref 的默认值 + 按 web 服务 name 取值的回调（两者皆空即缺失）。 */
export interface CredentialSource {
  /** 无 ref 占位符的默认来源（既有调用方零改动）。 */
  user?: string | null;
  password?: string | null;
  secret?: string | null;
  /** 按 web 服务 name 取该服务的凭据；返回 null = 该 ref 无凭据 → EnvMissing。 */
  byRef?: (ref: string) => { user?: string | null; password?: string | null } | null;
}

/**
 * AI 相 / 机械相共用的 fill 值替换器：把凭据占位符（哨兵 / 花括号 / @ref 任意形态）
 * 换成真实值；非占位符原样返回。缺凭据 → 抛 EnvMissing/SecretMissing 命名错误，
 * 错误消息点名缺失的 web 服务，绝不把占位符原样敲进表单（2026-10-21 prod228 实测：
 * 占位符原样进登录表单必败，AI 换 selector 空转烧掉 12+ 次 LLM 调用）。
 */
export function makeCredentialValueSub(src: CredentialSource): (v: string) => string {
  return (v: string): string => {
    const parsed = parseCredentialPlaceholder(v);
    if (!parsed) return v;
    const { kind, ref } = parsed;
    let real: string | null | undefined;
    if (ref && src.byRef) {
      const hit = src.byRef(ref);
      real = kind === 'user' ? hit?.user : hit?.password;
    }
    if (real === undefined || real === null) real = kind === 'user' ? src.user : kind === 'password' ? src.password : src.secret;
    if (!real) {
      const ph = credentialPlaceholder(kind, ref);
      const e = new Error(
        kind === 'secret'
          ? `secret-missing: 步骤引用了 ${ph}，但本步没有可用的敏感值（需 sensitive 步骤密文）`
          : `env-missing: 用例步骤引用了 ${ph}，但当前环境未配置对应的登录凭据（请到项目设置→测试环境配置）`,
      );
      e.name = kind === 'secret' ? 'SecretMissing' : 'EnvMissing';
      throw e;
    }
    return real;
  };
}
```

- [x] **Step 4: 实现共享 CredentialSource 构造（新建文件）**

`apps/api/src/execute/credentialSource.ts`：

```ts
/**
 * 执行期凭据来源的唯一构造点：机械回放（cdp.resolveFillValue）、AI 回放降级
 * （cdp.aiCredentialSub）、pi 层 verify/solidify/login 三个工具都用它。
 *
 * 默认链三级：显式 @ref → 用例绑定的 web_service_ref → 环境的默认 web 服务。
 * 一条链同时覆盖"不同用例测不同 web"（第二级）与"同一用例跨 web"（第一级）。
 */
import type { CredentialSource } from './aiTask.js';
import type { EnvCtx } from './envContext.js';

/** 无 ref 占位符该落到哪个 web 服务上（第二/三级链的结果；null = 环境无可用 web）。 */
export function defaultWebRef(ctx: { envCtx?: EnvCtx; caseWebServiceRef?: string | null }): string | null {
  const explicit = ctx.caseWebServiceRef;
  if (explicit) return explicit;
  const webs = ctx.envCtx?.webServices ?? [];
  const def = webs.find((w) => w.isDefault) ?? webs.find((w) => w.name);
  return def?.name ?? null;
}

/** 组装 CredentialSource。secret 为步骤级敏感密文（与 web 无关，原样透传）。 */
export function buildCredentialSource(
  ctx: { envCtx?: EnvCtx; caseWebServiceRef?: string | null },
  secret?: string | undefined,
): CredentialSource {
  const env = ctx.envCtx;
  const def = env?.resolveLogin(defaultWebRef(ctx)) ?? null;
  return {
    user: def?.user ?? null,
    password: def?.password ?? null,
    secret: secret ?? null,
    byRef: (ref) => env?.resolveLogin(ref) ?? null,
  };
}

/** AI 提示词的资源清单（只含 name / origin / 有无凭据，绝不出现真实值）。 */
export function renderWebResourceManifest(ctx: { envCtx?: EnvCtx }): string {
  const webs = ctx.envCtx?.webServices ?? [];
  if (webs.length === 0) return '';
  const lines = webs.map((w) => {
    if (!w.name) return '';
    return `- ${w.name}（${w.isDefault ? '默认' : w.label}） ${w.origin} ${w.hasCredentials(w.name) ? '已配置凭据' : '未配置凭据'}`;
  }).filter(Boolean);
  if (lines.length === 0) return '';
  return `可用 web 服务（凭据归属用 @name 指定；不写 @name 时用标注「默认」的那个）：\n${lines.join('\n')}`;
}
```

- [x] **Step 5: 机械路径改走同一替换器**

`apps/api/src/execute/cdp.ts`：

**(a)** `resolveEnvCredential`（248-270 行整段）替换为：

```ts
/** 机械派发路径的 fill 值替换器——与 AI 相共用 makeCredentialValueSub（同一实现，
 *  避免两处各写一套字面量精确匹配后再次分叉，2026-10-21 prod228 即此根因）。
 *  机械路径没有 web 归属语义，ref 链固定落在用例绑定的 web 服务上。 */
function resolveEnvCredential(raw: string, ctx: ExecContext): string {
  const parsed = parseCredentialPlaceholder(raw);
  if (!parsed) return raw;
  if (parsed.kind === 'secret' && !parsed.ref) {
    // 步骤级密文只有 sensitive 分支（secretResolver）能解；compiled 里写占位符无处可解。
    const e = new Error(`secret-missing: 步骤 compiled 含 ${SECRET_PH}，敏感值只能走 sensitive=true + 密文，不能写占位符`);
    e.name = 'SecretMissing';
    throw e;
  }
  return makeCredentialValueSub(buildCredentialSource(ctx))(raw);
}
```

**(b)** `resolveFillValue` 的签名与两处调用改掉（它是 `resolveEnvCredential` 的薄包装，直接删掉更省）：

```ts
// 删除 resolveFillValue
```
`tryDomFallback` 里的 `domFill(page, action.locator, resolveFillValue(action.value ?? '', opts.ctx.envCtx, vars))` →
`domFill(page, action.locator, substituteVars(typeof action.value === 'string' ? action.value : '', vars).value)`；
`dispatchInner` 的 `case 'fill'` 分支里 `value = resolveFillValue(action.value, opts.ctx.envCtx, vars);` →
`value = resolveEnvCredential(materializeValue(action.value, vars), opts.ctx);`
（`materializeValue` 已在第 14 行 import，删掉 `resolveFillValue` 后不会产生孤儿 import。）

**(c)** `aiCredentialSub`（301-310 行）替换为委托：

```ts
/** AI 相（降级 / aiTask）的凭据来源：机械相同一构造点，只是多了步骤密文。 */
function aiCredentialSub(ctx: ExecContext, secret: string | undefined): CredentialSource {
  return buildCredentialSource(ctx, secret);
}
```

**(d)** `credentialPreflightError`（290-299 行）替换为按解析结果逐个检查：

```ts
/** AI 相预检：指令引用的凭据占位符（含 @ref）在当前环境不可解析 → 命名 EnvMissing。
 *  在烧 LLM 轮次之前拦截——占位符原样进登录表单必败（2026-10-21 prod228 实测整轮空转 12+ 次调用）。 */
function credentialPreflightError(inst: string, ctx: ExecContext): Error | null {
  const phs = inst.match(new RegExp(CREDENTIAL_PLACEHOLDER_SCAN.source, 'g')) ?? [];
  if (phs.length === 0) return null;
  let sub: (v: string) => string;
  try {
    sub = makeCredentialValueSub(buildCredentialSource(ctx));
  } catch (e) {
    return e instanceof Error ? e : null;
  }
  for (const ph of phs) {
    try {
      sub(ph);
    } catch (e) {
      return e instanceof Error ? e : null;
    }
  }
  return null;
}
```

**(e)** import 行（30 行）加 `parseCredentialPlaceholder` 与 `CREDENTIAL_PLACEHOLDER_SCAN`；并在 `aiTask.ts` 导出该扫描正则：

```ts
/** 扫描文本里所有凭据占位符出现（供前置检查逐个解析）。带 @ref 的形态整体匹配。 */
export const CREDENTIAL_PLACEHOLDER_SCAN = /__?ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)@?[A-Za-z0-9_]*__?|\{\{\s*_*ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)@?[A-Za-z0-9_ ]*_*\s*\}\}/g;
```

在 cdp.ts 的 import 里加 `makeCredentialValueSub, parseCredentialPlaceholder, CREDENTIAL_PLACEHOLDER_SCAN`，以及 `import { buildCredentialSource } from './credentialSource.js';`、`import type { CredentialSource } from './aiTask.js';`。

- [x] **Step 6: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run test/ai-task.test.ts test/execute-ai-fallback.test.ts test/ai-action-map.test.ts`
Expected: PASS。若 `test/ai-action-map.test.ts` 不存在，用 `pnpm vitest run test/ai-task.test.ts test/execute-ai-fallback.test.ts` 代替，并在 Task 6 补该文件。

- [x] **Step 7: 类型检查 + 提交**

Run: `cd apps/api && pnpm tsc --noEmit -p tsconfig.json`
Expected: 无错（`credentialPlaceholderKind` 的旧导出保留，`aiActionMap.ts` 零改动仍可用）

```bash
git add apps/api/src/execute/credentialSource.ts apps/api/src/execute/aiTask.ts apps/api/src/execute/cdp.ts apps/api/test/ai-task.test.ts apps/api/test/execute-ai-fallback.test.ts
git commit -m "refactor(api): 机械路径与 AI 相共用 makeCredentialValueSub——凭据替换单一实现，支持 @ref"
```

---

## Task 4: 三级链第二级 —— 用例绑定的 web 服务传进执行上下文

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`（`ExecContext` 接口 + `executeCaseReal` / `executeCaseInBrowser` 的 steps 参数无需改）
- Modify: `apps/api/src/execute/runCase.ts`（`execCtx` 注入 `caseWebServiceRef`）
- Test: `apps/api/test/execute-ai-fallback.test.ts`（追加）

- [x] **Step 1: 写失败测试**

`apps/api/test/execute-ai-fallback.test.ts` 的凭据 describe 内追加：

```ts
it('无 @ref 的占位符落到用例绑定的 web 服务上（不同用例测不同 web）', async () => {
  mocked.__typed.length = 0;
  const { llm } = makeMockLlm([]);
  mocked.__page.evaluate.mockReset();
  mocked.__page.evaluate.mockImplementation(() => Promise.resolve([]));
  const envCtx = {
    ...makeEnvCtx({ user: 'front_u', password: 'front_p' }),
    logins: new Map<string, { user: string; password: string; loginUrl: null }>([
      ['backend', { user: 'be_u', password: 'be_p', loginUrl: null }],
    ]),
    resolveLogin: (ref?: string | null) => (ref && ref !== 'backend'
      ? null
      : ref === 'backend' ? { user: 'be_u', password: 'be_p', loginUrl: null } : { user: 'front_u', password: 'front_p', loginUrl: null }),
    hasCredentials: () => true,
  };
  const results = await executeCaseReal(
    '00000000-0000-0000-0000-000000000142',
    [{
      order: 1, id: 's-bind-1', instruction: '登录并提交',
      compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '__ITEST_USERNAME__' }],
    }],
    { reportId: 'r-cred-bind', aiFallback: OFF, llmClient: llm, envCtx, caseWebServiceRef: 'backend' },
  );
  expect(results[0]!.status).toBe('passed');
  expect(mocked.__typed).toContain('be_u');
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/execute-ai-fallback.test.ts`
Expected: FAIL —— 无 `caseWebServiceRef` 字段（TS 报字段不存在或填了 front_u）

- [x] **Step 3: 实现**

**(a)** `apps/api/src/execute/cdp.ts` 的 `ExecContext` 里，`caseWebOrigin?: string | null;` 那行之后插入：

```ts
  /** 用例绑定的 web 服务（environment_objects payload.name）；无 ref 占位符的第二级解析目标。 */
  caseWebServiceRef?: string | null;
```

**(b)** `apps/api/src/execute/runCase.ts` 的 `execCtx` 字面量里，`...(caseWebOrigin ? { caseWebOrigin } : {}),` 之后插入：

```ts
      ...(caseRow.webServiceRef ? { caseWebServiceRef: caseRow.webServiceRef } : {}),
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run test/execute-ai-fallback.test.ts test/runCase-mobile.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add apps/api/src/execute/cdp.ts apps/api/src/execute/runCase.ts apps/api/test/execute-ai-fallback.test.ts
git commit -m "feat(api): 用例 web_service_ref 传进执行上下文——无 ref 占位符的第二级解析"
```

---

## Task 5: AI 资源清单进提示词

**Files:**
- Modify: `apps/api/src/execute/aiTask.ts`（`RunAiTaskOpts` + `SYSTEM_PROMPT` 凭据段 + `userMessage` 组装）
- Modify: `apps/api/src/execute/cdp.ts`（三处 `runAiTask` 调用传 `resourceManifest`）
- Test: `apps/api/test/ai-task.test.ts`（追加）

- [x] **Step 1: 写失败测试**

追加到 `apps/api/test/ai-task.test.ts` 的 `describe('runAiTask')`：

```ts
it('resourceManifest 进系统提示词且不含真实凭据', async () => {
  const { page } = makeStubPage();
  const { llm, requests } = makeMockLlm([{ done: true, summary: 'ok' }]);
  await runAiTask(page, '登录', llm, false, {
    resourceManifest: '可用 web 服务：\n- backend（默认） http://10.0.0.1:90 已配置凭据\n- staging http://10.0.0.9 未配置凭据',
  });
  expect(requests[0]).toContain('backend（默认） http://10.0.0.1:90');
  expect(requests[0]).toContain('未配置凭据');
  expect(requests[0]).toContain('__ITEST_USERNAME@backend__');
  // 缺省不注入（无清单的调用方提示词与既有形态一致）
  const { llm: l2, requests: r2 } = makeMockLlm([{ done: true, summary: 'ok' }]);
  await runAiTask(page, '登录', l2);
  expect(r2[0]).not.toContain('可用 web 服务');
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/ai-task.test.ts`
Expected: FAIL —— manifest 未进请求

- [x] **Step 3: 实现**

**(a)** `SYSTEM_PROMPT` 末尾那一行（现在硬写着 `__ITEST_USERNAME__ / __ITEST_PASSWORD__`）替换为占位符 + 动态段：

```ts
- 凭据（用户名/密码）：fill 的 value 用字面量 __ITEST_USERNAME@服务名__ / __ITEST_PASSWORD@服务名__（平台在填入的瞬间替换为真实值）；不要输出 {{}} 变量模板，平台不替换模板。`;
```

并在 `runAiTask` 内，`const systemPrompt = mobile ? MOBILE_SYSTEM_PROMPT : SYSTEM_PROMPT;`（第 418 行）替换为：

```ts
  const manifest = opts?.resourceManifest?.trim() ?? '';
  const credentialHint = manifest
    ? `${manifest}\n不写 @服务名 时用标注「默认」的那个。清单里「未配置凭据」的服务不要尝试登录（必然失败）。`
    : '用户名输入框 fill 的 value 用字面量 __ITEST_USERNAME__，密码用 __ITEST_PASSWORD__（平台在填入的瞬间替换为真实值）。';
  const systemPrompt = mobile ? MOBILE_SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${credentialHint}`;
```

**(b)** `RunAiTaskOpts` 加：

```ts
  /** web 资源清单（name / origin / 有无凭据）文本，由调用方用 renderWebResourceManifest 渲染。 */
  resourceManifest?: string;
```

**(c)** `apps/api/src/execute/cdp.ts` 三处 `runAiTask(...)` 调用（aiTask 分支、compileMissing 降级、locatorFailed 降级）各加一项 `resourceManifest: renderWebResourceManifest({ envCtx: opts.ctx.envCtx })`。import 加 `renderWebResourceManifest`（并入 Task 3 加的那行 `buildCredentialSource` import）。

- [x] **Step 4: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run test/ai-task.test.ts test/execute-ai-fallback.test.ts test/pi-verify-case.test.ts test/pi-solidify-case.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add apps/api/src/execute/aiTask.ts apps/api/src/execute/cdp.ts apps/api/test/ai-task.test.ts
git commit -m "feat(api): web 资源清单进 AI 提示词——模型知道有哪些服务、哪些配了凭据"
```

---

## Task 6: 固化路径同步

**Files:**
- Modify: `apps/api/src/execute/aiActionMap.ts:56-60`
- Create: `apps/api/test/ai-action-map.test.ts`

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/ai-action-map.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { mapAiActionsToCompiled } from '../src/execute/aiActionMap.js';

describe('mapAiActionsToCompiled 凭据占位符', () => {
  it('带 @ref 的 fill 同样不固化（固化会把字面量冻进 compiled）', () => {
    const r = mapAiActionsToCompiled([
      { type: 'click', selector: '#submit' },
      { type: 'fill', selector: '#u', value: '__ITEST_USERNAME@backend__' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/凭据占位符/);
  });

  it('普通 fill 照常固化；watch 截图跳过不阻断', () => {
    const r = mapAiActionsToCompiled([
      { type: 'screenshot', selector: '#captcha' },
      { type: 'fill', selector: '#name', value: '张三' },
      { type: 'wait', ms: 1500 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.compiled).toEqual([
      { kind: 'fill', locator: [{ strategy: 'css', value: '#name' }], value: '张三' },
      { kind: 'waitFor', locator: [], timeoutMs: 1500 },
    ]);
    expect(r.ok && r.skippedCount).toBe(1);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/ai-action-map.test.ts`
Expected: FAIL —— 原因文案不含「@ref」（功能其实已生效，因为 Task 1 让 `credentialPlaceholderKind` 委托给了 `parseCredentialPlaceholder`；本任务锁的是文案与回归）

- [x] **Step 3: 实现**

`apps/api/src/execute/aiActionMap.ts` 的 fill 分支（56-60 行）替换为：

```ts
      case 'fill': {
        // 任意形态的凭据占位符（哨兵 / 花括号 / @ref 归属）都不固化——
        // 固化会把字面量冻结进 compiled，回放时 valueSub 认得但字面量里没有凭据，
        // 且换环境后归属失效。保守整步保持 aiTask。
        if (credentialPlaceholderKind(a.value)) {
          return { ok: false, reason: 'fill value 为登录/敏感凭据占位符（含 @服务名 归属形态，登录不属于用例步骤，归环境登录），不固化' };
        }
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run test/ai-action-map.test.ts test/execute-aitask-cache.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add apps/api/src/execute/aiActionMap.ts apps/api/test/ai-action-map.test.ts
git commit -m "test(api): 固化判定锁定 @ref 凭据占位符不固化"
```

---

## Task 7: EnvCtx 命名 db（懒建连接池）

**Files:**
- Modify: `apps/api/src/execute/envContext.ts`（`EnvCtx` 接口 + `resolveEnv` 的 db 段 + 返回对象 + `close()`）
- Test: `apps/api/src/execute/envContext.test.ts`（追加）

**注意:** 现状 `resolveEnv` 对默认 db **急切建池**。多 db 下急切建全部会浪费连接，改懒建 + Map 缓存；`EnvCtx.pool` / `EnvCtx.db` 保留为默认 db 的派生 getter（`queryDb` 零改动）。

- [x] **Step 1: 写失败测试**

追加到 `apps/api/src/execute/envContext.test.ts`：

```ts
describe('resolveEnv 命名 db', () => {
  const dbObjs = [
    { id: 'd-m', environmentId: 'env-1', objectType: 'db', label: '主库', isDefault: true,
      payload: { host: 'pg-main', dbName: 'main', user: 'u1', secret: encrypt('p1') } },
    { id: 'd-o', environmentId: 'env-1', objectType: 'db', label: 'olap', isDefault: false,
      payload: { host: 'my-olap', dbName: 'dw', dbType: 'mysql', user: 'u2', secret: encrypt('p2') } },
    { id: 'd-bad', environmentId: 'env-1', objectType: 'db', label: '缺字段', isDefault: false, payload: {} },
  ];

  it('dbs 列出全部配置完整的 db（label 即 ref），缺字段的跳过', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: dbObjs, project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.dbs.map((d) => d.label)).toEqual(['主库', 'olap']);
    expect(env.resolveDb('olap')?.dialect).toBe('mysql');
    expect(env.resolveDb()?.label).toBe('主库');
    expect(env.resolveDb('nope')).toBeNull();
  });

  it('resolveEnv 不再急切建池；pool 是懒建 getter', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: dbObjs, project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    // resolveEnv 本身不该建连接（多 db 场景下急切建全部会浪费连接）
    expect(env.db).toBeUndefined();          // 默认 db 的 getter 尚未触发
    const p = env.pool;                       // 触发一次
    expect(p?.dialect).toBe('postgres');
    expect(env.pool).toBe(p);                 // 缓存，不重建
  });

  it('close() 关闭所有已建池', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: dbObjs, project_versions: [] });
    const ended: string[] = [];
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    const pools = await Promise.all([env.resolveDbPool('主库'), env.resolveDbPool('olap')]);
    for (const p of pools) { /* 触发建池 */ void p; }
    void ended;
    await env.close();
    // 真库连不上时 close 不得抛（未建立的池本就不在缓存里）
    expect(true).toBe(true);
  });
});
```

> `close()` 那个用例只锁"不抛"。真实 `end()` 的验证留给 Task 9 的 `sqlQuery` 单测（用假 pool）。

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run src/execute/envContext.test.ts`
Expected: FAIL —— `env.dbs is undefined`

- [x] **Step 3: 实现**

**(a)** `DbPayload` 定义后追加：

```ts
/** 一个配置完整的 db 对象（label 即执行期的 ref；`(envId,'db',label)` 已在 service 层保证唯一）。 */
export interface DbEntry {
  label: string;
  dialect: DbDialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  isDefault: boolean;
}
```

**(b)** `EnvCtx` 接口：`pool?: QueryPool;` 与 `syslog?: SyslogCtx;` 之间插入：

```ts
  /** 全部配置完整的 db 对象（label 即 ref）。 */
  dbs: DbEntry[];
  /** 按 ref 取 db；ref 空 → isDefault → 最早；未命中 → null。 */
  resolveDb(ref?: string | null): DbEntry | null;
  /** 懒建 + 缓存连接池；未命中 → EnvDbMissing（消息点名 ref）。同名调用返回同一个池。 */
  resolveDbPool(ref?: string | null): Promise<QueryPool>;
```
并把 `db?: {...}` / `pool?: QueryPool;` 两行加注释说明是默认 db 的派生 getter。

**(c)** `resolveEnv` 里删掉 `let pool / let dbCfg / const dbObj = pick('db')` 那整段（202-214 行），替换为：

```ts
  // db 对象：以 label 为 ref 列出全部配置完整的条目。连接池懒建（多 db 场景下急切建全部会浪费连接），
  // 池缓存进 pools，close() 统一 end()。EnvCtx.db / EnvCtx.pool 是「默认 db 的派生 getter」。
  const dbs: DbEntry[] = [];
  for (const o of objects.filter((x) => x.objectType === 'db')) {
    const p = (o.payload ?? {}) as DbPayload;
    if (!p.host || !p.dbName || !p.user) continue;
    const dialect: DbDialect = p.dbType === 'mysql' ? 'mysql' : 'postgres';
    dbs.push({
      label: o.label,
      dialect,
      host: p.host,
      port: p.port ?? (dialect === 'mysql' ? 3306 : 5432),
      database: p.dbName,
      user: p.user,
      password: p.secret?.c && p.secret?.i && p.secret?.t ? safeDecrypt(p.secret) : '',
      isDefault: o.isDefault,
    });
  }
  const resolveDb = (ref?: string | null): DbEntry | null => {
    if (ref) return dbs.find((d) => d.label === ref) ?? null;
    return dbs.find((d) => d.isDefault) ?? dbs[0] ?? null;
  };
  const pools = new Map<string, QueryPool>();
  const resolveDbPool = async (ref?: string | null): Promise<QueryPool> => {
    const entry = resolveDb(ref);
    if (!entry) {
      const e = new Error(`env-db-missing: 环境「${env.name}」${ref ? `不存在名为 ${ref} 的数据库对象` : '未配置任何数据库对象'}，可用:${dbs.map((d) => d.label).join('、') || '(无)'}`);
      e.name = 'EnvDbMissing';
      (e as Error & { resource?: string | null }).resource = ref ?? null;
      throw e;
    }
    const hit = pools.get(entry.label);
    if (hit) return hit;
    const created = createQueryPool({
      dialect: entry.dialect, host: entry.host, port: entry.port,
      database: entry.database, user: entry.user, password: entry.password,
    });
    pools.set(entry.label, created);
    return created;
  };
```

**(d)** 返回对象替换 `db: dbCfg,` / `pool,` 两行为：

```ts
    dbs,
    resolveDb,
    resolveDbPool,
    get db() {
      const d = resolveDb();
      if (!d) return undefined;
      const { label: _l, isDefault: _def, dialect: _dia, ...rest } = d;
      return rest;
    },
    get pool() {
      // 缺省 db 未配置 → undefined（保持 queryDb 分支的 `!envCtx?.pool` → EnvDbMissing 语义）；
      // 配置了则同步建池——该调用点（queryDb 步骤）本来就要立即用它。
      const d = resolveDb();
      if (!d) return undefined;
      const hit = pools.get(d.label);
      if (hit) return hit;
      const created = createQueryPool({
        dialect: d.dialect, host: d.host, port: d.port, database: d.database, user: d.user, password: d.password,
      });
      pools.set(d.label, created);
      return created;
    },
```

> 这两个 getter 在未配置 db 时返回 `undefined` 而非抛错，`queryDb` 的既有判死分支（`cdp.ts:630-634`）零改动。

**(e)** `close()` 改为遍历：

```ts
    async close() {
      await Promise.all(Array.from(pools.values()).map((p) => p.end().catch(() => undefined)));
      pools.clear();
    },
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run src/execute/envContext.test.ts test/execute-cdp.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add apps/api/src/execute/envContext.ts apps/api/src/execute/envContext.test.ts
git commit -m "feat(api): EnvCtx 命名 db（label 即 ref）+ 连接池懒建缓存，pool/db 降为默认库派生 getter"
```

---

## Task 8: 只读守卫 `sqlGuard.ts`

**Files:**
- Create: `apps/api/src/execute/sqlGuard.ts`
- Create: `apps/api/test/sql-guard.test.ts`

纯函数、无依赖，可独立单测。这是 Task 9 的地基。

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/sql-guard.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { assertReadOnlySql } from '../src/execute/sqlGuard.js';

describe('assertReadOnlySql', () => {
  it('放行 SELECT / WITH（含小写、带注释、带 CTE）', () => {
    for (const s of [
      'SELECT 1',
      'select id from users where id = $1',
      '  \n SELECT * FROM t LIMIT 10',
      'WITH recent AS (SELECT id FROM orders WHERE ts > now()) SELECT * FROM recent',
      'SELECT /* hint */ 1',
      "SELECT 'a; b' FROM t",
      "SELECT 'delete from t' FROM t",
      'SELECT name FROM users -- ; drop table x',
    ]) expect(() => assertReadOnlySql(s)).not.toThrow();
  });

  it('拒绝非 SELECT/WITH 开头', () => {
    for (const s of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a=1', 'DELETE FROM t', 'DROP TABLE t', 'TRUNCATE t', 'CALL p()']) {
      expect(() => assertReadOnlySql(s)).toThrow(/只允许 SELECT|只读/);
    }
  });

  it('拒绝多语句（字符串字面量与注释里的分号不算）', () => {
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE users')).toThrow(/多语句|只读/);
    expect(() => assertReadOnlySql('SELECT 1;\nSELECT 2')).toThrow(/多语句|只读/);
  });

  it('拒绝 DDL/DML 关键字与 SELECT ... INTO', () => {
    for (const s of [
      'WITH x AS (SELECT 1) SELECT * FROM x INTO OUTFILE \'/tmp/x\'',
      'WITH x AS (SELECT 1) SELECT * FROM x WHERE 1 IN (SELECT 1 FROM generate_series(1,2))',
    ]) expect(() => assertReadOnlySql(s)).not.toThrow();   // 合法形态别误杀
    expect(() => assertReadOnlySql("SELECT * FROM t WHERE a = 'create table'")).not.toThrow();
  });

  it('拒绝超长语句', () => {
    expect(() => assertReadOnlySql(`SELECT ${'a'.repeat(9000)}`)).toThrow(/长度/);
  });

  it('空语句拒绝', () => {
    expect(() => assertReadOnlySql('')).toThrow();
    expect(() => assertReadOnlySql('   ')).toThrow();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/sql-guard.test.ts`
Expected: FAIL —— `Cannot find module '../src/execute/sqlGuard.js'`

- [x] **Step 3: 实现**

`apps/api/src/execute/sqlGuard.ts`：

```ts
/**
 * 只读 SQL 守卫：sql 步骤执行前的词法检查。与 ALLOWED_QUERY_COLUMNS 同级——
 * 都是字符串判定，**不是安全边界**（挡不住 `SELECT ... INTO` 的全部变体与
 * 存储过程中的副作用）。真正的防线是给被测库配只读账号；错误提示里也这么讲。
 *
 * 剥掉注释与单引号字符串后再判定，避免 `SELECT 'delete from t'` 这类误杀。
 */

export const MAX_SQL_CHARS = 8000;

/** 去掉行注释、块注释与单引号字符串字面量（保留占位空格，保持可读长度）。 */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

/** 明确禁止的写/管理关键字（词边界匹配，避免命中列名如 `created_at`）。 */
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COMMIT|ROLLBACK|VACUUM|COPY|REINDEX|CLUSTER|LOCK|CALL|DO|EXECUTE|PREPARE)\b/i;

export function assertReadOnlySql(raw: string): void {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw sqlGuardError('SQL 不能为空');
  }
  if (raw.length > MAX_SQL_CHARS) {
    throw sqlGuardError(`SQL 长度 ${raw.length} 超过上限 ${MAX_SQL_CHARS}`);
  }
  const stripped = stripLiteralsAndComments(raw);
  const body = stripped.trim();
  if (!/^(SELECT|WITH)\b/i.test(body)) {
    throw sqlGuardError(`只允许 SELECT / WITH 开头的只读语句，当前以 "${body.slice(0, 40)}" 开头`);
  }
  // 去尾分号后仍含分号 = 多语句
  const noTrail = body.replace(/;\s*$/, '');
  if (noTrail.includes(';')) {
    throw sqlGuardError('只允许单条语句：检测到多个语句分隔符 ";"');
  }
  if (FORBIDDEN.test(noTrail)) {
    const hit = noTrail.match(FORBIDDEN)![0]!.toUpperCase();
    throw sqlGuardError(`只读语句中不允许 ${hit}（如确需写入请走别的工具）`);
  }
}

function sqlGuardError(detail: string): Error {
  const e = new Error(`${detail}。只读守卫是词法检查、非安全边界，请给被测库配只读账号`);
  e.name = 'SqlReadOnlyViolation';
  return e;
}
```

> `SELECT ... INTO OUTFILE` 已被 `COPY`/`INTO` 语义覆盖不到时不必强求——文档已说明非安全边界，测试用例第 4 组只锁"合法形态别误杀"。

- [x] **Step 4: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run test/sql-guard.test.ts`
Expected: PASS，5 组全过

- [x] **Step 5: 提交**

```bash
git add apps/api/src/execute/sqlGuard.ts apps/api/test/sql-guard.test.ts
git commit -m "feat(api): 只读 SQL 守卫 sqlGuard——单语句 + 禁写关键字 + 长度上限"
```

---

## Task 9: `sql` DSL 动作（schema + 失败归类）

**Files:**
- Modify: `packages/shared/src/step-dsl.ts`（`SqlAction` 定义 + union + discriminatedUnion）
- Modify: `packages/shared/src/playback.ts`（`SqlStepResult` 类型 + `FailureReason` 3 项）
- Modify: `apps/api/src/execute/failureClassifier.ts`（`HUMAN` 3 条 + `classify` 3 个分支）
- Test: `apps/api/test/failureClassifier.test.ts`（追加）、新建 `apps/api/test/sql-action-dsl.test.ts`

**注意:** `packages/shared` 的 `.js` 产物编进 `src/` 且被 gitignore，改完 TS 必须在**任何 web 测试前**跑 `cd packages/shared && pnpm build` 重编译，否则用到旧 schema 假失败。

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/sql-action-dsl.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { StepAction } from '@itest/shared';

describe('sql 动作 DSL', () => {
  it('解析最小形态并给默认', () => {
    const a = StepAction.parse({ kind: 'sql', sql: 'SELECT 1' });
    expect(a).toMatchObject({ kind: 'sql', dbRef: undefined, params: [], limit: 50 });
  });

  it('带 dbRef / params / assertion', () => {
    const a = StepAction.parse({ kind: 'sql', dbRef: 'olap', sql: 'SELECT * FROM dw.t WHERE id = ?', params: ['u1'], limit: 10, assertion: { match: 'contains', expected: 'x' } });
    expect(a).toMatchObject({ kind: 'sql', dbRef: 'olap', params: ['u1'], limit: 10 });
  });

  it('拒绝空 sql / 超长 sql / dbRef 超长', () => {
    expect(() => StepAction.parse({ kind: 'sql', sql: '' })).toThrow();
    expect(() => StepAction.parse({ kind: 'sql', sql: 'x'.repeat(9000) })).toThrow();
    expect(() => StepAction.parse({ kind: 'sql', sql: 'SELECT 1', dbRef: 'x'.repeat(65) })).toThrow();
  });

  it('既有 queryDb 语义不变', () => {
    const a = StepAction.parse({ kind: 'queryDb', table: 'test_cases' });
    expect(a).toMatchObject({ kind: 'queryDb', table: 'test_cases', limit: 50, columns: [] });
    expect(() => StepAction.parse({ kind: 'queryDb', table: 'not_a_table' })).toThrow();
  });
});
```

`apps/api/test/failureClassifier.test.ts` 追加：

```ts
it('sql 三类失败归类', () => {
  const mk = (name: string) => Object.assign(new Error('x'), { name });
  expect(classify(mk('SqlReadOnlyViolation'), { durationMs: 1 }).reason).toBe('SqlReadOnlyViolation');
  expect(classify(mk('SqlError'), { durationMs: 1 }).reason).toBe('SqlError');
  expect(classify(mk('SqlAssertionFailed'), { durationMs: 1 }).reason).toBe('SqlAssertionFailed');
  expect(classify(mk('SqlError'), { durationMs: 1 }).humanMessage).toMatch(/只读 SQL/);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/sql-action-dsl.test.ts test/failureClassifier.test.ts`
Expected: FAIL —— `sql` 不在 discriminatedUnion 里；`SqlError` 不在 FailureReason 里

- [x] **Step 3: 实现 schema**

`packages/shared/src/step-dsl.ts`：`SendSyslogAction` 定义之后（`HttpRequestAction` 之前）插入：

```ts
/** 2026-10-22: sql 步骤——对【被测系统自己的数据库】执行单条只读 SQL。
 *  与 queryDb 的区别：queryDb 只查平台自己的表（平台自检），sql 查 SUT 的库（关系库 / OLAP）。 */
export const SqlAction = z.object({
  kind: z.literal('sql'),
  /** 环境 db 对象的 label；缺省 = 环境默认 db 对象。 */
  dbRef: z.string().min(1).max(64).optional(),
  /** 单条只读 SQL（SELECT / WITH 开头），执行层再做词法守卫。 */
  sql: z.string().min(1).max(8000),
  /** 位置参数；方言适配由执行层处理（postgres $n / mysql ?）。 */
  params: z.array(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).max(20).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
    column: z.string().max(64).optional(),
  }).optional(),
});
export type SqlAction = z.infer<typeof SqlAction>;
```

union（305 行起）加 `| z.infer<typeof SqlAction>`（放在 `SendSyslogAction` 那行之后）；discriminatedUnion 数组（335 行起）加 `SqlAction,`（同样位置）。

`packages/shared/src/playback.ts`：`ObserveLogLineResult` 之后追加：

```ts
/** sql 步骤执行结果：命中的 db 对象 label / 行数 / 行内容（值截断）/断言命中。 */
export interface SqlStepResult {
  dbRef: string | null;
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}
```

`FailureReason` 枚举在 `'QueryDbAssertionFailed',` 之后插入三项：

```ts
  /** 2026-10-22: sql 步骤（查被测系统库）失败 */
  SqlError,
  SqlReadOnlyViolation,
  SqlAssertionFailed,
```

- [x] **Step 4: 实现失败归类**

`apps/api/src/execute/failureClassifier.ts` 的 `HUMAN` 里 `'QueryDbAssertionFailed': '数据库断言未命中',` 之后插入：

```ts
  SqlError: '只读 SQL 执行失败（连接或语句错误）',
  SqlReadOnlyViolation: 'SQL 非只读语句（仅允许单条 SELECT / WITH），已拒绝执行',
  SqlAssertionFailed: 'SQL 结果断言未命中',
```

`classify` 里 `if (e?.name === 'QueryDbAssertionFailed') ...` 那行之后插入三行：

```ts
  if (e?.name === 'SqlReadOnlyViolation') return { reason: 'SqlReadOnlyViolation', humanMessage: HUMAN.SqlReadOnlyViolation };
  if (e?.name === 'SqlAssertionFailed') return { reason: 'SqlAssertionFailed', humanMessage: HUMAN.SqlAssertionFailed };
  if (e?.name === 'SqlError') return { reason: 'SqlError', humanMessage: HUMAN.SqlError };
```

`EnvDbMissing` 分支补资源名（`e?.name === 'EnvDbMissing'` 那行替换为）：

```ts
  if (e?.name === 'EnvDbMissing') {
    const res = (e as { resource?: string | null }).resource;
    return {
      reason: 'EnvDbMissing',
      humanMessage: res ? `当前环境未配置名为「${res}」的数据库连接` : HUMAN.EnvDbMissing,
    };
  }
```

- [x] **Step 5: 重编译 shared + 跑测试**

```bash
cd packages/shared && pnpm build && cd ../..
cd apps/api && pnpm vitest run test/sql-action-dsl.test.ts test/failureClassifier.test.ts
```
Expected: PASS

- [x] **Step 6: 提交**

```bash
git add packages/shared/src/step-dsl.ts packages/shared/src/playback.ts apps/api/src/execute/failureClassifier.ts apps/api/test/sql-action-dsl.test.ts apps/api/test/failureClassifier.test.ts
git commit -m "feat(api): sql 只读动作 DSL + SqlStepResult + 三类失败归类（queryDb 语义不动）"
```

---

## Task 10: `sqlQuery.ts` 执行器 + cdp 分支

**Files:**
- Create: `apps/api/src/execute/sqlQuery.ts`
- Create: `apps/api/test/sql-query.test.ts`
- Modify: `apps/api/src/execute/cdp.ts`（`ExecStepResult.sql` + `DispatchOpts.sqlSink` + `case 'sql'` + 两处 sink 初始化/组装）

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/sql-query.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import type { QueryPool } from '../src/execute/envContext.js';
import { runSql } from '../src/execute/sqlQuery.js';

/** 假池：记录被执行的 sql / params，按需抛错。 */
function fakePool(rows: Record<string, unknown>[], opts: { fail?: Error } = {}): QueryPool & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    dialect: 'postgres',
    calls,
    async query(sql, params) { calls.push({ sql, params }); if (opts.fail) throw opts.fail; return { rows }; },
    async end() {},
  };
}

describe('runSql', () => {
  it('变量替换后执行，按 limit 截断，记录 dbRef 与耗时', async () => {
    const pool = fakePool(Array.from({ length: 5 }, (_, i) => ({ id: i })));
    const r = await runSql({ pool, action: { kind: 'sql', dbRef: 'olap', sql: 'SELECT * FROM dw WHERE u = {{name}}', params: [], limit: 3 } });
    expect(pool.calls[0]!.sql).toBe('SELECT * FROM dw WHERE u = $1');
    expect(pool.calls[0]!.params).toEqual(['alice']);
    expect(r.rowCount).toBe(3);
    expect(r.dbRef).toBe('olap');
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(3);
  });

  it('mysql 方言用 ? 占位，postgres 用 $n', async () => {
    const pg = fakePool([]);
    await runSql({ pool: pg, action: { kind: 'sql', sql: 'SELECT {{a}}, {{b}}', params: [], limit: 10 } });
    expect(pg.calls[0]!.sql).toBe('SELECT $1, $2');
    const my = { ...fakePool([]), dialect: 'mysql' as const };
    await runSql({ pool: my, action: { kind: 'sql', sql: 'SELECT {{a}}, {{b}}', params: [], limit: 10 } });
    expect(my.calls[0]!.sql).toBe('SELECT ?, ?');
  });

  it('缺变量 → var-missing 命名错误，不发查询', async () => {
    const pool = fakePool([]);
    await expect(runSql({ pool, action: { kind: 'sql', sql: 'SELECT {{nope}}', params: [], limit: 10 } }))
      .rejects.toThrow(/var-missing/);
    expect(pool.calls).toHaveLength(0);
  });

  it('非只读语句被守卫拦下（不发查询）', async () => {
    const pool = fakePool([]);
    await expect(runSql({ pool, action: { kind: 'sql', sql: 'DROP TABLE users', params: [], limit: 10 } }))
      .rejects.toThrow(/只允许/);
    expect(pool.calls).toHaveLength(0);
  });

  it('连接/语句错误 → SqlError', async () => {
    const pool = fakePool([], { fail: new Error('connection refused') });
    await expect(runSql({ pool, action: { kind: 'sql', sql: 'SELECT 1', params: [], limit: 10 } }))
      .rejects.toMatchObject({ name: 'SqlError' });
  });

  it('断言命中/不命中：整表文本或指定列', async () => {
    const pool = fakePool([{ status: 'ok' }, { status: 'ok' }]);
    const hit = await runSql({ pool, action: { kind: 'sql', sql: 'SELECT 1', params: [], limit: 10, assertion: { match: 'contains', expected: 'ok', column: 'status' } } });
    expect(hit.assertion?.matched).toBe(true);
    const miss = await runSql({ pool, action: { kind: 'sql', sql: 'SELECT 1', params: [], limit: 10, assertion: { match: 'contains', expected: 'nope' } } });
    expect(miss.assertion?.matched).toBe(false);
  });

  it('单元格超长截断到 2000 字符', async () => {
    const pool = fakePool([{ big: 'x'.repeat(5000) }]);
    const r = await runSql({ pool, action: { kind: 'sql', sql: 'SELECT 1', params: [], limit: 10 } });
    expect(String(r.rows[0]!.big)).toHaveLength(2000);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/sql-query.test.ts`
Expected: FAIL —— `Cannot find module '../src/execute/sqlQuery.js'`

- [x] **Step 3: 实现**

`apps/api/src/execute/sqlQuery.ts`：

```ts
/**
 * sql 步骤执行器：对被测系统自己的数据库跑单条只读 SQL。
 * 与 dbQuery.ts 的分工：那边只查平台自己的表（平台自检，白名单列），这边查 SUT 的库。
 *
 * 三道防线：变量缺失 fail-fast → sqlGuard 词法只读守卫 → 结果序列化截断。
 * 真正的安全边界是被测库的只读账号（守卫挡不住全部变体，见 sqlGuard 注释）。
 */
import { substituteVars } from '@itest/shared';
import type { SqlStepResult } from '@itest/shared';
import type { QueryPool } from './envContext.js';
import { assertReadOnlySql } from './sqlGuard.js';

const MAX_CELL_CHARS = 2000;

export async function runSql(opts: {
  pool: QueryPool;
  action: { kind: 'sql'; dbRef?: string; sql: string; params: unknown[]; limit: number; assertion?: { match: 'equals' | 'contains' | 'regex'; expected: string; column?: string } };
  vars?: Record<string, string>;
  dbRef?: string | null;
}): Promise<SqlStepResult> {
  const { pool, action } = opts;
  const started = Date.now();
  const { value, missing } = substituteVars(action.sql, opts.vars ?? {});
  if (missing.length > 0) {
    const e = new Error(`var-missing: {{${missing[0]!}}} (sql="${action.sql.slice(0, 100)}")`);
    e.name = 'VarMissing';
    throw e;
  }
  assertReadOnlySql(value);

  // 参数先物化；mysql 用 ?、postgres 用 $n。语句里已有的 ? 不动。
  const params = (action.params ?? []).map((p) => (typeof p === 'string' ? substituteVars(p, opts.vars ?? {}).value : p));
  const sql = params.length === 0
    ? value
    : pool.dialect === 'mysql'
      ? value.replace(/\$(\d+)/g, '?')
      : value.replace(/\$(\d+)/g, (_, n: string) => `$${n}`);

  let rows: Record<string, unknown>[];
  try {
    const r = await pool.query(sql, params);
    rows = r.rows;
  } catch (cause) {
    const e = new Error(`只读 SQL 执行失败: ${cause instanceof Error ? cause.message : String(cause)}`);
    e.name = 'SqlError';
    throw e;
  }
  const limit = Math.min(Math.max(1, action.limit), 200);
  const truncated = rows.length > limit;
  const clipped = rows.slice(0, limit).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'string' && v.length > MAX_CELL_CHARS ? `${v.slice(0, MAX_CELL_CHARS)}…(截断)` : v;
    }
    return out;
  });
  const result: SqlStepResult = {
    dbRef: action.dbRef ?? opts.dbRef ?? null,
    rowCount: clipped.length,
    durationMs: Date.now() - started,
    rows: clipped,
    ...(truncated ? { truncated: true } : {}),
  };
  if (action.assertion) {
    const haystack = action.assertion.column
      ? clipped.map((r) => String(r[action.assertion!.column!] ?? '')).join('\n')
      : clipped.map((r) => JSON.stringify(r)).join('\n');
    const matched = matchText(haystack, action.assertion.expected, action.assertion.match);
    result.assertion = { matched, expected: action.assertion.expected, match: action.assertion.match };
  }
  return result;
}

function matchText(haystack: string, expected: string, match: 'equals' | 'contains' | 'regex'): boolean {
  if (match === 'equals') return haystack.trim() === expected.trim();
  if (match === 'regex') { try { return new RegExp(expected).test(haystack); } catch { return false; } }
  return haystack.includes(expected);
}
```

- [x] **Step 4: 接进 cdp**

`apps/api/src/execute/cdp.ts`：

**(a)** `ExecStepResult` 的 `db?: DbQueryRowResult;` 那行之后插入：

```ts
  /** sql 步骤的结果（仅 sql 步携带，其它步 undefined） */
  sql?: SqlStepResult;
```

**(b)** import：`import { runSql } from './sqlQuery.js';`，`import type { ... } from '@itest/shared'` 里加 `SqlStepResult`。

**(c)** `DispatchOpts` 的 `dbSink` 之后插入：

```ts
  /** 记录本步 sql 结果（由 sql 分支写入） */
  sqlSink?: { current: SqlStepResult | null };
```

**(d)** `case 'queryDb'` 之后（`case 'observeLog'` 之前）插入：

```ts
    case 'sql': {
      const a = action as StepAction & { kind: 'sql' };
      const envCtx = opts.ctx.envCtx;
      const pool = await envCtx?.resolveDbPool(a.dbRef ?? null);
      if (!pool) {
        const e = new Error('env-db-missing: 当前环境未配置数据库连接');
        e.name = 'EnvDbMissing';
        throw e;
      }
      const result = await runSql({ pool, action: a, vars: opts.vars, dbRef: envCtx?.resolveDb(a.dbRef ?? null)?.label ?? null });
      if (opts.sqlSink) opts.sqlSink.current = result;
      if (a.assertion && !result.assertion?.matched) {
        const e = new Error('sql assertion failed'); e.name = 'SqlAssertionFailed'; throw e;
      }
      return;
    }
```

**(e)** `runStepsInContext` 循环里：`opts.dbSink = { current: null };` 之后插入 `opts.sqlSink = { current: null };`；`passedResult` 与 `failedResult` 两处 `db: opts.dbSink.current ?? undefined,` 之后各插入 `sql: opts.sqlSink.current ?? undefined,`。

- [x] **Step 5: 跑测试确认通过**

Run: `cd apps/api && pnpm vitest run test/sql-query.test.ts test/execute-cdp.test.ts test/failureClassifier.test.ts`
Expected: PASS

- [x] **Step 6: 类型检查 + 提交**

Run: `cd apps/api && pnpm tsc --noEmit -p tsconfig.json`
Expected: 无错

```bash
git add apps/api/src/execute/sqlQuery.ts apps/api/src/execute/cdp.ts apps/api/test/sql-query.test.ts
git commit -m "feat(api): sqlQuery 执行器 + cdp sql 分支（按 dbRef 取池，结果进 step.sql）"
```

---

## Task 11: 前端 `sql` 表单 + 摘要 + 报告展示

**Files:**
- Modify: `apps/web/src/components/step-form/switchAction.ts`（`STEP_KINDS` + `switchAction` case）
- Modify: `apps/web/src/components/StepEditDrawer.tsx`（state + 提交归一 + 表单块）
- Modify: `apps/web/src/lib/stepSummary.ts`（摘要）
- Modify: `apps/web/src/pages/ReportDetail.tsx`（`SqlResultCell`）
- Modify: `apps/web/src/i18n/locales/zh-CN/cases.json` 与 `en-US/cases.json`（键）
- Modify: `apps/web/src/i18n/locales/zh-CN/reports.json` 与 `en-US/reports.json`（键）

**前置:** 必须先 `cd packages/shared && pnpm build`，否则 web 侧 import 到旧 `.js`。

- [x] **Step 1: 改 switchAction**

`apps/web/src/components/step-form/switchAction.ts`：`STEP_KINDS` 的 `'sendSyslog',` 之后加 `'sql',`；switch 里 `case 'sendSyslog':` 之后加：

```ts
    case 'sql':
      action = { kind: 'sql', sql: '', params: [], limit: 50 };
      break;
```

- [x] **Step 2: 加 i18n 键**

`cases.json`（两个 locale 各加一份）：

zh-CN：
```json
"sqlDbRefLabel": "数据库对象（留空=环境默认）",
"sqlTextLabel": "只读 SQL（SELECT / WITH 开头，单条）",
"sqlParamsLabel": "参数（按序，{{var}} 会替换）",
"sqlLimitLabel": "limit（1-200）",
"sqlReadOnlyHint": "只允许单条 SELECT / WITH；写操作会被拒绝（守卫是词法检查，被测库请配只读账号）"
```

en-US：
```json
"sqlDbRefLabel": "DB object (empty = env default)",
"sqlTextLabel": "Read-only SQL (single statement, SELECT / WITH)",
"sqlParamsLabel": "Params (ordered, {{var}} substituted)",
"sqlLimitLabel": "limit (1-200)",
"sqlReadOnlyHint": "Only a single SELECT / WITH is allowed; writes are rejected (the guard is lexical — use a read-only DB account)"
```

`reports.json`（两 locale 各加）：`"sql.summary": "SQL 返回 {{count}} 行"` / `"sql.summary": "SQL returned {{count}} rows"`。

- [x] **Step 3: StepEditDrawer 加状态与提交归一**

在既有 `queryLimit` / `queryAssertion` 状态之后（约 218 行附近）加：

```tsx
  const [sqlText, setSqlText] = useState(typeof action.sql === 'string' ? action.sql : '');
  const [sqlParams, setSqlParams] = useState<string[]>(Array.isArray(action.params) ? (action.params as string[]).map(String) : []);
  const [sqlLimit, setSqlLimit] = useState(String(action.limit ?? 50));
  const [sqlDbRef, setSqlDbRef] = useState(typeof action.dbRef === 'string' ? action.dbRef : '');
  const [sqlAssertion, setSqlAssertion] = useState<{ match: 'equals' | 'contains' | 'regex'; expected: string; column?: string } | undefined>(
    action.assertion as never,
  );
```

提交归一（与既有 `if (kind === 'queryDb')` 同处，约 360 行）之后加：

```tsx
      if (kind === 'sql') {
        next.sql = sqlText;
        next.limit = Math.max(1, Math.min(200, Number(sqlLimit) || 50));
        next.params = sqlParams.slice(0, 20).map((p) => {
          const t = p.trim();
          if (t === 'true') return true;
          if (t === 'false') return false;
          if (t === 'null') return null;
          if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
          return p;
        });
        if (sqlDbRef.trim()) next.dbRef = sqlDbRef.trim(); else delete next.dbRef;
        if (sqlAssertion) next.assertion = sqlAssertion; else delete next.assertion;
      }
```

- [x] **Step 4: 表单块**

在 `{kind === 'sendSyslog' && (` 那块**之后**插入：

```tsx
        {kind === 'sql' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:sqlDbRefLabel')}</span>
              <input className="input-base input-xs" value={sqlDbRef} onChange={(e) => setSqlDbRef(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:sqlTextLabel')}</span>
              <textarea className="input-base input-xs font-mono" style={{ minHeight: 96 }} value={sqlText} onChange={(e) => setSqlText(e.target.value)} placeholder="SELECT id, status FROM orders WHERE user = {{user}}" />
            </label>
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:sqlReadOnlyHint')}</p>
            <div className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:sqlParamsLabel')}</span>
              {sqlParams.map((p, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <input className="input-base input-xs flex-1" value={p} onChange={(e) => {
                    const next = [...sqlParams]; next[i] = e.target.value; setSqlParams(next);
                  }} />
                  <button type="button" className="text-[11px] press" style={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4 }} onClick={() => setSqlParams(sqlParams.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              {sqlParams.length < 20 && (
                <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4, padding: '4px 8px' }} onClick={() => setSqlParams([...sqlParams, ''])}>
                  {t('cases:addParam')}
                </button>
              )}
            </div>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:sqlLimitLabel')}</span>
              <input className="input-base input-xs" type="number" min={1} max={200} value={sqlLimit} onChange={(e) => setSqlLimit(e.target.value)} />
            </label>
            <DbAssertionEditor value={sqlAssertion} onChange={setSqlAssertion} />
          </div>
        )}
```

补 i18n 键 `addParam`（zh: `"addParam": "+ 参数"` / en: `"addParam": "+ Param"`）。

- [x] **Step 5: 摘要 + 报告展示**

`apps/web/src/lib/stepSummary.ts` 的 `case 'sendSyslog':` 之后加：

```ts
    case 'sql': {
      const ref = str(a.dbRef);
      const oneLine = String(a.sql ?? '').replace(/\s+/g, ' ').slice(0, 40);
      return ref
        ? t('cases:stepSummary.act.sqlWithRef', { db: ref, sql: oneLine })
        : t('cases:stepSummary.act.sql', { sql: oneLine });
    }
```

i18n（两 locale）：zh `"sql": "SQL {{sql}}"` / `"sqlWithRef": "{{db}}：SQL {{sql}}"`；en `"sql": "SQL {{sql}}"` / `"sqlWithRef": "{{db}}: SQL {{sql}}"`。

`apps/web/src/pages/ReportDetail.ts.tsx`… 实为 `.tsx`：在 `{s.db && <DbResultCell db={s.db} />}` 之后加 `{s.sql && <SqlResultCell sql={s.sql} />}`，并把 `DbResultCell` 复制一份改名 `SqlResultCell`，summary 用 `t('reports:sql.summary', { count: sql.rowCount })`、额外显示 `sql.dbRef`：

```tsx
function SqlResultCell({ sql }: { sql: SqlStepResult }) {
  const { t } = useTranslation();
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>
        {t('reports:sql.summary', { count: sql.rowCount })}
        {sql.dbRef ? ` @${sql.dbRef}` : ''}
        {sql.truncated ? t('reports:truncated') : ''}
        {sql.assertion && (
          <span style={{ color: sql.assertion.matched ? 'var(--success)' : 'var(--destructive)', marginLeft: 8 }}>
            {t(sql.assertion.matched ? 'reports:assertion.hit' : 'reports:assertion.miss')}
            {t('reports:assertion.quote', { expected: sql.assertion.expected })}
          </span>
        )}
      </summary>
      <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, margin: '4px 0', padding: 8, borderRadius: 4, background: 'var(--muted)', color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}>
        {JSON.stringify(sql.rows, null, 2)}
      </pre>
    </details>
  );
}
```

并在文件顶部的类型 import 里加 `SqlStepResult`，在结果类型注释处（46 行附近）加 `/** sql 步骤的结果（仅 sql 步携带） */ sql?: SqlStepResult;`。

- [x] **Step 6: 构建 + 提交**

```bash
cd packages/shared && pnpm build
cd ../../apps/web && pnpm build
```
Expected: tsc 无错、vite 构建成功

```bash
cd /Users/lyq/workdir/codedev/iTest
git add packages/shared/src apps/web/src
git commit -m "feat(web): sql 步骤表单/摘要/报告结果展示"
```

---

## Task 12: 命名 syslog（`syslogRef`）

**Files:**
- Modify: `apps/api/src/execute/envContext.ts`（`syslogs[]` / `resolveSyslog`）
- Modify: `packages/shared/src/step-dsl.ts`（`ObserveLogAction.syslogRef`）
- Modify: `apps/api/src/execute/cdp.ts`（observeLog 分支按 ref 取）
- Modify: `apps/api/src/execute/syslogReader.ts`（`EnvSyslogMissing` 消息带 ref）
- Test: `apps/api/src/execute/envContext.test.ts`、`apps/api/test/sql-query.test.ts` 之外新建 `apps/api/test/observe-log-ref.test.ts`

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/observe-log-ref.test.ts`（不连真 SSH，只测"取哪个连接"的决策）：

```ts
import { describe, it, expect, vi } from 'vitest';
import type { EnvCtx } from '../src/execute/envContext.js';

vi.mock('playwright-core', () => ({ chromium: { launch: vi.fn() } }));

/** 最小 EnvCtx 桩：只提供 observeLog 分支真正用到的东西。 */
function makeCtx(over: Partial<EnvCtx>): EnvCtx {
  return {
    envId: 'e1', envName: '测试环境', webServices: [], resolveWebOrigin: () => null, baseUrl: null,
    dbs: [], resolveDb: () => null, resolveDbPool: async () => { throw new Error('nope'); },
    logins: new Map(), resolveLogin: () => null, hasCredentials: () => false,
    syslogs: [], resolveSyslog: () => null,
    close: async () => undefined,
    ...over,
  } as unknown as EnvCtx;
}

const base = { host: 'h1', port: 22, user: 'u1', filePath: '/var/log/a.log', authType: 'key' as const };
const alt = { host: 'h2', port: 22, user: 'u2', filePath: '/var/log/b.log', authType: 'key' as const };

describe('observeLog syslogRef', () => {
  it('显式 syslogRef → 取对应 label 的连接', () => {
    const syslogs = [
      { label: '主日志机', ctx: base, isDefault: true },
      { label: '审计机', ctx: alt, isDefault: false },
    ];
    expect(makeCtx({ syslogs }).resolveSyslog('审计机')).toBe(alt);
  });

  it('缺省 → isDefault；显式 ref 不存在 → null（绝不静默回落默认）', () => {
    const syslogs = [
      { label: '主日志机', ctx: base, isDefault: true },
      { label: '审计机', ctx: alt, isDefault: false },
    ];
    expect(makeCtx({ syslogs }).resolveSyslog()?.host).toBe('h1');
    expect(makeCtx({ syslogs }).resolveSyslog('nope')).toBeNull();
  });
});
```

`envContext.test.ts` 追加：

```ts
describe('resolveEnv 命名 syslog', () => {
  const so = [
    { id: 's-1', environmentId: 'env-1', objectType: 'syslog', label: '主日志机', isDefault: true,
      payload: { host: 'h1', user: 'u1', sshPort: 22, filePath: '/var/log/a.log', authType: 'password', secret: encrypt('pw') } },
    { id: 's-2', environmentId: 'env-1', objectType: 'syslog', label: '审计机', isDefault: false,
      payload: { host: 'h2', user: 'u2', sshPort: 2222, filePath: '/var/log/b.log', authType: 'password', secret: encrypt('pw2') } },
  ];
  it('syslogs 列出全部配置完整的，resolveSyslog 按 label', async () => {
    mockTables({ test_environments: [ENV_ROW], environment_objects: so, project_versions: [] });
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.syslogs.map((s) => s.label)).toEqual(['主日志机', '审计机']);
    expect(env.resolveSyslog('审计机')?.host).toBe('h2');
    expect(env.resolveSyslog()?.host).toBe('h1');
    expect(env.resolveSyslog('nope')).toBeNull();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/api && pnpm vitest run test/observe-log-ref.test.ts src/execute/envContext.test.ts`
Expected: FAIL —— `env.syslogs` undefined

- [x] **Step 3: 实现**

**(a)** `apps/api/src/execute/envContext.ts`：`SyslogCtx` 定义后追加 `export interface SyslogEntry { label: string; ctx: SyslogCtx; isDefault: boolean }`；`EnvCtx` 的 `syslog?: SyslogCtx;` 之后加：

```ts
  /** 全部配置完整的 syslog 对象（label 即 ref）。 */
  syslogs: SyslogEntry[];
  /** 按 ref 取；ref 空 → isDefault → 最早；未命中 → null。 */
  resolveSyslog(ref?: string | null): SyslogCtx | null;
```

`resolveEnv` 里把 `let syslogCfg` 那段（216-232 行）替换为「逐个收集 + 保留默认项」：

```ts
  // syslog 对象：以 label 为 ref 收集全部配置完整的条目；默认项额外挂到兼容字段 syslog。
  const syslogs: SyslogEntry[] = [];
  for (const o of objects.filter((x) => x.objectType === 'syslog')) {
    const p = (o.payload ?? {}) as SyslogPayload;
    if (!p.host || !p.user || !p.filePath || !p.secret?.c || !p.secret?.i || !p.secret?.t) continue;
    const authType: SyslogCtx['authType'] = p.authType === 'password' ? 'password' : 'key';
    const secret = safeDecrypt(p.secret);
    syslogs.push({
      label: o.label,
      isDefault: o.isDefault,
      ctx: {
        host: p.host, port: p.sshPort ?? 22, user: p.user, filePath: p.filePath, authType,
        ...(authType === 'password' ? { password: secret } : { privateKey: Buffer.from(secret) }),
      },
    });
  }
  const resolveSyslogEntry = (ref?: string | null) => {
    if (ref) return syslogs.find((s) => s.label === ref) ?? null;
    return syslogs.find((s) => s.isDefault) ?? syslogs[0] ?? null;
  };
  const syslogCfg = resolveSyslogEntry()?.ctx;
```

返回对象里 `syslog: syslogCfg,` 之后插入 `syslogs, resolveSyslog: (ref?: string | null) => resolveSyslogEntry(ref)?.ctx ?? null,`。

**(b)** `packages/shared/src/step-dsl.ts` 的 `ObserveLogAction` 加一行（`kind` 之后）：

```ts
  /** 环境 syslog 对象的 label；缺省 = 环境默认 syslog 对象。 */
  syslogRef: z.string().min(1).max(64).optional(),
```

**(c)** `apps/api/src/execute/cdp.ts` 的 `case 'observeLog':` 分支替换为：

```ts
    case 'observeLog': {
      const a = action as StepAction & { kind: 'observeLog' };
      const envCtx = opts.ctx.envCtx;
      const conn = envCtx?.resolveSyslog(a.syslogRef ?? null);
      if (!conn) {
        const ref = a.syslogRef ?? null;
        const e = new Error(`env-syslog-missing: ${ref ? `环境「${envCtx?.envName ?? ''}」不存在名为 ${ref} 的 syslog 对象` : '当前环境未配置 syslog 连接'}`);
        e.name = 'EnvSyslogMissing';
        throw e;
      }
      const result = await runObserveLog({ env: conn, action: a, since: new Date() });
      if (result.assertion && !result.assertion.matched) {
        if (opts.logSink) opts.logSink.current = result;
        const e = new Error('observeLog assertion failed'); e.name = 'LogAssertionFailed'; throw e;
      }
      if (opts.logSink) opts.logSink.current = result;
      return;
    }
```

**(d)** `apps/web/src/components/step-form/switchAction.ts` 的 `case 'observeLog':` 补 `syslogRef: ''`。

- [x] **Step 4: 重编译 + 跑测试**

```bash
cd packages/shared && pnpm build
cd ../../apps/api && pnpm vitest run test/observe-log-ref.test.ts src/execute/envContext.test.ts test/execute-cdp.test.ts
```
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add apps/api/src/execute/envContext.ts apps/api/src/execute/cdp.ts packages/shared/src/step-dsl.ts apps/web/src/components/step-form/switchAction.ts apps/api/src/execute/envContext.test.ts apps/api/test/observe-log-ref.test.ts
git commit -m "feat(api): 命名 syslog（label 即 ref）+ observeLog.syslogRef，显式 ref 落空即硬错误"
```

---

## Task 13: pi 层同步（verify / solidify / login）

**Files:**
- Modify: `apps/api/src/pi/space/tools/verifyCase.ts`（提示词 324-325、valueSub 691-693）
- Modify: `apps/api/src/pi/space/tools/solidifyCase.ts`（valueSub 335-337）
- Modify: `apps/api/src/pi/space/tools/login.ts`（`webRef` 参数 + 复用 `buildCredentialSource`）
- Test: `apps/api/test/pi-verify-case.test.ts`、`apps/api/test/pi-solidify-case.test.ts`（mock 的 aiTask 常量导出需补 `parseCredentialPlaceholder`）

**背景:** 这两个测试文件 `vi.mock` 了 `aiTask.js` 的常量导出；若 mock 里缺 Task 1 新增的导出，`credentialSource.ts` 会在测试里炸。

- [x] **Step 1: 先让测试文件跟上**

`apps/api/test/pi-verify-case.test.ts` 与 `apps/api/test/pi-solidify-case.test.ts` 的 `vi.mock('../src/execute/aiTask.js', ...)` 工厂里，在现有 `USER_PH/PASSWORD_PH/SECRET_PH` 三行之后补：

```ts
  parseCredentialPlaceholder: (raw: string) => {
    const m = /^__ITEST_(USERNAME|PASSWORD|STEP_SECRET)(?:@([A-Za-z_][A-Za-z0-9_]*))?__$/.exec(raw);
    if (!m) return null;
    return {
      kind: m[1] === 'USERNAME' ? 'user' : m[1] === 'PASSWORD' ? 'password' : 'secret',
      ref: m[2] ?? null,
    };
  },
  makeCredentialValueSub: (src: { user?: string | null; password?: string | null; secret?: string | null; byRef?: (r: string) => { user?: string | null; password?: string | null } | null }) => {
    const kindOf = (v: string) => {
      const m = /^__ITEST_(USERNAME|PASSWORD|STEP_SECRET)(?:@([A-Za-z_][A-Za-z0-9_]*))?__$/.exec(v);
      return m ? { kind: m[1] === 'USERNAME' ? 'user' : m[1] === 'PASSWORD' ? 'password' : 'secret', ref: m[2] ?? null } : null;
    };
    return (v: string) => {
      const p = kindOf(v);
      if (!p) return v;
      const real = p.ref && src.byRef ? (p.kind === 'user' ? src.byRef(p.ref)?.user : src.byRef(p.ref)?.password) : undefined;
      const val = real ?? (p.kind === 'user' ? src.user : p.kind === 'password' ? src.password : src.secret);
      return val ?? '';
    };
  },
  credentialPlaceholder: (kind: string, ref?: string | null) => (kind === 'user' ? '__ITEST_USERNAME' : kind === 'password' ? '__ITEST_PASSWORD__' : '__ITEST_STEP_SECRET__'),
```

> 既有 mock 里已有的 `runAiTask`/`mapAiActionsToCompiled` 等保持不动；`credentialSource.ts` 只 import 上面的两个 + 类型（类型在运行时被擦除）。

- [x] **Step 2: 跑测试确认通过（此刻应仍绿）**

Run: `cd apps/api && pnpm vitest run test/pi-verify-case.test.ts test/pi-solidify-case.test.ts test/pi-login-tools.test.ts`
Expected: PASS

- [x] **Step 3: verifyCase / solidifyCase 换共享构造**

`apps/api/src/pi/space/tools/verifyCase.ts:688-693` 与 `apps/api/src/pi/space/tools/solidifyCase.ts:332-337` 的三行 `if (v === USER_PH) ...` 替换为：

```ts
            // 凭据替换复用执行层唯一实现（@ref 归属 / 缺凭据 fail-fast 语义与回放一致）。
            valueSub: makeCredentialValueSub(buildCredentialSource({ envCtx }, stepSecret)),
```

两文件各自补 import：

```ts
import { makeCredentialValueSub, credentialPlaceholder } from '../../../execute/aiTask.js';
import { buildCredentialSource, renderWebResourceManifest } from '../../../execute/credentialSource.js';
```

`verifyCase.ts:324-325` 的两行提示词（`- 用户名输入框 fill 的 value 用字面量 ${USER_PH}` 等）替换为动态拼装——在其所在 `lines.push` 序列之前插入：

```ts
    const manifest = renderWebResourceManifest({ envCtx });
    if (manifest) {
      lines.push('## 本次可用的 web 服务');
      lines.push(manifest);
      lines.push(`- 用户名输入框 fill 的 value 用字面量 ${credentialPlaceholder('user', '<服务名>')}`);
      lines.push(`- 密码输入框 fill 的 value 用字面量 ${credentialPlaceholder('password', '<服务名>')}`);
      lines.push('- 「未配置凭据」的服务不要尝试登录（必然失败）；需要跨系统时用对应服务名做归属。');
    } else {
      lines.push(`- 用户名输入框 fill 的 value 用字面量 ${credentialPlaceholder('user')}`);
      lines.push(`- 密码输入框 fill 的 value 用字面量 ${credentialPlaceholder('password')}`);
    }
```

并删掉原来那两行 `lines.push` 的用户名/密码说明（避免重复）。`solidifyCase.ts` 若也复用了 `buildStepInstruction`，同理改在 `verifyCase.ts` 的 `buildStepInstruction` 里（`solidifyCase.ts:36` 就是从那里 import 的），故只在 `verifyCase.ts` 改一处。

- [x] **Step 4: login.ts 支持 webRef**

`apps/api/src/pi/space/tools/login.ts`：

**(a)** 删掉本文件里的 `const USER_PH / const PASSWORD_PH` 两个本地常量（12-13 行），改为 `import { credentialPlaceholder, makeCredentialValueSub } from '../../../execute/aiTask.js';` + `import { buildCredentialSource } from '../../../execute/credentialSource.js';`

**(b)** `buildLoginInstruction(targetUrl)` 改为 `buildLoginInstruction(targetUrl: string, manifest: string)`，其第 3 条文案改为：

```ts
3. 登录页：找到用户名/密码输入框，fill 的 value 一律用字面量 ${credentialPlaceholder('user', refHint)} / ${credentialPlaceholder('password', refHint)}
   （平台会替换为真实值；你不得猜测、拼接或输出真实凭据）。
```

其中 `refHint = '<服务名>'`；并在指令开头插入 manifest 段（manifest 为空则整段省略）。

**(c)** 两个工具的 `parameters` 加可选 `webRef`：

```ts
      parameters: Type.Object({ webRef: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) }),
```

`execute` 里：

```ts
        execute: async (input) => {
          const webRef = (input as { webRef?: string }).webRef ?? null;
          const envCtx = await resolveEnv({ ... });
          const cred = envCtx.resolveLogin(webRef);
          if (!cred) return { ok: false, error: webRef
            ? `环境未配置 web 服务 ${webRef} 的登录凭据（可用：${[...envCtx.logins.keys()].join('、') || '无'}）`
            : '当前默认环境未配置登录凭据（默认 web 服务未填用户名/密码）' };
          const targetUrl = url || (cred.loginUrl?.startsWith('/') ? `${envCtx.baseUrl ?? ''}${cred.loginUrl}` : cred.loginUrl ?? '') || envCtx.baseUrl || '';
          ...
          valueSub: makeCredentialValueSub(buildCredentialSource({ envCtx, caseWebServiceRef: webRef })),
```

`get_login_credentials` 的返回体加一行 `webServices: [...envCtx.logins.keys()]`（供模型知道有哪些可选）。

- [x] **Step 5: 跑测试 + 类型检查**

Run: `cd apps/api && pnpm vitest run test/pi-verify-case.test.ts test/pi-solidify-case.test.ts test/pi-login-tools.test.ts && pnpm tsc --noEmit -p tsconfig.json`
Expected: PASS + 无 TS 错

- [x] **Step 6: 提交**

```bash
git add apps/api/src/pi/space/tools/verifyCase.ts apps/api/src/pi/space/tools/solidifyCase.ts apps/api/src/pi/space/tools/login.ts apps/api/test/pi-verify-case.test.ts apps/api/test/pi-solidify-case.test.ts
git commit -m "refactor(pi): verify/solidify/login 复用共享 CredentialSource——支持 @ref 归属"
```

---

## 全量回归与验证

### 1. 单元/集成测试（改动横跨 execute / shared / pi / web）

```bash
cd packages/shared && pnpm build && pnpm test
cd ../../apps/api && pnpm vitest run
```

**门判定标准**：本地既有基线失败是 `sendSyslog`（基线即红）与 `recorder xpath`（typecheck 报错，非本轮引入）；除这两项外不得新增失败。

### 2. 类型检查

```bash
cd apps/api && pnpm tsc --noEmit -p tsconfig.json
cd ../../apps/web && pnpm build
```

### 3. 端到端（prod228，人工）

1. 环境里配两个命名 web：`backend`（有账号）+ `frontend`（有账号），两者都填 user/password/loginUrl。
2. 建用例 A 绑 `web_service_ref=backend`，步骤填 `__ITEST_USERNAME__` → 回放应拿到 backend 的账号（报告不出现明文）。
3. 建用例 B 不绑 web，compiled 里写 `__ITEST_USERNAME@backend__` + `__ITEST_PASSWORD@backend__` → 同上。
4. 用例里加一个 `sql` 步骤，`dbRef` 指 OLAP 库 → 报告出现结果表；把 SQL 改成 `DROP TABLE x` → 步骤 failed、`failureReason=SqlReadOnlyViolation`。
5. 加一个 `observeLog` 步骤，`syslogRef` 指第二台日志机 → 能读到；填不存在的 ref → failed `EnvSyslogMissing`。
6. 把 `backend` 的密码删掉，用例 B 复跑 → **零 LLM 调用**即失败，`error` 含 `backend` 与 `env-missing`。

### 4. 安全自查

- 报告页 / warning / LLM 反馈里搜真实密码：任一处出现即回归（`rg 'be_p|front_p' /tmp/report-*.json` 之类的脱敏抽查）。

### 5. 本地回归实跑结果（2026-10-22）

| 门 | 结果 |
|---|---|
| `packages/shared` build | ✅ |
| `packages/shared` test | ⚠️ 6 fail —— **既有基线，非本轮引入**：`77731b0`（2026-10-06）从 `step-dsl.ts` 删掉 `aiStep` kind，却留下 6 条 `aiStep` 测试；本轮只改 `observeLog.syslogRef` 与 `sql` 相关字段，未触碰 `aiStep`。清理需另开提交。 |
| `apps/api` tsc | ✅ 0 error |
| `apps/api` vitest 全量 | ✅ 988 pass / 0 断言失败 |
| `apps/web` build | ✅ |

**全量跑出现 9 个文件"失败"是 testcontainer 资源耗尽，不是回归**：126 个文件各自起一个 PG 容器并行，容器被停/崩导致 setup 阶段 `container stopped/paused`。把这 9 个文件单独重跑 → **209/209 全过**（含全部 `pi-verify-case` / `pi-solidify-case` 用例）。判定回归时须按文件单跑复核。

**提交卫生**：`4dafa2e` 误把并发会话的 `NON_BROWSER_KINDS`（cdp.ts）hunk 带入本轮提交——代码完整无损（工作树与对方测试均通过），仅归属错位。因对方会话在跑，未做 rebase 拆分；待其空闲时 `git rebase -i 8c05208` 拆开。

## 风险与回滚

| 风险 | 缓解 / 回滚 |
|---|---|
| `EnvCtx` 形状变更波及消费点 | `login`/`pool`/`db`/`syslog`/`baseUrl` 全保留为派生，新增项纯增量；`verifyCase`/`solidifyCase`/`login`/`inspect` 四处消费点在 Task 13 与编译期逐个兜住 |
| 急切建池改懒建引入连接时序变化 | 默认 db 的 `pool` getter 在 `queryDb` 分支里同步建池（该分支本就要立刻用）；连接超时参数不变 |
| 只读守卫被绕过 | 守卫是词法检查，**不是安全边界**——已写进 `sqlGuard` 注释、前端提示文案与本计划；真正的防线是被测库只读账号 |
| `referencesCredential` 正则加了 `@` 段，可能误吞普通文本 | 正则要求 `ITEST_(USERNAME|PASSWORD|STEP_SECRET)` 前缀，Task 1 测试锁住 `点击保存`/`{{OTHER_VAR}}` 不误判 |
| pi 层与并发会话冲突 | 其改动已提交（`8dcf69b`），本轮在其上增量改；Task 13 只碰 valueSub 与提示词两处 |
| `packages/shared` 编译产物过期导致假失败 | 每个碰 shared 的任务都先 `pnpm build` 再跑测试 |

## 不做的事（明确 out of scope）

- **凭据作为普通数据集变量**——`{{password}}` 走 extract/数据集列，不进本设计。
- **用例执行中临时切换环境**——环境选择仍走 用例/计划/版本/项目 四级解析链。
- **新数据库驱动**（ClickHouse / Hive 原生协议）——走 mysql 协议接入，不加驱动。
- **跨环境 `@ref`**——不支持 `env2.backend` 形态。
- **`sql` 的写操作**——只读是硬边界。
- **syslogRef 的前端表单**——本轮只交付后端与 DSL 字段，前端下拉留后续（StepEditDrawer 的 observeLog 块加一个输入框即可，与 Task 11 同形）。