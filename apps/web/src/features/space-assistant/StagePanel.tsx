import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAui } from '@assistant-ui/react';
import { api } from '../../api/client';
import Icon from '../../components/Icon';
import Button from '../../components/ui/Button';
import { useSpaceEventsStore, type StageObject } from './spaceEventsStore';

const KIND_LABEL: Record<StageObject['kind'], string> = {
  case: '用例', scenario: '场景', environment: '环境', plan: '计划', group: '分组',
};

const ACTION_LABEL: Record<string, string> = {
  create: '新建', update: '更新', delete: '删除', upsert: '保存',
  move_group: '移动分组', create_group: '新建分组',
  add_cases: '添加用例', remove_cases: '移除用例', set_secret: '设置密钥',
};
const actionLabel = (a: string) => ACTION_LABEL[a] ?? a;

function openPathFor(o: StageObject, projectId: string, versionId: string): string {
  const base = `/p/${projectId}`;
  if (o.kind === 'case') return `${base}/v/${versionId}/cases/${o.id}`;
  if (o.kind === 'plan') return `${base}/v/${versionId}/plans/${o.id}`;
  if (o.kind === 'environment') return `${base}/environments`;
  return `${base}/v/${versionId}/groups`;
}

interface Props {
  projectId: string;
  versionId: string;
}

/**
 * 舞台:展示 AI 最近操作的对象(stage 事件流)。批量操作 = 历史列表 + 点选详情;
 * announce 事件驱动进度条。卡片底部跳传统页 + 「就此提问」显式注入 composer。
 */
export default function StagePanel({ projectId, versionId }: Props) {
  const stageHistory = useSpaceEventsStore((s) => s.stageHistory);
  const announce = useSpaceEventsStore((s) => s.announce);
  const navigate = useNavigate();
  const aui = useAui();
  const latest = stageHistory[stageHistory.length - 1] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 新 stage 到来自动切到最新对象;用户点选历史后保持所选
  useEffect(() => {
    if (latest) setSelectedKey(latest.key);
  }, [latest]);
  const selected = stageHistory.find((o) => o.key === selectedKey) ?? latest;

  // queryKey 混入 stage key:同对象重复 update 时每次事件都强制 refetch,避免展示陈旧缓存
  const caseQ = useQuery({
    queryKey: ['case', selected?.id, selected?.key],
    queryFn: () => api.cases.get(selected!.id),
    enabled: selected?.kind === 'case',
    retry: false,
  });
  const planQ = useQuery({
    queryKey: ['plan', selected?.id, selected?.key],
    queryFn: () => api.plans.get(selected!.id),
    enabled: selected?.kind === 'plan',
    retry: false,
  });
  const envsQ = useQuery({
    queryKey: ['environments', projectId],
    queryFn: () => api.environments.list(projectId),
    enabled: selected?.kind === 'environment',
  });
  const scenariosQ = useQuery({
    queryKey: ['scenarios', projectId],
    queryFn: () => api.scenarios.listForProject(projectId),
    enabled: selected?.kind === 'scenario',
  });

  // 选中对象的展示标题(取不到时不渲染「就此提问」)。
  // body 约定:查询进行中留 null(兜底渲染 loader),其余状态必须显式给出内容或「已不存在」文案。
  let title: string | null = null;
  let body: ReactNode = null;
  if (selected?.kind === 'case') {
    if (caseQ.isPending) {
      body = null;
    } else {
      const c = caseQ.data;
      if (c) {
        title = c.title;
        body = (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>{c.priority}</span>
              <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>{c.status}</span>
            </div>
            {c.url && <div className="text-[12px] break-all" style={{ color: 'var(--muted-foreground)' }}>{c.url}</div>}
            {c.description && <p className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>{c.description}</p>}
          </div>
        );
      } else {
        // isError 或 404:对象已不存在
        body = <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>用例已不存在(可能已被删除)。</p>;
      }
    }
  } else if (selected?.kind === 'plan') {
    if (planQ.isPending) {
      body = null;
    } else {
      const p = planQ.data;
      if (p) {
        title = p.name;
        body = (
          <div className="flex flex-col gap-1.5">
            <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>编排 {p.cases.length} 条用例</div>
            <ol className="text-[12px] pl-4 list-decimal" style={{ color: 'var(--muted-foreground)' }}>
              {p.cases.slice(0, 10).map((c) => <li key={c.id} className="truncate">{c.title}</li>)}
            </ol>
            {p.cases.length > 10 && <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>…等 {p.cases.length} 条</div>}
          </div>
        );
      } else {
        // isError 或 404:对象已不存在
        body = <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>计划已不存在。</p>;
      }
    }
  } else if (selected?.kind === 'environment') {
    const env = (envsQ.data ?? []).find((e) => e.id === selected.id);
    if (envsQ.isPending) {
      body = null;
    } else if (env) {
      title = env.name;
      body = (
        <div className="flex flex-col gap-1.5">
          {env.isDefault && <span className="text-[10px] px-1.5 py-[1px] rounded self-start" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>默认环境</span>}
          {env.baseUrl && <div className="text-[12px] break-all" style={{ color: 'var(--muted-foreground)' }}>{env.baseUrl}</div>}
          <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            凭据对象 {env.objects.length} 个
          </div>
        </div>
      );
    } else {
      // isError 或列表中找不到:对象已不存在
      body = <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>环境已不存在。</p>;
    }
  } else if (selected?.kind === 'scenario') {
    const sc = (scenariosQ.data ?? []).find((x) => x.id === selected.id);
    if (scenariosQ.isPending) {
      body = null;
    } else if (sc) {
      title = sc.title;
      // 场景无详情接口,命中时给短文案,避免落进 loader 兜底
      body = <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>场景已保存,可在用例库查看。</p>;
    } else {
      // isError 或列表中找不到:对象已不存在
      body = <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>场景已不存在。</p>;
    }
  } else if (selected) {
    // group:无单查接口,展示 diff 或引导文案
    body = selected.diff
      ? <pre className="text-[11px] whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>{selected.diff}</pre>
      : <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>分组已更新,可在用例库查看。</p>;
  }

  const askAbout = () => {
    if (!selected || !title) return;
    aui.thread.composer().setText(`关于${KIND_LABEL[selected.kind]}「${title}」：`);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="px-4 py-2.5 text-[12px] font-medium shrink-0"
        style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
      >
        舞台
      </div>
      {announce && (
        <div className="px-4 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={12} className="animate-spin shrink-0" />
            <span className="truncate">{announce.summary}</span>
            <span className="shrink-0">{Math.min(announce.done, announce.total)}/{announce.total}</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: 'var(--muted)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${announce.total ? Math.min(100, (announce.done / announce.total) * 100) : 0}%`,
                background: 'var(--primary)',
              }}
            />
          </div>
        </div>
      )}
      {stageHistory.length > 1 && (
        <div className="shrink-0 max-h-32 overflow-y-auto" style={{ borderBottom: '1px solid var(--border)' }}>
          {[...stageHistory].reverse().map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setSelectedKey(o.key)}
              className="block w-full text-left px-4 py-1.5 text-[12px] truncate"
              style={{
                background: o.key === selected?.key ? 'var(--muted)' : 'transparent',
                color: o.key === selected?.key ? 'var(--foreground)' : 'var(--muted-foreground)',
              }}
            >
              {KIND_LABEL[o.kind]} · {actionLabel(o.action)}
            </button>
          ))}
        </div>
      )}
      {!selected ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12px] px-6 text-center" style={{ color: 'var(--muted-foreground)' }}>
            AI 创建或修改的用例、环境、计划会展示在这里
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="text-[10px] px-1.5 py-[1px] rounded shrink-0"
              style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
            >
              {KIND_LABEL[selected.kind]}
            </span>
            <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>{actionLabel(selected.action)}</span>
          </div>
          {title && <h3 className="text-[14px] font-semibold mb-2" style={{ color: 'var(--foreground)' }}>{title}</h3>}
          {body ?? <Icon name="loader" size={14} className="animate-spin" />}
        </div>
      )}
      {selected && (
        <div
          className="flex items-center gap-2 px-4 py-2.5 shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <Button size="sm" variant="ghost" onClick={() => navigate(openPathFor(selected, projectId, versionId))}>
            <Icon name="externalLink" size={12} />
            {selected.kind === 'environment' ? '环境管理' : selected.kind === 'plan' ? '打开计划' : '在用例库打开'} →
          </Button>
          {title && (
            <Button size="sm" variant="ghost" onClick={askAbout}>
              就此提问
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
