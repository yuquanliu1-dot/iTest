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
import { createSession, getSession, persistSession } from '../recorder/ws.js';
import { resolveCaseUrl, projectWebOrigins, relativizeUrl } from '../lib/resolve-url.js';
import { WebServiceMissing } from '../execute/envContext.js';
import { assertCaseVisible } from '../services/projectAccess.js';
import { invalidateCasesCache } from '../services/cases.service.js';
import { encrypt } from '../lib/secret-crypto.js';
import { migrateAction } from '../lib/step-migration.js';
import { logger } from '../logger.js';

export const recorderRoute = Router();

// 录制 WS 地址：扩展所在机器必须能直连该地址（不能指向 web 端口——/recorder 不走 vite proxy）。
// RECORDER_PUBLIC_WS_URL 为完整 endpoint，path 为空时补 /recorder；非法值回落本机默认。
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
    // resumeFromOrder 是第一条新步骤的 order；之前的步骤只做校验（回放由扩展侧驱动）。
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
  // 相对 url 解析失败必须在建会话前拦下：否则 resolvedUrl=null 传到扩展,chrome.tabs.create
  // 会把空/相对串当扩展内相对路径打开 → "Your file couldn't be accessed"。
  // WebServiceMissing(环境无 web 服务 / url 形态非法)转 422 用户可见;无默认环境这条 resolveCaseUrl
  // 只回 null 的路也补 422,给出可操作指引。
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
  // createSession 已 write-through 一次,但那时 dbSessionId 还没赋值;补一次让跨副本能读到审计 id。
  void persistSession(session);
  res.json({
    sessionId: session.sessionId,
    wsToken: process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me',
    wsUrl: buildRecorderWsUrl(),
    resolvedUrl,
    mode: body.mode,
  });
});

// 连续同 locator 的 fill 合并：React controlled input 在输入过程中 remount / 用户中途停顿时，
// recorder 会产多条 fill（值为累计值，回放时逐条执行结果等价但噪音大）。合并保留最后一条的值，
// 位置取第一条。其他 kind 或 locator 不同不合并（切走再回来填是合法的两步，中间必有其他步骤隔开）。
type RecordedStepItem = { action?: { kind?: string; locator?: unknown; value?: unknown; sensitive?: unknown } };

function mergeConsecutiveFills(steps: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1] as RecordedStepItem | undefined;
    const cur = step as RecordedStepItem;
    if (
      prev && cur.action?.kind === 'fill' && prev.action?.kind === 'fill'
      && JSON.stringify(prev.action.locator) === JSON.stringify(cur.action.locator)
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
  const session = await getSession(req.params.id);
  if (!session) throw new HttpError(404, 'not_found', 'session not found');
  await assertCaseVisible(session.caseId, req.user!);
  session.ws?.close(1000, 'finished');
  let inserted = 0;
  const existing = await db.select().from(testSteps).where(eq(testSteps.caseId, session.caseId));
  let nextOrder = existing.length > 0 ? Math.max(...existing.map((s) => s.order)) + 1 : 1;
  // 初始导航不再落成 navigate 步骤；改写到 test_cases.url（用例级 init step），
  // 由 runCase / executeCaseReal 在每次回放前 goto 一次。来源优先级：web 中台传入的 targetUrl
  // > 录制第一步发生的页面 URL > 用例解析链兜底。已有的 case.url 不覆盖（避免 append/resume
  // 把首录的 URL 写到一条已配置过的用例上）。
  // 尽力相对化（spec 2026-10-16）：origin 命中项目任一环境 web 服务 → 存相对路径 + 绑定服务；
  // 未命中（外站）保留绝对。
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, session.caseId)))[0];
  const caseProjectId = caseRow
    ? (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, caseRow.groupId)))[0]!.projectId
    : null;
  const origins = caseRow ? await projectWebOrigins(caseProjectId!) : new Map<string, string | null>();
  if (caseRow && !caseRow.url) {
    const firstStepUrl = (session.steps[0] as { url?: string | null } | undefined)?.url ?? null;
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
  const mergedSteps = mergeConsecutiveFills(session.steps);
  for (const step of mergedSteps) {
    const item = step as { action: unknown; tabRef?: string; componentKind?: string; url?: string };
    StepAction.parse(item.action);
    const action = item.action as {
      kind?: string;
      url?: string;
      value?: unknown;
      sensitive?: boolean;
    };
    // 中途 navigate 尽力相对化：origin 命中项目任一环境 web 服务 → 存相对路径（执行时再拼）；
    // 未命中（外站）保留绝对。只改内存里的 action 再落库，不动原目标。
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
    // 录制产物:instruction 留空,compiled 单元素数组 = [录制得到的 StepAction]。
    // kind === 'navigate' 不再单独落 step(初始化 URL 已写用例级 url),与回放/前端一致。
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
  if (session.tabs && session.tabs.length > 0 && session.dbSessionId) {
    await db.update(testSessions).set({ tabs: session.tabs }).where(eq(testSessions.id, session.dbSessionId));
  }
  // 录制产物改了用例 url + 追加步骤,列表缓存(固化进度列)必须失效
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
  if (!session.tabs) session.tabs = [];
  session.tabs.push(...body.events);
  void persistSession(session);
  res.json({ count: session.tabs.length });
});

/** 用 @itest/recorder workspace 包的 package.json 反推扩展根目录。
 *  dev 走 pnpm symlink 到 apps/recorder；prod 走 tsc 编译后也可能保留 symlink；
 *  解析失败时回退到 cwd 相对路径（保留一份鲁棒兜底）。 */
function resolveRecorderRoot(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@itest/recorder/package.json');
    // ../package.json → 上一级就是包根目录
    return join(pkgPath, '..');
  } catch (err) {
    logger.warn({ err }, 'resolveRecorderRoot: @itest/recorder not resolvable, falling back to cwd/../recorder');
    return join(process.cwd(), 'apps', 'recorder');
  }
}

/** 白名单后缀：扩展 manifest 实际加载的运行时文件类型。
 *  不在白名单的（.ts 源码、.map、.git 等）一律不进 zip。 */
const ALLOWED_EXTS = new Set(['.js', '.json', '.css', '.html', '.png']);
const SKIP_DIRS = new Set(['node_modules', 'test', '.git']);
/** 配置/类型/构建工件：扩展运行时不需要，开发者修改后会让 Chrome 把根目录当 workspace 误识别。 */
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

/** 解析下载请求对应中台 origin（写到 zip 里的 manifest 与 console-config.default）。
 *  优先级：浏览器 Origin 头 > Referer 解析 > nginx 透传的 Host + X-Forwarded-Proto。
 *  解析失败回退 null（保留 manifest 默认 localhost/127.0.0.1）。
 *  导出仅供测试；生产代码用不到。 */
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

/** 把 origin 拼成 content_scripts matches 项；同源已是 http(s)/* 一条足够。
 *  origin 形如 http://192.168.30.228:8080 → http://192.168.30.228:8080/*
 *  注意：Chromium 拒绝 :/* 这种省略 host 的 pattern，所以要保留 host+port。
 *  导出仅供测试。 */
export function originToMatchPattern(origin: string): string {
  return `${origin}/*`;
}

recorderRoute.get('/extension.zip', async (req, res) => {
  const root = resolveRecorderRoot();
  // build 产物校验：modules/recorder-manager.js 是 esbuild 入口，缺失 = 还没 build。
  try {
    await stat(join(root, 'modules', 'recorder-manager.js'));
  } catch {
    throw new HttpError(
      409,
      'extension_not_built',
      'recorder extension has no build artifacts; run `pnpm --filter @itest/recorder build` first',
    );
  }
  // manifest version 用作 zip 文件名后缀——build 后会同步更新
  let version = '0.0.0';
  let manifestText: string | null = null;
  try {
    manifestText = await readFile(join(root, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText) as { version?: string; content_scripts?: Array<{ matches?: string[] }> };
    version = manifest.version ?? version;
  } catch (err) {
    logger.warn({ err }, 'extension.zip: manifest.json read failed, using default version');
  }

  // 根据请求 origin 重写 manifest.content_scripts.matches，让下载得到的扩展在对应中台域名直接注入。
  // 没解析出 origin（curl 直连等）时保留源码 manifest 原样。
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
        // 避免重复：部署 origin 已经等于 default 之一时跳过写入。
        const merged = Array.from(new Set([...(cs.matches ?? []), deployed, ...defaults]));
        cs.matches = merged.filter((m, idx, arr) => arr.indexOf(m) === idx);
        manifestText = JSON.stringify(manifest, null, 2);
      }
    } catch (err) {
      logger.warn({ err, consoleOrigin }, 'extension.zip: failed to inject deployed origin into manifest');
    }
  }

  // console-config.js 里的 DEFAULT_CONSOLE_ORIGIN 决定 popup 首屏 input 默认值；
  // 重写为部署 origin，下载即用、跨机器时不必再去弹窗里改。
  let consoleConfigText: string | null = null;
  if (consoleOrigin) {
    try {
      const raw = await readFile(join(root, 'modules', 'console-config.js'), 'utf8');
      // 仅在 DEFAULT_CONSOLE_ORIGIN 是源码默认 http://localhost:5173 时改写，
      // 避免覆盖测试或后续手工构建的产物。
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

  // 先把两个要重写的文件清掉，避免被后面 archive.file 覆盖式同名追加（archiver 不会去重同 name 条目）。
  const OVERRIDE_FILES = new Set<string>([
    'manifest.json',
    'modules' + sep + 'console-config.js',
  ]);

  for (const rel of files) {
    if (OVERRIDE_FILES.has(rel)) continue;
    // 双重保险：再断言一遍路径不会逃出 root（防止 manifest.json 被改坏导致 readdir 跑飞）
    const safe = relative(root, join(root, rel));
    if (safe.startsWith('..') || safe.includes('..' + sep)) continue;
    archive.file(join(root, rel), { name: `itest-recorder${sep}${safe}` });
  }

  if (manifestText) {
    archive.append(manifestText, { name: `itest-recorder${sep}manifest.json` });
  } else {
    // 解析失败时还是带上源码默认 manifest，避免扩展装上空 manifest
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

// 当前部署扩展的版本（manifest.json 里的 version，与 /extension.zip 同源）。
// 前端徽标拿它和「已装版本」对比：已装较旧时亮出可升级态 + 下载入口。
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

