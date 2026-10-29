/** StepAction DSL 规格：内联给 LLM（它读不到 packages/shared 的类型定义）。
 *  case-to-script 等 prompt 都拼接此片段。
 *
 *  维护要点（2026-10-28 复盘）：本规格必须【逐字覆盖 packages/shared/src/step-dsl.ts
 *  的每个 kind 与其必填字段】。此前缺 sql / queryDb / observeLog / assertJson /
 *  switchTab，LLM 只能靠 zod 报错反推字段形状——实测烧掉 17 轮探针用例才摸清 sql。
 *  新增 kind 时同步改这里，否则 LLM 会重新走「试探错误信息」的老路。 */
export const STEP_DSL_SPEC = `StepAction 按 kind 区分（discriminated union），只允许以下形状：
- {"kind":"navigate","url":"https://..."}（url 必须是完整合法 URL，或以 / 开头的相对路径，或以 {{变量}} 打头）
- {"kind":"click","locator":[Locator,...]}
- {"kind":"fill","locator":[Locator,...],"value":"文本" 或 ValueGenerator 或 CompositeValue}
- {"kind":"hover","locator":[Locator,...]}
- {"kind":"waitFor","locator":[Locator,...],"timeoutMs":3000（可选）}（locator 传空数组 = 固定时长等待 timeoutMs）
- {"kind":"assertText","locator":[Locator,...],"equals":"期望文本","target":"specifiedElement"|"page"|"errorMessage"|"url"（可选，默认 specifiedElement）,"match":"equals"|"contains"|"notContains"|"regex"（可选，默认 equals）}
- {"kind":"assertVisible","locator":[Locator,...]}
- {"kind":"screenshot","name":"截图名"}
- {"kind":"check","locator":[Locator,...],"checked":true}
- {"kind":"select","locator":[Locator,...],"value":"选项值"}
- {"kind":"upload","locator":[Locator,...],"fileId":"附件 UUID"}（附件须先由用户上传到用例附件，AI 无上传通道；拿不到 fileId 就别用这步）
- {"kind":"extract","locator":[Locator,...],"varName":"变量名","mode":"completeValue"|"smartExtract"|"regex"（可选，默认 completeValue）,"pattern":"正则"（mode=regex 时必填）,"group":1（可选，0=整个匹配，1-based）}
- {"kind":"aiTask","instruction":"自然语言指令"}（回放时由 AI 智能体实时看截图执行，不预编译；登录页有验证码时用它代替普通 fill——例："识别验证码图片中的字符并填入验证码输入框"；也适用于其他难以固化为 DSL 的动态交互）
- {"kind":"assertJson","locator":[Locator,...],"equals":<任意 JSON 值>}（取元素 innerText 解析为 JSON，与 equals 深比较——元素必须正好是一段 JSON 文本）
- {"kind":"switchTab","tabRef":"标签页标识"}（切到已打开的标签页；tabRef 来自用例的标签页清单，AI 一般拿不到——拿不到就别用）
- {"kind":"httpRequest","method":"GET","url":"https://api.example.com/users","headers":[{"key":"Content-Type","value":"application/json"}],"body":"JSON字符串(可选)","timeoutMs":10000,"carryLoginState":true(可选,转发浏览器登录态Cookie),"saveAs":{"varName":"orderId","from":"body","path":"data.id"}(可选,提取响应值为变量),"assertion":{"status":200,"match":"contains","expected":"ok"}(可选)}（REST API 请求步骤，回放机械执行；url/headers值/body 支持 {{变量}} 替换。match 可取 equals/contains/notContains/regex；assertion 另可带 allowTransportFailure:true —— 把「传输层失败（连接被拒/被重置/超时）」判为通过，用于「SUT 在传输层拒绝伪造 Host」这类没有 HTTP 响应可断言的场景。httpRequest 走 node:http 直发，**能原样设置 Host 等受保护请求头**（浏览器 JS 做不到），所以伪造 Host / 改写 Host 的安全用例必须用 httpRequest，禁止编成 aiTask）
- {"kind":"sql","sql":"select ... from ...","dbRef":"环境里的 db 对象 label(可选,缺省=默认 db 对象)","params":["{{变量}}"],"limit":50,"assertion":{"match":"equals"|"contains"|"regex","expected":"期望文本","column":"列名(可选)"}}（对【被测系统自己的数据库】执行单条只读 SQL；回放机械执行零 LLM。跨库查询写全限定名 \`库名.表名\`。**{{变量}} 必须写在 params 里配 ? 占位符，不能写在 sql 文本里**——写在文本里会被替换成 ? 字面量并落进引号内，断言必然不命中。params 支持 {{变量}} 替换（数据集列或前置 extract/saveAs 定义的变量）。断言作用于结果集文本（给了 column 则只对该列比对）；命中/失败都会把行数据回传给调用方。查【平台自己的库】用 queryDb，不是 sql）
- {"kind":"queryDb","table":"test_cases","where":[{"column":"id","equals":"..."}],"columns":["id"],"limit":50,"assertion":{"match":"contains","expected":"..."}}（查【平台自身数据库】的表做平台自检；table 只能是平台库枚举值：projects / groups / users / test_cases / test_steps / datasets / reports / execution_plans / plan_case_groups / plan_cases / plan_runs / plan_run_cases / plan_schedules / test_attachments。**查被测系统的库用 sql，不是 queryDb**——用 queryDb 查 SUT 的表会因 table 枚举被拒）
- {"kind":"observeLog","syslogRef":"环境里的 syslog 对象 label(可选,缺省=默认 syslog 对象)","windowMs":60000,"keywords":["关键字"],"fromLine":200,"assertion":{"match":"contains","expected":"期望文本"}}（SSH 到 syslog 服务器读日志文件尾部，keywords 过滤；assertion 命中即任意一行匹配。观察被测系统是否上报了预期日志）
- {"kind":"sendSyslog","protocol":"udp"|"tcp","host":"syslog服务器地址(支持{{变量}})","port":514,"facility":"user","severity":"info","message":"日志内容","timeoutMs":5000}（向 syslog 服务器发送一条 RFC3164 日志；facility 常用 user/daemon/local0~local7，severity emerg~debug；用于触发被测系统日志采集。message 不做变量替换，只有 host 支持）
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
CompositeValue（fill.value 分段拼接，可选其一）：
- {"mode":"composite","fragments":[{"mode":"fixed","value":"前缀"},{"mode":"date","format":"YYYYMMDD"},{"mode":"randomNumber","min":1,"max":9999,"length":4},{"mode":"randomString","length":8},{"mode":"timestamp"}]}

规则：
1. action 必须是对象，绝不能是纯字符串描述。
2. 优先 role / text 定位；testId 仅限上下文提供的页面快照中确认存在的 testid，禁止编造 id/testid。
3. 关键路径末尾必须有断言（assertVisible 或 assertText）。
4. 页面跳转后先 waitFor 再操作。
5. assertText 的 equals 必须是页面真实 UI 文本片段（按钮文案 / Toast 提示 / 错误信息 / 页面标题），禁止描述性短语（如"正常展示""已发出""已触发""已实现"），服务端会直接过滤掉。禁止用 target:"page" + 空 locator 的整页模糊断言——它对任何页面都命中，只会掩盖失败。
6. **查库步骤（sql）不要靠试探形状来发现**——上面已给出完整形状。要点：(a) 查被测库用 sql，查平台自己的库用 queryDb，两者不要混；(b) 表不在默认库时写全限定名 \`库名.表名\`；(c) 变量一律走 params 配 \`?\` 占位符，不要写进 sql 文本；(d) 断言用 assertion 里的 match/expected/column，结果行会回传给你，不必猜库名/表名/数据长什么样——**一次就能写对，不要用探针用例反复试**；(e) sql 步骤不消费 saveAs，DB 结果回传给 UI 步骤要靠「sql 断言 contains 期望值」，或用 httpRequest 的 saveAs 取接口响应。
7. **拿不到凭据/标识的步骤就别编**：upload 要附件 fileId、switchTab 要 tabRef、queryDb 要平台表名——这些 AI 侧都拿不到，硬编出来的必然在回放时失败。改用 aiTask 兜底或向用户索取。

完整示例 steps：
[
  {"order":1,"action":{"kind":"navigate","url":"https://example.com/login"}},
  {"order":2,"action":{"kind":"fill","locator":[{"strategy":"css","value":"input[type='tel']"},{"strategy":"role","value":"textbox[name=\\"手机号\\"]"}],"value":"13800000000"}},
  {"order":3,"action":{"kind":"click","locator":[{"strategy":"role","value":"button[name=\\"登录\\"]"}]}},
  {"order":4,"action":{"kind":"waitFor","locator":[{"strategy":"text","value":"工作台"}]}},
  {"order":5,"action":{"kind":"assertVisible","locator":[{"strategy":"role","value":"main"}]}}
]`;
