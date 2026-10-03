function SkeletonBlock({ h = 92 }: { h?: number }) {
  return (
    <div
      className="rounded-[var(--radius-md)] animate-pulse"
      style={{ minHeight: h, background: 'var(--color-muted)' }}
    />
  );
}

export default function OverviewSkeleton() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4">
        <div className="space-y-2">
          <div className="h-5 w-20 rounded animate-pulse" style={{ background: 'var(--color-muted)' }} />
          <div className="h-3 w-40 rounded animate-pulse" style={{ background: 'var(--color-muted)' }} />
        </div>
      </div>
      <div className="grid grid-cols-5 gap-4 px-5 pt-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBlock key={i} />
        ))}
      </div>
      <div className="grid grid-cols-12 gap-4 px-5 pt-4">
        <div className="col-span-8">
          <SkeletonBlock h={300} />
        </div>
        <div className="col-span-4">
          <SkeletonBlock h={300} />
        </div>
      </div>
    </div>
  );
}
