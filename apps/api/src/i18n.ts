/** 服务端最小 t:按语言返回 tool summary 等模板文案。key 与产物文案同文件,便于对照。 */
export type StLang = 'zh-CN' | 'en-US';

const dict = {
  'case.updated': { 'zh-CN': '更新「{title}」({keys})', 'en-US': 'Updated "{title}" ({keys})' },
  'case.deleted': { 'zh-CN': '删除「{title}」', 'en-US': 'Deleted "{title}"' },
  'case.moved': { 'zh-CN': '移动「{title}」到分组 {target}', 'en-US': 'Moved "{title}" to group {target}' },
  'step.updated': { 'zh-CN': '更新步骤 #{order}（{changes}）', 'en-US': 'Updated step #{order} ({changes})' },
  'step.insertAfter': { 'zh-CN': '在#{order} 后 插入新步骤', 'en-US': 'Insert new step after #{order}' },
  'step.insertEnd': { 'zh-CN': '在末尾 插入新步骤', 'en-US': 'Insert new step at the end' },
  'step.deleted': { 'zh-CN': '删除步骤 #{order}', 'en-US': 'Deleted step #{order}' },
  'step.reordered': { 'zh-CN': '重排 {count} 个步骤', 'en-US': 'Reordered {count} steps' },
  'plan.updated': { 'zh-CN': '更新计划「{name}」', 'en-US': 'Updated plan "{name}"' },
  'plan.casesAdded': { 'zh-CN': '向计划「{name}」添加 {count} 个用例', 'en-US': 'Added {count} cases to plan "{name}"' },
  'plan.casesRemoved': { 'zh-CN': '从计划「{name}」移除 {count} 个用例', 'en-US': 'Removed {count} cases from plan "{name}"' },
  'plan.scheduleCreated': { 'zh-CN': '为计划「{name}」新建调度(cron={cron}, tz={tz}, enabled={enabled})', 'en-US': 'Created schedule for plan "{name}" (cron={cron}, tz={tz}, enabled={enabled})' },
  'plan.scheduleUpdated': { 'zh-CN': '更新计划「{name}」的调度', 'en-US': 'Updated schedule of plan "{name}"' },
  'plan.scheduleDeleted': { 'zh-CN': '删除计划「{name}」的调度(cron={cron})', 'en-US': 'Deleted schedule of plan "{name}" (cron={cron})' },
  'env.updated': { 'zh-CN': '更新环境「{name}」', 'en-US': 'Updated environment "{name}"' },
  'env.credentialsSet': { 'zh-CN': '设置环境「{name}」的 {type} 对象「{label}」访问凭据(值不回显)', 'en-US': 'Set access credentials for {type} object "{label}" of environment "{name}" (value not echoed)' },
  'env.deleted': { 'zh-CN': '删除环境「{name}」{usage}', 'en-US': 'Deleted environment "{name}" {usage}' },
  'env.usageReferenced': { 'zh-CN': '(将使 {caseCount} 个用例与 {planCount} 个计划的引用置空)', 'en-US': '(will null out references of {caseCount} case(s) and {planCount} plan(s))' },
  'env.usageNone': { 'zh-CN': '(无引用)', 'en-US': '(no references)' },
  'scenario.updated': { 'zh-CN': '更新场景「{title}」', 'en-US': 'Updated scenario "{title}"' },
  'scenario.deleted': { 'zh-CN': '删除场景「{title}」(关联用例将解绑)', 'en-US': 'Deleted scenario "{title}" (linked cases will be unbound)' },
  'step.solidified': { 'zh-CN': '固化步骤 #{order}（aiTask → {count} 个机械动作）', 'en-US': 'Solidified step #{order} (aiTask → {count} mechanical actions)' },
  'planRun.summary': { 'zh-CN': '{passed} 通过 / {failed} 失败 / {skipped} 跳过', 'en-US': '{passed} passed / {failed} failed / {skipped} skipped' },
  'planRun.incognitoConflict': { 'zh-CN': 'incognito 模式与登录准备互斥:{caseIds}', 'en-US': 'incognito mode conflicts with login prepare: {caseIds}' },
  'planRun.loginPrepareFailed': { 'zh-CN': '登录准备失败:{reason}', 'en-US': 'login prepare failed: {reason}' },
} as const;

export type StKey = keyof typeof dict;

export function st(lang: StLang, key: StKey, vars?: Record<string, string | number | boolean>): string {
  let s: string = (dict[key] as Record<StLang, string>)[lang];
  for (const [k, v] of Object.entries(vars ?? {})) s = s.split(`{${k}}`).join(String(v));
  return s;
}