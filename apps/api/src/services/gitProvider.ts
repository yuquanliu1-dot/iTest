/**
 * Git provider 抽象。当前只支持「仓库元数据 + 可达性验证」，不接 clone / file read。
 * 引入背景：iTest 的 AI 生成用例步骤会需要看代码；现在先确认 URL 形式合法、目标 host
 * 可达、PAT 有效（GitHub）；Gitee / GitLab 仅做 URL 形式校验。
 *
 * 接口契约：verifyRepoAccess 返回 { valid: boolean, error?: string }，失败原因要可读，
 * 让前端表单在保存前提示。
 */
export type GitProviderName = 'github' | 'gitee' | 'gitlab';

export interface VerifyRepoInput {
  repoUrl: string;
  provider: GitProviderName;
  pat?: string;
  branch?: string;
  projectName?: string;
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

export function repoShortName(repoUrl: string): string {
  const m = repoUrl.match(/\/([^/]+?)(\.git)?\/?$/);
  return m ? m[1]! : '';
}

export function validateRepoName(name: string): { valid: boolean; error?: string } {
  // GitHub/Gitee 仓库名：字母数字 + . _ -，最长 100
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    return { valid: false, error: '仓库名只允许字母数字与 . _ -，最长 100' };
  }
  return { valid: true };
}

/**
 * 校验仓库可达性 + 分支存在 + 项目名一致。
 *  - URL 形式校验总是先做
 *  - GitHub：HEAD /repos/{owner}/{repo}（带 PAT）；无 PAT 则 GET /repos/.../branches/{branch}
 *    （unauthenticated 60/hr；超时即「提示需 PAT」）
 *  - Gitee / GitLab：URL 形式校验 + 可选 HEAD；未配置 token 时只校验 URL
 */
export async function verifyRepoAccess(input: VerifyRepoInput): Promise<VerifyRepoResult> {
  const urlCheck = validateRepoUrl(input.repoUrl, input.provider);
  if (!urlCheck.valid) return { valid: false, error: urlCheck.error };

  const shortName = repoShortName(input.repoUrl);
  if (input.projectName) {
    if (input.projectName !== shortName) {
      return { valid: false, error: `项目名称必须与仓库短名一致（${input.projectName} vs ${shortName}）` };
    }
  }
  if (input.provider !== 'github') {
    // Gitee / GitLab 当前只做 URL + 名称校验；不假装可达
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