import { configDefaults, defineConfig } from 'vitest/config';

// .data/repos 是 repo-context 功能的仓库克隆缓存（含被克隆项目自己的测试），
// 不属于本包测试，必须排除，否则 vitest 会把它们收集进来跑挂。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.data/**'],
  },
});
