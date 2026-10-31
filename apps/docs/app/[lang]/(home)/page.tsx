import Link from 'next/link';
import type { Metadata } from 'next';
import { Logo } from '@/components/logo';
import { siteText } from '@/lib/layout.shared';
import { steamUrl, githubUrl } from '@/lib/shared';
import type { Locale } from '@/lib/i18n';

export async function generateMetadata({ params }: PageProps<'/[lang]'>): Promise<Metadata> {
  const { lang } = await params;
  const t = siteText[lang as Locale];
  return { title: { absolute: `VPuppet · ${t.tagline}` }, description: t.pitch };
}

export default async function HomePage({ params }: PageProps<'/[lang]'>) {
  const { lang } = await params;
  const t = siteText[lang as Locale];

  return (
    <main className="vp-landing flex-1">
      <section className="vp-hero">
        <div className="vp-hero-inner">
          <h1 className="vp-hero-logo">
            <Logo className="h-auto w-full max-w-[640px]" />
          </h1>
          <p className="vp-pitch">{t.pitch}</p>
          <div className="vp-actions">
            <Link href={`/${lang}/docs/`} className="vp-btn vp-btn-ink">
              {t.readDocs} <kbd>→</kbd>
            </Link>
            <a href={steamUrl} className="vp-btn vp-btn-accent" target="_blank" rel="noreferrer noopener">
              {t.buySteam} <kbd>$19.99</kbd>
            </a>
          </div>
          <ul className="vp-meta">
            <li>{t.demoNote}</li>
            <li>{t.platforms}</li>
            <li>
              <a href={githubUrl} target="_blank" rel="noreferrer noopener">
                {t.sourceNote} ↗
              </a>
            </li>
          </ul>
        </div>
      </section>
      <section className="vp-features">
        {t.features.map((f) => (
          <div key={f.idx} className="vp-feature">
            <h2>
              <span className="vp-idx">{f.idx}</span> {f.title}
            </h2>
            <p>{f.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
