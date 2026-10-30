---
name: export-cases
description: 把当前版本的用例导出为 XMind 思维导图或 Word 表格文档（.docx）并生成下载卡。数据由 dump_cases_payload 工具落盘、脚本读 payload 文件渲染，内容不经对话誊抄、零幻觉；docx 优先 python-docx，缺失时标准库降级。
---

# 用例导出（export-cases：XMind / Word）

把用例导出为可下载文件。核心纪律：**内容全部来自 dump_cases_payload 落盘的 payload 文件，脚本直接渲染——不在对话里复述用例内容，也不把 payload 内容抄进任何参数，只传 payloadPath。**

## 工作流

1. **确认范围与格式**：格式二选一 `xmind` / `docx`（用户没说格式先问；说「word/文档/评审稿」= docx，「思维导图/xmind」= xmind）。范围四选一：指定用例 / 某分组 / 关键词 / 当前版本全部——用户没说范围时先确认。
2. **取数**：调 `dump_cases_payload`（caseIds / groupId / keyword，都缺省=当前版本全部），拿到 `payloadPath` 与用例数。
3. **生成**：调用
   `run_skill_script(skillName="export-cases", script="scripts/export_cases.py", args=['{"payload":"<payloadPath>","format":"xmind 或 docx"}'])`
   JSON 作为**单个参数**整体传入（平台直接 argv 传递，不经 shell，无需转义引号）。可选 `"title":"自定义根标题"`（缺省用版本名）。
   同一份 payloadPath 换 format 可再渲染另一种格式，不必重复 dump。
4. **回复用户**：脚本返回「已生成 …」即说明下载卡已推送给用户，说明文件名、用例数与格式即可；不需要也无法自己发文件。

## 参数 JSON schema

```json
{
  "payload": "/tmp/itest-export-payload-….json",  // 必填，dump_cases_payload 返回的路径
  "format": "docx",                               // 必填，xmind | docx
  "title": "评审材料"                              // 可选，文档/导图根标题，缺省用版本名
}
```

## 产物版式

- **xmind**：层级 版本 → [版本(跨版本时)] → 分组 → 用例 → 预置条件/测试步骤/预期结果（双格式兼容 XMind 2020+/XMind 8）。
- **docx**：表格式——分组做章节标题，每个用例一张表（用例名称/所属分组/预置条件/测试步骤/预期结果）。

## 禁止

- 把 payload 文件内容读出来抄进参数或对话——数据只经文件通道，防誊抄错漏。
- 用户没确认范围就全量导出；范围含糊（「导出一些」）先问清楚。
- 生成多个版本让用户挑——一次一个文件；要改标题/格式就重新渲染（文件名带时间戳，新旧可区分）。
