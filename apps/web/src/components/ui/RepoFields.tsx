import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import Input from './Input';
import Button from './Button';
import Icon from '../Icon';

/** 仓库配置折叠区：provider / repoUrl / gitlabUrlOverride / PAT / 测试连接。
 *  与项目表单同构——既用于 ProjectsHome 新建/编辑弹窗，也用于 ProjectVersionsPage。 */
export interface RepoFieldsValue {
  repoUrl: string;
  provider: 'github' | 'gitee' | 'gitlab';
  gitlabUrlOverride: string;
  patOverride: string;
  defaultBranch: string;
  hasPat: boolean;
}

export const EMPTY_REPO: RepoFieldsValue = {
  repoUrl: '',
  provider: 'github',
  gitlabUrlOverride: '',
  patOverride: '',
  defaultBranch: 'main',
  hasPat: false,
};

interface Props {
  value: RepoFieldsValue;
  onChange: (v: RepoFieldsValue) => void;
  /** 测试连接时用于必填的 projectName（URL 解析出来的短名应与之匹配）。新建项目时可用项目名实时对比 */
  projectNameHint?: string;
}

export default function RepoFields({ value, onChange, projectNameHint }: Props) {
  const [open, setOpen] = useState<boolean>(!!value.repoUrl);
  const [verifyState, setVerifyState] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'ok'; defaultBranch?: string }
    | { kind: 'fail'; error: string }
  >({ kind: 'idle' });

  const verify = useMutation({
    mutationFn: () =>
      api.projects.verifyRepo({
        repoUrl: value.repoUrl.trim(),
        provider: value.provider,
        patOverride: value.patOverride.trim() || undefined,
        branch: value.defaultBranch.trim() || undefined,
        projectName: projectNameHint,
      }),
    onMutate: () => setVerifyState({ kind: 'checking' }),
    onSuccess: (r) => {
      if (r.valid) {
        setVerifyState({ kind: 'ok', defaultBranch: r.defaultBranch });
        if (r.defaultBranch && !value.defaultBranch.trim()) {
          onChange({ ...value, defaultBranch: r.defaultBranch });
        }
      } else {
        setVerifyState({ kind: 'fail', error: r.error ?? '连接失败' });
      }
    },
    onError: (e: Error) => setVerifyState({ kind: 'fail', error: e.message }),
  });

  const canTest = !!value.repoUrl.trim() && (value.provider === 'github' ? true : !!value.patOverride.trim() || true);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--card)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between w-full px-3 py-2"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        <span className="text-[12px] font-medium" style={{ color: 'var(--foreground)' }}>
          仓库配置（可选，用于 AI 工作台参考源码）
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} style={{ color: 'var(--muted-foreground)' }} />
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 pb-3" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex flex-col gap-1" style={{ marginTop: 10 }}>
            <label className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
              Git 提供方
            </label>
            <select
              className="input-base"
              value={value.provider}
              onChange={(e) => onChange({ ...value, provider: e.target.value as 'github' | 'gitee' | 'gitlab' })}
            >
              <option value="github">GitHub</option>
              <option value="gitee">Gitee</option>
              <option value="gitlab">GitLab（自建 / 官方）</option>
            </select>
          </div>
          <div style={{ marginTop: 10 }}>
            <Input
              label="默认分支"
              placeholder="main"
              value={value.defaultBranch}
              onChange={(e) => onChange({ ...value, defaultBranch: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Input
              label="仓库 URL"
              placeholder={value.provider === 'github' ? 'https://github.com/<owner>/<repo>' : 'https://...'}
              value={value.repoUrl}
              onChange={(e) => onChange({ ...value, repoUrl: e.target.value })}
            />
          </div>
          {value.provider === 'gitlab' && (
            <div className="col-span-2">
              <Input
                label="GitLab 实例 URL（自建时填写，留空走仓库 URL）"
                placeholder="https://gitlab.example.com"
                value={value.gitlabUrlOverride}
                onChange={(e) => onChange({ ...value, gitlabUrlOverride: e.target.value })}
              />
            </div>
          )}
          <div className="col-span-2">
            <Input
              label={`Personal Access Token${value.hasPat ? '（已存，输入覆盖）' : ''}`}
              type="password"
              placeholder={value.hasPat ? '已配置，输入新值覆盖' : '可选；私有仓库 / 提高限速必填'}
              value={value.patOverride}
              onChange={(e) => onChange({ ...value, patOverride: e.target.value })}
            />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={verify.isPending || !value.repoUrl.trim()}
              onClick={() => verify.mutate()}
            >
              {verify.isPending ? '测试中...' : '测试连接'}
            </Button>
            {verifyState.kind === 'ok' && (
              <span className="text-[11px]" style={{ color: 'var(--success, #16a34a)' }}>
                ✓ 连接成功{verifyState.defaultBranch ? ` · 默认分支 ${verifyState.defaultBranch}` : ''}
              </span>
            )}
            {verifyState.kind === 'fail' && (
              <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>
                {verifyState.error}
              </span>
            )}
          </div>
          <p className="col-span-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            PAT 仅用于仓库元数据 + 测试连接；列表查询会返回 hasPat，原始值不会回传前端。
          </p>
        </div>
      )}
    </div>
  );
}
