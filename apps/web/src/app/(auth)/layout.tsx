'use client';

import { BedDouble, CalendarCheck, ShieldCheck, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden bg-brand-500 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/15">H</span>
          {t('app.name')}
        </div>
        <div className="space-y-6">
          <h2 className="max-w-md text-3xl leading-tight font-semibold">{t('app.tagline')}</h2>
          <ul className="space-y-3 text-white/90">
            {[
              [CalendarCheck, t('nav.reservations') + ' · ' + t('nav.frontDesk')],
              [Sparkles, t('nav.housekeeping')],
              [BedDouble, t('nav.rooms') + ' · ' + t('nav.rates')],
              [ShieldCheck, '2FA · RBAC · GDPR'],
            ].map(([Icon, label], i) => {
              const I = Icon as typeof CalendarCheck;
              return (
                <li key={i} className="flex items-center gap-3">
                  <I size={18} /> {label as string}
                </li>
              );
            })}
          </ul>
        </div>
        <p className="text-sm text-white/70">© {new Date().getFullYear()} {t('app.name')}</p>
        <div className="pointer-events-none absolute -right-24 -bottom-24 h-96 w-96 rounded-full bg-white/10" />
      </aside>
      <main className="flex flex-col items-center justify-center px-4 py-10">
        <div className="mb-6 flex w-full max-w-sm justify-end gap-1 text-xs">
          {(['ro', 'en'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLocale(l)}
              className={`rounded px-2 py-1 uppercase ${locale === l ? 'bg-brand-50 font-semibold text-brand-700' : 'text-muted'}`}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
