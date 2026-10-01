# 文件上传步骤优化：project 隔离 + 限额 + 列表复用

日期：2026-10-01
状态：待用户审阅
上游参考：用户提供的 CueCast 文件上传步骤文档（本地 HTML）。已落地的 phase 2 录音：docs/superpowers/specs/2026-09-30-recorder-phase2-design.md。已落地的 phase 3 步骤配置：docs/superpowers/specs/2026-10-01-step-settings-phase3-design.md。

## 背景与目标

iTest 已经能完成文件上传步骤的核心闭环：Chrome 扩展在 `change` 上识别 file input、生成 `upload` 步骤（value 为文件名），编辑器从本机上传绑定文件（按 sha256 全局去重），回放阶段用 `setInputFiles` 注入。

CueCast 文档描述的差异点：

- 测试文件"按组织隔离"，iTest 用 case 落库 + sha256 全局去重。
- 单文件 ≤ 10 MB，iTest 默认 50 MB。
- 用例详情页可"或从当前用例已上传的测试文件中选择"，iTest 没有复用列表。
- 回放遇到"点击按钮后才露出隐藏 file input"的组件时"避免打开系统文件选择窗口，但仍保留页面按钮本身的业务逻辑"。

本期把上述四点对齐到 iTest，回放鲁棒性落到代码层面而不是文档承诺上。

### 范围（YAGNI）

**做**：

- `test_attachments` 加 `project_id` 列，dedup 由"全局 sha256"变为"project 内 sha256"。
- `UPLOAD_MAX_BYTES` 默认改为 10 MB（环境变量仍可覆盖）。
- 新增 `GET /cases/:caseId/attachments`：返回本 project 已上传的全部附件，最新在前；当前 case 优先排前（可选）。
- `StepEditModal` upload 区增加"已上传文件"列表，点击即绑定。
- 上传步骤在 PUT 校验时，fileId 必须归属到该 case 的 project。

**不做**：

- 拖拽上传（文档边界外）。
- 多文件 / 多 fileId（边界外）。
- 录制的 componentKind 解析逻辑重构（已存在；用现成的就行）。
- 自动重试 / 断点续传 / OSS（保持本机 .data/uploads 落盘）。
- iTest 多组织（暂不存在组织概念；project 即最小隔离单元）。

### 设计决策（已与用户确认）

| 议题 | 决策 |
|---|---|
| 隔离范围 | project（用户已选） |
| 单文件上限 | 10 MB 默认（环境变量可覆盖） |
| 已上传文件列表 | 本 project（用户已选） |
| 回放组件适配 | 隐藏 input 优先 + 不打开系统选择窗口 |
| UI 主题 | 保持紫罗兰玻璃（用户已选） |
| 跨 project 引用 fileId | 422 upload_unknown_file 直接拒 |
| GET 列表分页 | 不分页；MVP 单 project 内附件数 < 200 |
| GET 列表排序 | createdAt DESC；当前 case 的附件优先（命中时 boost） |
| 老附件 project_id 回填 | 迁移时按 test_cases.project_id 回填 |
| 录制阶段采集文件名 | 不变（recorder-manager 只记文件名） |
| 上传大小前端校验 | 是，避免浪费请求 |

## 架构

```
┌────────────────────┐  POST /cases/:id/attachments        ┌────────────────────────┐
│  StepEditModal     │ ─────────────────────────────────▶ │  apps/api              │
│  + 附件列表复用    │  GET  /cases/:id/attachments        │  routes/attachments.ts │
└────────────────────┘                                     │  lib/attachments.ts    │
                                                            │   ├── persistUpload    │
                                                            │   └── ensureUploadDir  │
                                                            │  db/test_attachments   │
                                                            │   ├─ project_id (新)   │
                                                            │   └─ (project_id,      │
                                                            │       sha256) 唯一     │
                                                            └────────────────────────┘

回放（apps/api/src/execute/cdp.ts dispatch 'upload' 分支）：
   action.fileId → defaultAttachmentResolver 查 (project_id, fileId) → meta.storedPath
   → firstMatch(page, action.locator).setInputFiles(meta.storedPath)
   // 不打开系统文件选择窗口；locator-core 已经把隐藏 file input 收纳进候选 css
```

### 数据层

`apps/api/src/db/schema.ts` 的 `testAttachments`：

```ts
export const testAttachments = pgTable('test_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  stepId: uuid('step_id').references(() => testSteps.id, { onDelete: 'set null' }),
  originalName: text('original_name').notNull(),
  mime: text('mime'),
  size: integer('size').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  storedPath: text('stored_path').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectShaUq: unique('test_attachments_project_sha_uq').on(t.projectId, t.sha256),
}));
```

迁移 SQL（由 drizzle generate 产出）：

```sql
ALTER TABLE test_attachments
  ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE;

-- 老数据按 test_cases.project_id 回填
UPDATE test_attachments a
SET project_id = c.project_id
FROM test_cases c
WHERE a.case_id = c.id AND a.project_id IS NULL;

ALTER TABLE test_attachments
  ALTER COLUMN project_id SET NOT NULL;

DROP INDEX IF EXISTS test_attachments_sha256_key;  -- 老 unique on sha256
CREATE UNIQUE INDEX test_attachments_project_sha_uq
  ON test_attachments(project_id, sha256);
```

### 接口

**POST /cases/:caseId/attachments**

```ts
// 现有签名不变；body: octet-stream，header: X-Filename, Content-Type
// 行为变化：
//   1. 默认上限 10 MB（DEFAULT_UPLOAD_MAX_BYTES = 10485760）
//   2. 写入 project_id = testCases.project_id
//   3. 查重：(project_id, sha256)；命中时返回已有 record
// 响应：{ id, sha256, originalName, size, mime, createdAt }
```

**GET /cases/:caseId/attachments**（新增）

```ts
// 鉴权：跟其他 cases 路由一致（无 MVP 鉴权概念；同 process）
// 行为：
//   1. caseId 必须存在；否则 404
//   2. 查 case 所属 project
//   3. SELECT * FROM test_attachments WHERE project_id = ? ORDER BY created_at DESC
//   4. 可选：当前 case 的附件置顶（CASE WHEN case_id = ? THEN 0 ELSE 1 END, created_at DESC）
// 响应：[{ id, originalName, size, mime, sha256, createdAt }]
```

**PUT /cases/:caseId/steps**（upload 校验收紧）

```ts
// 原校验：fileId 是 UUID 且 test_attachments 存在
// 新校验：在该 case 的 project 内查 fileId；否则 422 upload_unknown_file
const projectId = caseExists[0].projectId;
const att = await db.select().from(testAttachments)
  .where(and(eq(testAttachments.id, fileId), eq(testAttachments.projectId, projectId)));
if (att.length === 0) throw new HttpError(422, 'upload_unknown_file', ...);
```

**defaultAttachmentResolver（cdp.ts）**：同样改为 project-scoped 查询。ExecContext.attachmentResolver 签名不变；test 注入时按新签名实现。

### 前端（StepEditModal.tsx）

upload 分支改造：

```tsx
{kind === 'upload' && (
  <div className="flex flex-col gap-2">
    <span style={labelStyle}>绑定回放文件（按 project 隔离，≤ 10 MB）</span>
    <input
      type="file"
      style={inputStyle}
      onChange={handleUploadNew}
    />
    {attachments && attachments.length > 0 && (
      <>
        <span style={labelStyle}>—— 或从本 project 已上传文件选择 ——</span>
        <ul style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--color-glass-border)', borderRadius: 6 }}>
          {attachments.map((a) => (
            <li
              key={a.id}
              onClick={() => setFileId(a.id)}
              style={{
                padding: '6px 8px', cursor: 'pointer',
                background: fileId === a.id ? 'var(--color-accent)' : 'transparent',
                color: fileId === a.id ? '#fff' : 'var(--color-foreground-secondary)',
                fontSize: 11, display: 'flex', gap: 8, justifyContent: 'space-between',
              }}
            >
              <span className="truncate">{a.originalName}</span>
              <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>
                {a.sha256.slice(0, 8)}… · {formatBytes(a.size)}
              </span>
            </li>
          ))}
        </ul>
      </>
    )}
    {fileId && (
      <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
        已绑定 fileId: <code>{fileId.slice(0, 8)}…</code>
        <button onClick={() => setFileId(undefined)} style={{ marginLeft: 8, background: 'transparent', border: 'none', color: 'var(--color-accent)', cursor: 'pointer' }}>更换</button>
      </p>
    )}
  </div>
)}
```

`formatBytes` 在 `apps/web/src/lib/format.ts` 已有（如无则新增）。

### 客户端 API

`apps/web/src/api/client.ts`：

```ts
attachments: {
  upload: async (caseId, file) => { /* 现存不变 */ },
  list: (caseId: string) =>
    request<Array<{ id: string; originalName: string; size: number; mime: string | null; sha256: string; createdAt: string }>>(
      `/cases/${caseId}/attachments`,
    ),
},
```

### 错误处理

| 场景 | HTTP | code | UI |
|---|---|---|---|
| 文件 > 上限 | 413 | too_large | toast |
| case 不存在 | 404 | not_found | 阻断 |
| sha256 已存在（同 project） | 200 | — | 直接复用 |
| 跨 project fileId | 422 | upload_unknown_file | toast |
| 录制时选了同名 file 但没 change | — | — | 不生成 upload 步骤（现状） |
| 回放 attachment 缺失 | — | — | 步骤失败 + 截图 + `attachment-missing: <id>` |

## 测试

### 后端

`apps/api/test/attachments.test.ts`：

- 上传文件 + 返回 sha256 + id + createdAt
- 同 project 同 sha256 返回同 record
- 不同 project 同 sha256 返回不同 record
- 超出 10 MB 默认拒绝（环境变量覆盖仍有效）
- GET /cases/:caseId/attachments 返回 project 内全部附件，createdAt DESC
- 当前 case 附件优先排序

新增 `apps/api/test/attachments-list.test.ts` 或合并：

- 跨 project 的 fileId 在 steps PUT 时返回 422
- 跨 case 同 project 的 fileId 在 steps PUT 时通过

### 前端

- 不加单测（StepEditModal 单测成本高；保持现有手工 e2e）。
- 不动现有 case2script 工作流。

## 实现步骤

1. **db**：drizzle generate 出 0003；review SQL；run migrate。
2. **lib/attachments.ts**：DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024。
3. **routes/attachments.ts**：
   - POST 写 project_id；查重改成 (project_id, sha256)。
   - 新增 GET 列表。
4. **routes/steps.ts**：upload 校验改成 project-scoped。
5. **execute/cdp.ts**：defaultAttachmentResolver 改成 project-scoped 查询（或在测试中通过 attachmentResolver 注入）。ExecContext 注释更新。
6. **apps/web/src/api/client.ts**：新增 `attachments.list`。
7. **apps/web/src/components/StepEditModal.tsx**：upload 分支加列表 + 复用 + 更换按钮。
8. **apps/web/src/lib/format.ts**：formatBytes（若无）。
9. **测试**：attachments.test.ts 扩展 + 跨 project 校验测试。
10. **回归**：pnpm verify。

## 不在范围内

- 编辑器"批量上传多个文件选一个绑定"（保持一对一）。
- 附件删除（用户要求时再加；当前 case 删除会级联删除 attachment 行，落盘文件保留或由 cleanup job 处理）。
- 上传到 OSS（边界外）。
- 录制阶段对隐藏 file input 的特殊采集（phase 2 已覆盖）。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 迁移时 project_id 为 NULL 的老附件 | 迁移脚本显式回填 + NOT NULL 约束 |
| 跨 project 引用 fileId 误拒 | 422 错误信息带原 fileId；用户重新上传或绑定正确附件 |
| GET 列表大文件多 | MVP 不分页；按 createdAt DESC 限 200 条（hard cap） |
| 删 case 时 attachment 残留文件 | case 删除时已 cascade test_attachments 行；磁盘文件待 cleanup job（MVP 不做） |
