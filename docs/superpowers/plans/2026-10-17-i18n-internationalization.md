# iTest 国际化改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 iTest 增加可扩展多语言框架(本期 zh-CN + en-US),覆盖 web UI 壳层、API 错误边界、AI 输出语言,且 SUT 语言定位与展示文案分离。

**Architecture:** react-i18next 资源文件驱动 web UI;语言真相源为后端 `users.languagePreference`,前端 i18n 状态随 auth store 的 user 变化同步;后端错误用现有 `HttpError` 的稳定 code(`body.error`)做前端错误目录;AI 输出在 prompt 装配点注入「语言指令块」,定位文本约束为页面实际文本、展示文本约束为界面语言。存量数据不迁移。

**Tech Stack:** react-i18next, zustand(已有), dayjs(已有), Node 脚本做 key 覆盖率 CI, Chrome `_locales`(recorder)。

**Spec:** `docs/superpowers/specs/2026-10-17-i18n-internationalization-design.md`

**工作约定(全计划通用):**
- **zh 资源 = 现状文案的搬运地**:迁移某字符串时,把中文原样搬进 zh JSON、en 填对应英文,JSX 同时换成 `t()`。三步同宽,保证 zh 界面任何时刻无裸 key。
- **验收闸门**:`pnpm i18n:check`(en key ⊇ zh key)+ `pnpm typecheck` + `pnpm test` 全绿。
- **改动范围纪律**:语言保持 zh 时,视觉与文案零变化。
- 提交风格:常规提交,一次一个 Task 一个 commit。

---

## Phase 0:语言基础设施(纯加法,零行为变化)

### Task 1:安装依赖 + i18n 初始化脚手架

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/i18n/index.ts`
- Create: `apps/web/src/i18n/locales/zh-CN/common.json`
- Create: `apps/web/src/i18n/locales/en-US/common.json`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1:安装 react-i18next 与 i18next**

```bash
cd /Users/lyq/workdir/codedev/iTest && pnpm --filter @itest/web add i18next react-i18next
```

- [ ] **Step 2:建 zh 与 en 的 common 初始资源**

`apps/web/src/i18n/locales/zh-CN/common.json`:
```json
{}
```

`apps/web/src/i18n/locales/en-US/common.json`:
```json
{}
```

- [ ] **Step 3:写 i18n 初始化模块**

`apps/web/src/i18n/index.ts`:
```ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCommon from './locales/zh-CN/common.json';
import enCommon from './locales/en-US/common.json';

export type Lang = 'zh-CN' | 'en-US';

export const LANG_STORAGE_KEY = 'itest-lang';

const resources = {
  'zh-CN': { common: zhCommon },
  'en-US': { common: enCommon },
};

void i18n.use(initReactI18next).init({
  resources,
  lng: readStoredLang(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

/** 未登录 / 首次访问时先从 localStorage 读(登录后由 auth user 覆盖)。 */
export function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    return v === 'en-US' ? 'en-US' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

export function applyHtmlLang(lang: Lang): void {
  document.documentElement.lang = lang === 'en-US' ? 'en' : 'zh-CN';
}

export default i18n;
```

> 注意:后续 Task(Phase 1)每新建一个命名空间,都要在 `index.ts` 的 `resources` 里补一行注册,并 export 对应 JSON。

- [ ] **Step 4:main.tsx 引入 i18n 并应用 html lang**

`apps/web/src/main.tsx` 第 9 行 `import './index.css';` 后加两行:
```ts
import './i18n';
import { applyHtmlLang } from './i18n';
applyHtmlLang(readStoredLang());
```
(上面 `readStoredLang` 也从 `./i18n` import,与 `applyHtmlLang` 同一行或分行皆可)

- [ ] **Step 5:验证**

```bash
pnpm --filter @itest/web typecheck
```
Expected:PASS。启动 `pnpm --filter @itest/web dev` 打开页面,控制台无 i18next 报错,`<html lang="zh-CN">`。

- [ ] **Step 6:Commit**

```bash
git add apps/web/package.json apps/web/src/i18n apps/web/src/main.tsx
git commit -m "feat(web): i18n 脚手架——react-i18next + zh/en 资源骨架"
```

### Task 2:语言状态 store + auth 同步

**Files:**
- Create: `apps/web/src/stores/lang.ts`
- Modify: `apps/web/src/App.tsx`

语言真相源是后端 user,所以 i18n 语言跟随 auth store 的 user 变化,而不是独立 state —— 登录/登出/偏好恢复自动一致。

- [ ] **Step 1:写 lang store**

`apps/web/src/stores/lang.ts`:
```ts
import i18n, { applyHtmlLang, readStoredLang, type Lang } from '../i18n';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

const DAYJS_LOCALES: Record<Lang, string> = { 'zh-CN': 'zh-cn', 'en-US': 'en' };

/** 应用指定语言到 i18n + html lang + dayjs;不持久化(持久化归后端 languagePreference)。 */
export function applyLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  applyHtmlLang(lang);
  dayjs.locale(DAYJS_LOCALES[lang]);
}

/** 从用户语言偏好解析成 Lang;缺失/未知回落默认。 */
export function langFromPref(pref: string | null | undefined): Lang {
  return pref === 'en-US' ? 'en-US' : 'zh-CN';
}
```

- [ ] **Step 2:App.tsx 订阅 user 语言变化**

下面 `langFromPref` 对 user 为 null(未登录登录页)时回落 `readStoredLang()`(读 localStorage 兜底,见 Step 2 内特例说明)。

`apps/web/src/App.tsx` 在现有 theme init effect 旁新增:
```tsx
import { useAuthStore } from './stores/auth';
import { applyLang, langFromPref } from './stores/lang';

// 组件内,initTheme effect 之前/之后均可:
const user = useAuthStore((s) => s.user);
useEffect(() => {
  applyLang(langFromPref(user?.languagePreference));
}, [user?.languagePreference]);
```
同时保留 localStorage 兜底:user 为 null(未登录登录页)时,`langFromPref(null)` 返回 zh-CN —— **改动点**:`langFromPref(null)` 应回落 `readStoredLang()` 而不是硬编码 zh-CN。改成:
```ts
export function langFromPref(pref: string | null | undefined): Lang {
  if (pref === 'en-US') return 'en-US';
  if (pref === 'zh-CN') return 'zh-CN';
  return readStoredLang();
}
```

- [ ] **Step 3:验证登录态恢复**

现有开发环境登录(admin/…),刷新页面 → `<html lang>` 应等于该用户 `languagePreference`(default zh-CN)。改 SQL 或直接库里把某个测试账号 `language_preference` 改成 `en-US`,重新登录,`<html lang="en">`。

- [ ] **Step 4:Commit**

```bash
git add apps/web/src/stores/lang.ts apps/web/src/App.tsx
git commit -m "feat(web): 语言状态随 auth user 同步——i18n/dayjs/html lang"
```

### Task 3:UserMenu 语言切换

**Files:**
- Modify: `apps/web/src/components/layout/UserMenu.tsx`
- Modify: `apps/web/src/api/client.ts`(若 updateMember 复用)

- [ ] **Step 1:加切换逻辑**

`apps/web/src/components/layout/UserMenu.tsx`:
- `import { useTranslation } from 'react-i18next';`
- `import { applyLang, langFromPref } from '../../stores/lang';`
- `import type { Lang } from '../../i18n';`
- 组件内:`const { i18n } = useTranslation();` `const user = useAuthStore((s) => s.user);`(已有)

在「修改密码」上面的 `DropdownMenuSeparator` 前插入语言切换项(镜像主题切换写法):
```tsx
<DropdownMenuItem
  onSelect={(event) => {
    event.preventDefault();
    const next: Lang = langFromPref(i18n.language) === 'en-US' ? 'zh-CN' : 'en-US';
    applyLang(next);
    if (user?.id) {
      void api.users.update(user.id, { languagePreference: next }).catch(() => {
        // 后端持久化失败不阻断切换;下次登录恢复原语言。
      });
    }
    try { localStorage.setItem('itest-lang', next); } catch { /* no-op */ }
  }}
>
  <Icon name="languages" size={14} />
  {langFromPref(i18n.language) === 'en-US' ? '中文' : 'English'}
</DropdownMenuItem>
```
> 需要 `import { api } from '../../api/client';`。`Icon` 组件有 `languages` 图标吗?没有就用现有的 `settings` 或 `globe` —— 实施时先 `grep "languages\|globe" components/Icon.tsx` 确认;没有则加一个别名映射到 lucide `Languages`。`applyLang` 已内含 `i18n.changeLanguage`,**勿重复调用**。

- [ ] **Step 2:验证**

启动 dev,登录 → UserMenu 出现语言项 → 点一下 → 页面 chrome 文案此刻仍是中文(Phase 1 未迁移),但 `<html lang>` 变化、dayjs 语言切换(计划里 ScheduleDialol 的日期间隔显示会变英文)。刷新后语言保持(en 未迁移的 key 回落到 zh,正文仍是中文 —— 符合预期)。

- [ ] **Step 3:Backend 确认 `PATCH /users/:id` 接受 languagePreference**

已在 `users.ts:102` 验证(`z.enum(['zh-CN','en-US']).optional()`),此项零改动。若实施中发现某个页面调用了别的 update 入口,以实际为准。

- [ ] **Step 4:Commit**

```bash
git add apps/web/src/components/layout/UserMenu.tsx
git commit -m "feat(web): UserMenu 语言切换——前端 i18n + 持久化到 languagePreference"
```

### Task 4:keys 覆盖率 CI 脚本

**Files:**
- Create: `apps/web/scripts/check-i18n-keys.mjs`
- Modify: `apps/web/package.json`

- [ ] **Step 1:写对比脚本**

`apps/web/scripts/check-i18n-keys.mjs`:
```js
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const localesDir = new URL('../src/i18n/locales/', import.meta.url);
const namespaces = ['common']; // 每新增命名空间,Phase 1 各 Task 里同步追加

function flatKeys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? flatKeys(v, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

let failed = false;
for (const ns of namespaces) {
  const zh = JSON.parse(readFileSync(join(localesDir, `zh-CN/${ns}.json`), 'utf8'));
  const en = JSON.parse(readFileSync(join(localesDir, `en-US/${ns}.json`), 'utf8'));
  const zhKeys = new Set(flatKeys(zh));
  const enKeys = new Set(flatKeys(en));
  const missing = [...zhKeys].filter((k) => !enKeys.has(k));
  if (missing.length) {
    failed = true;
    console.error(`[i18n] ${ns}: en 缺少 ${missing.length} 个 key:`);
    for (const k of missing) console.error(`  - ${k}`);
  }
}
if (failed) process.exit(1);
console.log('[i18n] 所有命名空间 en ⊇ zh,key 完整。');
```

- [ ] **Step 2:注册 pnpm 脚本**

`apps/web/package.json` 的 `scripts` 加:
```json
"i18n:check": "node scripts/check-i18n-keys.mjs"
```

- [ ] **Step 3:验证**

```bash
pnpm --filter @itest/web i18n:check
```
Expected: `[i18n] 所有命名空间 en ⊇ zh,key 完整。`,exit 0。故意在 zh/common.json 加一个 `"x": "1"`,应报错列出 `x`,再删掉还原。

- [ ] **Step 4:Commit**

```bash
git add apps/web/scripts/check-i18n-keys.mjs apps/web/package.json
git commit -m "chore(web): i18n key 覆盖率 CI——en 必须覆盖 zh"
```

### Task 5:Phase 0 收尾验证

- [ ] **Step 1:全量闸门**

```bash
cd /Users/lyq/workdir/codedev/iTest && pnpm --filter @itest/web typecheck && pnpm --filter @itest/web test
```
Expected:全 PASS。zh 界面零变化(所有迁移还没开始)。

- [ ] **Step 2:Commit(如有微调)**

```bash
git add -A && git commit -m "chore(web): Phase 0 i18n 基础设施收尾"
```

---

## Phase 1:web UI 文案迁移(common → features)

> 迁移规则(Gate):
> 1. JSX 里 `中文` 字面量 → `t('ns:key')`,组件顶部 `import { useTranslation } from 'react-i18next'`,`const { t } = useTranslation()`。
> 2. 非组件文件(纯函数、常量枚举)→ 传 `t` 或改用 key 映射,调用方渲染时翻译。
> 3. zh JSON = 原样搬中文,en JSON = 英文,namespace 在 `i18n/index.ts` 的 `resources` 注册、`check-i18n-keys.mjs` 的 `namespaces` 数组追加。
> 4. 动态插值:`t('ns:has', { count })`;en 复数用 `key_one` / `key_other`。
> 5. 数据映射型文案(状态枚举、表头字典)一并在迁移时转换,禁止遗留散落的 switch(中文)。
> 6. 每个 Task 完成闸门:`pnpm --filter @itest/web typecheck && i18n:check`。
> 7. 每 Task 一个 commit。

### Task 6:common —— layout 与通用组件

**Files:**
- Modify: `apps/web/src/components/layout/UserMenu.tsx`
- Modify: `apps/web/src/components/layout/AppShell.tsx`
- Modify: `apps/web/src/components/ui/EmptyState.tsx`
- Modify: `apps/web/src/components/ui/Modal.tsx`
- Modify: `apps/web/src/components/ui/Pagination.tsx`
- Modify: `apps/web/src/components/ui/FieldLabel.tsx`
- Modify: `apps/web/src/components/ui/RepoFields.tsx`
- Modify: `apps/web/src/components/ui/shadcn/sheet.tsx`(若有可翻译文案)
- Modify: `apps/web/src/components/auth/AuthGuard.tsx`
- Create/Modify: `apps/web/src/i18n/locales/zh-CN/common.json`、`en-US/common.json`
- Modify: `apps/web/src/i18n/index.ts`、`apps/web/scripts/check-i18n-keys.mjs`

**代表示例(实际迁移必须覆盖文件内全部中文字面量,不止示例):**

`UserMenu.tsx` 示例:
```tsx
const { t } = useTranslation(); // 已有 i18n hooks,改用 useTranslation
// 原:<Icon name={theme === 'dark' ? 'sun' : 'moon'} /> {theme === 'dark' ? '浅色主题' : '深色主题'}
// 改:<Icon name={theme === 'dark' ? 'sun' : 'moon'} /> {theme === 'dark' ? t('common:theme.light') : t('common:theme.dark')}
// 原:toast('已切换组织', 'success')
// 改:toast(t('common:orgSwitched'), 'success')
```
`common.json`(zh):
```json
{
  "theme": { "light": "浅色主题", "dark": "深色主题" },
  "orgSwitched": "已切换组织",
  "changePassword": "修改密码",
  "logout": "退出登录",
  "userMenu": "用户菜单",
  "switchOrg": "切换组织"
}
```
(en 对应英文;其余文件的中文全部按此规则平铺进 common,key 语义化命名)

**迁移清单核对法**(每文件):`grep -n '[一-龥]' <file>` 剩 0 行才算完成(注释除外,注释保留中文不回写 JSON)。注释不算用户可见文本,保留。

- [ ] **Step 1:迁移 UserMenu(含语言切换项的文案本地化)**
- [ ] **Step 2:迁移 AppShell、AuthGuard**
- [ ] **Step 3:迁移通用组件 EmptyState / Modal / Pagination / FieldLabel / RepoFields 等**
- [ ] **Step 4:更新 i18n/index.ts 与 check-i18n-keys.mjs(namespace 已存在 common,若 key 足够则无新增)**
- [ ] **Step 5:验证**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check
```
Expected:全绿。`grep -rn '[一-龥]' src/components/layout apps/web...`(本批文件)只剩注释。

- [ ] **Step 6:Commit**

```bash
git add -A && git commit -m "feat(web): common 命名空间——layout 与通用组件文案迁移"
```

### Task 7:auth 与 settings

**Files:**
- Modify: `apps/web/src/pages/LoginPage.tsx`
- Modify: `apps/web/src/components/auth/ChangeMyPasswordModal.tsx`
- Modify: `apps/web/src/pages/Settings.tsx`
- Create: `apps/web/src/i18n/locales/zh-CN/auth.json`、`en-US/auth.json`、`zh-CN/settings.json`、`en-US/settings.json`
- Modify: `apps/web/src/i18n/index.ts`、`apps/web/scripts/check-i18n-keys.mjs`

**代表示例(插值 + provider 参数):**

`LoginPage.tsx` 里类似 `登录`、`账号`、`密码` → `t('auth:login')` 等。`Settings.tsx` 里 `toast('设置已保存', 'success')` → `t('settings:saved')`;`保存中...` → `t('settings:saving')`;`加载中...` → `t('common:loading')`(加载中在很多文件出现,放 common)。

- [ ] **Step 1:迁移 LoginPage(含校验错误提示)**
- [ ] **Step 2:迁移 ChangeMyPasswordModal**
- [ ] **Step 3:迁移 Settings(含配置面板分组标题)**
- [ ] **Step 4:注册 auth / settings 命名空间**
- [ ] **Step 5:验证 + Commit**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check
git add -A && git commit -m "feat(web): auth/settings 命名空间——登录改密与设置页迁移"
```

### Task 8:projects 与 members

**Files:**
- Modify: `apps/web/src/pages/ProjectsHome.tsx`
- Modify: `apps/web/src/pages/MembersPage.tsx`
- Create: `apps/web/src/i18n/locales/{zh-CN,en-US}/{projects,members}.json`
- Modify: `apps/web/src/i18n/index.ts`、`apps/web/scripts/check-i18n-keys.mjs`

**代表示例(插值,`新建项目`、`进入`、邀请成员等):**
```tsx
{t('projects:total', { count: projects.length })}
```
en: `"total_one": "{{count}} project", "total_other": "{{count}} projects"`(复数)。

- [ ] **Step 1:迁移 ProjectsHome(项目卡片、新建项目对话框、版本进入)**
- [ ] **Step 2:迁移 MembersPage(成员表格、角色/状态枚举翻译)**
- [ ] **Step 3:注册命名空间**
- [ ] **Step 4:验证 + Commit**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check
git add -A && git commit -m "feat(web): projects/members 命名空间迁移"
```

### Task 9:groups 与 cases 详情(最大块)

**Files:**
- Modify: `apps/web/src/pages/GroupsPage.tsx`
- Modify: `apps/web/src/pages/CaseDetail.tsx`(1587 行,最大)
- Modify: `apps/web/src/components/ui/StatusPill.tsx` 相关调用方(statusText 枚举)
- Create: `apps/web/src/i18n/locales/{zh-CN,en-US}/{groups,cases}.json`
- Modify: `apps/web/src/i18n/index.ts`、`apps/web/scripts/check-i18n-keys.mjs`

**代表示例:状态枚举转为翻译。** 现有类似 `const statusText: Record<...> = { queued: '排队中', running: '执行中', ... }` 的地方改为:
```tsx
const statusText = (s: string) => t(`cases:status.${s}`);
```
zh JSON:
```json
{ "status": { "queued": "排队中", "running": "执行中", "passed": "通过", "failed": "失败", "draft": "草稿", "completed": "已完成", "ready": "就绪", "pending": "待处理", "review": "待审", "deprecated": "已废弃", "error": "错误", "success": "成功" } }
```
> 执行时先全局 grep 出全部状态枚举源(如 `grep -rn "排队中\|执行中\|已通过" apps/web/src`),统一建一张 `cases:status.*` / 相应 ns 映射,一次性替换各处。

- [ ] **Step 1:全局清点状态枚举 → 建 status 映射表(key 一处、t() 各处)**
- [ ] **Step 2:迁移 GroupsPage(分组树、用例列、批量操作)**
- [ ] **Step 3:迁移 CaseDetail(步骤编辑、AI 面板、执行面板、录制面板文案)**
- [ ] **Step 4:注册命名空间**
- [ ] **Step 5:验证 + Commit**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check
git add -A && git commit -m "feat(web): groups/cases 命名空间——状态枚举统一 translation 化"
```

### Task 10:plans 与 reports

**Files:**
- Modify: `apps/web/src/pages/Plans.tsx`
- Modify: `apps/web/src/pages/PlanDetail.tsx`
- Modify: `apps/web/src/pages/PlanRunDetail.tsx`
- Modify: `apps/web/src/components/plans/ScheduleListCard.tsx`
- Modify: `apps/web/src/components/plans/ScheduleDialog.tsx`
- Modify: `apps/web/src/components/plans/schedule-format.ts`(格式化文案,非组件 → 用 key 返回,调用方翻译或传 t)
- Modify: `apps/web/src/pages/Reports.tsx`
- Modify: `apps/web/src/pages/ReportDetail.tsx`
- Create: `apps/web/src/i18n/locales/{zh-CN,en-US}/{plans,reports}.json`
- Modify: `apps/web/src/i18n/index.ts`、`apps/web/scripts/check-i18n-keys.mjs`

**代表示例(日期文案,must 顺带处理 ScheduleListCard 里硬编码 `dayjs.locale('zh-cn')`):** 该文件 `schedule-format.ts` 若输出「今天/明天/x天前」,改为接收 `lang` 参数或返回结构化描述,由调用方 `t()`。`dayjs.locale('zh-cn')` 的全局强制调用要移除 —— 语言已由 lang store 的 dayjs.locale 统一管理(Task 2)。

- [ ] **Step 1:移除 ScheduleListCard 里 `dayjs.locale('zh-cn')` 硬编码,验证日期组件语言随切换**
- [ ] **Step 2:迁移 Plans / PlanDetail / PlanRunDetail(计划 CRUD 与运行状态流)**
- [ ] **Step 3:迁移 Reports / ReportDetail(报告列表、逐步截图标题、断言结论区)**
- [ ] **Step 4:注册命名空间**
- [ ] **Step 5:验证 + Commit**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check
git add -A && git commit -m "feat(web): plans/reports 命名空间迁移 + 移除 dayjs 硬编码 locale"
```

### Task 11:overview 与 assistant(space-assistant)

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Modify: `apps/web/src/features/overview/components/*.tsx`(OverviewHeader, KpiStripCard, OverviewEmpty, charts: TopFailuresChart, PassRateTrendChart, AiActivityChart, PriorityDonut, RecentRunsStream, RecordingActivityChart, PlanStatusLine)
- Modify: `apps/web/src/features/overview/chartTheme.ts` 若含文案
- Modify: `apps/web/src/features/space-assistant/*.tsx`(SpaceWorkspace, StagePanel, SpaceThreadPane, LiveViewRail, ConfirmCard, SaveDialog)
- Modify: `apps/web/src/features/space-assistant/spaceEventsStore.ts`(若 store 内置中文提示文案)
- Create: `apps/web/src/i18n/locales/{zh-CN,en-US}/{overview,assistant}.json`
- Modify: `apps/web/src/i18n/index.ts`、`apps/web/scripts/check-i18n-keys.mjs`

**代表示例(chart 空态/图例):** `OverviewEmpty` 空文案、`KpiStripCard` 指标名、chart loading/empty 覆盖文案 → `t('overview:...')`。`StagePanel` 阶段标题 → `t('assistant:stage.xxx')`。

> 注意:assistant 面板里 **LLM 生成的内容**不动(数据),只迁移外壳文案(按钮、标题、空态、错误提示)。

- [ ] **Step 1:迁移 overview(仪表盘 KPI/图表壳)**
- [ ] **Step 2:迁移 space-assistant 外壳(会话列、阶段面板、暂存对象区)**
- [ ] **Step 3:注册命名空间**
- [ ] **Step 4:验证 + Commit**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check
git add -A && git commit -m "feat(web): overview/assistant 命名空间——仪表盘与空间助手外壳迁移"
```

### Task 12:environments / datasets / device-targets / mobile

**Files:**
- Modify: `apps/web/src/pages/EnvironmentsPage.tsx`
- Modify: `apps/web/src/pages/DatasetsPage.tsx`
- Modify: `apps/web/src/pages/DeviceTargetsPage.tsx`
- Modify: `apps/web/src/features/mobile-recorder/MobileRecorder.tsx`
- Create: `apps/web/src/i18n/locales/{zh-CN,en-US}/{environments,datasets,device,mobile}.json`
- Modify: `apps/web/src/i18n/index.ts`、`apps/web/scripts/check-i18n-keys.mjs`

- [ ] **Step 1:迁移 EnvironmentsPage / DatasetsPage / DeviceTargetsPage**
- [ ] **Step 2:迁移 MobileRecorder(录制控制、连接面板)**
- [ ] **Step 3:注册命名空间 + 验证 + Commit**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check
git add -A && git commit -m "feat(web): environments/datasets/device/mobile 命名空间迁移"
```

### Task 13:Phase 1 全量收尾(裸中文清点 + 兜底抽查)

- [ ] **Step 1:裸中文字面量清点**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/web && grep -rln '[一-龥]' src --include="*.tsx" --include="*.ts" | grep -v '^src/i18n' | grep -v '/test/'
```
对每个剩余文件:确认剩下的中文字符串是「注释」或「LLM 生成数据的不动区」。可迁移但遗漏的补迁。记录无法清干净的(如运行动态生成的文本)到该文件注释。

- [ ] **Step 2:全量闸门**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check && pnpm --filter @itest/web test
```

- [ ] **Step 3:浏览器冒烟(zh 零变化 + en 关键页)**

dev 起 web+api,登录:
1. 语言保持 zh:随便走 Cases / Plans / Reports 三个页,文案与迁移前一致。
2. UserMenu 切 en-US:三页关键字符串(标题、主按钮、导航)显示英文;无裸 `t('...')` 泄漏(有泄漏即该任务没完成)。

- [ ] **Step 4:Commit**

```bash
git add -A && git commit -m "feat(web): Phase 1 收尾——裸中文清点与双语冒烟"
```

---

## Phase 2:错误目录 + code 透传 + SSE 映射

### Task 14:ApiError 透传 code

**Files:**
- Modify: `apps/web/src/api/client.ts:4-11,39-40`

错误体稳定码在 **`body.error`**(见 `apps/api/src/middleware/errorHandler.ts`: `{ error: err.code, message: err.message }`)。

- [ ] **Step 1:改 ApiError**

```ts
export class ApiError extends Error {
  status: number;
  /** 后端稳定错误码(errorHandler 里 HttpError.code / 'validation_failed' / 'conflict' …)。无码时为 undefined。 */
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
```
request() 里:
```ts
throw new ApiError(res.status, body.message ?? `HTTP ${res.status}`, typeof body?.error === 'string' ? body.error : undefined);
```

- [ ] **Step 2:写单测验证 code 透传**

复用现有测试模式。新建 `apps/web/src/api/client.test.ts`(若已有则追加):
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from './client';

describe('ApiError code', () => {
  it('透传 body.error 为稳定码', async () => {
    const err = new ApiError(403, '需要管理员角色', 'forbidden');
    expect(err.code).toBe('forbidden');
    expect(err.status).toBe(403);
  });
});
```
> 若现有 `client.ts` 无测试文件,新建 `client.test.ts`;`request` 是模块内函数,直接测 ApiError 构造即可(契约主要靠集成)。

- [ ] **Step 3:验证**

```bash
pnpm --filter @itest/web test -- --run client.test.ts && pnpm --filter @itest/web typecheck
```

- [ ] **Step 4:Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/api/client.test.ts
git commit -m "fix(web): ApiError 透传后端稳定错误码 body.error"
```

### Task 15:errors 命名空间目录 + 渲染管线

**Files:**
- Create: `apps/web/src/i18n/locales/{zh-CN,en-US}/errors.json`
- Modify: `apps/web/src/i18n/index.ts`、`apps/web/scripts/check-i18n-keys.mjs`
- Modify: `apps/web/src/stores/ui.ts`(showToast 的错误渲染)或其调用约定
- Modify: `apps/web/src/hooks/*` 若有统一的错误消息抽取(实施时 grep `msg.message\|e.message` 定位)

**设计:全局唯一的「错误码 → 文案」函数。**

- [ ] **Step 1:建 errors.json 目录(初版覆盖高频码)**

`i18n/locales/zh-CN/errors.json`:
```json
{
  "not_found": "资源不存在或无权访问",
  "forbidden": "需要管理员或更高权限",
  "invalid_credentials": "用户名或密码错误",
  "invalid_token": "链接已失效,请重新登录",
  "weak_password": "密码强度不足",
  "conflict": "数据冲突,请刷新后重试",
  "validation_failed": "提交的数据不合法",
  "internal_error": "服务内部错误",
  "unauthorized": "登录已过期,请重新登录"
}
```
en-US 对应英文。**这不是封闭集**:实施时 `grep -rho "new HttpError([^,], '[a-z_]*'" ../api/src | sort -u` 把出现的 code 全登记进来;遗漏的走兜底(Step 3)。

- [ ] **Step 2:写统一解析函数**

`apps/web/src/i18n/index.ts` 追加:
```ts
import i18n from 'i18next'; // 已有
import enErrors from './locales/en-US/errors.json';
import zhErrors from './locales/zh-CN/errors.json';
// resources 里注册 errors 命名空间: 'zh-CN': { ..., errors: zhErrors }, 'en-US': { ..., errors: enErrors }

/** API 错误 → 本地化文案。命中错误码目录用目录;否则回落原始 message。
 *  保证任何未知 code 也不泄漏裸 key(见 errors 命名空间的 _fallback 约定)。 */
export function localizeApiError(err: { code?: string; message?: string }): string {
  if (err?.code && i18n.exists(`errors:${err.code}`)) {
    return i18n.t(`errors:${err.code}`);
  }
  return err?.message ?? '';
}
```
同时在 `errors.json` 里约定一条专门兜底 key(若希望未登记 code 也显示非中文占位,可后续加 `_unknown`;本期未登记 code 直接回落 message,符合「中文兜底」设计)。

- [ ] **Step 3:接入 toast 错误渲染**

在 UI 层报错入口统一替换 —— 实施时 `grep -rn "showToast(.*error)\|toast(.*'" src --include="*.tsx"` 定位所有错误 toast,把 `toast((e as Error).message, 'error')` 换成 `toast(localizeApiError(e as ApiError), 'error')`。`localizeApiError` 入参兼容 `ApiError`(`{code?, message?}`)与普通 Error(返回 message)。

**注意**:消息里可能带动态参数(详情),本期不解析 details 填充;错误码命中即用目录文案,丢失 details 信息可接受(本期范围)。

- [ ] **Step 4:注册 errors 命名空间 + 验证**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web i18n:check
```
单测(可选):`localizeApiError({ code: 'forbidden' })` 返回对应本地文案;`localizeApiError({ code: 'no_such_code' , message: '中文' })` 返回 `'中文'`。

- [ ] **Step 5:Commit**

```bash
git add apps/web/src/i18n apps/web/src/stores/ui.ts apps/web/src/api/client.ts
git commit -m "feat(web): errors 错误码目录——toast 统一经 localizeApiError"
```

### Task 16:SSE 运行事件与状态 pill 映射本地化

**Files:**
- Modify: `apps/web/src/pages/PlanRunDetail.tsx`
- Modify: `apps/web/src/components/plans/*`(状态字样的调用方)
- Modify: `apps/web/src/features/overview/components/RecentRunsStream.tsx`
- Modify: `apps/web/src/stores/planRun.ts`(若存在)或 SSE 消费 store
- 相关页面的 StatusPill `children` 传参处

**代表示例:** 现有 `StatusPill` 组件不翻译自身(children 由调用方传)。调用方多写 `statusText[status]`。Phase 2 让所有状态文案走 `t('cases:status.<status>')`(Task 9 已建)。SSE `PlanRunEvent.type`(`case_done` 等)/`status` 渲染时同样走 `t`。

- [ ] **Step 1:清点所有 StatusPill / statusText 调用点,统一走 cases:status 翻译映射**
- [ ] **Step 2:PlanRunDetail + RecentRunsStream 对 SSE 事件的 type/status 文案本地化**
- [ ] **Step 3:验证(切 en 计划运行页状态徽标为英文)+ Commit**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web test
git add -A && git commit -m "feat(web): 计划运行 SSE 事件状态文案本地化"
```

---

## Phase 3:AI 输出层 + recorder

### Task 17:AI 语言指令块 helper

**Files:**
- Create: `apps/api/src/agent/langDirective.ts`
- Create: `apps/api/test/langDirective.test.ts`

- [ ] **Step 1:写指令块 helper**

`apps/api/src/agent/langDirective.ts`:
```ts
/**
 * AI 输出语言指令块。定位/展示分离:
 * - 展示文案(标题/说明/摘要/回复)跟随界面语言;
 * - 定位用业务文案(Locator.value / assertText.equals / contextText)必须取页面实际文本,禁止翻译。
 * 会追加到 systemPrompt 末尾,由各 prompt 装配点调用。
 */
export type AiLang = 'zh-CN' | 'en-US';

export function langDirective(lang: AiLang): string {
  const uiName = lang === 'en-US' ? 'English' : 'Chinese (简体中文)';
  return [
    '',
    '--- output language rules ---',
    `UI language is ${lang} (${uiName}).`,
    `All user-visible text you produce (case titles, step names, requirement summaries, verdict reasons, assistant replies) MUST be written in ${uiName}.`,
    `All locator matching text you produce (Locator.value for text strategy, assertText.equals, IntentLocator.contextText) MUST be taken verbatim from the actual page snapshot you are given, in the page's own language. NEVER translate, paraphrase, or rewrite locator matching text.`,
    'If the page text is in another language than the UI language, locator text stays in the page language.',
  ].join('\n');
}

export function aiLangFrom(pref: string | null | undefined): AiLang {
  return pref === 'en-US' ? 'en-US' : 'zh-CN';
}
```

- [ ] **Step 2:单测**

`apps/api/test/langDirective.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { langDirective, aiLangFrom } from '../src/agent/langDirective.js';

describe('langDirective', () => {
  it('en/zh 指令块都包含定位文本分离规则', () => {
    for (const lang of ['en-US', 'zh-CN'] as const) {
      const d = langDirective(lang);
      expect(d).toContain(lang);
      expect(d).toContain('NEVER translate');
      expect(d).toContain('page snapshot');
    }
  });
});

describe('aiLangFrom', () => {
  it('未知/缺失回落 zh-CN', () => {
    expect(aiLangFrom('en-US')).toBe('en-US');
    expect(aiLangFrom('ja-JP')).toBe('zh-CN');
    expect(aiLangFrom(null)).toBe('zh-CN');
  });
});
```

- [ ] **Step 3:验证**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm vitest run test/langDirective.test.ts
```
Expected:2 个 describe 全 PASS。

- [ ] **Step 4:Commit**

```bash
git add apps/api/src/agent/langDirective.ts apps/api/test/langDirective.test.ts
git commit -m "feat(api): AI 语言指令块 helper——定位/展示语言分离规则"
```

### Task 18:llm-client 注入指令块

**Files:**
- Modify: `apps/api/src/agent/llm-client.ts`(`LLMRequest` 加 `lang`)
- Modify: `apps/api/src/agent/llm-openai.ts`
- Modify: `apps/api/src/agent/llm-anthropic.ts`
- Modify: `apps/api/src/agent/llm-google.ts`
- Test: `apps/api/test/langDirective.test.ts`(追加)或新增 test

- [ ] **Step 1:LLMRequest 加 lang 字段**

`llm-client.ts` 的 `LLMRequest` 追加一行:
```ts
  /** 界面语言。存在时 systemPrompt 末尾自动追加语言指令块;缺省不追加(兼容旧调用)。 */
  lang?: AiLang;
```
顶部 `import { type AiLang, langDirective } from './langDirective.js';`

- [ ] **Step 2:三个 provider 的 complete() 在发请求前拼接指令块**

以 `llm-openai.ts` 为例(其余两人同样的 append 位,位于构造 messages/system prompt 之前):
```ts
import { langDirective, type AiLang } from './langDirective.js';
// complete(req) 内,后续使用 systemPrompt 之前:
const systemPrompt = req.lang ? `${req.systemPrompt}\n${langDirective(req.lang)}` : req.systemPrompt;
```
> 实施时打开三个 provider 文件,找到「systemPrompt 首次被使用构造请求」的那一行,在其前插入上面对应的局部变量并替换引用。若各 provider 直接读 `req.systemPrompt` 多次,则统一在函数入口先算一次局部变量。

- [ ] **Step 3:验证注入(替代单测——provider 是 SDK 薄封装,不 mock SDK)**

provider 的注入逻辑只有一行字符串拼接(Task 18 Step 2),已由 Task 17 的 `langDirective` 单测覆盖规则内容。此处验证靠 Task 19 Step 3 的集成断言(mock llm client 捕获 `req.lang` 后 `systemPrompt` 含 `--- output language rules ---`),不在本 Task 重复造 SDK mock。

- [ ] **Step 4:验证 + Commit**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm vitest run test/langDirective.test.ts && pnpm typecheck
git add apps/api/src/agent
git commit -m "feat(api): LLM 客户端按 req.lang 自动追加语言指令块"
```

### Task 19:顶层调用方传入 lang(生效接线)

**Files:**
- Modify: `apps/api/src/execute/aiTask.ts`
- Modify: `apps/api/src/agent/judgeCaseOutcome.ts`
- Modify: `apps/api/src/pi/space/tools/*.ts`(stage-tools / verifyCase / solidifyCase / assertionJudge / login / cases / scenarios 等所有构造 `LLMRequest` 或 `systemPrompt` 的地方)
- Modify: `apps/api/src/agent/llmSettings.ts` 若构造请求

- [ ] **Step 1:在每条 LLM 入口拿到语言**

各调用点分布在两类上下文:
- **HTTP 请求上下文**(有 `req.user`)。
- **执行/调度上下文**(`aiTask` 由用例执行携带,`judgeCaseOutcome` 由执行/计划调用)—— 这些把 `case` 或 `plan` 关联的创建者/发起用户语言透传;拿不到时 `aiLangFrom(null)` 回落 zh-CN。

**接线示例**(以 `execute/aiTask.ts` 为例,实际每个调用点按其现有上下文取):
```ts
import { aiLangFrom } from '../agent/langDirective.js';
// ... 构造 LLMRequest 处:
// { lang: aiLangFrom(user?.languagePreference ?? null) }
```
> `aiTask` 的 user 来源:执行由谁触发,若 run 上下文有发起人则用;否则回落。

- [ ] **Step 2:清点网关**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && grep -rn "systemPrompt" src --include="*.ts" | grep -v langDirective | grep -v "test/"
```
对每个出现 `systemPrompt` 的文件:确认它构造 `LLMRequest/LLMClient.complete` 时已带 `lang`;未带的按该文件上下文接线。

- [ ] **Step 3:验证接线(集成级,人工/脚本)**

写一个临时断言脚本或在现有 `execute` 测试里:mock llm client 捕获收到的 `req` 数组
```ts
expect(lastReq.systemPrompt).toContain('--- output language rules ---');
```
为 `aiTask`(有 user)、`judgeCaseOutcome`(无 user → zh-CN 回落)各一例。跑:
```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm vitest run
```

- [ ] **Step 4:Commit**

```bash
git add apps/api/src
git commit -m "feat(api): AI 输出语言接线——执行/助手/判定各入口传 lang"
```

### Task 20:服务端 tool summary 按会话语言格式化

**Files:**
- Create: `apps/api/src/i18n.ts`(服务端小型 t)
- Modify: `apps/api/src/pi/space/tools/case-ops-tools.ts`(summary 模板)
- Modify: `apps/api/src/pi/space/tools/*.ts`(所有 `summary: \`...\`` 中文模板)
- Modify: `apps/api/src/pi/space/router.ts` 或 `stageRoute.ts`(会话语言判定入口)

- [ ] **Step 1:服务端 t helper**

`apps/api/src/i18n.ts`:
```ts
/** 服务端最小 t:按语言返回 tool summary 等模板文案。key 与产物文案同文件,便于对照。 */
export type StLang = 'zh-CN' | 'en-US';

const dict = {
  'case.copied': { 'zh-CN': '已复制用例为「{title}」', 'en-US': 'Copied case "{title}"' },
  'case.updated': { 'zh-CN': '更新「{title}」({keys})', 'en-US': 'Updated "{title}" ({keys})' },
  'case.deleted': { 'zh-CN': '删除「{title}」', 'en-US': 'Deleted "{title}"' },
  'case.moved': { 'zh-CN': '移动「{title}」到分组 {target}', 'en-US': 'Moved "{title}" to group {target}' },
} as const;

type TKey = keyof typeof dict;

export function st(lang: StLang, key: TKey, vars?: Record<string, string | number>): string {
  let s: string = dict[key][lang];
  for (const [k, v] of Object.entries(vars ?? {})) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}
```
> 实施时把 case-ops-tools / cases / scenarios / stage-tools 等处的所有中文 summary 模板逐一搬进 `dict`,流水线式扩容。

- [ ] **Step 2:接线「会话语言」**

`pi/space/router.ts` 或会话创建处把 `aiThreads` 建会话时记语言。**已有字段?** `aiThreads` 表(见 `db/schema.ts`)若无语言列,本 Task **不动 schema**(避免迁移),改为运行时取 `req.user.languagePreference`。即 tool 调用上下文里已有 `req.user`,summary 格式化直接用 `aiLangFrom(req.user.languagePreference)`。

- [ ] **Step 3:替换 summary 模板**

`case-ops-tools.ts:133-145` 为例:
```ts
// 原:const summary = `更新「${title}」(${keys.join('/')})`;
// 改:const summary = st(aiLangFrom(user?.languagePreference), 'case.updated', { title, keys: keys.join('/') });
```
其余文件同法。

- [ ] **Step 4:验证 + Commit**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm typecheck && pnpm vitest run
git add apps/api/src/i18n.ts apps/api/src/pi
git commit -m "feat(api): tool summary 按用户语言格式化——服务端最小 t"
```

### Task 21:Recorder 扩展 Chrome _locales

**Files:**
- Create: `apps/recorder/_locales/zh_CN/messages.json`
- Create: `apps/recorder/_locales/en/messages.json`
- Modify: `apps/recorder/manifest.json`(`default_locale` 移除或保持)
- Modify: `apps/recorder/popup/popup.html`、`popup/panel.html`、录制 HUD 覆盖层(实际文件以 `grep -rn '[一-龥]' apps/recorder` 为准,含 modules 里注入页面显示的字符串)

> Chrome 扩展 `_locales` 只支持 `__MSG_key__` 占位替换 HTML 里固定文本 + `chrome.i18n.getMessage()` 给 JS 用。目录名:中文 `zh_CN`、英文 `en`。

- [ ] **Step 1:消息清单抽取**

把 popup/panel/HUD 的中文提成 message key。`messages.json`(zh_CN):
```json
{
  "title": { "message": "录制面板" },
  "submit": { "message": "确定" },
  "close": { "message": "关闭窗口" },
  "desc": { "message": "在中台用例详情页点击「录制补充」即可开始录制,页面右下角会出现控制面板。" },
  "consoleOrigin": { "message": "中台地址(跨机器访问时改为实际地址)" },
  "save": { "message": "保存" },
  "open": { "message": "打开中台" }
}
```
en 对应英文。

- [ ] **Step 2:HTML 替换占位**

`popup/popup.html` 中 `<h1 id="title">录制面板</h1>` → `<h1 id="title">__MSG_title__</h1>`,其余同理;JS 内动态文案用 `chrome.i18n.getMessage('save')`。

- [ ] **Step 3:语言跟随 bridge 同步(可选增强,本期优先手动)**

spec 里设计为 bridge.js 读 `document.documentElement.lang` 同步到 `chrome.storage`。**实施范围裁定**:先做 `_locales` + popup 手动语言选择自己决定?——Chrome `_locales` 本身没有运行时切换,一个扩展一次一种语言。**本期方案:默认跟随系统扩展显示语言**;若 popup 需要中英手动切换,则放弃 `_locales` 改 JS dict(见"开放项")。**TDD 验证**:`apps/recorder/test/` 现有纯函数测试模式,只对抽取出的词典函数写单测。

> 若实施中发现 HUD 覆盖层是动态 DOM 文案(injected),`_locales` 的 `__MSG__` 只在扩展页面 HTML 生效,注入页面需用 `chrome.i18n.getMessage()`,与扩展页面不同 —— **处理**:HUD 用 `chrome.i18n.getMessage()`。

- [ ] **Step 4:验证 + Commit**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/recorder && pnpm vitest run && pnpm build
git add apps/recorder
git commit -m "feat(recorder): Chrome _locales 中英消息清单"
```

---

## Phase 4:收尾与质量闸

### Task 22:keys-diff CI 挂到 verify + 兜底审查

**Files:**
- Modify: 根 `package.json` / `turbo.json` 或 web package.json

- [ ] **Step 1:把 i18n:check 纳入项目 verify**

`apps/web/package.json`:
```json
"verify": "pnpm typecheck && pnpm i18n:check && pnpm test"
```
(或在根 turbo 任务的 test 前串联。以仓库现有 verify 结构为准,只加 i18n:check 一环。)

- [ ] **Step 2:全仓库兜底扫描**

```bash
cd /Users/lyq/workdir/codedev/iTest && grep -rn "t('" apps/web/src --include="*.tsx" | grep -v "i18n/" | grep -oE "t\('[^:']+" | sort | uniq -c | sort -rn | head
```
抽查 key 未带命名空间前缀的(项目统一带 ns:key,禁止裸 key)。

- [ ] **Step 3:全量闸门**

```bash
cd /Users/lyq/workdir/codedev/iTest && pnpm --filter @itest/web verify
```

- [ ] **Step 4:Commit**

```bash
git add -A && git commit -m "chore: i18n:check 纳入 verify 与全量兜底审查"
```

### Task 23:双语冒烟回归(全链路)

- [ ] **Step 1:zh 全功能巡检(回归零变化)**

按 README 核心流程走一遍:登录 → 新建需求(AI 生成)→ 用例详情 → 执行 → 报告。语言保持 zh,所有环节文案与迁移前一致,执行照常(定位不随语言变化,重点验证中文 SUT 用例仍通过)。

- [ ] **Step 2:en 关键链路**

1. 切 en-US → UI 全英文(漏翻 key 用浏览器 Console i18next 报错定位,补 key)。
2. AI 生成一条用例:用例标题/步骤名英文;`Locator.value`/`contextText` 仍为中文 SUT 页面真实文本。**逐条核对 AI 产出**。
3. assistant 对话:外壳英文、LLM 回复英文。
4. 触发一个 403/404 错误(普通成员访问 admin 接口),toast 显示英文错误目录文案。
5. 计划运行页:状态徽标英文,SSE 事件不崩。

- [ ] **Step 3:记录已知残差到 spec 开放项,更新 spec/plan 若发现设计缺口**

- [ ] **Step 4:Commit(若有修正)**

```bash
git add -A && git commit -m "test: 双语冒烟回路闭合"
```

---

## 自审记录(写完后线做)

- **Spec 覆盖**:@1 框架/语言状态 → Task1-3;@2 范围决策 → 贯穿;@3 架构 → Task1-3;@4 UI 壳 → Task6-13;@5 错误/SSE → Task14-16;@6 AI 输出 → Task17-20;@7 recorder → Task21;@8 shared 不动 → 显式排除;@9 测试 → Task13/22/23;@10 分期/回滚 → Phase 划分;@11 开放项 → recorder _locales 手动切换留到 Task21 裁定。
- **占位符**:无 TBD/TODO。迁移类 Task 用「迁移清单核对法 grep 清点」做完成闸,避免占位。
- **类型一致性**:`AiLang`/`langDirective`(Task17)与 `llm-client`(Task18)一致;`localizeApiError` 签名(Task15)兼容 `ApiError{code?,message?}`(Task14);`t('errors:'+code)`(Task15)与 `i18n.exists` 判定一致。