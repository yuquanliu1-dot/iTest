/**
 * Git provider abstraction. Currently supports "repo metadata + reachability verification" only; no clone / file read.
 * Why it exists: iTest's AI-generated case steps will need to read code; for now we confirm the URL form is valid,
 * the target host is reachable, and the PAT works (GitHub via REST API; GitLab via real git ls-remote probing; Gitee URL-form check only).
 *
 * Interface contract: verifyRepoAccess returns { valid: boolean, error?: string }; failure reasons must be readable
 * so the frontend form can warn before saving.
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
  /** Whether the branch exists (meaningful only when branch is non-empty) */
  branchExists?: boolean;
  /** Default branch (when the provider exposes it) */
  defaultBranch?: string;
}

/** URL form validation: same shape as iDO provider.validateRepoName, but without querying the actual repo. */
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
      // Form: /owner/repo[.git][/...]
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
      // Self-hosted GitLab: hostname unrestricted; path must contain owner/repo
      if (!/^\/[^/]+\/[^/]+(\.git)?\/?$/.test(parsed.pathname)) {
        return { valid: false, error: 'GitLab 仓库 URL 形如 https://<host>/<owner>/<repo>' };
      }
      return { valid: true };
    }
  }
}

export function validateRepoName(name: string): { valid: boolean; error?: string } {
  // GitHub/Gitee repo names: alphanumerics plus . _ -, max 100
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    return { valid: false, error: '仓库名只允许字母数字与 . _ -，最长 100' };
  }
  return { valid: true };
}

/**
 * Verifies repo reachability + branch existence.
 *  - URL form validation always runs first
 *  - GitHub: HEAD /repos/{owner}/{repo} (with PAT); without a PAT, GET /repos/.../branches/{branch}
 *    (unauthenticated 60/hr; timeout is reported as "PAT required")
 *  - GitLab: real git ls-remote --symref probing (same transport as clone), fetching default branch + branch existence in one shot
 *  - Gitee: URL form validation; without a token configured, only the URL is checked
 */

/** Injects the PAT into the remote URL (gitlab mirrors clone semantics: oauth2:<pat>; returned as-is when no PAT). */
function withPat(repoUrl: string, pat?: string): string {
  const u = new URL(repoUrl);
  if (pat) {
    u.username = 'oauth2';
    u.password = pat;
  }
  return u.toString();
}

/** Real GitLab reachability probe. Uses git ls-remote rather than HTTP HEAD: exactly the same transport as cloneFirst,
 *  so anything clone would fail at fails here too — unreachable networks like JW/code.srdcloud.cn surface before saving
 *  instead of waiting for the AI workbench checkout to report "repo unavailable". PAT injection matches repo.ts injectPat's
 *  gitlab branch (oauth2:<pat>); without a PAT it probes as-is with the username, classifying private repos as auth failure. */
async function probeGitLab(input: VerifyRepoInput): Promise<VerifyRepoResult> {
  // --symref HEAD also yields the remote default branch (ref: refs/heads/<x>\tHEAD); the frontend uses it to auto-correct a mis-typed main/master
  const args = ['ls-remote', '--symref', withPat(input.repoUrl, input.pat), 'HEAD'];
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

/** git ls-remote with a hard timeout. Interaction disabled (GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=echo);
 *  a hung network gets SIGKILLed after 10s and reported as "connection timeout"; stderr is classified by auth signatures,
 *  the rest passes git's key line through verbatim. */
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
    // Gitee currently only validates the URL form; doesn't fake reachability
    return { valid: true };
  }
  // GitHub: REST API HEAD /repos/{owner}/{repo}; a PAT relaxes the rate limit
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
 * Lists remote refs (branch or tag). Existence/reachability only, no clone.
 *  - GitHub: REST API (with PAT it authenticates; without, anonymous 60/hr)
 *  - GitLab: git ls-remote --refs (same transport as clone, PAT injected the same oauth2 way) —
 *    before 2026-10-24 only GitHub was supported and gitlab always said "please enter manually", so the version-ref dropdown was permanently empty
 *  - Gitee: no refs-listing channel wired up; a clear error steers the UI into the "enter manually" branch.
 */
export async function listRefs(input: VerifyRepoInput & { kind: 'branch' | 'tag' }): Promise<string[]> {
  const urlCheck = validateRepoUrl(input.repoUrl, input.provider);
  if (!urlCheck.valid) throw new Error(urlCheck.error);

  if (input.provider === 'gitlab') {
    const args = ['ls-remote', '--refs', withPat(input.repoUrl, input.pat), input.kind === 'tag' ? 'refs/tags/*' : 'refs/heads/*'];
    const r = await runGitProbe(args, 20_000);
    if (!r.ok) throw new Error(r.result.error ?? '列举远端 refs 失败');
    return parseLsRemoteRefs(r.stdout, input.kind);
  }

  if (input.provider === 'github') {
    const m = input.repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (!m) throw new Error('无法解析 GitHub owner/repo');
    const owner = m[1]!;
    const repo = m[2]!;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'iTest' };
    if (input.pat) headers.Authorization = `Bearer ${input.pat}`;
    // tags hit /repos/{owner}/{repo}/tags?per_page=100; branches hit /repos/{owner}/{repo}/branches?per_page=100
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
  // Gitee: no API channel for listing remote refs yet. The error steers the UI into the "enter manually" branch.
  throw new Error(`provider ${input.provider} 暂不支持列举 ${input.kind}，请手动输入`);
}

/** Parses ls-remote output lines `<sha>\t<full-ref>`, stripping the refs/heads/ or refs/tags/ prefix;
 *  skips `^{}` deref lines and stray lines without a tab. Exported for unit tests only. */
export function parseLsRemoteRefs(stdout: string, kind: 'branch' | 'tag'): string[] {
  const prefix = kind === 'tag' ? 'refs/tags/' : 'refs/heads/';
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const full = line.slice(tab + 1).trim();
    if (!full.startsWith(prefix) || full.endsWith('^{}')) continue;
    out.push(full.slice(prefix.length));
  }
  return out;
}

export interface VerifyRefResult {
  valid: boolean;
  error?: string;
}

/** Verifies the remote branch/tag exists — the "test" before saving a ref, surfacing typos in the dialog,
 *  instead of waiting for the AI workbench checkout to silently fall back to the default branch or the clone to fail.
 *  - GitLab: git ls-remote exact-matches refs/heads/<ref> / refs/tags/<ref> (same transport as clone);
 *    no match yields git exit 0 + empty stdout, which distinguishes "missing" from "probe failed"
 *  - GitHub: REST API (branches/<ref> / git/ref/tags/<ref>)
 *  - Gitee: no verification channel wired up; asks for manual confirmation. */
export async function verifyRef(
  input: VerifyRepoInput & { ref: string; kind: 'branch' | 'tag' },
): Promise<VerifyRefResult> {
  const urlCheck = validateRepoUrl(input.repoUrl, input.provider);
  if (!urlCheck.valid) return { valid: false, error: urlCheck.error };
  const ref = input.ref.trim();
  if (!ref) return { valid: false, error: 'ref 不能为空' };
  const noun = input.kind === 'tag' ? '标签' : '分支';

  if (input.provider === 'gitlab') {
    // branch→refs/heads/<ref>: git's prefix is heads, not branchs (spelling refs/branchs/ makes the exact match miss,
    // exit 0 with empty output → the branch always false-reports "missing on remote"; tag's refs/tags/ happens to be spelled right, so only branches were broken).
    const pattern = input.kind === 'tag' ? `refs/tags/${ref}` : `refs/heads/${ref}`;
    const r = await runGitProbe(['ls-remote', withPat(input.repoUrl, input.pat), pattern], 20_000);
    if (!r.ok) return r.result;
    return r.stdout.trim().length > 0 ? { valid: true } : { valid: false, error: `远端不存在${noun} ${ref}` };
  }

  if (input.provider === 'github') {
    const m = input.repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (!m) return { valid: false, error: '无法解析 GitHub owner/repo' };
    const [, owner, repo] = m;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'iTest' };
    if (input.pat) headers.Authorization = `Bearer ${input.pat}`;
    const url = input.kind === 'tag'
      ? `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(ref)}`
      : `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(ref)}`;
    try {
      const res = await fetch(url, { headers });
      if (res.status === 404) return { valid: false, error: `远端不存在${noun} ${ref}` };
      if (res.status === 403) return { valid: false, error: 'GitHub API 限流，请提供 PAT' };
      if (!res.ok) return { valid: false, error: `GitHub API 返回 ${res.status}` };
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `网络错误：${(err as Error).message}` };
    }
  }

  return { valid: false, error: `provider ${input.provider} 暂不支持校验${noun}，请手动确认` };
}