import { PageShell } from '../../../components/layout/PageShell';

function SkeletonBlock({ h = 92 }: { h?: number }) {
  return (
    <div
      className="rounded-[var(--radius-md)] animate-pulse"
      style={{ minHeight: h, background: 'var(--muted)' }}
    />
  );
}

/** Isomorphic with the actual page layout: 5 equal-width KPIs, an 8+4 trend row, 3 side-by-side cards, the plan table, a 6+6 tail row. */
export default function OverviewSkeleton() {
  return (
    <PageShell>
      <div className="space-y-2">
        <div className="h-6 w-24 animate-pulse rounded" style={{ background: 'var(--muted)' }} />
        <div className="h-3.5 w-44 animate-pulse rounded" style={{ background: 'var(--muted)' }} />
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBlock key={i} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-8">
          <SkeletonBlock h={330} />
        </div>
        <div className="xl:col-span-4">
          <SkeletonBlock h={330} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
        <div className="xl:col-span-4">
          <SkeletonBlock h={220} />
        </div>
        <div className="xl:col-span-4">
          <SkeletonBlock h={220} />
        </div>
        <div className="md:col-span-2 xl:col-span-4">
          <SkeletonBlock h={220} />
        </div>
      </div>
      <SkeletonBlock h={240} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-6">
          <SkeletonBlock h={280} />
        </div>
        <div className="xl:col-span-6">
          <SkeletonBlock h={280} />
        </div>
      </div>
    </PageShell>
  );
}
