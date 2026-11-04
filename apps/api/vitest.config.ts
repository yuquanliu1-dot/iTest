import { configDefaults, defineConfig } from 'vitest/config';

// .data/repos 是 repo-context 功能的仓库克隆缓存（含被克隆项目自己的测试），
// 不属于本包测试，必须排除，否则 vitest 会把它们收集进来跑挂。
// globalSetup 起整轮共享的 PG 容器（每文件独立数据库，见 test/globalSetup.ts）；
// hookTimeout 仍放宽：settings.test.ts 的 LLM 探针、environments 的 MySQL 容器启动等较慢。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.data/**'],
    globalSetup: ['./test/globalSetup.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
