/**
 * Exploratory-testing session shared constants: persona enum + findings structural types.
 * The api side assembles exploration directives from directive, the web side renders dropdowns from label — a single source of truth.
 */

export interface ExplorationPersona {
  key: string;
  labelZh: string;
  labelEn: string;
  /** Perspective directive injected into the exploration AI (the persona segment assembled into each round's instruction). */
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
  {
    key: 'security',
    labelZh: '安全视角',
    labelEn: 'Security',
    directive:
      '以安全视角探索：核查鉴权与越权边界——改 URL 里的 id/序号/参数尝试访问他人数据或无权限页面，已登录状态下直达管理/配置类地址看是否被拦；留意页面与报错中泄露的敏感信息（凭据、内部路径、堆栈）；输入框试特殊字符与脚本片段看回显是否被转义。越权尝试被放行即缺陷候选，被系统正确拦截则如实申报排除。',
  },
];

export const EXPLORATION_PERSONA_KEYS = EXPLORATION_PERSONAS.map((p) => p.key);

export function getExplorationPersona(key: string): ExplorationPersona {
  return EXPLORATION_PERSONAS.find((p) => p.key === key) ?? EXPLORATION_PERSONAS[0]!;
}

/** A single reproduction step in the model findings contract. */
export interface ExplorationReproStep {
  action: string;
  expected?: string;
}
