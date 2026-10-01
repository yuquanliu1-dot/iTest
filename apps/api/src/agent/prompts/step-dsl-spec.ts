/** StepAction DSL 规格：内联给 LLM（它读不到 packages/shared 的类型定义）。
 *  case-to-script 等 prompt 都拼接此片段。 */
export const STEP_DSL_SPEC = `StepAction 按 kind 区分（discriminated union），只允许以下形状：
- {"kind":"navigate","url":"https://..."}（url 必须是完整合法 URL）
- {"kind":"click","locator":[Locator,...]}
- {"kind":"fill","locator":[Locator,...],"value":"文本" 或 ValueGenerator}
- {"kind":"hover","locator":[Locator,...]}
- {"kind":"waitFor","locator":[Locator,...],"timeoutMs":3000（可选）}
- {"kind":"assertText","locator":[Locator,...],"equals":"期望文本"}
- {"kind":"assertVisible","locator":[Locator,...]}
- {"kind":"screenshot","name":"截图名"}
- {"kind":"check","locator":[Locator,...],"checked":true}
- {"kind":"select","locator":[Locator,...],"value":"选项值"}
- {"kind":"upload","locator":[Locator,...],"fileName":"a.png"（可选）}
- {"kind":"extract","locator":[Locator,...],"varName":"变量名"}
Locator = {"strategy":"role"|"text"|"testId"|"css"|"xpath","value":"定位值"}
ValueGenerator（fill.value 动态取值，可选其一）：
- {"mode":"randomString","length":12}
- {"mode":"randomNumber","min":0,"max":999999}
- {"mode":"timestamp"}
- {"mode":"prefixTimestamp","prefix":"用户"}

规则：
1. action 必须是对象，绝不能是纯字符串描述。
2. 优先 role / testId 定位，避免 css/xpath。
3. 关键路径末尾必须有断言（assertVisible 或 assertText）。
4. 页面跳转后先 waitFor 再操作。

完整示例 steps：
[
  {"order":1,"action":{"kind":"navigate","url":"https://example.com/login"}},
  {"order":2,"action":{"kind":"fill","locator":[{"strategy":"testId","value":"phone-input"}],"value":"13800000000"}},
  {"order":3,"action":{"kind":"click","locator":[{"strategy":"role","value":"button[name=\\"登录\\"]"}]}},
  {"order":4,"action":{"kind":"waitFor","locator":[{"strategy":"text","value":"工作台"}]}},
  {"order":5,"action":{"kind":"assertVisible","locator":[{"strategy":"role","value":"main"}]}}
]`;
