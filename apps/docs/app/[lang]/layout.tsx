import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { i18nProvider } from 'fumadocs-ui/i18n';
import { Provider } from '@/components/provider';
import { i18n, isLocale } from '@/lib/i18n';
import { translations } from '@/lib/layout.shared';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import '../global.css';

export const metadata: Metadata = {
  title: { template: '%s · VPuppet', default: 'VPuppet' },
  description: 'VPuppet: a webcam VTuber app for macOS, Windows and Linux.',
};

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export const dynamicParams = false;

export default async function Layout({ params, children }: LayoutProps<'/[lang]'>) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  return (
    <html lang={lang} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider i18n={i18nProvider(translations, lang)}>{children}</Provider>
      </body>
    </html>
  );
}
