import { describe, it, expect } from 'vitest';
import type { Locator } from '@itest/shared';
import {
  analyzeLocatorCandidates,
  analyzeLocatorCandidatesBatch,
  extractGrepKeys,
  reorderCandidates,
  summarizeStaticReports,
  type BatchLocatorCountFn,
  type LocatorCountFn,
  type SourceCount,
  type StaticLocatorReport,
} from '../src/execute/staticLocator.js';

/** Fake grep counter: runs the pattern as a regex against fake source lines, mimicking repo_grep's real matching semantics,
 *  thereby proving the keys produced by extractGrepKeys do hit real source shapes (HTML attributes / Vue bindings / JS objects). */
function makeCounter(lines: string[]): LocatorCountFn {
  return async (pattern) => {
    const re = new RegExp(pattern);
    const hits = lines.filter((l) => re.test(l));
    return { count: hits.length, truncated: hits.length >= 200, samplePaths: hits.slice(0, 3).map((_, i) => `views/line-${i + 1}.vue`) };
  };
}

// ── Key extraction: proving the precise key covers real source-adjacent shapes ──
describe('extractGrepKeys', () => {
  it('css 属性选择器：属性名+值邻接，兼容双引号/单引号/Vue 绑定/JS 对象', () => {
    const lines = [
      '<i title="查看"></i>',          // HTML double quotes
      "<span :title=\"'查看'\"></span>", // Vue binding(:title="'查看'")
      "const t = { title: '查看' };",   // JS object
    ];
    // All three shapes belong to the same「title=查看」anchor → the precise key should hit all of them
    const keys = extractGrepKeys('css', '[title="查看"]');
    expect(keys).toEqual({ precise: 'title\\s*[:=]\\s*[\'"]{1,2}查看', loose: '\\btitle\\b' });
    for (const l of lines) expect(new RegExp(keys!.precise).test(l)).toBe(true);
  });

  it('css .class / #id：取裸 token，且属性选择器优先于 class', () => {
    expect(extractGrepKeys('css', '.icon-chakan')).toEqual({ precise: 'icon-chakan', loose: null });
    expect(extractGrepKeys('css', '#loginBtn')).toEqual({ precise: 'loginBtn', loose: null });
    expect(extractGrepKeys('css', 'input[placeholder="规则名称"]')).toEqual({
      precise: 'placeholder\\s*[:=]\\s*[\'"]{1,2}规则名称',
      loose: '\\bplaceholder\\b',
    });
  });

  it('裸标签/纯组合器无静态可判 → null', () => {
    expect(extractGrepKeys('css', 'input')).toBeNull();
    expect(extractGrepKeys('css', '.baseForm input')).toEqual({ precise: 'baseForm', loose: null });
    expect(extractGrepKeys('css', 'div > span')).toBeNull();
  });

  it('text 取文案；role 取 name；xpath/移动端锚点跳过', () => {
    expect(extractGrepKeys('text', '确认')).toEqual({ precise: '确认', loose: null });
    expect(extractGrepKeys('role', "button[name='登录']")).toEqual({ precise: "name\\s*[:=]\\s*['\"]{1,2}登录", loose: null });
    expect(extractGrepKeys('role', 'button')).toBeNull();
    expect(extractGrepKeys('xpath', '/html/body/div[1]/button')).toBeNull();
    expect(extractGrepKeys('accessibilityId', 'login')).toBeNull();
    expect(extractGrepKeys('label', '登录')).toBeNull();
  });
});

// ── Fixture 1: project fully covered by testid ──
describe('夹具 1 · testid 覆盖项目', () => {
  const lines = [
    '<button data-testid="login">登录</button>',
    '<div data-testid="tab">A</div>',
    '<div data-testid="tab">B</div>',
    '<div data-testid="tab">C</div>',
  ];

  it('[data-testid="login"] 源码唯一 → unique', async () => {
    const [r] = await analyzeLocatorCandidates([{ strategy: 'css', value: '[data-testid="login"]' }], makeCounter(lines));
    expect(r!.verdict).toBe('unique');
    expect(r!.sourceCount).toBe(1);
  });

  it('[data-testid="tab"] 源码 3 处 → multiple（预测回放歧义）', async () => {
    const [r] = await analyzeLocatorCandidates([{ strategy: 'css', value: '[data-testid="tab"]' }], makeCounter(lines));
    expect(r!.verdict).toBe('multiple');
    expect(r!.sourceCount).toBe(3);
  });
});

// ── Fixture 2: SOC acceptance anchors (mixed project: zero testid, semantic icon class) ──
describe('夹具 2 · SOC 混合项目（验收锚点 .icon-chakan）', () => {
  // The pseudo-unique anchor title="查看" is reused in 5 source places (toolbar/menu/table action columns of multiple views)
  const lines = [
    '<i class="icon-chakan operateBtn" title="查看"></i>', // the single semantic icon class (also the template definition site)
    '<button class="toolbar-link" title="查看">查看</button>',
    '<a title="查看">查看</a>',
    '<li><span title="查看">查看</span></li>',
    '<p title="查看">点击查看</p>',
  ];

  it('[title="查看"] 源码命中 5 处 → multiple（伪唯一锚点，回放会静默点错）', async () => {
    const [r] = await analyzeLocatorCandidates([{ strategy: 'css', value: '[title="查看"]' }], makeCounter(lines));
    expect(r!.verdict).toBe('multiple');
    expect(r!.sourceCount).toBe(5);
  });

  it('.icon-chakan 源码唯一 → unique（语义锚点，优于 [title]）', async () => {
    const [r] = await analyzeLocatorCandidates([{ strategy: 'css', value: '.icon-chakan' }], makeCounter(lines));
    expect(r!.verdict).toBe('unique');
    expect(r!.sourceCount).toBe(1);
  });

  it('两个候选一起分析：dynamic/静态排行把 unique 的 .icon-chakan 排到 multiple 的 [title] 前', async () => {
    const reports = await analyzeLocatorCandidates(
      [{ strategy: 'css', value: '[title="查看"]' }, { strategy: 'css', value: '.icon-chakan' }],
      makeCounter(lines),
    );
    const ordered = reorderCandidates(reports);
    expect(ordered[0]!.value).toBe('.icon-chakan');
    expect(ordered[1]!.value).toBe('[title="查看"]');
  });
});

// ── Fixture 3: attribute-less project (pure text / legacy xpath) ──
describe('夹具 3 · 无属性项目', () => {
  const lines = Array.from({ length: 5 }, () => '<button>确认</button>');

  it('text "确认" 源码 5 处 → multiple（text 本就是弱锚点）', async () => {
    const [r] = await analyzeLocatorCandidates([{ strategy: 'text', value: '确认' }], makeCounter(lines));
    expect(r!.verdict).toBe('multiple');
    expect(r!.sourceCount).toBe(5);
  });

  it('xpath 历史兼容 → skipped（无静态可判）', async () => {
    const [r] = await analyzeLocatorCandidates([{ strategy: 'xpath', value: '/html/body/div[1]/button' }], makeCounter(lines));
    expect(r!.verdict).toBe('skipped');
    expect(r!.sourceCount).toBeNull();
  });
});

// ── Fixture 4: dynamically rendered project (key: don't wrongly kill dynamic elements) ──
describe('夹具 4 · 动态渲染不误杀', () => {
  const lines = [
    '<el-input :placeholder="keywordPlaceholder" />', // placeholder comes from a data binding
    '<li :data-id="item.id" v-for="item in list">...</li>', // data-id comes from a dynamic value
  ];

  it('[placeholder="请输入关键字"] 字面量不在源码但 placeholder 绑定存在 → dynamic-suspect（不判 not-found）', async () => {
    const [r] = await analyzeLocatorCandidates(
      [{ strategy: 'css', value: '[placeholder="请输入关键字"]' }],
      makeCounter(lines),
    );
    expect(r!.verdict).toBe('dynamic-suspect');
    // Key assertion: dynamic-suspect ≠ rejection — it must never fall into not-found
    expect(r!.verdict).not.toBe('not-found');
  });

  it('[data-id="9123"] 属性名存在但值动态 → dynamic-suspect', async () => {
    const [r] = await analyzeLocatorCandidates([{ strategy: 'css', value: '[data-id="9123"]' }], makeCounter(lines));
    expect(r!.verdict).toBe('dynamic-suspect');
  });

  it('真的臆造：[data-custom-flag="zzz"] 属性名与值都不在源码 → not-found', async () => {
    const [r] = await analyzeLocatorCandidates(
      [{ strategy: 'css', value: '[data-custom-flag="zzz"]' }],
      makeCounter(lines),
    );
    expect(r!.verdict).toBe('not-found');
    expect(r!.sourceCount).toBe(0);
  });
});

// ── Ranker ──
describe('reorderCandidates', () => {
  it('稳定重排：unique → dynamic-suspect → multiple → not-found → skipped', () => {
    const mk = (value: string, verdict: StaticLocatorReport['verdict']): StaticLocatorReport => ({
      strategy: 'css', value, verdict, sourceCount: null, sourceTruncated: false, samplePaths: [],
    });
    const reports = [
      mk('xpath-anc', 'skipped'),
      mk('title-anchor', 'multiple'),
      mk('ghost-anchor', 'not-found'),
      mk('good-anchor', 'unique'),
      mk('dynamic-anchor', 'dynamic-suspect'),
    ];
    const ordered = reorderCandidates(reports).map((r) => r.verdict);
    expect(ordered).toEqual(['unique', 'dynamic-suspect', 'multiple', 'not-found', 'skipped']);
  });
});

// ── Summary and dedupe cache ──
describe('summarizeStaticReports / 缓存', () => {
  it('摘要覆盖多命中/未命中/动态三类', async () => {
    const lines = [
      '<i class="icon-chakan" title="查看"></i>',
      '<li title="查看"></li>',
      '<input :placeholder="p" />',
    ];
    const s = await summarizeStaticReports(
      await analyzeLocatorCandidates(
        [
          { strategy: 'css', value: '[title="查看"]' },
          { strategy: 'css', value: '.icon-chakan' },
          { strategy: 'css', value: '[placeholder="请输入"]' },
        ],
        makeCounter(lines),
      ),
    );
    expect(s).toBeTruthy();
    expect(s!).toContain('源码命中多处');
    expect(s!).toContain('动态绑定');
    // .icon-chakan is unique → doesn't enter the summary
    expect(s!).not.toContain('.icon-chakan');
  });

  it('not-found 摘要措辞中性：不出现「臆造」等结论性字眼（prod228 实测会被 AI 当成选择器是假的）', async () => {
    const s = await summarizeStaticReports(
      await analyzeLocatorCandidates([{ strategy: 'css', value: '#tab-autodo' }], async () => ({ count: 0, truncated: false, samplePaths: [] })),
    );
    expect(s).toBeTruthy();
    expect(s!).toContain('源码无字面命中');
    expect(s!).toContain('运行时命中与否以实测为准');
    expect(s!).not.toContain('臆造');
  });

  it('重复候选共用一次 grep（pattern 去重缓存）', async () => {
    let calls = 0;
    const counting: LocatorCountFn = async (pattern) => {
      calls += 1;
      return { count: pattern.includes('wat') ? 1 : 0, truncated: false, samplePaths: [] };
    };
    const cands: Locator[] = [
      { strategy: 'css', value: '.wat' },
      { strategy: 'css', value: '.wat' },
      { strategy: 'css', value: '#other' },
    ];
    await analyzeLocatorCandidates(cands, counting);
    expect(calls).toBe(2); // .wat and #other once each
  });
});

// ── Batch version: verdicts must match the per-item version field for field ──
describe('analyzeLocatorCandidatesBatch', () => {
  /** Fake batch counter: one call receives all patterns, judging hits against the same fake source.
   *  Also asserts "duplicate patterns across candidates appear only once" (the dedupe benefit the batch version has over the per-item one). */
  function makeBatch(lines: string[]): BatchLocatorCountFn {
    return async (patterns) => {
      const table = new Map<string, SourceCount>();
      for (const p of new Set(patterns)) {
        const re = new RegExp(p);
        const hits = lines.filter((l) => re.test(l));
        table.set(p, { count: hits.length, truncated: false, samplePaths: hits.slice(0, 3).map((_, i) => `views/line-${i + 1}.vue`) });
      }
      return table;
    };
  }

  const socLines = [
    '<i class="icon-chakan operateBtn" title="查看"></i>',
    '<button class="toolbar-link" title="查看">查看</button>',
    '<a title="查看">查看</a>',
    '<li><span title="查看">查看</span></li>',
    '<p title="查看">点击查看</p>',
  ];

  it('输出与逐条版逐字段一致（SOC 夹具）', async () => {
    const cands: Locator[] = [
      { strategy: 'css', value: '[title="查看"]' },
      { strategy: 'css', value: '.icon-chakan' },
      { strategy: 'xpath', value: '/html/body/div[1]/button' },
    ];
    const serial = await analyzeLocatorCandidates(cands, makeCounter(socLines));
    const batch = await analyzeLocatorCandidatesBatch(cands, makeBatch(socLines));
    expect(batch).toEqual(serial);
  });

  it('dynamic-suspect / not-found 判定与逐条版一致', async () => {
    const dynLines = ['<el-input :placeholder="keywordPlaceholder" />', '<li :data-id="item.id" v-for="i in list" />'];
    const cands: Locator[] = [
      { strategy: 'css', value: '[placeholder="请输入关键字"]' },
      { strategy: 'css', value: '[data-id="9123"]' },
      { strategy: 'css', value: '[data-custom-flag="zzz"]' },
    ];
    expect(await analyzeLocatorCandidatesBatch(cands, makeBatch(dynLines))).toEqual(
      await analyzeLocatorCandidates(cands, makeCounter(dynLines)),
    );
  });

  it('一次性收集 precise+loose 全部 pattern；重复候选只带一份', async () => {
    let seen: string[] = [];
    const batch: BatchLocatorCountFn = async (patterns) => {
      seen = patterns;
      return new Map();
    };
    await analyzeLocatorCandidatesBatch(
      [
        { strategy: 'css', value: '[placeholder="账号"]' }, // precise + loose
        { strategy: 'css', value: '[placeholder="账号"]' }, // duplicate candidate
        { strategy: 'css', value: '.icon-chakan' }, // precise only
        { strategy: 'xpath', value: '/html/body' }, // statically undecidable, no pattern carried
      ],
      batch,
    );
    expect(seen).toHaveLength(3); // placeholder precise / placeholder loose / icon-chakan
    expect(new Set(seen).size).toBe(3);
  });

  it('批量查询抛错 → 全体降级为 0 命中（静默不判死，语义同逐条版的 count 失败兜底）', async () => {
    const reports = await analyzeLocatorCandidatesBatch(
      [{ strategy: 'css', value: '.icon-chakan' }],
      async () => { throw new Error('rg timeout'); },
    );
    expect(reports[0]!.verdict).toBe('not-found');
  });

  it('Map 缺失的 pattern 视为 0 命中，不抛错', async () => {
    const reports = await analyzeLocatorCandidatesBatch(
      [{ strategy: 'css', value: '.ghost' }],
      async () => new Map<string, SourceCount>(),
    );
    expect(reports[0]!.sourceCount).toBe(0);
  });
});