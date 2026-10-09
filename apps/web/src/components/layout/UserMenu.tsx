import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/shadcn/dropdown-menu';
import { Button } from '../ui/shadcn/button';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { useUIStore } from '../../stores/ui';
import ChangeMyPasswordModal from '../auth/ChangeMyPasswordModal';
import Icon from '../Icon';

/**
 * 顶栏头像菜单（CRM app-header UserMenu 模式）：
 * 头像触发 → 用户信息 / 切换组织 / 主题切换 / 退出登录。
 * 系统配置与成员管理入口已上移到 icon rail。
 */
export default function UserMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const toast = useUIStore((s) => s.showToast);
  const user = useAuthStore((s) => s.user);
  const organizations = useAuthStore((s) => s.organizations);
  const activeOrgId = useAuthStore((s) => s.activeOrgId);
  const switchOrg = useAuthStore((s) => s.switchOrg);
  const logout = useAuthStore((s) => s.logout);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  const activeOrg = organizations.find((o) => o.id === activeOrgId);
  const showOrgList = organizations.length > 1;

  const initial = (user?.displayName || user?.username || '?').trim().charAt(0).toUpperCase();

  const handleSwitch = async (orgId: string) => {
    if (orgId === activeOrgId) return;
    setOpen(false);
    try {
      await switchOrg(orgId);
      toast('已切换组织', 'success');
      navigate('/');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const handleLogout = async () => {
    setOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  const handleOpenPwd = () => {
    setOpen(false);
    setPwdOpen(true);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="用户菜单"
          className="rounded-full hover:bg-transparent aria-expanded:bg-transparent"
        >
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--primary-soft)] text-xs font-semibold text-[var(--primary)]"
          >
            {initial}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{user?.displayName || user?.username}</span>
          <span className="truncate text-xs font-normal text-[var(--muted-foreground)]">
            @{user?.username}
            {activeOrg ? ` · ${activeOrg.name}` : ''}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* 切换组织（多组织时显示） */}
        {showOrgList && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Icon name="layers" size={14} />
              切换组织
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-44">
              {organizations.map((o) => (
                <DropdownMenuItem key={o.id} onSelect={() => void handleSwitch(o.id)}>
                  <span className="flex-1 truncate">{o.name}</span>
                  {o.id === activeOrgId && <Icon name="check" size={14} />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {/* 主题切换（CRM：单击切换，图标随状态变化） */}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            toggleTheme();
          }}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
          {theme === 'dark' ? '浅色主题' : '深色主题'}
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); handleOpenPwd(); }}>
          <Icon name="settings" size={14} />
          修改密码
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-[var(--destructive)] data-[highlighted]:text-[var(--destructive)]"
          onSelect={() => void handleLogout()}
        >
          <Icon name="logOut" size={14} />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
      <ChangeMyPasswordModal open={pwdOpen} onOpenChange={setPwdOpen} />
    </DropdownMenu>
  );
}
