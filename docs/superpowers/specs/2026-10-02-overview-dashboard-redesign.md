# Overview Dashboard 重做 — 设计 spec

**日期**: 2026-10-02
**状态**: 已批准(待用户最终 spec 复核)
**范围**: `/p/:projectId/overview` 单项目维度概览重做 + 后端聚合接口 + 图表库接入

## 1. 背景与目标

当前 `apps/web/src/pages/Dashboard.tsx` 是项目内的「总览」页,只展示 3 张 KPI 卡 + 最近运行列表,信息密度低、视觉单调,与 iTest 整套设计语言(紫罗兰玻璃 + status pill + staggered fade-up)不一致;用户期望其更像专业 SaaS dashboard。

目标:
- 内容更丰富(KPI + 趋势 + 分布 + 计划 + 录制 + AI + 活动流,7 区段)
- 视觉更活泼(在紫调主色上加青/绿/橙/粉辅助)
- 布局更专业(顶部 KPI 带 + 中部左右双栏 + 底部宽条)
- 数据一次取完,前端不重复查询

## 2. 路径与权限

- URL:`/p/:projectId/overview`(不变)
- 鉴权:沿用 `assertProjectVisible(projectId, user)`,无权限返回 404(不泄露存在性,同现状)
- 项目不存在:返回 404;前端跳 `/`(回到 ProjectsHome)

## 3. 后端聚合接口

**`GET /api/projects/:id/overview?range=7d|30d`**

- 单文件:`apps/api/src/routes/overview.ts`,在 `apps/api/src/index.ts` 注册
- 鉴权失败 → 404(`assertProjectVisible` 抛 `HttpError(404, 'not_found', 'project not found')`)
- 鉴权成功 → 200,返回 JSON(下表)
- `range` 缺省 7d;非法值 → 400(zod schema 校验)
- 数据源 SQL 一次性聚合,避免 web 层 N 次查询

### 3.1 返回结构

```ts
interface OverviewResponse {
  kpi: {
    totalCases: number;
    totalPlans: number;
    passRate: number;          // 0..1
    totalRuns7d: number;
    aiCalls7d: number;
  };
  trend: Array<{
    date: string;              // 'YYYY-MM-DD'(本地时区锚定)
    passed: number;
    failed: number;
    total: number;
  }>;
  topFailures: Array<{
    caseId: string;
    caseTitle: string;
    failureCount: number;
    lastFailureAt: string;
  }>;
  priorityDistribution: Array<{
    priority: 'urgent' | 'high' | 'medium' | 'low';
    count: number;
  }>;
  plans: Array<{
    id: string;
    name: string;
    lastStatus: 'passed' | 'failed' | 'running' | 'queued' | null;
    lastRunAt: string | null;
    passRate: number;          // 0..1
    totalCases: number;
  }>;
  recordingActivity: Array<{
    kind: 'click' | 'input' | 'hover' | 'check' | 'upload' | 'assert' | 'variable';
    count: number;
  }>;
  aiActivity: Array<{
    date: string;
    casesGenerated: number;
    stepsGenerated: number;
  }>;
  recentRuns: Array<{
    id: string;
    caseId: string;
    caseTitle: string;
    status: string;
    durationMs: number | null;
    createdAt: string;
    kind: 'case' | 'plan';
  }>;
}
```

### 3.2 数据源与边界

- `kpi.passRate = passed / totalRuns7d`,`totalRuns7d = 0` → `passRate = 0`
- `trend`:`range=7d` 返 7 个点,`range=30d` 返 30 个点;补 0,不允许缺口
- `topFailures`:Top 5,按 `failureCount` desc;并列时按 `lastFailureAt` desc
- `priorityDistribution`:固定 4 项(无数据项 `count: 0`,前端 donut 不显示空段)
- `plans`:项目下所有 plan;无任何 plan 时返空数组
- `recordingActivity`:MVP 无录制统计表,**固定返空数组**,前端展示「后续接入」占位
- `aiActivity`:`agentRuns` 表聚合;无 → 全 0
- `recentRuns`:最多 10 条;`case` + `plan` 合并按 `createdAt` desc(复用 executions list 的合并逻辑)

## 4. 前端布局与组件拆分

### 4.1 栅格

12 列响应式 grid(`grid-cols-12`);桌面布局
[laptop:略]
─ KPI 带(col-span 各占 12/5 ≈ 等分,实际 `grid-cols-5`)
─ 主区 + 右活动:`grid-cols-12`,主区 `col-span-8`,右活动 `col-span-4`
─ 底部宽条:`col-span-12`,内部分 6/6 或 8/4

移动端(<1024px):折叠为单列;不深度优化(MVP 外)

### 4.2 文件清单

```
apps/web/src/pages/Dashboard.tsx                  # 编排容器(布局 + 数据)
apps/web/src/features/overview/
  api.ts                                       # useOverviewQuery hook
  chartTheme.ts                                # recharts token 封装(读 data-theme)
  components/
    KpiStripCard.tsx                           # 单张 KPI 卡
    PassRateTrendChart.tsx                     # 通过率趋势
    TopFailuresChart.tsx                       # 失败 Top
    PriorityDonut.tsx                          # 优先级分布
    PlanStatusLine.tsx                         # 计划运行状态
    RecentRunsStream.tsx                       # 最近运行
    RecordingActivityChart.tsx                  # 录制活动
    AiActivityChart.tsx                        # AI 活动
    OverviewEmpty.tsx                          # 项目零数据空态
    OverviewSkeleton.tsx                       # 整页骨架
    OverviewHeader.tsx                         # 页面头 + 时间范围 + 刷新
```

规则:
- 图表组件只接收 `data` + `loading`,不直接调 API
- 颜色全部用 design token,**禁止** 硬编码 hex
- recharts 通过 `THEME` 注入 token,不让其走默认色板

## 5. 配色扩展

新增到 `packages/ui/src/tokens.css` `@theme static` 与 `:root[data-theme="dark"]` 块:

```css
--color-chart-1: #7C5CFC;   /* violet  主序列 */
--color-chart-2: #3FC9E8;   /* 青 */
--color-chart-3: #34D399;   /* 绿 */
--color-chart-4: #FBBF24;   /* 橙黄 */
--color-chart-5: #F472B6;   /* 粉红 */

--color-chart-1-soft: rgba(124, 92, 252, 0.16);
--color-chart-2-soft: rgba(63, 201, 232, 0.16);
--color-chart-3-soft: rgba(52, 211, 153, 0.16);
--color-chart-4-soft: rgba(251, 191, 36, 0.16);
--color-chart-5-soft: rgba(244, 114, 182, 0.16);
```

Dark 主题下按现有 `--color-accent: #9B86FF` 模式上调一档亮度。

图表序列色:
- 趋势:chart-1(passed) + chart-2(failed),区域填 chart-*-soft
- Top 失败柱:chart-1,失败数字 var(--color-destructive)
- 优先级分布(urgent→low):chart-4 → chart-1 → chart-2 → chart-3
- 计划运行:success / destructive / accent / muted
- 录制活动:chart-2
- AI 活动:bar=chart-5(粉),line=chart-1(紫)

## 6. 动效

- 沿用现有 `fade-up` + `data-stagger`(Dashboard.tsx 已在用)
- 顶部 KPI5 卡 stagger 50ms
- 主区 / 右活动 / 底部 stagger 80ms
- 图表首次渲染走 recharts `isAnimationActive`,时长 400ms
- hover:`.hover-card` + `translateY(-1px)` + `shadow-middle`,transition 180ms
- KPI 卡 hover 时右侧图标 scale(1 → 1.08),180ms

## 7. 交互矩阵

| 区域 | 点击行为 |
|---|---|
| KPI · 用例总数 | → `/p/:id/groups` |
| KPI · 计划数 | → `/p/:id/plans` |
| KPI · 通过率 | → `/p/:id/reports?filter=passed-7d` |
| KPI · 近7d运行次数 | → `/p/:id/reports?range=7d` |
| KPI · AI调用 | → `/p/:id/requirements` |
| 趋势点 | 仅 tooltip,跳转进 backlog |
| Top 失败 | 跳最近失败报告详情 |
| 优先级段 | 暂不上跳,backlog |
| 计划行 | 跳 `/plans/:id` 或最近 run |
| 最近运行行 | 跳报告详情(同现状) |
| 录制活动 | 暂不上跳 |
| AI 活动 | 暂不上跳 |

## 8. 时间范围与刷新

- `OverviewHeader` 右侧 Segmented:`7d` / `30d`,默认 7d
- 状态存 React Query URL state? 不;存 React Query `queryKey: ['overview', projectId, range]`
- 「刷新」IconButton:`queryClient.invalidateQueries(['overview', projectId, range])`
- `staleTime: 30_000`,`refetchOnWindowFocus: false`

## 9. 错误 / 加载 / 空态

- **加载:`OverviewSkeleton`,各区域显示对应卡片轮廓 + 渐变扫光
- **项目零数据**:整页 `OverviewEmpty` + CTA「去新建用例 → /requirements」「去新建计划 → /plans/new」
- **部分空态**(只有用例无报告):趋势图显示「暂无运行」轻提示;其他区域正常渲染
- **404 项目不可见**:跳 `/`
- **5xx**:全局 toast + 各区域回退到「暂时不可用,点此重试」占位;不阻断其他区域
- **网络断开**:由 `request()` 抛错 + toast,不重复弹

## 10. 测试

前端(vitest):
- `KpiStripCard`:渲染 / 点击触发 navigate
- `chartTheme`:dark / light 切换返回正确色板
- `useOverviewQuery`:query key 含 range,mock fixture

后端(vitest + testcontainers PG):
- `GET /projects/:id/overview`:鉴权失败 404 / 项目不存在 404 / 无数据返回空结构
- 聚合 SQL:fixture 校验通过率 / Top 排序 / 优先级分布计数正确

E2E(现有 E2E 流程,不加新文件):
- 登录 → 进项目 → 触发一次执行 → Overview 显示对应 run

`pnpm verify` 必须绿。

## 11. 兼容性 / 边界

- `recordingActivity` 固定空数组(MVP 无数据源)
- 趋势图无数据补 0,不缺口
- 时区用本地时区(前端 `toLocaleDateString`)
- 后端趋势 14 / 30 个点,`recentRuns` ≤ 10 条,`topFailures` ≤ 5,`priorityDistribution` 固定 4 项

## 12. 显式排除(Out of Scope)

- 移动端深度优化(README 标 MVP 外)
- i18n
- 时间区间自定义(仅 7d/30d)
- 导出 PDF / 图片
- 「趋势点跳转报告」「优先级段跳转」「AI 点跳录制」跨来源跟踪 v1 留 backlog

## 13. 涉及文件汇总

后端:
- 新建 `apps/api/src/routes/overview.ts`
- 改 `apps/api/src/index.ts`(注册路由)

前端:
- 改 `apps/web/src/pages/Dashboard.tsx`(重写为编排容器)
- 新建 `apps/web/src/features/overview/api.ts`
- 新建 `apps/web/src/features/overview/chartTheme.ts`
- 新建 `apps/web/src/features/overview/components/*.tsx`(11 个)
- 改 `apps/web/src/api/client.ts`(`api.projects.overview(id, range)`)
- 改 `apps/web/package.json`(`recharts` 依赖)

设计系统:
- 改 `packages/ui/src/tokens.css`(新增 chart-1~5 与 soft)