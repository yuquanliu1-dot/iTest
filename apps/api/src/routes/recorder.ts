import { Router } from 'express';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { stat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import archiver from 'archiver';
import { db } from '../db/client.js';
import { testCases, testSteps, testAttachments, testSessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { StepAction } from '@itest/shared';
import { createSession, getSession } from '../recorder/ws.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { assertCaseVisible } from '../services/projectAccess.js';
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
  const resolvedUrl = await resolveCaseUrl(exists[0]!, { defaultEnvFallback: true });
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
  const session = getSession(req.params.id);
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
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, session.caseId)))[0];
  if (caseRow && !caseRow.url) {
    const firstStepUrl = (session.steps[0] as { url?: string | null } | undefined)?.url ?? null;
    const candidate = session.targetUrl ?? firstStepUrl ?? (await resolveCaseUrl(caseRow, { defaultEnvFallback: true }));
    if (candidate && /^https?:\/\//.test(candidate)) {
      await db.update(testCases).set({ url: candidate, updatedAt: new Date() }).where(eq(testCases.id, session.caseId));
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
  res.json({ inserted });
});

recorderRoute.post('/sessions/:id/tab-events', async (req, res) => {
  const session = getSession(req.params.id);
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

recorderRoute.get('/extension.zip', async (_req, res) => {
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
  try {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { version?: string };
    version = manifest.version ?? version;
  } catch (err) {
    logger.warn({ err }, 'extension.zip: manifest.json read failed, using default version');
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

  for (const rel of files) {
    // 双重保险：再断言一遍路径不会逃出 root（防止 manifest.json 被改坏导致 readdir 跑飞）
    const safe = relative(root, join(root, rel));
    if (safe.startsWith('..') || safe.includes('..' + sep)) continue;
    archive.file(join(root, rel), { name: `itest-recorder${sep}${safe}` });
  }
  await archive.finalize();
});