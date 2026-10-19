'use client';

import clsx from 'clsx';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';

/** Hotel-branded header for guest pages: the hotel is the brand here, era. stays in the footer. */
export function HotelHeader({ name, place, compact, back }: { name: string; place?: string | null; compact?: boolean; back?: ReactNode }) {
  const { locale, setLocale } = useI18n();
  return (
    <header className="bg-navy-800 text-white">
      <div className={clsx('mx-auto flex max-w-5xl items-center gap-3 px-4', compact ? 'py-3' : 'pt-7 pb-6')}>
        {back}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {!compact && place && <span className="text-[11px] leading-4 tracking-[0.14em] text-[#c7d1ea] uppercase">{place}</span>}
          <span className={clsx('font-display font-medium', compact ? 'text-[26px] leading-[30px]' : 'text-4xl leading-10')}>{name}</span>
        </div>
        <button
          type="button"
          onClick={() => setLocale(locale === 'en' ? 'ro' : 'en')}
          className="min-h-11 rounded-md px-3 text-xs font-semibold tracking-wide text-[#dde3f2] uppercase hover:bg-white/10"
          aria-label={locale === 'en' ? 'Română' : 'English'}
        >
          {locale === 'en' ? 'RO' : 'EN'}
        </button>
      </div>
    </header>
  );
}

export function StepNav({ step }: { step: 1 | 2 | 3 }) {
  const { t } = useI18n();
  const items = [t('guest.steps.room'), t('guest.steps.details'), t('guest.steps.done')];
  return (
    <nav aria-label="Booking steps" className="border-b border-line bg-surface">
      <ol className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3.5 text-xs">
        {items.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          const current = n === step;
          return (
            <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
              <span className={clsx('flex items-center gap-1.5', current ? 'font-semibold text-ink' : done ? 'text-success' : 'text-muted')} aria-current={current ? 'step' : undefined}>
                <span
                  className={clsx(
                    'grid h-5 w-5 place-items-center rounded-full text-[11px]',
                    current && 'bg-brand text-on-brand',
                    done && 'bg-success-soft',
                    !current && !done && 'border border-line-strong',
                  )}
                >
                  {done ? <Check size={12} strokeWidth={2.5} /> : n}
                </span>
                {label}
              </span>
              {n < 3 && <span aria-hidden className="h-px flex-1 bg-line" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PoweredBy() {
  const { t } = useI18n();
  return (
    <footer className="flex items-center justify-center gap-1.5 py-6 text-xs text-muted">
      {t('guest.poweredBy')}
      <span className="inline-flex items-baseline gap-px text-ink">
        <span className="font-display text-lg italic">era</span>
        <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-accent" />
      </span>
    </footer>
  );
}

export function GuestCard({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx('rounded-2xl border border-line bg-surface shadow-card', className)}>{children}</section>;
}

/** Human date such as "Sat 14 Nov 2026". */
export function stayDate(iso: string, locale: string, withYear = true) {
  return new Intl.DateTimeFormat(locale === 'ro' ? 'ro-RO' : 'en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));
}
