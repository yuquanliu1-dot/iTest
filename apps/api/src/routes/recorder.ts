import { Router } from 'express';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { stat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import archiver from 'archiver';
import { db } from '../db/client.js';
import { testCases, testSteps, testAttachments, testSessions, groups } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { StepAction } from '@itest/shared';
import { createSession, getSession, persistSession, appendTabEvent, getSessionTabs, finishSession } from '../recorder/ws.js';
import { resolveCaseUrl, projectWebOrigins, relativizeUrl } from '../lib/resolve-url.js';
import { WebServiceMissing } from '../execute/envContext.js';
import { assertCaseVisible } from '../services/projectAccess.js';
import { invalidateCasesCache } from '../services/cases.service.js';
import { encrypt } from '../lib/secret-crypto.js';
import { migrateAction } from '../lib/step-migration.js';
import { logger } from '../logger.js';

export const recorderRoute = Router();

// Recording WS address: the extension's machine must be able to connect directly (must not point at the web port — /recorder doesn't go through the vite proxy).
// RECORDER_PUBLIC_WS_URL is the full endpoint; when the path is empty, /recorder is appended; invalid values fall back to the local default.
export function buildRecorderWsUrl(): string {
  const fallback = `ws://127.0.0.1:${process.env.API_PORT ?? 54321}/recorder`;
  const raw = process.env.RECORDER_PUBLIC_WS_URL;
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('scheme must be ws/wss');
    if (u.pathname === '' || u.pathname === '/') u.pathname = '/recorder';
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch (err) {
    logger.warn({ raw, err }, 'invalid RECORDER_PUBLIC_WS_URL, falling back to localhost');
    return fallback;
  }
}

const CreateBody = z.object({
  caseId: z.string().uuid(),
  mode: z.enum(['fresh', 'append', 'resume', 'incognito']).default('fresh'),
  incognito: z.boolean().optional(),
  resumeFromOrder: z.number().int().positive().optional(),
  targetUrl: z.string().url().optional(),
});

recorderRoute.post('/sessions', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, body.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(body.caseId, req.user!);
  if (body.mode === 'resume') {
    const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, body.caseId));
    // resumeFromOrder is the order of the first new step; earlier steps are validation only (replay is driven on the extension side).
    const upto = body.resumeFromOrder ?? steps.length + 1;
    const slice = steps.filter((s) => s.order < upto);
    for (const s of slice) {
      const a = (Array.isArray(s.compiled) && s.compiled.length > 0
        ? s.compiled[0]
        : undefined) as { kind?: string; fileId?: string } | undefined;
      if (a?.kind === 'upload') {
        if (!a.fileId) throw new HttpError(409, 'upload_unbound', `upload step #${s.order} has no fileId bound`);
        const att = await db.select().from(testAttachments).where(eq(testAttachments.id, a.fileId));
        if (att.length === 0) throw new HttpError(409, 'upload_missing', `attachment ${a.fileId} not found`);
      }
    }
  }
  // A relative-url resolution failure must be intercepted before creating the session: otherwise resolvedUrl=null reaches
  // the extension and chrome.tabs.create opens the empty/relative string as an extension-relative path → "Your file couldn't be accessed".
  // WebServiceMissing (environment has no web service / url shape illegal) converts to a user-visible 422; the no-default-environment path,
  // where resolveCaseUrl only returns null, also gets a 422 with actionable guidance.
  let resolvedUrl: string | null;
  try {
    resolvedUrl = await resolveCaseUrl(exists[0]!, { defaultEnvFallback: true });
  } catch (e) {
    if (e instanceof WebServiceMissing) throw new HttpError(422, 'web_service_missing', e.message);
    throw e;
  }
  if (!resolvedUrl && exists[0]!.url) {
    throw new HttpError(
      422,
      'url_unresolved',
      `用例 URL「${exists[0]!.url}」为相对路径，但项目没有默认环境可拼接 origin：请到环境管理把目标环境设为默认，或给用例选择默认环境，或在录制面板手填完整目标 URL`,
    );
  }
  const session = createSession(body.caseId, {
    mode: body.mode,
    incognito: body.incognito ?? body.mode === 'incognito',
    resumeFromOrder: body.resumeFromOrder,
    targetUrl: body.targetUrl ?? null,
  });
  // Also persist the session row for audit
  const dbRow = await db
    .insert(testSessions)
    .values({
      caseId: body.caseId,
      mode: body.mode,
      incognito: body.incognito ?? body.mode === 'incognito',
      resumeFromOrder: body.resumeFromOrder ?? null,
    })
    .returning({ id: testSessions.id });
  session.dbSessionId = dbRow[0]!.id;
  // createSession already write-throughs once, but dbSessionId wasn't assigned yet at that point; do it again so cross-replica reads can see the audit id.
  void persistSession(session);
  res.json({
    sessionId: session.sessionId,
    wsToken: process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me',
    wsUrl: buildRecorderWsUrl(),
    resolvedUrl,
    mode: body.mode,
  });
});

// Merge consecutive fills with the same locator: React controlled inputs remount during typing / the user pauses midway,
// so the recorder produces multiple fills (values accumulate; executing them one by one on replay is equivalent but noisy).
// The merge keeps the last fill's value, position from the first. Other kinds or different locators don't merge
// (switching away and coming back to fill is legitimately two steps, necessarily separated by other steps).
// frameChain joins the merge key: the same locator in different frames targets different elements; merging would write the value into the wrong frame.
type RecordedStepItem = { action?: { kind?: string; locator?: unknown; value?: unknown; sensitive?: unknown; frameChain?: unknown } };

/** Exported for unit tests (regression anchor for cross-frame fill not merging). */
export function mergeConsecutiveFills(steps: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1] as RecordedStepItem | undefined;
    const cur = step as RecordedStepItem;
    if (
      prev && cur.action?.kind === 'fill' && prev.action?.kind === 'fill'
      && JSON.stringify(prev.action.locator) === JSON.stringify(cur.action.locator)
      && JSON.stringify(prev.action.frameChain ?? null) === JSON.stringify(cur.action.frameChain ?? null)
    ) {
      prev.action.value = cur.action.value;
      prev.action.sensitive = cur.action.sensitive ?? prev.action.sensitive;
      continue;
    }
    out.push(step);
  }
  return out;
}

recorderRoute.post('/sessions/:id/finish', async (req, res) => {
  // Read-and-delete at finish: a second finish 404s (the old implementation re-inserted steps on repeat reads). steps/tabs come from append-only storage,
  // so even cross-replica (WS and REST finish landing on different replicas) the union can be assembled.
  const finished = await finishSession(req.params.id);
  if (!finished) throw new HttpError(404, 'not_found', 'session not found');
  const session = finished.meta;
  await assertCaseVisible(session.caseId, req.user!);
  session.ws?.close(1000, 'finished');
  let inserted = 0;
  const existing = await db.select().from(testSteps).where(eq(testSteps.caseId, session.caseId));
  let nextOrder = existing.length > 0 ? Math.max(...existing.map((s) => s.order)) + 1 : 1;
  // The initial navigation no longer becomes a navigate step; it is written to test_cases.url (case-level init step),
  // and runCase / executeCaseReal goto it once before each replay. Source priority: targetUrl passed by the web console
  // > the page URL where recording's first step happened > the case resolution chain fallback. An existing case.url is not overwritten
  // (avoiding append/resume writing the first recording's URL onto an already-configured case).
  // Best-effort relativization (spec 2026-10-16): origin matches any environment web service of the project → store the relative path + bind the service;
  // no match (external site) keeps the absolute URL.
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, session.caseId)))[0];
  const caseProjectId = caseRow
    ? (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, caseRow.groupId)))[0]!.projectId
    : null;
  const origins = caseRow ? await projectWebOrigins(caseProjectId!) : new Map<string, string | null>();
  if (caseRow && !caseRow.url) {
    const firstStepUrl = (finished.steps[0] as { url?: string | null } | undefined)?.url ?? null;
    const candidate = session.targetUrl ?? firstStepUrl ?? (await resolveCaseUrl(caseRow, { defaultEnvFallback: true }));
    if (candidate && /^https?:\/\//.test(candidate)) {
      const rel = relativizeUrl(candidate, origins);
      await db.update(testCases).set({
        url: rel ? (rel.path || null) : candidate,
        ...(rel ? { webServiceRef: rel.ref } : {}),
        updatedAt: new Date(),
      }).where(eq(testCases.id, session.caseId));
    }
  }
  const mergedSteps = mergeConsecutiveFills(finished.steps);
  for (const step of mergedSteps) {
    const item = step as { action: unknown; tabRef?: string; componentKind?: string; url?: string };
    StepAction.parse(item.action);
    const action = item.action as {
      kind?: string;
      url?: string;
      value?: unknown;
      sensitive?: boolean;
    };
    // Mid-run navigate best-effort relativization: origin matches any environment web service of the project → store the relative path (joined again at execution time);
    // no match (external site) keeps the absolute URL. Only the in-memory action is changed before persisting; the original target is untouched.
    if (action.kind === 'navigate' && typeof action.url === 'string') {
      const rel = relativizeUrl(action.url, origins);
      if (rel) action.url = rel.path || '/';
    }
    const sensitive = action.kind === 'fill' && !!action.sensitive;
    let secretCiphertext: string | null = null;
    let secretIv: string | null = null;
    let secretTag: string | null = null;
    if (sensitive) {
      const enc = encrypt(String(action.value ?? ''));
      secretCiphertext = enc.ciphertext.toString('base64');
      secretIv = enc.iv.toString('base64');
      secretTag = enc.tag.toString('base64');
      delete (action as Record<string, unknown>).value;
    }
    // Recording artifact: instruction left empty, compiled is a single-element array = [the recorded StepAction].
    // kind === 'navigate' no longer lands as its own step (the init URL is already written to the case-level url), consistent with replay/frontend.
    await db.insert(testSteps).values({
      caseId: session.caseId,
      order: nextOrder++,
      source: 'recorder',
      instruction: action.kind === 'navigate' ? `打开 ${action.url ?? ''}` : '',
      compiled: [migrateAction(action) as unknown] as unknown[],
      tabRef: item.tabRef ?? null,
      componentKind: item.componentKind ?? null,
      sensitive,
      secretCiphertext,
      secretIv,
      secretTag,
    });
    inserted++;
  }
  if (finished.tabs.length > 0 && session.dbSessionId) {
    await db.update(testSessions).set({ tabs: finished.tabs }).where(eq(testSessions.id, session.dbSessionId));
  }
  // The recording artifact changed the case url + appended steps, so the list cache (solidification progress column) must be invalidated
  await invalidateCasesCache(caseProjectId);
  res.json({ inserted });
});

recorderRoute.post('/sessions/:id/tab-events', async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) throw new HttpError(404, 'not_found', 'session not found');
  const body = z.object({
    events: z.array(z.object({
      kind: z.enum(['opened', 'closed']),
      tabRef: z.string().min(1).max(64),
      title: z.string().optional(),
      url: z.string().optional(),
    })),
  }).parse(req.body);
  for (const ev of body.events) await appendTabEvent(req.params.id, ev);
  res.json({ count: (await getSessionTabs(req.params.id)).length });
});

/** Infer the extension root directory from the @itest/recorder workspace package's package.json.
 *  dev goes through the pnpm symlink to apps/recorder; prod after tsc compilation may also keep the symlink;
 *  on resolution failure fall back to a cwd-relative path (one robust fallback kept). */
function resolveRecorderRoot(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@itest/recorder/package.json');
    // ../package.json → the parent level is the package root
    return join(pkgPath, '..');
  } catch (err) {
    logger.warn({ err }, 'resolveRecorderRoot: @itest/recorder not resolvable, falling back to cwd/../recorder');
    return join(process.cwd(), 'apps', 'recorder');
  }
}

/** Whitelisted extensions: the runtime file types the extension manifest actually loads.
 *  Anything not whitelisted (.ts sources, .map, .git, etc.) never enters the zip. */
const ALLOWED_EXTS = new Set(['.js', '.json', '.css', '.html', '.png']);
const SKIP_DIRS = new Set(['node_modules', 'test', '.git']);
/** Config/type/build artifacts: not needed at extension runtime; if modified by a developer they make Chrome misidentify the root directory as a workspace. */
const SKIP_FILES = new Set(['package.json', 'tsconfig.json', 'tsconfig.build.json', 'package-lock.json', 'pnpm-lock.yaml']);

async function walkRecorderDir(root: string, rel: string, out: string[]): Promise<void> {
  const abs = join(root, rel);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const childRel = rel ? `${rel}${sep}${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkRecorderDir(root, childRel, out);
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      const dot = e.name.lastIndexOf('.');
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : '';
      if (!ALLOWED_EXTS.has(ext)) continue;
      out.push(childRel);
    }
  }
}

/** Resolve the console origin corresponding to the download request (written into the manifest and console-config.default inside the zip).
 *  Priority: the browser's Origin header > Referer parsing > nginx-forwarded Host + X-Forwarded-Proto.
 *  On resolution failure fall back to null (keeping the manifest default localhost/127.0.0.1).
 *  Exported for tests only; production code doesn't use it. */
export function deriveConsoleOrigin(req: import('express').Request): string | null {
  const xfpRaw = req.headers['x-forwarded-proto'];
  const proto = (typeof xfpRaw === 'string' ? xfpRaw : Array.isArray(xfpRaw) ? xfpRaw[0] : 'http')
    ?.split(',')[0]?.trim().toLowerCase();
  const originHdr = req.headers['origin'];
  const originStr = typeof originHdr === 'string' ? originHdr : undefined;
  if (originStr) {
    try { return new URL(originStr).origin; } catch { /* fallthrough */ }
  }
  const refHdr = req.headers['referer'];
  const refStr = typeof refHdr === 'string' ? refHdr : undefined;
  if (refStr) {
    try { return new URL(refStr).origin; } catch { /* fallthrough */ }
  }
  const hostHdr = req.headers['host'];
  const hostStr = typeof hostHdr === 'string' ? hostHdr : undefined;
  if (hostStr) {
    const scheme = proto === 'https' ? 'https' : proto === 'http' ? 'http' : 'http';
    return `${scheme}://${hostStr}`;
  }
  return null;
}

/** Join an origin into a content_scripts matches entry; for the same origin one http(s)/* entry suffices.
 *  An origin like http://192.168.30.228:8080 → http://192.168.30.228:8080/*
 *  Note: Chromium rejects :/* patterns that omit the host, so host+port must be preserved.
 *  Exported for tests only. */
export function originToMatchPattern(origin: string): string {
  return `${origin}/*`;
}

recorderRoute.get('/extension.zip', async (req, res) => {
  const root = resolveRecorderRoot();
  // Build artifact check: modules/recorder-manager.js is the esbuild entry; missing = not built yet.
  try {
    await stat(join(root, 'modules', 'recorder-manager.js'));
  } catch {
    throw new HttpError(
      409,
      'extension_not_built',
      'recorder extension has no build artifacts; run `pnpm --filter @itest/recorder build` first',
    );
  }
  // manifest version is used as the zip filename suffix — updated in sync after build
  let version = '0.0.0';
  let manifestText: string | null = null;
  try {
    manifestText = await readFile(join(root, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText) as { version?: string; content_scripts?: Array<{ matches?: string[] }> };
    version = manifest.version ?? version;
  } catch (err) {
    logger.warn({ err }, 'extension.zip: manifest.json read failed, using default version');
  }

  // Rewrite manifest.content_scripts.matches based on the request origin, so the downloaded extension injects directly on the corresponding console domain.
  // When no origin resolves (direct curl etc.), the source manifest is kept as-is.
  const consoleOrigin = deriveConsoleOrigin(req);
  if (consoleOrigin && manifestText) {
    try {
      const manifest = JSON.parse(manifestText) as {
        content_scripts?: Array<{ matches?: string[]; js?: string[]; run_at?: string }>;
      };
      const cs = manifest.content_scripts?.[0];
      if (cs) {
        const defaults = ['http://localhost/*', 'http://127.0.0.1/*'];
        const deployed = originToMatchPattern(consoleOrigin);
        // Avoid duplicates: skip the write when the deployed origin already equals one of the defaults.
        const merged = Array.from(new Set([...(cs.matches ?? []), deployed, ...defaults]));
        cs.matches = merged.filter((m, idx, arr) => arr.indexOf(m) === idx);
        manifestText = JSON.stringify(manifest, null, 2);
      }
    } catch (err) {
      logger.warn({ err, consoleOrigin }, 'extension.zip: failed to inject deployed origin into manifest');
    }
  }

  // The DEFAULT_CONSOLE_ORIGIN in console-config.js decides the popup's first-screen input default;
  // rewriting it to the deployed origin makes it work right after download, no dialog edit needed across machines.
  let consoleConfigText: string | null = null;
  if (consoleOrigin) {
    try {
      const raw = await readFile(join(root, 'modules', 'console-config.js'), 'utf8');
      // Only rewrite when DEFAULT_CONSOLE_ORIGIN is the source default http://localhost:5173,
      // avoiding overwriting test or later hand-built artifacts.
      consoleConfigText = raw.replace(
        /export const DEFAULT_CONSOLE_ORIGIN = 'http:\/\/localhost:5173';/,
        `export const DEFAULT_CONSOLE_ORIGIN = ${JSON.stringify(consoleOrigin)};`,
      );
    } catch (err) {
      logger.warn({ err }, 'extension.zip: console-config.js read failed');
    }
  }

  const files: string[] = [];
  await walkRecorderDir(root, '', files);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="itest-recorder-v${version}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') logger.warn({ err }, 'extension.zip warning');
  });
  archive.on('error', (err) => {
    logger.error({ err }, 'extension.zip error');
    if (!res.headersSent) res.status(500).json({ message: 'failed to build extension zip' });
    else res.end();
  });
  archive.pipe(res);

  // Clear the two files to be rewritten first, avoiding later archive.file overwriting them as same-name appends (archiver doesn't dedupe same-name entries).
  const OVERRIDE_FILES = new Set<string>([
    'manifest.json',
    'modules' + sep + 'console-config.js',
  ]);

  for (const rel of files) {
    if (OVERRIDE_FILES.has(rel)) continue;
    // Double safety: assert again that the path can't escape root (prevents readdir from running wild if manifest.json got corrupted)
    const safe = relative(root, join(root, rel));
    if (safe.startsWith('..') || safe.includes('..' + sep)) continue;
    archive.file(join(root, rel), { name: `itest-recorder${sep}${safe}` });
  }

  if (manifestText) {
    archive.append(manifestText, { name: `itest-recorder${sep}manifest.json` });
  } else {
    // On parse failure still include the source default manifest, avoiding the extension installing with an empty manifest
    try {
      const fallback = await readFile(join(root, 'manifest.json'), 'utf8');
      archive.append(fallback, { name: `itest-recorder${sep}manifest.json` });
    } catch (err) {
      logger.error({ err }, 'extension.zip: fallback manifest.json read failed');
    }
  }
  if (consoleConfigText) {
    archive.append(consoleConfigText, { name: `itest-recorder${sep}modules${sep}console-config.js` });
  } else {
    try {
      const fallback = await readFile(join(root, 'modules', 'console-config.js'), 'utf8');
      archive.append(fallback, { name: `itest-recorder${sep}modules${sep}console-config.js` });
    } catch (err) {
      logger.warn({ err }, 'extension.zip: fallback console-config.js read failed');
    }
  }

  await archive.finalize();
});

// Version of the currently deployed extension (the version in manifest.json, same source as /extension.zip).
// The frontend badge compares it with the "installed version": when installed is older, show the upgrade-available state + download entry.
recorderRoute.get('/extension/version', async (_req, res) => {
  const root = resolveRecorderRoot();
  let version = '0.0.0';
  try {
    const text = await readFile(join(root, 'manifest.json'), 'utf8');
    version = (JSON.parse(text) as { version?: string }).version ?? version;
  } catch (err) {
    logger.warn({ err }, 'extension/version: manifest.json read failed');
  }
  res.json({ version });
});

