/**
 * 探索式测试会话共享常量：persona 枚举 + findings 结构类型。
 * api 侧用 directive 拼探索指令，web 侧用 label 渲染下拉——单一真源。
 */

export interface ExplorationPersona {
  key: string;
  labelZh: string;
  labelEn: string;
  /** 注入探索 AI 的视角指令（拼进每轮 instruction 的 persona 段）。 */
  directive: string;
}

export const EXPLORATION_PERSONAS: ExplorationPersona[] = [
  {
    key: 'qa',
    labelZh: '通用测试员',
    labelEn: 'QA Generalist',
    directive: '以通用测试员视角探索：关注主流程可用性、输入校验、边界条件与页面状态一致性。',
  },
  {
    key: 'novice',
    labelZh: '新手用户',
    labelEn: 'Novice User',
    directive: '以第一次使用系统的新手视角探索：不依赖先验知识，优先点最显眼最直觉的入口；留意缺少引导、提示含糊、术语难懂、操作无处下手的问题。',
  },
  {
    key: 'power',
    labelZh: '高级用户',
    labelEn: 'Power User',
    directive: '以熟练用户视角探索：追求效率，尝试批量操作、筛选排序、快捷路径与极端输入（超长文本/特殊字符/大量数据），关注性能感受与批量场景的正确性。',
  },
  {
    key: 'accessibility',
    labelZh: '无障碍视角',
    labelEn: 'Accessibility',
    directive: '以无障碍视角探索：留意图片缺替代文本、表单缺标签、对比度不足、键盘不可达、弹窗聚焦丢失等可访问性问题。',
  },
];

export const EXPLORATION_PERSONA_KEYS = EXPLORATION_PERSONAS.map((p) => p.key);

export function getExplorationPersona(key: string): ExplorationPersona {
  return EXPLORATION_PERSONAS.find((p) => p.key === key) ?? EXPLORATION_PERSONAS[0]!;
}

/** 模型 findings 契约里的单条复现步骤。 */
export interface ExplorationReproStep {
  action: string;
  expected?: string;
}
