import { PageShell } from '../../../components/layout/PageShell';

function SkeletonBlock({ h = 92 }: { h?: number }) {
  return (
    <div
      className="rounded-[var(--radius-md)] animate-pulse"
      style={{ minHeight: h, background: 'var(--muted)' }}
    />
  );
}

export default function OverviewSkeleton() {
  return (
    <PageShell>
      <div className="space-y-2">
        <div className="h-6 w-24 animate-pulse rounded" style={{ background: 'var(--muted)' }} />
        <div className="h-3.5 w-44 animate-pulse rounded" style={{ background: 'var(--muted)' }} />
      </div>
      <div className="grid grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBlock key={i} />
        ))}
      </div>
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-8">
          <SkeletonBlock h={300} />
        </div>
        <div className="col-span-4">
          <SkeletonBlock h={300} />
        </div>
      </div>
    </PageShell>
  );
}
