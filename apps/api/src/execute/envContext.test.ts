import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/client.js', () => {
  return {
    db: {
      select: vi.fn(),
    },
  };
});

import { resolveEnv, EnvMissing, EnvProjectMismatch, DecryptError } from './envContext.js';
import { db } from '../db/client.js';
import { encrypt } from '../lib/secret-crypto.js';

const ENV_ROW = {
  id: 'env-1',
  projectId: 'proj-1',
  name: 'staging',
  dbHost: 'pg.example.com',
  dbPort: 5432,
  dbName: 'app',
  dbUser: 'app',
  dbPasswordCiphertext: null,
  dbPasswordIv: null,
  dbPasswordTag: null,
  syslogHost: null,
  syslogUser: null,
  syslogSshPort: null,
  syslogKeyCiphertext: null,
  syslogKeyIv: null,
  syslogKeyTag: null,
  syslogFilePath: null,
};

beforeEach(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 0).toString('base64');
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([ENV_ROW]) }) }),
  } as never);
});

describe('resolveEnv', () => {
  it('prefers planEnvId over caseEnvId', async () => {
    const { envId } = await resolveEnv({ planEnvId: 'env-plan', caseEnvId: 'env-case' });
    expect(envId).toBe('env-plan');
  });

  it('falls back to caseEnvId', async () => {
    const { envId } = await resolveEnv({ caseEnvId: 'env-case' });
    expect(envId).toBe('env-case');
  });

  it('throws EnvMissing when neither is set', async () => {
    await expect(resolveEnv({})).rejects.toBeInstanceOf(EnvMissing);
  });

  it('throws EnvProjectMismatch when envId resolves to different project', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ...ENV_ROW, projectId: 'other' }]) }) }),
    } as never);
    await expect(resolveEnv({ caseEnvId: 'env-1' }, { expectedProjectId: 'proj-1' }))
      .rejects.toBeInstanceOf(EnvProjectMismatch);
  });

  it('decrypts dbPassword when ciphertext present', async () => {
    const enc = encrypt('hunter2');
    const rowWithPassword = { ...ENV_ROW, dbPasswordCiphertext: enc.ciphertext.toString('base64'), dbPasswordIv: enc.iv.toString('base64'), dbPasswordTag: enc.tag.toString('base64') };
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([rowWithPassword]) }) }),
    } as never);
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.db?.password).toBe('hunter2');
  });

  it('throws DecryptError when tag mismatches', async () => {
    const enc = encrypt('hunter2');
    const bad = { ...ENV_ROW, dbPasswordCiphertext: enc.ciphertext.toString('base64'), dbPasswordIv: enc.iv.toString('base64'), dbPasswordTag: Buffer.alloc(16, 0xff).toString('base64') };
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([bad]) }) }),
    } as never);
    await expect(resolveEnv({ caseEnvId: 'env-1' })).rejects.toBeInstanceOf(DecryptError);
  });
});