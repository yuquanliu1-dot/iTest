import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, ArrowUp, Bot, Database, FileCheck, FileText, GitBranch, MonitorSmartphone, Play, Repeat, Sparkles, Wrench,
} from 'lucide-react';
import BrandGlyph from '../components/BrandGlyph';
import Button from '../components/ui/Button';
import { useAuthStore } from '../stores/auth';
import { applyLang } from '../stores/lang';
import { LANG_STORAGE_KEY, readStoredLang, type Lang } from '../i18n';

const FEATURE_ICONS = [Repeat, Bot, Database, Wrench, GitBranch, MonitorSmartphone];
const STEP_ICONS = [FileText, Sparkles, Play, FileCheck];

/** 产品对外介绍页（公开路由，无 AuthGuard）。截图区为占位框，后续替换真实素材。 */
export default function LandingPage() {
  const { t } = useTranslation('landing');
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [lang, setLang] = useState<Lang>(readStoredLang());

  const switchLang = (next: Lang) => {
    if (next === lang) return;
    setLang(next);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      /* private mode 等场景写不进去也无妨，当前会话语言已生效 */
    }
    applyLang(next);
  };

  const ctaTarget = isAuthenticated ? '/' : '/login';
  const ctaLabel = isAuthenticated ? t('nav.openApp') : t('nav.signIn');

  return (
    <div className="min-h-full w-full" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
      <Nav lang={lang} onSwitchLang={switchLang} ctaTarget={ctaTarget} ctaLabel={ctaLabel} />
      <Hero t={t} ctaTarget={ctaTarget} />
      <Showcase t={t} />
      <Features t={t} />
      <Workflow t={t} />
      <FinalCta t={t} ctaTarget={ctaTarget} />
      <Footer t={t} />
    </div>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

/* ---------- 吸顶导航 ---------- */

function Nav({ lang, onSwitchLang, ctaTarget, ctaLabel }: {
  lang: Lang;
  onSwitchLang: (l: Lang) => void;
  ctaTarget: string;
  ctaLabel: string;
}) {
  const { t } = useTranslation('landing');
  return (
    <header
      className="sticky top-0 z-50 border-b backdrop-blur-md"
      style={{
        background: 'color-mix(in srgb, var(--background) 82%, transparent)',
        borderColor: 'var(--border)',
      }}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <BrandGlyph size={28} animated />
          <span className="text-[15px] font-semibold tracking-tight">iTest</span>
        </a>
        <nav className="hidden items-center gap-6 text-[13px] md:flex" style={{ color: 'var(--muted-foreground)' }}>
          <a href="#features" className="transition-colors hover:text-[var(--foreground)]">{t('nav.features')}</a>
          <a href="#workflow" className="transition-colors hover:text-[var(--foreground)]">{t('nav.workflow')}</a>
          <a href="#showcase" className="transition-colors hover:text-[var(--foreground)]">{t('nav.screenshots')}</a>
        </nav>
        <div className="flex items-center gap-3">
          <div
            className="flex items-center rounded-full border p-0.5 text-[12px]"
            style={{ borderColor: 'var(--border)' }}
          >
            {(['zh-CN', 'en-US'] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => onSwitchLang(l)}
                className="rounded-full px-2.5 py-1 transition-colors"
                style={l === lang
                  ? { background: 'var(--primary)', color: 'var(--primary-foreground)' }
                  : { color: 'var(--muted-foreground)' }}
              >
                {l === 'zh-CN' ? '中' : 'EN'}
              </button>
            ))}
          </div>
          <Link to={ctaTarget}>
            <Button size="sm">{ctaLabel}</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ---------- Hero ---------- */

function Hero({ t, ctaTarget }: { t: T; ctaTarget: string }) {
  return (
    <section id="top" className="relative overflow-hidden">
      {/* 品牌光晕背景（登录页同款语言） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% -10%, color-mix(in srgb, var(--primary) 16%, transparent), transparent 70%),' +
            'radial-gradient(ellipse 40% 35% at 80% 10%, color-mix(in srgb, var(--primary) 8%, transparent), transparent 70%)',
        }}
      />
      <div className="relative mx-auto max-w-6xl px-6 pb-14 pt-20 text-center md:pb-16 md:pt-24">
        <div
          className="fade-up mx-auto inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12.5px]"
          style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)', animationDelay: '0.02s' }}
        >
          <Sparkles size={13} style={{ color: 'var(--primary)' }} />
          {t('hero.badge')}
        </div>
        <h1
          className="fade-up mx-auto mt-6 text-4xl font-semibold leading-[1.12] tracking-[-0.03em] md:text-[56px]"
          style={{ animationDelay: '0.06s', maxWidth: 760 }}
        >
          {t('hero.titleLead')}
          <span
            className="italic"
            style={{
              background: 'var(--brand-gradient, var(--primary))',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {t('hero.titleAccent')}
          </span>
          {t('hero.titleTail')}
        </h1>
        <p
          className="fade-up mx-auto mt-5 text-[15px] leading-relaxed md:text-base"
          style={{ color: 'var(--muted-foreground)', maxWidth: 640, animationDelay: '0.1s' }}
        >
          {t('hero.subtitle')}
        </p>
        <div className="fade-up mt-9 flex items-center justify-center gap-3" style={{ animationDelay: '0.14s' }}>
          <Link to={ctaTarget}>
            <Button size="lg" className="gap-1.5">
              {t('hero.primaryCta')}
              <ArrowRight size={15} />
            </Button>
          </Link>
          <a href="#features">
            <Button size="lg" variant="ghost">{t('hero.secondaryCta')}</Button>
          </a>
        </div>
      </div>
    </section>
  );
}

/* ---------- 产品截图展示 ---------- */

const SHOT_IMAGES = ['/landing/assistant.png', '/landing/case-edit.png', '/landing/report.png'];

function Showcase({ t }: { t: T }) {
  const shots = t('showcase.shots', { returnObjects: true }) as { title: string; desc: string }[];
  return (
    <section id="showcase" className="mx-auto max-w-6xl px-6 py-20">
      <SectionHeading eyebrow={t('showcase.eyebrow')} title={t('showcase.title')} subtitle={t('showcase.subtitle')} />
      <div className="mt-12 grid gap-8 md:grid-cols-3">
        {shots.map((shot, i) => (
          <div key={shot.title} className="fade-up" style={{ animationDelay: `${i * 0.06}s` }}>
            {/* 浏览器窗口样式占位框 */}
            <div
              className="overflow-hidden rounded-xl border"
              style={{ borderColor: 'var(--border)', background: 'var(--card)', boxShadow: 'var(--shadow-lg)' }}
            >
              <div
                className="flex items-center gap-1.5 border-b px-3.5 py-2.5"
                style={{ borderColor: 'var(--border)' }}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--destructive)' }} />
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--warning, #d97706)' }} />
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--success, #059669)' }} />
                <span
                  className="ml-2 flex-1 truncate rounded-md px-2 py-0.5 text-[10.5px]"
                  style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                >
                  itest.app
                </span>
              </div>
              <div className="overflow-hidden" style={{ background: 'var(--muted)' }}>
                <img
                  src={SHOT_IMAGES[i % SHOT_IMAGES.length]}
                  alt={shot.title}
                  loading="lazy"
                  className="block h-auto w-full"
                />
              </div>
            </div>
            <h3 className="mt-4 text-[14.5px] font-semibold">{shot.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
              {shot.desc}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- 特性网格 ---------- */

function Features({ t }: { t: T }) {
  const items = t('features.items', { returnObjects: true }) as { title: string; desc: string }[];
  return (
    <section id="features" className="border-y" style={{ borderColor: 'var(--border)', background: 'var(--muted)' }}>
      <div className="mx-auto max-w-6xl px-6 py-20">
        <SectionHeading eyebrow={t('features.eyebrow')} title={t('features.title')} subtitle={t('features.subtitle')} />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((f, i) => {
            const Icon = FEATURE_ICONS[i % FEATURE_ICONS.length]!;
            return (
              <div
                key={f.title}
                className="fade-up rounded-xl border p-6 transition-shadow hover:shadow-lg"
                style={{ borderColor: 'var(--border)', background: 'var(--card)', animationDelay: `${i * 0.04}s` }}
              >
                <div
                  className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg"
                  style={{ background: 'color-mix(in srgb, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
                >
                  <Icon size={19} />
                </div>
                <h3 className="text-[14.5px] font-semibold">{f.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
                  {f.desc}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------- 工作流 ---------- */

function Workflow({ t }: { t: T }) {
  const steps = t('workflow.steps', { returnObjects: true }) as { title: string; desc: string }[];
  return (
    <section id="workflow" className="mx-auto max-w-6xl px-6 py-20">
      <SectionHeading eyebrow={t('workflow.eyebrow')} title={t('workflow.title')} subtitle={t('workflow.subtitle')} />
      <div className="mt-14 grid gap-10 md:grid-cols-4 md:gap-6">
        {steps.map((s, i) => {
          const Icon = STEP_ICONS[i % STEP_ICONS.length]!;
          return (
            <div key={s.title} className="fade-up relative" style={{ animationDelay: `${i * 0.07}s` }}>
              {/* 连接线（桌面端） */}
              {i < steps.length - 1 && (
                <div
                  aria-hidden
                  className="absolute left-full top-5 hidden h-px w-6 md:block"
                  style={{ background: 'var(--border)' }}
                />
              )}
              <div className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
                  style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
                >
                  <Icon size={16} />
                </div>
                <span className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 className="mt-4 text-[14.5px] font-semibold">{s.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
                {s.desc}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ---------- 底部 CTA + 页脚 ---------- */

function FinalCta({ t, ctaTarget }: { t: T; ctaTarget: string }) {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20">
      <div
        className="fade-up relative overflow-hidden rounded-2xl px-6 py-16 text-center"
        style={{
          background: 'linear-gradient(135deg, #00915f 0%, #006b4f 55%, #025e46 100%)',
          color: '#fff',
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(ellipse 50% 60% at 80% 0%, rgba(255,255,255,0.18), transparent 70%)' }}
        />
        <h2 className="relative text-2xl font-semibold tracking-[-0.02em] md:text-3xl">{t('cta.title')}</h2>
        <p className="relative mx-auto mt-3 max-w-md text-[14px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.82)' }}>
          {t('cta.subtitle')}
        </p>
        <Link to={ctaTarget} className="relative mt-8 inline-block">
          <Button size="lg" variant="ghost" className="gap-1.5" style={{ background: '#fff', color: '#006b4f', borderColor: '#fff' }}>
            {t('cta.button')}
            <ArrowRight size={15} />
          </Button>
        </Link>
      </div>
    </section>
  );
}

function Footer({ t }: { t: T }) {
  return (
    <footer className="border-t py-8" style={{ borderColor: 'var(--border)' }}>
      <div
        className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-[12.5px] sm:flex-row"
        style={{ color: 'var(--muted-foreground)' }}
      >
        <div className="flex items-center gap-2">
          <BrandGlyph size={18} animated={false} />
          <span>iTest · {t('footer.tagline')}</span>
        </div>
        <div className="flex items-center gap-5">
          <span>{t('footer.copyright')}</span>
          <a
            href="#top"
            className="flex items-center gap-1 transition-colors hover:text-[var(--foreground)]"
          >
            {t('footer.backToTop')}
            <ArrowUp size={12} />
          </a>
        </div>
      </div>
    </footer>
  );
}

/* ---------- 共用 ---------- */

function SectionHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <div className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--primary)' }}>
        {eyebrow}
      </div>
      <h2 className="mt-3 text-2xl font-semibold tracking-[-0.02em] md:text-[32px]">{title}</h2>
      <p className="mt-3 text-[14px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
        {subtitle}
      </p>
    </div>
  );
}
