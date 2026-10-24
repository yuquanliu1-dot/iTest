import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// gitProvider 只用 spawn 探测 git；mock 掉即可在服务层断言 ls-remote 的 ref pattern。
// （路由层 project-versions.test.ts 把 verifyRef 整个 mock 了，pattern 拼错漏网——
//  曾把 branch 拼成 refs/branchs/<ref>，git 精确匹配落空 exit 0 空输出，分支恒误报「不存在」。）
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const makeChild = (stdout: string) => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
};

const importSvc = () => import('../src/services/gitProvider.js');
const URL_GITLAB = 'https://git.example.com/owner/repo.git';

beforeEach(() => {
  spawnMock.mockReset();
});

describe('verifyRef gitlab：ls-remote ref pattern（refs/heads 回归锚定）', () => {
  it('branch → refs/heads/<ref>；命中输出 → valid:true', async () => {
    spawnMock.mockImplementation(() => makeChild('aaaa\trefs/heads/master\n'));
    const { verifyRef } = await importSvc();
    const r = await verifyRef({ repoUrl: URL_GITLAB, provider: 'gitlab', pat: 'P', ref: 'master', kind: 'branch' });
    expect(r).toEqual({ valid: true });
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('ls-remote');
    expect(args[1]).toBe('https://oauth2:P@git.example.com/owner/repo.git');
    expect(args[2]).toBe('refs/heads/master');
  });

  it('tag → refs/tags/<ref>', async () => {
    spawnMock.mockImplementation(() => makeChild('bbbb\trefs/tags/v2.0.6\n'));
    const { verifyRef } = await importSvc();
    const r = await verifyRef({ repoUrl: URL_GITLAB, provider: 'gitlab', ref: 'v2.0.6', kind: 'tag' });
    expect(r).toEqual({ valid: true });
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[2]).toBe('refs/tags/v2.0.6');
  });

  it('exit 0 空输出（pattern 不匹配）→ valid:false「远端不存在」', async () => {
    spawnMock.mockImplementation(() => makeChild(''));
    const { verifyRef } = await importSvc();
    const r = await verifyRef({ repoUrl: URL_GITLAB, provider: 'gitlab', ref: 'nope', kind: 'branch' });
    expect(r).toEqual({ valid: false, error: '远端不存在分支 nope' });
  });
});
