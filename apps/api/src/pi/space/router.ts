/**
 * Version-space AI assistant HTTP+SSE contract (react-pi compatible subset), mounted at /api/assistant.
 * Only serves kind='version' threads.
 * Event channels share the same source as session fanOut (including confirm_request from emitThreadEvent).
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  aiThreads, aiStageCases, aiStageCaseOps, aiStageScenarios, aiStageEnvironments, aiStagePlans, aiStageDatasets,
} from '../../db/schema.js';
import { logger } from '../../logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertVersionVisible } from '../../services/projectAccess.js';
import { sseHeaders, sseSend, startSseHeartbeat } from '../../sse/pi.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../../execute/liveView.js';
import type { AuthUser } from '../../services/auth.service.js';
import { readLlmConfig } from '../modelBridge.js';
import { resolveConfirmation } from './confirm.js';
import { subscribeThreadMirror } from './threadBus.js';
import { generateSpaceSuggestionsOnce } from './suggestions.js';
import { stageRoute } from './stageRoute.js';
import { saveAssistantAttachmentUpload, MAX_ATTACHMENT_BYTES, type AttachmentExt } from './threadAttachments.js';
import { feedbackRoute } from './feedbackRoute.js';
import { getArtifact, readArtifactFile, contentDispositionUtf8, listThreadArtifacts } from './artifacts.js';
import { requireManager } from '../../middleware/auth.js';
import { guidesRoute } from './guidesRoute.js';
import { mcpServersRoute } from './mcpServersRoute.js';
import { skillsRoute } from './skillsRoute.js';
import { memoriesRoute } from './memoriesRoute.js';
import { trajectoriesRoute } from './trajectoriesRoute.js';
import promptModulesRoute from './promptModulesRoute.js';
import solidifyRoute from './solidifyRoute.js';
import failureLessonsRoute from './failureLessonsRoute.js';
import {
  cancelThread, clearThreadQueue, dropSpaceRecord, ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, spaceRepoIssue, subscribeThread, threadStatusAsync,
} from './session.js';
import type { ThreadSnapshot, SpacePromptImage } from './session.js';

export const spaceRoute = Router();

/** threadId → versionId; only accepts kind='version' (requirement threads belong to /api/pi; always 404 here). */
export async function assertSpaceThreadVisible(threadId: string, user: AuthUser): Promise<string> {
  const row = (await db
    .select({ kind: aiThreads.kind, versionId: aiThreads.versionId })
    .from(aiThreads)
    .where(eq(aiThreads.id, threadId))
    .limit(1))[0];
  if (!row || row.kind !== 'version' || !row.versionId) throw new HttpError(404, 'not_found', 'thread not found');
  await assertVersionVisible(row.versionId, user);
  return row.versionId;
}

/** react-pi contract: POST/GET threads must return a full PiThreadSnapshot; the fallback empty snapshot deliberately omits seq (the requirement-level /api/pi fallback carries legacy seq:0, do not sync them).
 *  Async: snapshotOfThread internally waits for the seq pump to drain, guaranteeing watermark ≥ content (a poisoned snapshot gives the frontend double bubbles). */
async function threadSnapshotResponse(threadId: string): Promise<ThreadSnapshot> {
  const live = await snapshotOfThread(threadId);
  return live ?? { metadata: { id: threadId, status: 'idle', messageCount: 0 }, messages: [] };
}

spaceRoute.post('/threads', async (req, res) => {
  const body = req.body as { metadata?: { versionId?: string }; workspacePath?: string };
  // react-pi's initialize sends {workspacePath} (Pi's official scope channel), legacy page-level calls send
  // {metadata:{versionId}}; accept both, versionId ≡ workspacePath (UUID string).
  const versionId = body.metadata?.versionId ?? body.workspacePath;
  if (!versionId) throw new HttpError(400, 'bad_request', 'metadata.versionId required');
  await assertVersionVisible(versionId, req.user as AuthUser);
  // Each call creates a new thread (one version, many threads). Init failure (LLM not configured etc.) → delete the row and surface the error,
  // frontend redirects to the settings page; repo unavailability does not block (session is still created, reason surfaced via lastError).
  const threadId = randomUUID();
  await db.insert(aiThreads).values({ id: threadId, kind: 'version', versionId, piThreadId: '', createdByUserId: (req.user as AuthUser).userId });
  try {
    await ensureSpaceRecord(threadId);
  } catch (e) {
    logger.error({ err: e, threadId, versionId }, 'space thread init failed');
    await db.delete(aiThreads).where(eq(aiThreads.id, threadId));
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, 'session_init_failed', e instanceof Error ? e.message : '会话初始化失败');
  }
  const snap: ThreadSnapshot & { lastError?: string } = await threadSnapshotResponse(threadId);
  const issue = spaceRepoIssue(threadId);
  if (issue) snap.lastError = `仓库暂不可用:${issue};对话可用,repo 类工具在修复仓库配置前会失败`;
  res.json(snap);
});

/** Row selection columns for GET /threads (piThreadId for fs probing). */
const threadListColumns = {
  id: aiThreads.id, title: aiThreads.title, createdAt: aiThreads.createdAt,
  updatedAt: aiThreads.updatedAt, piThreadId: aiThreads.piThreadId,
};
type ThreadListRow = {
  id: string; title: string | null; createdAt: Date | null; updatedAt: Date | null; piThreadId: string;
};

/** "Has session" criterion = the session file actually exists. Cannot use piThreadId !== '': with persist=true pi
 *  assigns the sessionFile path immediately (only the disk write is delayed), so draft threads also have a non-empty
 *  piThreadId, which would put every session that never sent a message into the history list — exactly what this
 *  filter was meant to prevent. */
async function probeSessionFiles(rows: ThreadListRow[]): Promise<boolean[]> {
  return Promise.all(rows.map((r) =>
    fs.access(r.piThreadId)
      .then(() => true)
      .catch((e: NodeJS.ErrnoException) => {
        // ENOENT is the norm (thread not written to disk yet); anything else (EACCES/EIO/dead volume) is an environment fault, don't swallow it silently.
        if (e.code !== 'ENOENT') logger.warn({ err: e, sessionFile: r.piThreadId }, 'session file probe failed');
        return false;
      })));
}

/** Serialize thread rows (react-pi validation compatible: title null must be a missing key; times emitted as ISO). status uses the async variant:
 *  when there is no local record, probe the run lock on other replicas so threads running on the polled replica are not mislabeled idle. */
async function serializeThreadRows(rows: ThreadListRow[]) {
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    // react-pi's isThreadMetadata validates with isOptionalString, so title:null would be rejected → the whole list
    // load throws Invalid Pi HTTP response. DB threads without a title (title NULL, the window before the first
    // message sets it) must serialize as undefined (key simply missing in JSON).
    title: row.title ?? undefined,
    status: (await threadStatusAsync(row.id)) ?? 'idle',
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
  })));
}

/** Common where clause for list queries: draft rows (piThreadId='') cannot pass the file criterion (fs.access('') always rejects),
 *  push it down into SQL so the LIMIT window is reserved for threads that may have a session; otherwise empty rows eat the quota and crowd out qualifying older threads. */
function threadListWhere(versionId: string) {
  return and(eq(aiThreads.kind, 'version'), eq(aiThreads.versionId, versionId), sql`${aiThreads.piThreadId} <> ''`);
}

spaceRoute.get('/threads', async (req, res) => {
  const raw = req.query.versionId;
  // react-pi's list goes through ?workspacePath= (official scope channel, value is the versionId); legacy page-level calls go through ?versionId=.
  const rawWs = req.query.workspacePath;
  const versionId = (typeof raw === 'string' ? raw : '') || (typeof rawWs === 'string' ? rawWs : '');
  // Neither param present → empty list (never return cross-version data out of scope).
  if (!versionId) { res.json([]); return; }
  await assertVersionVisible(versionId, req.user as AuthUser);

  // With ?limit= use the pagination contract ({threads, hasMore}); without it keep the legacy contract (hard cap 20 + bare array), zero awareness for legacy consumers.
  const limitRaw = Number(req.query.limit);
  if (!Number.isFinite(limitRaw) || limitRaw < 1) {
    const rows = (await db
      .select(threadListColumns)
      .from(aiThreads)
      .where(threadListWhere(versionId))
      // Sort anchor = creation time: updatedAt gets bumped by renames/new-message-title updates etc., floating old sessions into the wrong place;
      // id as tiebreaker gives a total order. Display order for same-instant ties was previously undefined, no behavior change.
      .orderBy(desc(aiThreads.createdAt), desc(aiThreads.id))
      .limit(20)) as ThreadListRow[];
    const exists = await probeSessionFiles(rows);
    res.json(await serializeThreadRows(rows.filter((_, i) => exists[i])));
    return;
  }

  const limit = Math.min(Math.floor(limitRaw), 200);
  // File existence can only be probed row by row and cannot be pushed down into SQL, so after filtering there may be fewer than a page ⇒ keyset loop fetching:
  // each round fetches a batch of raw rows in (createdAt,id) total order, until limit is met or raw rows run out (capped at 20 rounds,
  // to prevent a table full of draft rows from turning probing into a full scan). Cursor = last row's thread id of the previous batch; the comparison (createdAt,id)
  // goes through a row-value subquery so the DB resolves it itself — timestamp is microsecond precision; a round trip through ISO strings truncates to milliseconds,
  // skipping same-millisecond tie rows; the subquery has no such loss. Cursor row deleted → subquery NULL → empty page, accepted
  // (only happens when the other end happens to delete the cursor row). createdAt is immutable ⇒ position stable, keyset has no drift.
  // Each round fetches 1 extra row as the existence criterion ⇒ hasMore is exact rather than optimistic. Optimistic semantics cause real harm:
  // the client freshly pulls page 1 and writes back hasMore on every reload; optimistic true would revive the sentinel at "already scrolled to bottom + DB
  // exhausted", triggering a paging request destined to be empty; exact false keeps the sentinel off.
  const kept: ThreadListRow[] = [];
  let cursorId: string | undefined =
    typeof req.query.cursor === 'string' && req.query.cursor !== '' ? req.query.cursor : undefined;
  let hasMore = false;
  for (let round = 0; round < 20; round++) {
    const want = limit - kept.length;
    const batch = (await db
      .select(threadListColumns)
      .from(aiThreads)
      .where(and(
        threadListWhere(versionId),
        cursorId
          ? sql`(${aiThreads.createdAt}, ${aiThreads.id}) < (SELECT ${aiThreads.createdAt}, ${aiThreads.id} FROM ${aiThreads} WHERE ${aiThreads.id} = ${cursorId})`
          : undefined,
      ))
      .orderBy(desc(aiThreads.createdAt), desc(aiThreads.id))
      .limit(want + 1)) as ThreadListRow[];
    hasMore = batch.length > want;
    const page = hasMore ? batch.slice(0, want) : batch;
    const exists = await probeSessionFiles(page);
    for (let i = 0; i < page.length; i++) if (exists[i]) kept.push(page[i]!);
    if (kept.length >= limit) break; // can only be ==: page ≤ want ⇒ kept ≤ limit; hasMore must then be true
    if (!hasMore) break; // raw rows exhausted (this batch has fewer than want+1)
    cursorId = page[page.length - 1]!.id; // the truncated want+1-th row is naturally re-fetched next round via keyset
  }
  res.json({ threads: await serializeThreadRows(kept), hasMore });
});

spaceRoute.get('/threads/:id', async (req, res) => {
  // assertSpaceThreadVisible already guarantees kind='version' and the row exists (otherwise 404)
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  // Must ensure first (same as the SSE route below): snapshotOfThread only reads in-memory records; after a release restart
  // historical threads are cold in memory → an empty snapshot would be returned directly, the frontend shows a blank history session and the user must click twice
  // (the second SSE has rebuilt the session from JSONL). Here the session is rebuilt from disk (cold path measured ~20ms,
  // far below the user perception threshold) so the first click shows history; ensure is idempotent single-flight, zero cost for hot threads.
  try { await ensureSpaceRecord(req.params.id!); } catch { /* on build failure still return the fallback snapshot, no 500 */ }
  res.json(await threadSnapshotResponse(req.params.id!));
});

/** react-pi rename contract: PATCH {title} → 204. Empty/non-string 400; trimmed before persisting. */
spaceRoute.patch('/threads/:id', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { title?: unknown };
  if (typeof body.title !== 'string') throw new HttpError(400, 'bad_request', 'title required');
  const title = body.title.trim().slice(0, 200);
  await db.update(aiThreads).set({ title, updatedAt: new Date() }).where(eq(aiThreads.id, req.params.id!));
  res.status(204).end();
});

/** react-pi delete contract: DELETE → 204 (204 even if already gone; the client tolerates 404 the same way).
 *  In the same transaction, clear the six ai_stage_* staged rows (by threadId, no FK cascade) and the thread row; the in-memory session
 *  is released via dropSpaceRecord (dispose + unsubscribe), the on-disk session file is deleted separately, and SSE subscribers receive the disconnect afterwards. */
spaceRoute.delete('/threads/:id', async (req, res) => {
  const threadId = req.params.id!;
  await assertSpaceThreadVisible(threadId, req.user as AuthUser);
  // The session file path must be read before the transaction: once the transaction deletes the aiThreads row there is no way to recover it.
  const row = (await db.select({ piThreadId: aiThreads.piThreadId }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1))[0];
  await db.transaction(async (tx) => {
    await tx.delete(aiStageCases).where(eq(aiStageCases.threadId, threadId));
    await tx.delete(aiStageCaseOps).where(eq(aiStageCaseOps.threadId, threadId));
    await tx.delete(aiStageScenarios).where(eq(aiStageScenarios.threadId, threadId));
    await tx.delete(aiStageEnvironments).where(eq(aiStageEnvironments.threadId, threadId));
    await tx.delete(aiStagePlans).where(eq(aiStagePlans.threadId, threadId));
    await tx.delete(aiStageDatasets).where(eq(aiStageDatasets.threadId, threadId));
    await tx.delete(aiThreads).where(eq(aiThreads.id, threadId));
  });
  dropSpaceRecord(threadId);
  // Delete the session file outside the transaction: a delete failure must not roll the DB back into "thread still there but file gone";
  // missing file (ENOENT) is ignored silently, other faults are logged as warn — otherwise orphan files leave no trace.
  if (row?.piThreadId) await fs.unlink(row.piThreadId).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') logger.warn({ err: e, sessionFile: row.piThreadId }, 'session file delete failed; orphaned');
  });
  res.status(204).end();
});

spaceRoute.post('/threads/:id/messages', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { input?: { content?: string; streamingBehavior?: string; attachments?: unknown } };
  const content = body.input?.content ?? '';
  // react-pi's ThreadController derives streamingBehavior from the run state and sends it with input
  // (ThreadController.js:265). It must be passed through to the session, otherwise sending a message while running is rejected by Pi:
  // a no-arg prompt throws "Agent is already processing" while isStreaming. Only the two enum values are accepted;
  // unknown values fall back to default, never passing arbitrary strings into the SDK.
  const streamingBehavior = body.input?.streamingBehavior === 'steer' || body.input?.streamingBehavior === 'followUp'
    ? body.input.streamingBehavior
    : undefined;
  // images: react-pi converts composer attachments into pi's ImageContent ({type,mimeType,data as raw base64});
  // pass through into prompt.images as-is. Without validation, arbitrary structures from the raw body would reach the SDK,
  // so only items with all three fields present, mimeType image/*, and pure-base64 data are accepted.
  const images = parsePromptImages(body.input?.attachments);
  // Non-blocking response: reply 204 first, ensure + dispatch in the background (same as the requirement flow; silent when the LLM is not configured, the frontend learns via snapshot)
  void (async () => {
    try {
      await ensureSpaceRecord(req.params.id!);
      await sendSpaceUserMessage(req.params.id!, content, streamingBehavior, images);
    } catch (err) {
      // Cannot be silent: sendSpaceUserMessage already emitted an assistant_error event internally; this is the fallback error log
      // (unified attribution for ensure failure/prompt throw). Without this line the user message persists but the AI never responds, zero frontend feedback.
      logger.error({ threadId: req.params.id, err }, 'space message dispatch failed');
    }
  })();
  res.status(204).end();
});

/** Assistant attachment pre-upload: uploaded as soon as the composer picks a file (draft thread has no threadId yet → scope = version).
 *  raw octet-stream + X-Filename (global express.raw is mounted, same pattern as /api/cases attachments).
 *  The reference tag is spliced into the message body by the frontend adapter in send() — this route never touches message text.
 *  Type is dispatched by the X-Filename extension whitelist (.docx/.xlsx); .xls is OLE2 binary, not a zip,
 *  so renamed files are still rejected by the zip magic number; the 400 message tells users to re-save as .xlsx.
 *  X-Filename goes through encodeURIComponent (stuffing a non-ASCII filename directly into Headers throws a ByteString error in some browsers);
 *  the server decodes it, keeping the original value on failure. The default name is only a defensive fallback (the frontend always sends the header). */
spaceRoute.post('/versions/:versionId/attachments', async (req, res) => {
  const versionId = req.params.versionId!;
  await assertVersionVisible(versionId, req.user as AuthUser);
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf)) throw new HttpError(400, 'bad_request', 'expected octet-stream body');
  if (buf.length === 0) throw new HttpError(400, 'bad_request', 'empty body');
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'too_large', 'file exceeds the 10MB limit');
  const rawName = req.header('x-filename') ?? 'document.docx';
  let name = rawName;
  try { name = decodeURIComponent(rawName); } catch { /* keep non-encoded values as-is */ }
  const extName = path.extname(name).toLowerCase();
  const ext: AttachmentExt | null = extName === '.docx' ? 'docx' : extName === '.xlsx' ? 'xlsx' : null;
  if (!ext) throw new HttpError(400, 'bad_request', '仅支持 .docx / .xlsx 附件（.xls 请先另存为 .xlsx）');
  const { row, deduped } = await saveAssistantAttachmentUpload({
    versionId,
    name,
    buf,
    ext,
    createdByUserId: (req.user as AuthUser).userId ?? null,
  });
  res.json({
    name: row.name,
    path: row.storagePath,
    chars: row.extractedChars,
    size: row.sizeBytes,
    sha256: row.sha256,
    deduped,
    extracted: row.extractedPath !== null,
  });
});

/** Per-image byte cap. base64 encoding inflates by roughly 4/3; the worst-case size of a single message is decided by these two constants
 *  together with ASSISTANT_JSON_BODY_LIMIT (see the mount-order note in index.ts). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Per-message image count cap: aligned with what the Pi side can ingest; more only adds tokens and latency. */
const MAX_IMAGES = 4;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** base64 length → upper bound of the original byte count. Integer division would miss a valid image exactly at the cap, hence ceiling. */
const maxBase64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/** Pick valid image entries out of input.attachments. Invalid entries are dropped silently (no error) —
 *  attachments are an enhancement; one bad image must not block the whole message. */
function parsePromptImages(raw: unknown): SpacePromptImage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SpacePromptImage[] = [];
  for (const item of raw) {
    if (out.length >= MAX_IMAGES) break;
    if (!item || typeof item !== 'object') continue;
    const a = item as { mimeType?: unknown; data?: unknown };
    if (typeof a.mimeType !== 'string' || !a.mimeType.startsWith('image/')) continue;
    if (typeof a.data !== 'string' || a.data.length === 0) continue;
    if (a.data.length > maxBase64Length(MAX_IMAGE_BYTES)) continue;
    if (!BASE64_RE.test(a.data)) continue;
    out.push({ data: a.data, mimeType: a.mimeType });
  }
  return out.length > 0 ? out : undefined;
}

/** For index.ts to compute this router's json body cap: worst-case image size + margin. */
export const ASSISTANT_JSON_BODY_LIMIT = `${Math.ceil(maxBase64Length(MAX_IMAGE_BYTES) * MAX_IMAGES / 1024 / 1024) + 4}mb`;

spaceRoute.post('/threads/:id/cancel', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  cancelThread(req.params.id!);
  res.status(204).end();
});

/** Clear-queue route of the react-pi contract (see httpClient's wire contract). Returns the cleared content
 *  so the frontend can restore the text into the input box — a user canceling a queued message must not lose text. */
spaceRoute.post('/threads/:id/queue/clear', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  res.json(clearThreadQueue(req.params.id!));
});

/** Suggested follow-ups: pulled on demand by the frontend after an AI answer settles (POST rather than GET: it triggers an LLM call, must not be cached/prefetched).
 *  The transcript comes from the server-side session.messages full text; failure semantics in suggestions.ts (HttpError surfaced / otherwise falls back to []).
 *  Cross-replica: session records live on the running replica; when local is cold but the pi session file is on the shared volume → ensure rebuilds the transcript from JSONL,
 *  fixing "polling lands on another replica and always 404s". Orphan rows with empty piThreadId have no session to rebuild; skip ensure
 *  (avoiding the side effect of triggering a full session build for a thread that never had one), 404 semantics unchanged. */
spaceRoute.post('/threads/:id/suggestions', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const row = (await db.select({ piThreadId: aiThreads.piThreadId }).from(aiThreads).where(eq(aiThreads.id, req.params.id!)).limit(1))[0];
  if (row?.piThreadId) {
    try { await ensureSpaceRecord(req.params.id!); } catch { /* 404/502 semantics are handled by generate */ }
  }
  res.json(await generateSpaceSuggestionsOnce(req.params.id!));
});

spaceRoute.post('/threads/:id/confirm', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { confirmId?: string; approved?: boolean };
  if (!body.confirmId || typeof body.approved !== 'boolean') {
    throw new HttpError(400, 'bad_request', 'confirmId and approved are required');
  }
  // async: when no local pending confirmation, goes through the cross-replica gate (GETDEL claim + PUBLISH the answer back to the pending replica); miss still 404s.
  if (!(await resolveConfirmation(body.confirmId, body.approved))) {
    throw new HttpError(404, 'not_found', 'confirmation not found or expired');
  }
  res.status(204).end();
});

spaceRoute.get('/models', async (_req, res) => {
  const cfg = await readLlmConfig();
  if (!cfg) { res.json([]); return; }
  res.json([{ provider: cfg.provider, modelId: cfg.model }]);
});

spaceRoute.get('/threads/:id/events', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  sseHeaders(res);
  // The close handle is registered before ensure: building a session can take tens of seconds; if the client disconnects during that window
  // the close event has already fired, and an unsub registered afterwards would never run → listener leak.
  let closed = false;
  let unsub: (() => void) | null = null;
  let unsubMirror: (() => void) | null = null;
  // Heartbeat: keeps the byte stream alive during long tasks (a verify_case single-step AI phase can be silent for 240s); otherwise nginx
  // proxy_read_timeout (300s) kills the connection during silent read-side stretches, react-pi never reconnects = frontend frozen forever.
  // The comment frame `: ping` is discarded by EventSource, only keeping the connection alive without producing events. On write failure/disconnect, clear the timer to finish up.
  const stopHeartbeat = startSseHeartbeat(res);
  const cleanup = (): void => {
    stopHeartbeat();
    unsub?.();
    unsubMirror?.();
  };
  res.on('error', cleanup);
  req.on('close', () => { closed = true; cleanup(); });
  // Ensure the session is built before subscribing: if SSE arrives before the first message with no record, the listener registers on
  // noop and all subsequent confirm_request/stage events are lost; ensure is idempotent single-flight, returns immediately if cached.
  // On failure (LLM not configured etc.) keep the empty-snapshot semantics without breaking the connection.
  try { await ensureSpaceRecord(req.params.id!); } catch { /* thread cannot become active, snapshot still receivable */ }
  if (closed) { cleanup(); return; }
  try {
    const send = (e: unknown) => sseSend(res, e as unknown as Parameters<typeof sseSend>[1]);
    // subscribeThread carries its own snapshot (sends a legal empty snapshot when there is no active session), and after the snapshot replays in order
    // the in-session custom events buffered during disconnection (verify_progress/announce/stage/…) plus still-pending confirmation cards;
    // the frontend store dedupes by seq — reconnects lose no live state; confirm_request / stage events go through the same listeners channel via emitThreadEvent.
    // subscribeThread returns unsub synchronously: between the closed check above and the assignment there is no await, no race window.
    unsub = subscribeThread(req.params.id!, send, { includeSnapshot: true });
    // Cross-replica mirror: when the thread lives on another replica, events are relayed via Redis into the same response (origin filters this replica's loopback,
    // avoiding double-delivery of locally delivered events). When the thread runs on this replica, local listeners cover it and the mirror stays silent.
    unsubMirror = subscribeThreadMirror(req.params.id!, send);
  } catch {
    cleanup();
    if (res.writable && !res.writableEnded) res.end();
  }
});

/** Assistant playground live view: MJPEG stream during verify_case / solidify_case execution.
 *  Auth identical to SSE (thread visibility); key is randomly generated by the tool runtime and delivered with the start event.
 *  ?replay=1 is the recording replay of this tool execution (within 30min after execution ends); &speed=N is the replay speed;
 *  ?replay=meta probes whether the recording can still be replayed (the frontend uses this to decide whether to show the "Replay" button). */
spaceRoute.get('/threads/:id/live/:key', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  if (req.query.replay === 'meta') return handleLiveReplayMeta(res, req.params.key!);
  if (req.query.replay === '1') return handleLiveReplay(req, res, req.params.key!, { speed: replaySpeedOf(req.query) });
  handleLiveView(req, res, req.params.key!);
});

/** A thread's persisted artifacts list (documents generated by skills etc.). Pulled by the frontend when switching sessions, refilling download cards into the UI —
 *  SSE artifact events are only pushed while running, and the server-side replay buffer lives in process memory, so refreshing the page loses download cards. */
spaceRoute.get('/threads/:id/artifacts', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const items = await listThreadArtifacts(req.params.id!);
  res.json(items);
});

/** AI-generated file download (the token carried by artifact events is exchanged for the file stream).
 *  Auth = thread visibility (same as SSE); expired/missing 410; file swept 404.
 *  Content-Type comes from the artifact record's mime — cannot hardcode application/zip, otherwise docx/xlsx/png
 *  would be downloaded as a zip in the browser (extension right, type wrong). */
spaceRoute.get('/threads/:id/artifacts/:token', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const a = await getArtifact(req.params.token!);
  if (!a) throw new HttpError(410, 'artifact_expired', '文件已过期或不存在');
  if (a.threadId !== req.params.id) throw new HttpError(410, 'artifact_expired', '文件已过期或不存在');
  let buf: Buffer;
  try {
    buf = await readArtifactFile(a);
  } catch {
    throw new HttpError(404, 'not_found', '文件已被清理');
  }
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Content-Disposition', contentDispositionUtf8(a.name));
  res.send(buf);
});

spaceRoute.use(stageRoute);

// User feedback (collected only, not consumed). Same tier as stage: no requireManager — submitting feedback is ordinary user
// behavior; thread visibility is enforced by assertSpaceThreadVisible inside feedbackRoute.
spaceRoute.use(feedbackRoute);

// Admin-side CRUD: protected by requireManager (member → 403). Mounted under /api/assistant;
// the global requireAuth is handled uniformly by the outer index.ts (router.ts does not re-auth itself).
spaceRoute.use('/guides', requireManager, guidesRoute);
spaceRoute.use('/mcp-servers', requireManager, mcpServersRoute);
spaceRoute.use('/skills', requireManager, skillsRoute);
spaceRoute.use('/memories', requireManager, memoriesRoute);
spaceRoute.use('/trajectories', requireManager, trajectoriesRoute);
spaceRoute.use('/prompt-modules', requireManager, promptModulesRoute);
spaceRoute.use('/solidify', requireManager, solidifyRoute);
spaceRoute.use('/failure-lessons', requireManager, failureLessonsRoute);
