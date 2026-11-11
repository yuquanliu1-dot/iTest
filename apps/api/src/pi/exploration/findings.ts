/**
 * finding 状态与落库（pi 链路 A1 证据帧）。
 *
 * 与 legacy onFindings 的结构性差异：legacy 的截图发生在「模型下一轮 JSON 到达、
 * 上一条动作已把页面改掉」之后——截图永远不是模型做判断那一刻的画面。
 * pi 链路的 report_finding 是模型主动调用的工具：工具内部先 settle 再截图（= 决策帧），
 * 帧元数据落 evidence_frame 列，帧图回传给模型自检（报的内容与帧内容对不上，下一轮自己纠正）。
 *
 * 去重/配额/形状容错复用 coerceFindings 同一份口径（跨轮 near-dup、近义合并、脏 severity 兜底）。
 */
import fs from 'node:fs/promises';
import type { Page } from 'playwright-core';
import { db } from '../../db/client.js';
import { explorationFindings } from '../../db/schema.js';
import {
  coerceFindings,
  trailToSteps,
  EXPLORATION_MAX_FINDINGS,
  type ExplorationStep,
} from '../../execute/explorationPrompt.js';
import { waitForPageSettled } from '../../execute/pageSettle.js';
import { screenshotDiskPath } from '../../execute/explorationShared.js';
import { logger } from '../../logger.js';

export interface FindingReportOutcome {
  ok: boolean;
  /** 落库序号（ok=true 时有）。 */
  order?: number;
  /** 给模型的反馈文本（可行动）。 */
  message: string;
  /** 决策帧图（ok=true 且截图成功时附上，供模型自检）。 */
  imageBase64?: string;
}

export interface FindingStore {
  report(raw: unknown): Promise<FindingReportOutcome>;
  get savedCount(): number;
  get modelReported(): number;
}

export function createFindingStore(args: {
  sessionId: string;
  page: Page;
  /** 自上一条 finding 起的留痕片段（runner 持有，finding 落库后由 store 通知重置）。 */
  getTrailSince(): ExplorationStep[];
  resetTrailSince(): void;
  /** 会话级动作序号（evidence_frame.trailIndex：帧在整场动作序列里的位置）。 */
  sessionStepsLength(): number;
  /** 留痕落库（finding 落库后立刻 flush，详情页时序一致）。 */
  onPersist(): Promise<void>;
}): FindingStore {
  const seenTitles = new Set<string>();
  let savedCount = 0;
  let modelReported = 0;
  return {
    get savedCount() {
      return savedCount;
    },
    get modelReported() {
      return modelReported;
    },
    async report(raw: unknown): Promise<FindingReportOutcome> {
      modelReported += 1;
      const { accepted, dropped, invalid } = coerceFindings([raw], {
        existingTitles: [...seenTitles],
        max: Math.max(0, EXPLORATION_MAX_FINDINGS - savedCount),
      });
      if (accepted.length === 0) {
        logger.info({ sessionId: args.sessionId, dropped, invalid }, 'exploration pi finding rejected');
        return {
          ok: false,
          message:
            'finding 未落库（与已报条目重复、超出会话配额、或标题/描述缺失）。重复条目不要换措辞重报；若是新缺陷请补全标题与描述后再报。',
        };
      }
      const f = accepted[0]!;
      const order = savedCount + 1;
      // 决策帧：先等渲染稳定再截——这一帧必须是模型判断时的画面（A1 的全部意义）。
      try {
        await waitForPageSettled(args.page, { timeoutMs: 2500 });
      } catch {
        /* settle 尽力而为：失败也截图 */
      }
      let buf: Buffer | null = null;
      try {
        buf = await args.page.screenshot({ timeout: 5000, type: 'png' });
        await fs.writeFile(screenshotDiskPath(args.sessionId, order), buf);
      } catch (e) {
        logger.warn({ err: e, sessionId: args.sessionId, order }, 'exploration pi finding screenshot failed');
      }
      const trailSince = args.getTrailSince();
      const screenshotPath = buf ? `/screenshots/${args.sessionId}/finding-${order}.png` : null;
      try {
        await db.insert(explorationFindings).values({
          sessionId: args.sessionId,
          order,
          title: f.title,
          description: f.description,
          severity: f.severity,
          reproSteps: f.reproSteps.length > 0 ? f.reproSteps : trailToSteps(trailSince),
          actionsTrail: [...trailSince],
          screenshotPath,
          pageUrl: args.page.url(),
          evidenceFrame: {
            url: args.page.url(),
            viewport: args.page.viewportSize() ?? null,
            capturedAt: new Date().toISOString(),
            trailIndex: args.sessionStepsLength(),
            ...(screenshotPath ? { screenshotPath } : {}),
          },
        });
        savedCount += 1;
        seenTitles.add(f.title);
        // 只有落了 finding 才重置片段：被丢弃的批次不能截断「自上一条 finding 起」的语义（同 legacy）。
        args.resetTrailSince();
        await args.onPersist();
        return {
          ok: true,
          order,
          message: `finding #${order} 已落库（${savedCount}/${EXPLORATION_MAX_FINDINGS}）。上方截图即落库的证据帧，请核对帧内容与描述一致；不一致时在下一条 finding 的描述里修正。`,
          ...(buf ? { imageBase64: buf.toString('base64') } : {}),
        };
      } catch (e) {
        logger.warn({ err: e, sessionId: args.sessionId }, 'exploration pi finding insert failed');
        return { ok: false, message: 'finding 落库失败（平台存储异常），请稍后重报或换更完整的标题/描述。' };
      }
    },
  };
}
