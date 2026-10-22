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
- {"kind":"aiTask","instruction":"自然语言指令"}（回放时由 AI 智能体实时看截图执行，不预编译；登录页有验证码时用它代替普通 fill——例："识别验证码图片中的字符并填入验证码输入框"；也适用于其他难以固化为 DSL 的动态交互）
- {"kind":"httpRequest","method":"GET","url":"https://api.example.com/users","headers":[{"key":"Content-Type","value":"application/json"}],"body":"JSON字符串(可选)","timeoutMs":10000,"carryLoginState":true(可选,转发浏览器登录态Cookie),"saveAs":{"varName":"orderId","from":"body","path":"data.id"}(可选,提取响应值为变量),"assertion":{"status":200,"match":"contains","expected":"ok"}(可选)}（REST API 请求步骤，回放机械执行；url/headers值/body 支持 {{变量}} 替换。match 可取 equals/contains/notContains/regex；assertion 另可带 allowTransportFailure:true —— 把「传输层失败（连接被拒/被重置/超时）」判为通过，用于「SUT 在传输层拒绝伪造 Host」这类没有 HTTP 响应可断言的场景。httpRequest 走 node:http 直发，**能原样设置 Host 等受保护请求头**（浏览器 JS 做不到），所以伪造 Host / 改写 Host 的安全用例必须用 httpRequest，禁止编成 aiTask）
- {"kind":"sendSyslog","protocol":"udp"|"tcp","host":"syslog服务器地址(支持{{变量}})","port":514,"facility":"user","severity":"info","message":"日志内容","timeoutMs":5000}（向 syslog 服务器发送一条 RFC3164 日志；facility 常用 user/daemon/local0~local7，severity emerg~debug；用于触发被测系统日志采集）
Locator = {"strategy":"role"|"text"|"testId"|"css"|"xpath","value":"定位值"}（xpath 仅用于读取历史数据;新生成的用例应优先 css / role / text / testId，结构鲁棒性差的位置不要选 xpath）
（mobile-only："accessibilityId"|"label"|"predicate"，仅在 platform=mobile 用例中可产出；web 用例不得使用）
mobile-only action（仅 platform=mobile 时产出）：
- {"kind":"tap","locator":[Locator,...]}（首选 tap；click 在 mobile 也可用但会映射为 tap）
- {"kind":"swipe","from":[Locator,...],"to":[Locator,...],"durationMs":300（默认）}
- {"kind":"setAppearance","mode":"light"|"dark"}
- {"kind":"setNetwork","state":"online"|"offline"|"airplane"}
- {"kind":"setLocation","latitude":<float>,"longitude":<float>}
- {"kind":"appOpen","bundleId":"com.x.y"}（缺省用 case.appRef.bundleId）
- {"kind":"appBack"}
- {"kind":"appRestart"}
- {"kind":"home"}
规则（同前）：
- platform=mobile 时 locator 优先 accessibilityId / label，禁止使用 css 修饰符。
- platform=web 时 locator 优先 role / text / testId；移动端策略不被接受。
ValueGenerator（fill.value 动态取值，可选其一）：
- {"mode":"randomString","length":12}
- {"mode":"randomNumber","min":0,"max":999999}
- {"mode":"timestamp"}
- {"mode":"prefixTimestamp","prefix":"用户"}

规则：
1. action 必须是对象，绝不能是纯字符串描述。
2. 优先 role / text 定位；testId 仅限上下文提供的页面快照中确认存在的 testid，禁止编造 id/testid。
3. 关键路径末尾必须有断言（assertVisible 或 assertText）。
4. 页面跳转后先 waitFor 再操作。
5. assertText 的 equals 必须是页面真实 UI 文本片段（按钮文案 / Toast 提示 / 错误信息 / 页面标题），禁止描述性短语（如"正常展示""已发出""已触发""已实现"），服务端会直接过滤掉。

完整示例 steps：
[
  {"order":1,"action":{"kind":"navigate","url":"https://example.com/login"}},
  {"order":2,"action":{"kind":"fill","locator":[{"strategy":"css","value":"input[type='tel']"},{"strategy":"role","value":"textbox[name=\\"手机号\\"]"}],"value":"13800000000"}},
  {"order":3,"action":{"kind":"click","locator":[{"strategy":"role","value":"button[name=\\"登录\\"]"}]}},
  {"order":4,"action":{"kind":"waitFor","locator":[{"strategy":"text","value":"工作台"}]}},
  {"order":5,"action":{"kind":"assertVisible","locator":[{"strategy":"role","value":"main"}]}}
]`;
