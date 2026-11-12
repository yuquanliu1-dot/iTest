import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// gitProvider only uses spawn to probe git; mocking it lets the service layer assert the ls-remote ref pattern.
// (The route layer's project-versions.test.ts mocks verifyRef entirely, so a wrong pattern slips through —
//  branch was once spelled refs/branchs/<ref>; git's exact match came up empty with exit 0 and empty output, so branches were always falsely reported "not found".)
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
