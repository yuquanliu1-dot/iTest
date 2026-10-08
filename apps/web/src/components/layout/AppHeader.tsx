import { Link, useLocation, useParams } from 'react-router-dom';
import { useProjectStore } from '../../stores/project';
import { useAuthStore } from '../../stores/auth';
import BrandGlyph from '../BrandGlyph';
import UserMenu from './UserMenu';
import RecorderExtensionBadge from './RecorderExtensionBadge';
import { Separator } from '../ui/shadcn/separator';

/**
 * 48px 顶栏（CRM app-header）：左 logo + 工作区名，右头像菜单。
 * 主题切换入口在 UserMenu 下拉里（CRM 模式）；返回项目选择页走左侧栏「项目」。
 */
export default function AppHeader() {
  const { projectId } = useParams<{ projectId: string }>();
  const { pathname } = useLocation();
  const current = useProjectStore((s) => s.current);
  const activeOrgName = useAuthStore(
    (s) => s.organizations.find((o) => o.id === s.activeOrgId)?.name,
  );
  // 组织级页面（成员/系统配置）URL 无项目段时回退 store 上下文，标题保持「项目 · 版本」
  const onAdminPage = pathname.startsWith('/members') || pathname.startsWith('/settings');
  const inProject = Boolean(projectId) || (onAdminPage && Boolean(current));

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <div className="flex shrink-0 items-center gap-1">
        <Link
          to="/"
          aria-label="首页"
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
