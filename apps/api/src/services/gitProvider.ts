/**
 * Git provider 抽象。当前只支持「仓库元数据 + 可达性验证」，不接 clone / file read。
 * 引入背景：iTest 的 AI 生成用例步骤会需要看代码；现在先确认 URL 形式合法、目标 host
 * 可达、PAT 有效（GitHub 走 REST API；GitLab 走 git ls-remote 真实探测；Gitee 仅 URL 形式校验）。
 *
 * 接口契约：verifyRepoAccess 返回 { valid: boolean, error?: string }，失败原因要可读，
 * 让前端表单在保存前提示。
 */
import { spawn } from 'node:child_process';

export type GitProviderName = 'github' | 'gitee' | 'gitlab';

export interface VerifyRepoInput {
  repoUrl: string;
  provider: GitProviderName;
  pat?: string;
  branch?: string;
}

export interface VerifyRepoResult {
  valid: boolean;
  error?: string;
  /** 分支是否存在（branch 非空时才有意义） */
  branchExists?: boolean;
  /** 默认分支（若 provider 可读出） */
  defaultBranch?: string;
}

/** URL 形式校验：与 iDO provider.validateRepoName 同型，但不去查实际 repo。 */
export function validateRepoUrl(repoUrl: string, provider: GitProviderName): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return { valid: false, error: '无效的仓库 URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: '仓库 URL 必须以 http(s):// 开头' };
  }
  switch (provider) {
    case 'github': {
      if (!/(^|\.)github\.com$/i.test(parsed.hostname)) {
        return { valid: false, error: 'GitHub 仓库 URL 主机名必须是 github.com' };
      }
      // 形如 /owner/repo[.git][/...]
      if (!/^\/[^/]+\/[^/]+(\.git)?\/?$/.test(parsed.pathname)) {
        return { valid: false, error: 'GitHub 仓库 URL 形如 https://github.com/<owner>/<repo>' };
      }
      return { valid: true };
    }
    case 'gitee': {
      if (!/(^|\.)gitee\.com$/i.test(parsed.hostname)) {
        return { valid: false, error: 'Gitee 仓库 URL 主机名必须是 gitee.com' };
      }
      if (!/^\/[^/]+\/[^/]+(\.git)?\/?$/.test(parsed.pathname)) {
        return { valid: false, error: 'Gitee 仓库 URL 形如 https://gitee.com/<owner>/<repo>' };
      }
      return { valid: true };
    }
    case 'gitlab': {
      // 自建 GitLab 不限 hostname；要求路径含 owner/repo
      if (!/^\/[^/]+\/[^/]+(\.git)?\/?$/.test(parsed.pathname)) {
        return { valid: false, error: 'GitLab 仓库 URL 形如 https://<host>/<owner>/<repo>' };
      }
      return { valid: true };
    }
  }
}

export function validateRepoName(name: string): { valid: boolean; error?: string } {
  // GitHub/Gitee 仓库名：字母数字 + . _ -，最长 100
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    return { valid: false, error: '仓库名只允许字母数字与 . _ -，最长 100' };
  }
  return { valid: true };
}

/**
 * 校验仓库可达性 + 分支存在。
 *  - URL 形式校验总是先做
 *  - GitHub：HEAD /repos/{owner}/{repo}（带 PAT）；无 PAT 则 GET /repos/.../branches/{branch}
 *    （unauthenticated 60/hr；超时即「提示需 PAT」）
 *  - GitLab：git ls-remote --symref 真实探测（与 clone 同传输层），一次拿默认分支 + 分支存在性
 *  - Gitee：URL 形式校验；未配置 token 时只校验 URL
 */

/** GitLab 真实可达性探测。用 git ls-remote 而非 HTTP HEAD：与 cloneFirst 走完全相同的传输层，
 *  clone 会失败的这里必失败——JW/code.srdcloud.cn 这类网络不通在保存前即暴露，而不是等
 *  AI 工作台 checkout 报「仓库不可用」。PAT 注入规则与 repo.ts injectPat 的 gitlab 分支对齐
 *  （oauth2:<pat>），无 PAT 原样带用户名探测，私有仓库会归为认证失败提示补 PAT。 */
async function probeGitLab(input: VerifyRepoInput): Promise<VerifyRepoResult> {
  const u = new URL(input.repoUrl);
  if (input.pat) {
    u.username = 'oauth2';
    u.password = input.pat;
  }
  // --symref HEAD 顺带吐出远端默认分支（ref: refs/heads/<x>\tHEAD），前端据此自动纠正 main/master 写错
  const args = ['ls-remote', '--symref', u.toString(), 'HEAD'];
  if (input.branch) args.push(`refs/heads/${input.branch}`);
  const r = await runGitProbe(args, 20_000);
  if (!r.ok) return r.result;
  let defaultBranch: string | undefined;
  let branchExists: boolean | undefined;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
    if (m) defaultBranch = m[1]!;
    if (input.branch && line.endsWith(`refs/heads/${input.branch}`)) branchExists = true;
  }
  if (input.branch && !branchExists) {
    return { valid: false, error: `分支 ${input.branch} 不存在`, defaultBranch, branchExists: false };
  }
  return { valid: true, defaultBranch, branchExists };
}

/** 带硬超时的 git ls-remote。禁交互（GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=echo），
 *  网络挂起时 10s 强杀并归为「连接超时」；stderr 按认证特征分类，其余原样透出 git 关键行。 */
function runGitProbe(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; result: VerifyRepoResult }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, result: { valid: false, error: `git 探测失败：${e.message}` } });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, stdout: out });
        return;
      }
      if (timedOut) {
        resolve({ ok: false, result: { valid: false, error: `连接超时：GitLab 服务 ${timeoutMs / 1000}s 内无响应（网络不可达或防火墙拦截）` } });
        return;
      }
      const lastLine = err.trim().split('\n').pop() ?? '';
      if (/401|403|authentication|could not read username|terminal prompts disabled/i.test(err)) {
        resolve({ ok: false, result: { valid: false, error: '认证失败：私有仓库须配置有效 PAT（或 PAT 权限不足）' } });
        return;
      }
      resolve({ ok: false, result: { valid: false, error: `仓库探测失败：${lastLine || `git exit ${code}`}` } });
    });
  });
}

export async function verifyRepoAccess(input: VerifyRepoInput): Promise<VerifyRepoResult> {
  const urlCheck = validateRepoUrl(input.repoUrl, input.provider);
  if (!urlCheck.valid) return { valid: false, error: urlCheck.error };

  if (input.provider === 'gitlab') return probeGitLab(input);
  if (input.provider !== 'github') {
    // Gitee 当前只做 URL 形式校验；不假装可达
    return { valid: true };
  }
  // GitHub：调用 REST API HEAD /repos/{owner}/{repo}；带 PAT 可放宽限速
  const m = input.repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/i);
  if (!m) return { valid: false, error: '无法解析 GitHub owner/repo' };
  const owner = m[1]!;
  const repo = m[2]!;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'iTest' };
  if (input.pat) headers.Authorization = `Bearer ${input.pat}`;
  try {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (repoRes.status === 404) return { valid: false, error: '仓库不存在或无权访问（404）' };
    if (repoRes.status === 403) return { valid: false, error: 'GitHub API 限流，请提供 PAT' };
    if (!repoRes.ok) return { valid: false, error: `GitHub API 返回 ${repoRes.status}` };
    const repoJson = (await repoRes.json()) as { default_branch?: string };
    const defaultBranch = repoJson.default_branch ?? 'main';
    let branchExists: boolean | undefined;
    if (input.branch) {
      const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(input.branch)}`, { headers });
      branchExists = branchRes.ok;
      if (!branchRes.ok && branchRes.status === 404) {
        return { valid: false, error: `分支 ${input.branch} 不存在`, defaultBranch, branchExists: false };
      }
    }
    return { valid: true, defaultBranch, branchExists };
  } catch (err) {
    return { valid: false, error: `网络错误：${(err as Error).message}` };
  }
}

/**
 * 列出远程 refs（branch 或 tag）。仅做存在性/可达性，不 clone。
 *  - GitHub：REST API（带 PAT 走认证；不带走匿名 60/hr）
 *  - Gitee / GitLab：URL 形式校验 + 头部可达性探针（Gitee/GitLab API 与 iTest 当前解耦，
 *    真实工程上需 PAT 才能稳定列远端 refs；这里给「provider 支持但本函数不支持」的明确错误，
 *    让 UI 显示「该 provider 暂不支持列举 refs，请手动输入」）。
 */
export async function listRefs(input: VerifyRepoInput & { kind: 'branch' | 'tag' }): Promise<string[]> {
  const urlCheck = validateRepoUrl(input.repoUrl, input.provider);
  if (!urlCheck.valid) throw new Error(urlCheck.error);

  if (input.provider === 'github') {
    const m = input.repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (!m) throw new Error('无法解析 GitHub owner/repo');
    const owner = m[1]!;
    const repo = m[2]!;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'iTest' };
    if (input.pat) headers.Authorization = `Bearer ${input.pat}`;
    // tags 走 /repos/{owner}/{repo}/tags?per_page=100；branches 走 /repos/{owner}/{repo}/branches?per_page=100
    const path = input.kind === 'tag'
      ? `/repos/${owner}/${repo}/tags?per_page=100`
      : `/repos/${owner}/${repo}/branches?per_page=100`;
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (res.status === 404) throw new Error('仓库不存在或无权访问（404）');
    if (res.status === 403) throw new Error('GitHub API 限流，请提供 PAT');
    if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
    const data = (await res.json()) as Array<{ name: string }>;
    return data.map((r) => r.name);
  }
  // Gitee / GitLab：当前不接 API 列远端 refs。错误提示 UI 走「手动输入」分支。
  throw new Error(`provider ${input.provider} 暂不支持列举 ${input.kind}，请手动输入`);
}