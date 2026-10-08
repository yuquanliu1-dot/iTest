import { configDefaults, defineConfig } from 'vitest/config';

// .data/repos 是 repo-context 功能的仓库克隆缓存（含被克隆项目自己的测试），
// 不属于本包测试，必须排除，否则 vitest 会把它们收集进来跑挂。
// plan-schedules.test.ts 用 Testcontainers 启 Postgres；冷启动 ≥ 60s，需要放宽 hook 超时。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.data/**'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
