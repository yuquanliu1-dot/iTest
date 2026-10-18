import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';
import { emptyRepoState } from '../src/pi/space/tools/context.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // LLM settings：工厂要求 readLlmConfig 非空（spike 不触发任何 LLM 调用，只建会话 + 断言工具注册）
  await pool.query(`INSERT INTO settings(key, value) VALUES
    ('llm_provider','"openai"'),
    ('llm_api_key','"sk-test"'),
    ('llm_model','"gpt-4o-mini"')`);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('MCP spike: registerMcpServer + createMcpExtension 真实链路', () => {
  it('stdio echo server 经 createSpaceSessionFactory 建会话后注册为 mcp__echo__echo', async () => {
    const marker = `/tmp/mcp-echo-marker-${Date.now()}.ok`;
    const { setMcpServersLoader } = await import('../src/pi/space/mcp.js');
    const { createSpaceSessionFactory } = await import('../src/pi/space/session.js');
    setMcpServersLoader(async () => [{
      name: 'echo',
      config: {
        type: 'stdio',
        command: process.execPath,
        args: [FIXTURE],
        exposure: 'direct',
        env: { MCP_ECHO_MARKER: marker },
      },
    }]);
    const session = await createSpaceSessionFactory({
      threadId: '00000000-0000-0000-0000-0000000000aa',
      versionId: '00000000-0000-0000-0000-0000000000bb',
      projectId: '00000000-0000-0000-0000-0000000000cc',
      repo: emptyRepoState(),
      createdByUserId: null,
      lang: 'zh-CN',
    });
    try {
      // 轮询以「工具真正注册」为准：MCP 连接是后台异步链（initialize → tools/list → registerTools），
      // marker 文件只在 initialize 落盘，早于工具注册，用它当就绪信号会在窗口内误炸核心断言。
      // marker 留作失败诊断：区分「session_start 未触发（bindExtensions 缺失）」与「tools/list 未跟上」。
      let tools: string[] = [];
      let markerSeen = false;
      for (let i = 0; i < 60; i++) {
        try { await fs.access(marker); markerSeen = true; } catch { /* 未落盘，继续等 */ }
        tools = (session as unknown as { getAllTools(): { name: string }[] }).getAllTools().map((t) => t.name);
        if (tools.includes('mcp__echo__echo')) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(
        tools,
        `mcp__echo__echo 未在 15s 内注册（initialize marker=${markerSeen}：session_start 或 tools/list 链路未走通）`,
      ).toContain('mcp__echo__echo');
    } finally {
      // pi v0.99.2 的 AgentSession.dispose 是同步 void（agent-session.d.ts:362），非 Promise。
      (session as unknown as { dispose(): void }).dispose();
      setMcpServersLoader(null);
      await fs.rm(marker, { force: true }).catch(() => undefined);
    }
  }, 60_000);
});

describe('MCP DB 加载 + 守卫（getMcpServersForThread 默认翻 DB）', () => {
  it('loadEnabledMcpServers：启用 server 全加载，oauth/缺失二进制/http 非 http(s) 全 skip', async () => {
    const { loadEnabledMcpServers } = await import('../src/pi/space/mcp.js');
    try {
      await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, command, exposure, enabled) VALUES
        ($1, 'echo-db', 'stdio', $2, 'direct', true)`,
        ['00000000-0000-0000-0000-0000000000d1', process.execPath]);
      await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, command, exposure, enabled) VALUES
        ($1, 'bad-oauth', 'stdio', 'node', 'oauth', true)`,
        ['00000000-0000-0000-0000-0000000000d2']);
      await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, command, exposure, enabled) VALUES
        ($1, 'missing-bin', 'stdio', '/nonexistent/definitely-missing', 'direct', true)`,
        ['00000000-0000-0000-0000-0000000000d3']);
      await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, url, exposure, enabled) VALUES
        ($1, 'file-url', 'http', 'file:///etc/passwd', 'direct', true)`,
        ['00000000-0000-0000-0000-0000000000d4']);
      const servers = await loadEnabledMcpServers();
      const names = servers.map((s) => s.name);
      expect(names).toContain('echo-db');
      expect(names).not.toContain('bad-oauth');
      expect(names).not.toContain('missing-bin');
      expect(names).not.toContain('file-url');
      const echo = servers.find((s) => s.name === 'echo-db')!;
      expect(echo.config).toMatchObject({ type: 'stdio', command: process.execPath, exposure: 'direct' });
    } finally {
      await pool.query(`DELETE FROM assistant_mcp_servers`);
    }
  });

  it('resolveMcpEnv：env:KEY 从 process.env 取真实值；未定义跳过', async () => {
    const { resolveMcpEnv } = await import('../src/pi/space/mcp.js');
    process.env.ITEST_MCP_SPIKE_KEY = 'supersecret';
    try {
      expect(resolveMcpEnv({ TOKEN: 'env:ITEST_MCP_SPIKE_KEY', PLAIN: 'hello' }))
        .toEqual({ TOKEN: 'supersecret', PLAIN: 'hello' });
      expect(resolveMcpEnv({ MISSING: 'env:NOPE_NOT_SET' })).toEqual({});
    } finally {
      delete process.env.ITEST_MCP_SPIKE_KEY;
    }
  });

  it('findExecutable：绝对/相对路径按存在性，裸名按 PATH 扫描', async () => {
    const { findExecutable } = await import('../src/pi/space/mcp.js');
    expect(findExecutable(process.execPath)).toBe(true);
    expect(findExecutable('/nonexistent/definitely-missing')).toBe(false);
    expect(findExecutable('node')).toBe(true);
  });
});