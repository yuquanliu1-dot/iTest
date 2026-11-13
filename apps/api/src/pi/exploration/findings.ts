/**
 * Finding persistence (pi chain A1 evidence frame).
 *
 * Structural difference from legacy onFindings: legacy screenshotted after "the model's next-round JSON arrived and
 * the previous action had already mutated the page" — the screenshot was never the frame the model judged on.
 * The pi chain's report_finding is a tool the model actively calls: the tool settles first, then screenshots (=
 * the decision frame); frame metadata lands in the evidence_frame column and the frame image is returned to the
 * model for self-checking (if the report and the frame disagree, it corrects itself next round).
 *
 * Dedup/quota/shape tolerance reuse the same rules as coerceFindings (cross-round near-dups, synonym merging, dirty severity fallback).
 */
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
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
  /** Persisted ordinal (present when ok=true). */
  order?: number;
  /** Feedback text for the model (actionable). */
  message: string;
  /** Decision-frame image (attached when ok=true and the screenshot succeeded, for model self-checking). */
  imageBase64?: string;
}

/** In-session verification record (report_finding mechanical gate). The tool layer validates it before
 *  calling report(); only verified candidates get here (reproduced is always true — failed-reproduction
 *  candidates are rejected and auto-recorded into the excluded ledger, never persisted). */
export interface FindingVerification {
  category: 'code' | 'environment' | 'data' | 'ux' | 'other';
  expected: string;
  actual: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface FindingStore {
  report(raw: unknown, verification?: FindingVerification): Promise<FindingReportOutcome>;
  get savedCount(): number;
  get modelReported(): number;
}

export function createFindingStore(args: {
  sessionId: string;
  page: Page;
  /** Action-trail fragment since the last finding (held by the runner; the store signals a reset after a finding is persisted). */
  getTrailSince(): ExplorationStep[];
  resetTrailSince(): void;
  /** Session-level action ordinal (evidence_frame.trailIndex: the frame's position in the whole action sequence). */
  sessionStepsLength(): number;
  /** Trail persistence (flushed immediately after the finding lands, keeping detail-page ordering consistent). */
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
    async report(raw: unknown, verification?: FindingVerification): Promise<FindingReportOutcome> {
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
      // Decision frame: settle first, then capture — this frame must be the picture at the moment the model judged (the whole point of A1).
      try {
        await waitForPageSettled(args.page, { timeoutMs: 2500 });
      } catch {
        /* settle best-effort: screenshot even on failure */
      }
      let buf: Buffer | null = null;
      let frameWritten = false;
      try {
        buf = await args.page.screenshot({ timeout: 15_000, type: 'png' });
        // The directory must be created manually: legacy went through page.screenshot({path}), where Playwright creates
        // the directory along the way; after the pi chain switched to buffer + fs.writeFile that step was missing → ENOENT,
        // decision frames never hit disk (proven on prod228: the DB recorded a path, the file did not exist, the frontend
        // evidence image was a guaranteed 404).
        const diskPath = screenshotDiskPath(args.sessionId, order);
        await fs.mkdir(dirname(diskPath), { recursive: true });
        await fs.writeFile(diskPath, buf);
        frameWritten = true;
      } catch (e) {
        logger.warn({ err: e, sessionId: args.sessionId, order }, 'exploration pi finding screenshot failed');
      }
      const trailSince = args.getTrailSince();
      // Record the path only on a real disk write: recording a path despite a failed write = a frontend image guaranteed to be broken.
      const screenshotPath = frameWritten ? `/screenshots/${args.sessionId}/finding-${order}.png` : null;
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
          ...(verification
            ? {
                verification: {
                  category: verification.category,
                  expected: verification.expected,
                  actual: verification.actual,
                  evidence: verification.evidence,
                  confidence: verification.confidence,
                  reproducedAt: new Date().toISOString(),
                },
              }
            : {}),
        });
        savedCount += 1;
        seenTitles.add(f.title);
        // Reset the fragment only when a finding landed: a dropped batch must not truncate the "since the last finding" semantics (same as legacy).
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
