import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, ArrowUp, Bot, Bug, Compass, Database, GitCompare, Menu, MonitorSmartphone, Repeat, Wrench,
} from 'lucide-react';
import BrandGlyph from '../components/BrandGlyph';
import Button from '../components/ui/Button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../components/ui/shadcn/dropdown-menu';
import { useAuthStore } from '../stores/auth';
import { applyLang } from '../stores/lang';
import { LANG_STORAGE_KEY, readStoredLang, type Lang } from '../i18n';

const FEATURE_ICONS = [Compass, Repeat, Bot, Database, Wrench, Bug, GitCompare, MonitorSmartphone];

/** 特性卡在 12 栅格里的跨度：两张大卡 7+5，四张紧凑卡 3×4，两张中卡 6+6。避免等宽卡栅格的模板感 */
const FEATURE_SPANS = [
  'lg:col-span-7',
  'lg:col-span-5',
  'lg:col-span-3',
  'lg:col-span-3',
  'lg:col-span-3',
  'lg:col-span-3',
  'lg:col-span-6',
  'lg:col-span-6',
];

/** 展示区四张真实界面截图，已按内容裁好取景：报告与探索两张全宽打头，两张并排垫底 */
const SHOT_IMAGES = [
  '/landing/showcase-report.png',
  '/landing/showcase-exploration.png',
  '/landing/showcase-assistant.png',
  '/landing/showcase-case.png',
];

/** 强调色文本：浅色用 --primary，深色换 --ring（浅绿），两者对底色均满足 4.5:1 */
const ACCENT_TEXT = 'text-[var(--primary)] dark:text-[var(--ring)]';

/** 标题字号：英文是小写拉丁字母，字数与中文相当但字面宽，按小一号排才不会在窄栏里折行 */
const HEADLINE_SIZE: Record<Lang, string> = {
  'zh-CN': 'text-[34px] lg:text-[44px]',
  'en-US': 'text-[28px] lg:text-[40px]',
};

/** 导航锚点，顺序与页面区块一致；桌面横排，窄屏收进菜单 */
const NAV_LINKS = [
  { href: '#pains', key: 'nav.pains' },
  { href: '#showcase', key: 'nav.screenshots' },
  { href: '#features', key: 'nav.features' },
  { href: '#workflow', key: 'nav.workflow' },
];

/** 产品对外介绍页（公开路由，无 AuthGuard）。截图区为真实界面素材。 */
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
      <main>
        <Hero t={t} ctaTarget={ctaTarget} lang={lang} />
        <PainPoints t={t} />
        <Showcase t={t} />
        <Features t={t} />
        <Workflow t={t} />
        <FinalCta t={t} ctaTarget={ctaTarget} />
      </main>
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
      className="sticky top-0 z-50 border-b"
      style={{ background: 'var(--background)', borderColor: 'var(--border)' }}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <BrandGlyph size={28} animated />
          <span className="text-[15px] font-semibold">iTest</span>
        </a>
        <nav className="hidden items-center gap-6 text-[14px] md:flex" style={{ color: 'var(--muted-foreground)' }}>
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-[var(--foreground)]">
              {t(l.key)}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('nav.menu')}
                className="flex h-8 w-8 items-center justify-center rounded-lg border md:hidden"
                style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
              >
                <Menu size={16} strokeWidth={1.5} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[8rem]">
              {NAV_LINKS.map((l) => (
                <DropdownMenuItem key={l.href} asChild className="text-[14px]">
                  <a href={l.href}>{t(l.key)}</a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center rounded-lg border p-0.5 text-[12px]" style={{ borderColor: 'var(--border)' }}>
            {(['zh-CN', 'en-US'] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => onSwitchLang(l)}
                className="rounded-[6px] px-2 py-1 transition-colors"
                style={l === lang
                  ? { background: 'var(--muted)', color: 'var(--foreground)' }
                  : { color: 'var(--muted-foreground)' }}
              >
                {l === 'zh-CN' ? '中' : 'EN'}
              </button>
            ))}
          </div>
          <Link to={ctaTarget}>
            <Button size="md">{ctaLabel}</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ---------- Hero：左文右产品界面 ---------- */

function Hero({ t, ctaTarget, lang }: { t: T; ctaTarget: string; lang: Lang }) {
  return (
    <section id="top" className="scroll-mt-16 overflow-hidden">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:gap-10 lg:py-20">
        <div className="fade-up">
          <span
            className="inline-flex items-center rounded-lg border px-2.5 py-1 text-[12px]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
          >
            {t('hero.badge')}
          </span>
          <h1 className={`mt-5 font-medium leading-[1.2] tracking-[-0.02em] ${HEADLINE_SIZE[lang]}`}>
            <span className="block">{t('hero.titleLead')}</span>
            <span className="block">
              <span className={ACCENT_TEXT}>{t('hero.titleAccent')}</span>
              {t('hero.titleTail')}
            </span>
          </h1>
          <p
            className="mt-5 max-w-[460px] text-[15px] leading-relaxed"
            style={{ color: 'var(--muted-foreground)' }}
          >
            {t('hero.subtitle')}
          </p>
          <div className="mt-8 flex items-center gap-6">
            <Link to={ctaTarget}>
              <Button size="lg" className="gap-1.5">
                {t('hero.primaryCta')}
                <ArrowRight size={16} strokeWidth={1.5} />
              </Button>
            </Link>
            <a
              href="#workflow"
              className="inline-flex items-center gap-1.5 text-[14px] transition-colors hover:text-[var(--foreground)]"
              style={{ color: 'var(--muted-foreground)' }}
            >
              {t('hero.secondaryCta')}
              <ArrowRight size={16} strokeWidth={1.5} />
            </a>
          </div>
        </div>
        <figure className="fade-up" style={{ animationDelay: '0.08s' }}>
          <div
            className="overflow-hidden rounded-xl border"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <img
              src="/landing/hero-steps.png"
              alt={t('hero.shotCaption')}
              className="block w-full"
            />
          </div>
          <figcaption
            className="mt-3 font-mono text-[11px]"
            style={{ color: 'var(--muted-foreground)' }}
          >
            {t('hero.shotCaption')}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ---------- 痛点：左标题 + 右编号清单 ---------- */

function PainPoints({ t }: { t: T }) {
  const items = t('pains.items', { returnObjects: true }) as { title: string; desc: string }[];
  return (
    <section
      id="pains"
      className="scroll-mt-16 border-y"
      style={{ borderColor: 'var(--border)', background: 'var(--muted)' }}
    >
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-16 lg:py-24">
        <div>
          <SectionLabel index="01">{t('pains.eyebrow')}</SectionLabel>
          <h2 className="mt-4 text-[26px] font-medium leading-[1.28] lg:text-[32px]">{t('pains.title')}</h2>
          <p
            className="mt-3 max-w-[420px] text-[14px] leading-relaxed"
            style={{ color: 'var(--muted-foreground)' }}
          >
            {t('pains.subtitle')}
          </p>
        </div>
        <ul>
          {items.map((p, i) => (
            <li key={p.title} className="border-t py-6 first:border-t-0 first:pt-0 last:pb-0">
              <div className="flex gap-5">
                <span
                  className="mt-0.5 shrink-0 font-mono text-[12px] tabular-nums"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-[15px] font-medium">{p.title}</h3>
                  <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
                    {p.desc}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------- 产品预览：两张全宽旗舰图 + 两张并排 ---------- */

function Showcase({ t }: { t: T }) {
  const shots = t('showcase.shots', { returnObjects: true }) as { title: string; desc: string }[];
  const [lead, second, ...rest] = shots;
  const wide = [lead!, second!];
  return (
    <section id="showcase" className="scroll-mt-16 mx-auto max-w-6xl px-6 py-20 lg:py-24">
      <header className="max-w-2xl">
        <SectionLabel index="02">{t('showcase.eyebrow')}</SectionLabel>
        <h2 className="mt-4 text-[26px] font-medium leading-[1.28] lg:text-[32px]">{t('showcase.title')}</h2>
        <p className="mt-3 text-[14px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
          {t('showcase.subtitle')}
        </p>
      </header>
      {/* 两张全宽：执行报告（页面签名元素）与探索式测试（新能力旗舰） */}
      {wide.map((shot, i) => (
        <figure key={shot.title} className={i === 0 ? 'mt-10' : 'mt-12'}>
          <div
            className="overflow-hidden rounded-xl border"
            style={{ boxShadow: 'var(--shadow-sm)' }}
          >
            <img
              src={SHOT_IMAGES[i]}
              alt={shot.title}
              loading={i === 0 ? undefined : 'lazy'}
              className="block w-full"
            />
          </div>
          <figcaption className="mt-3 max-w-[56ch]">
            <h3 className="text-[14px] font-medium">{shot.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
              {shot.desc}
            </p>
          </figcaption>
        </figure>
      ))}
      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        {rest.map((shot, i) => (
          <figure key={shot.title}>
            <div
              className="overflow-hidden rounded-xl border"
              style={{ boxShadow: 'var(--shadow-sm)' }}
            >
              <img
                src={SHOT_IMAGES[i + 2]}
                alt={shot.title}
                loading="lazy"
                className="block w-full"
              />
            </div>
            <figcaption className="mt-3">
              <h3 className="text-[14px] font-medium">{shot.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
                {shot.desc}
              </p>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/* ---------- 特性：12 栅格大小混排 ---------- */

function Features({ t }: { t: T }) {
  const items = t('features.items', { returnObjects: true }) as { title: string; desc: string }[];
  return (
    <section
      id="features"
      className="scroll-mt-16 border-y"
      style={{ borderColor: 'var(--border)', background: 'var(--muted)' }}
    >
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <header className="max-w-2xl">
          <SectionLabel index="03">{t('features.eyebrow')}</SectionLabel>
          <h2 className="mt-4 text-[26px] font-medium leading-[1.28] lg:text-[32px]">{t('features.title')}</h2>
          <p className="mt-3 text-[14px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
            {t('features.subtitle')}
          </p>
        </header>
        <div className="mt-10 grid gap-4 lg:grid-cols-12">
          {items.map((f, i) => {
            const Icon = FEATURE_ICONS[i % FEATURE_ICONS.length]!;
            return (
              <div
                key={f.title}
                className={`rounded-xl border p-6 ${FEATURE_SPANS[i] ?? 'lg:col-span-3'}`}
                style={{ background: 'var(--card)' }}
              >
                <Icon size={16} strokeWidth={1.5} style={{ color: 'var(--muted-foreground)' }} />
                <h3 className={`mt-3 font-medium ${i < 2 ? 'text-[17px]' : 'text-[15px]'}`}>{f.title}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
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

/* ---------- 工作流：一条轨迹线串四步 ---------- */

function Workflow({ t }: { t: T }) {
  const steps = t('workflow.steps', { returnObjects: true }) as { title: string; desc: string }[];
  return (
    <section id="workflow" className="scroll-mt-16 mx-auto max-w-6xl px-6 py-20 lg:py-24">
      <header className="max-w-2xl">
        <SectionLabel index="04">{t('workflow.eyebrow')}</SectionLabel>
        <h2 className="mt-4 text-[26px] font-medium leading-[1.28] lg:text-[32px]">{t('workflow.title')}</h2>
        <p className="mt-3 text-[14px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
          {t('workflow.subtitle')}
        </p>
      </header>
      <ol className="mt-12 grid gap-8 lg:grid-cols-5 lg:gap-5">
        {steps.map((s, i) => (
          <li key={s.title}>
            <div className="flex items-center gap-3">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border font-mono text-[11px] tabular-nums"
                style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
              >
                {i + 1}
              </span>
              {i < steps.length - 1 && (
                <span aria-hidden className="hidden h-px flex-1 lg:block" style={{ background: 'var(--border)' }} />
              )}
            </div>
            <h3 className="mt-4 text-[15px] font-medium">{s.title}</h3>
            <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
              {s.desc}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------- 底部 CTA + 页脚 ---------- */

function FinalCta({ t, ctaTarget }: { t: T; ctaTarget: string }) {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20">
      <div
        className="rounded-[16px] border p-8 lg:p-12"
        style={{ background: 'var(--card)' }}
      >
        <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:gap-12">
          <div>
            <h2 className="text-[24px] font-medium leading-[1.3] lg:text-[28px]">{t('cta.title')}</h2>
            <p
              className="mt-3 max-w-[440px] text-[14px] leading-relaxed"
              style={{ color: 'var(--muted-foreground)' }}
            >
              {t('cta.subtitle')}
            </p>
          </div>
          <div className="lg:justify-self-end">
            <Link to={ctaTarget}>
              <Button size="lg" className="gap-1.5">
                {t('cta.button')}
                <ArrowRight size={16} strokeWidth={1.5} />
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer({ t }: { t: T }) {
  return (
    <footer className="border-t py-8" style={{ borderColor: 'var(--border)' }}>
      <div
        className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-[13px] sm:flex-row"
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
            <ArrowUp size={14} strokeWidth={1.5} />
          </a>
        </div>
      </div>
    </footer>
  );
}

/* ---------- 共用：区块标签（报告式证据编号） ---------- */

function SectionLabel({ index, children }: { index: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
      <span className="font-mono tabular-nums">{index}</span>
      <span aria-hidden className="h-px w-6" style={{ background: 'var(--border)' }} />
      <span>{children}</span>
    </div>
  );
}
