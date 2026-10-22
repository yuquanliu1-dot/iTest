import { Link, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../stores/auth';
import { useProjectStore } from '../../stores/project';
import Icon, { type IconName } from '../Icon';
import { Button } from '../ui/shadcn/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/shadcn/tooltip';
import { cn } from '../../lib/cn';

type RailItem = {
  titleKey: string;
  to: string;
  icon: IconName;
};

/** 顶部：全局入口 */
const TOP_ITEMS: RailItem[] = [
  { titleKey: 'common:navProjects', to: '/', icon: 'layers' },
];

/** 底部（mt-auto）：管理入口 */
const BOTTOM_ITEMS: RailItem[] = [
  { titleKey: 'common:navMembers', to: '/members', icon: 'user' },
  { titleKey: 'common:navSettings', to: '/settings', icon: 'settings' },
];

type ProjectNavItem = {
  titleKey: string;
  path: string;
  icon: IconName;
  /** 除自身前缀外额外归属的前缀（如用例详情 /cases 归属「用例」） */
  related?: string[];
};

const PROJECT_ITEMS: ProjectNavItem[] = [
  { titleKey: 'common:navWorkspace', path: 'overview', icon: 'sparkles' },
  { titleKey: 'common:navAssistant', path: 'assistant', icon: 'message' },
  { titleKey: 'common:navCases', path: 'groups', icon: 'beaker', related: ['cases', 'ai'] },
  { titleKey: 'common:navPlans', path: 'plans', icon: 'play' },
  { titleKey: 'common:navReports', path: 'reports', icon: 'flag' },
];

function isActive(item: RailItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/' || pathname.startsWith('/p/');
  return pathname.startsWith(item.to);
}

function isProjectActive(
  item: ProjectNavItem,
  basePath: string,
  pathname: string,
): boolean {
  const full = `${basePath}/${item.path}`;
  const related = item.related?.some((p) => pathname.startsWith(`${basePath}/${p}`));
  return pathname.startsWith(full) || Boolean(related);
}

function RailLink({
  titleKey,
  to,
  icon,
  active,
}: RailItem & { active: boolean }) {
  const { t } = useTranslation();
  const title = t(titleKey);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className={cn(
            'text-[var(--muted-foreground)]',
            active &&
              'bg-[var(--muted)] text-[var(--foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
          )}
        >
          <Link to={to} aria-current={active ? 'page' : undefined}>
            <Icon name={icon} size={16} />
            <span className="sr-only">{title}</span>
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 56px 图标栏（CRM app-icon-rail）：项目入口在上，项目路由下追加
 * 工作台/用例/执行计划/执行历史（分隔线分组），成员/系统配置沉底。
 * active=bg-muted，hover tooltip。
 */
export default function AppIconRail() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const canManageMembers = useAuthStore((s) => s.organizations.some((o) => o.isManager));
  const { projectId: urlProjectId, versionId: urlVersionId } = useParams<{
    projectId: string;
    versionId?: string;
  }>();
  const current = useProjectStore((s) => s.current);

  const bottomItems = BOTTOM_ITEMS.filter(
    (item) => !(item.to === '/members' && !canManageMembers),
  );

  // /members、/settings 是组织级路由，URL 不带项目段；只要 store 还持有项目上下文就保留
  // 项目导航，避免点管理入口时像「退出了项目版本」。
  const onAdminPage = pathname.startsWith('/members') || pathname.startsWith('/settings');
  const projectId = urlProjectId ?? (onAdminPage ? current?.id : undefined);
  const versionId = urlVersionId ?? (onAdminPage ? current?.versionId ?? undefined : undefined);
  const inProject = Boolean(urlProjectId) || (onAdminPage && Boolean(current));
  const basePath = projectId
    ? versionId
      ? `/p/${projectId}/v/${versionId}`
      : `/p/${projectId}`
    : '';

  return (
    <div className="flex w-14 shrink-0 flex-col items-center border-r py-3">
      <nav aria-label={t('common:navMain')} className="flex flex-col items-center gap-1">
        {TOP_ITEMS.map((item) => (
          <RailLink key={item.to} {...item} active={isActive(item, pathname)} />
        ))}
      </nav>
      {inProject && (
        <>
          <hr aria-hidden className="my-2 w-6 border-[var(--border)]" />
          <nav aria-label={t('common:navProject')} className="flex flex-col items-center gap-1">
            {PROJECT_ITEMS.map((item) => (
              <RailLink
                key={item.path}
                titleKey={item.titleKey}
                to={`${basePath}/${item.path}`}
                icon={item.icon}
                active={isProjectActive(item, basePath, pathname)}
              />
            ))}
          </nav>
        </>
      )}
      <nav
        aria-label={t('common:navManagement')}
        className="mt-auto flex flex-col items-center gap-1"
      >
        {bottomItems.map((item) => (
          <RailLink key={item.to} {...item} active={isActive(item, pathname)} />
        ))}
      </nav>
    </div>
  );
}
