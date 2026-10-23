import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import Button from './ui/Button';
import type { RcaResult } from '../api/client';

/** RCA 分类徽章配色:系统缺陷红/环境黄/用例问题与其他灰。 */
const CATEGORY_STYLE: Record<RcaResult['category'], { bg: string; fg: string }> = {
  system_defect: { bg: 'var(--destructive-soft)', fg: 'var(--destructive)' },
  environment: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
  case_issue: { bg: 'var(--muted)', fg: 'var(--muted-foreground)' },
  other: { bg: 'var(--muted)', fg: 'var(--muted-foreground)' },
};

/** 根因分析展示块:PlanRunDetail 失败行与 ReportDetail 共用。
 *  timeout/error 只显示状态行;skipped 显示一句话结论;analyzed 全量(徽章/摘要/证据/建议/线程跳转)。 */
export default function RcaBlock({ rca, threadJump, assistantPath }: { rca: RcaResult; threadJump?: boolean; assistantPath: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (rca.status === 'timeout') {
    return <div className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('reports:rca.statusTimeout')}</div>;
  }
  if (rca.status === 'error') {
    return <div className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('reports:rca.statusError')}: {rca.summary}</div>;
  }
  const style = CATEGORY_STYLE[rca.category];
  return (
    <div className="mt-1.5 rounded-[var(--radius-sm)] px-3 py-2 text-[12px]" style={{ background: 'var(--muted)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold px-2 py-[1px] rounded-full" style={{ background: style.bg, color: style.fg }}>
          {t(`reports:rca.category.${rca.category}`)}
        </span>
        {rca.confidence && <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t(`reports:rca.confidence.${rca.confidence}`)}</span>}
        <span className="flex-1" />
        {threadJump && rca.threadId && (
          <Button variant="ghost" size="sm" onClick={() => navigate(assistantPath)} title={t('reports:rca.openThread')}>
            <Icon name="sparkles" size={12} />
            {t('reports:rca.openThread')}
          </Button>
        )}
      </div>
      <div className="mt-1" style={{ color: 'var(--foreground)' }}>{rca.summary}</div>
      {(rca.evidence?.length ?? 0) > 0 && (
        <div className="mt-1.5">
          <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('reports:rca.evidence')}</div>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {(rca.evidence ?? []).map((ev, i) => (
              <li key={i} className="font-mono text-[11px]" style={{ color: 'var(--foreground)' }}>
                {ev.file}{ev.lines ? `:${ev.lines}` : ''}{ev.note ? ` — ${ev.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {rca.suggestion && (
        <div className="mt-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          <span style={{ color: 'var(--foreground)' }}>{t('reports:rca.suggestion')}</span>：{rca.suggestion}
        </div>
      )}
    </div>
  );
}
