'use client';

import { BedDouble, CalendarCheck, ShieldCheck, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Wordmark } from '@/components/wordmark';
import { useI18n } from '@/lib/i18n';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden bg-navy-800 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Wordmark size="md" tagline inverse />
        <div className="space-y-6">
          <h2 className="max-w-md font-display text-5xl leading-[1.05] font-medium">{t('app.tagline')}</h2>
          <ul className="space-y-3 text-white/85">
            {[
              [CalendarCheck, t('nav.reservations') + ' · ' + t('nav.frontDesk')],
              [Sparkles, t('nav.housekeeping')],
              [BedDouble, t('nav.rooms') + ' · ' + t('nav.rates')],
              [ShieldCheck, '2FA · RBAC · GDPR'],
            ].map(([Icon, label], i) => {
              const I = Icon as typeof CalendarCheck;
              return (
                <li key={i} className="flex items-center gap-3">
                  <I size={18} strokeWidth={1.75} /> {label as string}
                </li>
              );
            })}
          </ul>
        </div>
        <p className="text-sm text-white/65">© {new Date().getFullYear()} era.</p>
        <div aria-hidden className="pointer-events-none absolute -right-28 -bottom-28 h-96 w-96 rounded-full bg-navy-700/60" />
        <div aria-hidden className="pointer-events-none absolute right-24 bottom-40 h-6 w-6 rounded-full bg-[#8fa5d8]" />
      </aside>
      <main className="flex flex-col items-center justify-center px-4 py-10">
        <div className="mb-6 flex w-full max-w-sm justify-end gap-1 text-xs">
          {(['ro', 'en'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLocale(l)}
              className={`rounded px-2 py-1 uppercase ${locale === l ? 'bg-brand-soft font-semibold text-on-brand-soft' : 'text-muted'}`}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="mb-8 lg:hidden">
          <Wordmark size="md" tagline />
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
