import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The whole test run shares one PG container; each test file gets its own empty database
 * inside the container via helpers/pg.createTestDatabase()
 * (isolation semantics equivalent to "one container per file").
 *
 * Connection info flows through provide/inject: the worker's process.env is snapshotted at createPool time,
 * so process.env changes in globalSetup do not reach workers.
 *
 * Note: this file must not import 'vitest' (globalSetup runs in an isolated context; inject would throw),
 * and must not import helpers/pg.ts (the latter depends on inject).
 */

export interface PgInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

let container: StartedPostgreSqlContainer;

export default async function setup({ provide }: { provide: (key: string, value: unknown) => void }): Promise<() => Promise<void>> {
  // max_connections: 9 concurrent workers × (app pool 5 + per-file pool 10) peaks at 135 > PG default 100
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
    // removeVolumes defaults to true (testcontainers stop semantics), leaving no dangling volumes
    await container.stop();
  };
}
