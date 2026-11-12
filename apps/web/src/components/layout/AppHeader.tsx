import { Link, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/project';
import { useAuthStore } from '../../stores/auth';
import BrandGlyph from '../BrandGlyph';
import UserMenu from './UserMenu';
import RecorderExtensionBadge from './RecorderExtensionBadge';
import { Separator } from '../ui/shadcn/separator';

/**
 * 48px top bar (CRM app-header): logo + workspace name on the left, avatar menu on the right.
 * The theme toggle lives in the UserMenu dropdown (CRM mode); returning to the project selection page goes through "Projects" in the left rail.
 */
export default function AppHeader() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();
  const { pathname } = useLocation();
  const current = useProjectStore((s) => s.current);
  const activeOrgName = useAuthStore(
    (s) => s.organizations.find((o) => o.id === s.activeOrgId)?.name,
  );
  // Org-level pages (members/system settings) fall back to store context when the URL has no project segment, so the title keeps "Project · Version"
  const onAdminPage = pathname.startsWith('/members') || pathname.startsWith('/settings');
  const inProject = Boolean(projectId) || (onAdminPage && Boolean(current));

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <div className="flex shrink-0 items-center gap-1">
        <Link
          to="/"
          aria-label={t('common:home')}
          className="flex size-8 items-center justify-center text-[var(--foreground)]"
        >
          <BrandGlyph size={20} animated={false} />
        </Link>
        <Separator orientation="vertical" className="mx-1 h-5 bg-transparent" />
        <span className="min-w-0 truncate text-sm font-medium">
          {inProject && current
            ? `${current.name}${current.versionName ? ` · ${current.versionName}` : ''}`
            : (activeOrgName ?? 'iTest')}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <RecorderExtensionBadge />
        <div className="h-5 w-px" style={{ background: 'var(--border)' }} aria-hidden />
        <UserMenu />
      </div>
    </header>
  );
}
