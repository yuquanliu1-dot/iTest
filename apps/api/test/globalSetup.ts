import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * 整轮测试共享一个 PG 容器；每个测试文件通过 helpers/pg.createTestDatabase()
 * 在容器内拿到自己的空数据库（隔离语义与"每文件一个容器"等价）。
 *
 * 连接信息走 provide/inject：worker 的 process.env 在 createPool 时已快照，
 * globalSetup 里改 process.env 传不到 worker。
 *
 * 注意：本文件不得 import 'vitest'（globalSetup 在独立上下文，inject 会抛），
 * 也不得 import helpers/pg.ts（后者依赖 inject）。
 */

export interface PgInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

let container: StartedPostgreSqlContainer;

export default async function setup({ provide }: { provide: (key: string, value: unknown) => void }): Promise<() => Promise<void>> {
  // max_connections：9 个并发 worker × (应用 pool 5 + 文件自带 pool 10) 峰值 135 > PG 默认 100
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withCommand(['postgres', '-c', 'max_connections=300'])
    .start();
  const info: PgInfo = {
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
  };
  provide('pgInfo', info);
  return async () => {
    // removeVolumes 默认 true（testcontainers stop 语义），不留悬空卷
    await container.stop();
  };
}
