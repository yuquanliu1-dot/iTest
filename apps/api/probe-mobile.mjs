#!/usr/bin/env node
// 启动一个 iOS Simulator（agent-device 内部 prepare ios-runner）→ 跑 3 条 mobile step：appOpen / tap / screenshot。
// 校验 report.status === 'passed'、screenshots 目录产出 png。
// 不在 CI 跑；本地手动验证用：node apps/api/probe-mobile.mjs
// DRY_RUN=1 时仅打印请求序列不发请求。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const API = process.env.API_URL ?? 'http://127.0.0.1:54321';
const TOKEN = process.env.API_TOKEN ?? '';
const ORG_ID = process.env.ORG_ID ?? '';
const DRY_RUN = process.env.DRY_RUN === '1';

let cookieToken = '';

const log = (...a) => console.log(...a);
const ok = (msg) => log(`  \x1b[32m✓\x1b[0m ${msg}`);
const step = (msg) => log(`[step] ${msg}`);
const fail = (msg, body) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  if (body !== undefined) console.error(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  process.exit(1);
};

function authHeader() {
  if (TOKEN) return `Bearer ${TOKEN}`;
  if (cookieToken) return `Bearer ${cookieToken}`;
  return '';
}

async function request(method, path, body) {
  const url = `${API}${path}`;
  if (DRY_RUN) {
    step(`${method} ${path}${body !== undefined ? ' <body>' : ''}`);
    return { __dry: true };
  }
  const headers = { 'Content-Type': 'application/json' };
  const auth = authHeader();
  if (auth) headers.Authorization = auth;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // 首次 login 之后记住 cookie 以便后续 Bearer 头复用
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/(?:^|,\s*)authToken=([^;]+)/);
    if (m) cookieToken = decodeURIComponent(m[1]);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave as null */
  }
  if (!res.ok) fail(`${method} ${path} → ${res.status}`, json ?? text);
  return json;
}

async function login() {
  if (TOKEN) return;
  const username = process.env.API_USERNAME ?? 'admin';
  const password = process.env.API_PASSWORD ?? 'admin123';
  step(`login as ${username}`);
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/(?:^|,\s*)authToken=([^;]+)/);
    if (m) cookieToken = decodeURIComponent(m[1]);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok || !json || json.status !== 'ok') {
    fail(`login failed (${res.status})`, json ?? text);
  }
  if (!cookieToken) fail('login succeeded but no authToken cookie returned', { setCookie });
  ok(`logged in`);
}

async function resolveOrgId() {
  if (ORG_ID) return ORG_ID;
  step('resolve orgId from /api/auth/me');
  const me = await request('GET', '/api/auth/me');
  const active = me?.activeOrganizationId;
  if (!active) fail('cannot resolve orgId — pass ORG_ID env or ensure user has an active organization', me);
  return active;
}

async function pollReport(reportId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await request('GET', `/api/reports/${reportId}`);
    last = r;
    if (r?.status && r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  fail(`report ${reportId} did not finish within ${timeoutMs}ms`, last);
}

async function main() {
  await login();
  // DRY_RUN 下跳过 /auth/me 解析（dry request 返回 __dry 占位），让用户自己传 ORG_ID
  const orgId = DRY_RUN && !ORG_ID ? 'DRY_ORG_ID' : await resolveOrgId();
  const stamp = Date.now();
  const projectName = `mobile-probe-${stamp}`;

  step(`create project ${projectName}`);
  const project = await request('POST', '/api/projects', { name: projectName, organizationId: orgId });
  ok(`project ${project.id}`);

  step('create version');
  const version = await request('POST', `/api/projects/${project.id}/versions`, { name: `v-${stamp}` });
  ok(`version ${version.id}`);

  step('create default group');
  const group = await request('POST', `/api/projects/${project.id}/groups`, { name: 'probe' });
  ok(`group ${group.id}`);

  step('create device target');
  const target = await request('POST', `/api/projects/${project.id}/device-targets`, {
    name: `iPhone 17 Pro (probe-${stamp})`,
    mobileOs: 'ios',
    deviceRef: 'iPhone 17 Pro',
  });
  ok(`device target ${target.id}`);

  step('create mobile case');
  const caseRow = await request('POST', '/api/cases', {
    title: `mobile-probe-${stamp}`,
    priority: 'P1',
    groupId: group.id,
    versionId: version.id,
    platform: 'mobile',
    mobileOs: 'ios',
    mobileDeviceTargetId: target.id,
    appRef: { bundleId: 'com.apple.Preferences' },
  });
  ok(`case ${caseRow.id}`);

  step('write 3 mobile steps');
  await request('PUT', `/api/cases/${caseRow.id}/steps`, {
    steps: [
      { instruction: '打开设置', compiled: [{ kind: 'appOpen' }] },
      {
        instruction: '点击外观',
        compiled: [{ kind: 'tap', locator: [{ strategy: 'accessibilityId', value: 'appearance' }] }],
      },
      { instruction: '截图', compiled: [{ kind: 'screenshot', name: 'final' }] },
    ],
  });
  ok('steps written');

  step('execute case');
  const exec = await request('POST', `/api/cases/${caseRow.id}/execute`, {});
  const reportId = exec?.reportId;
  if (!reportId) fail('execute did not return reportId', exec);
  ok(`reportId ${reportId}`);

  step('poll report');
  const report = await pollReport(reportId);
  ok(`status=${report.status}`);

  const stepResults = Array.isArray(report.stepResults) ? report.stepResults : [];
  if (stepResults.length !== 3) fail(`expected 3 step results, got ${stepResults.length}`, stepResults);
  ok('3 step results');

  const last = stepResults[stepResults.length - 1];
  if (!last?.screenshot) fail('final step has no screenshot field', last);
  ok(`final step screenshot ${last.screenshot}`);

  // /screenshots/... 是静态映射,确认本地 png 真的写出来了
  try {
    const entries = await readdir(join(process.cwd(), 'screenshots', reportId));
    const pngs = entries.filter((f) => f.endsWith('.png'));
    if (pngs.length === 0) fail(`no png files in screenshots/${reportId}`, entries);
    ok(`screenshots/${reportId}/ contains ${pngs.length} png file(s) (e.g. ${pngs[0]})`);
  } catch (e) {
    fail(`cannot read screenshots/${reportId}: ${e.message}`);
  }

  if (report.status !== 'passed') fail(`report.status expected 'passed', got '${report.status}'`, report);
  ok('report.status === passed');

  console.log('\nProbe summary:');
  console.log(`  project=${project.id}  version=${version.id}  group=${group.id}  target=${target.id}`);
  console.log(`  case=${caseRow.id}  report=${reportId}  status=${report.status}  steps=${stepResults.length}`);
}

main().catch((e) => {
  console.error('\x1b[31mprobe-mobile failed:\x1b[0m', e?.message ?? e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
