export default function Dashboard() {
  return (
    <div className="glass-panel p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold mb-4">iTest 控制台</h1>
      <p className="text-secondary" style={{ color: 'var(--color-text-secondary)' }}>
        MVP 框架已就绪。前往「设置」配置 LLM，或在「需求」开始第一个流程。
      </p>
    </div>
  );
}