'use client';

import clsx from 'clsx';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useAsk } from '@/components/ask-era';
import { Emph, NightAuditDialog, useNight } from '@/components/night-audit';
import { Button, ErrorText, Spinner } from '@/components/ui';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Property } from '@/lib/types';

/** Evening home: a calm greeting, one place to ask, and what stands before the night audit. */
export function NightHome({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { me, can } = useSession();
  const ask = useAsk();
  const q = useNight(property.id);
  const [question, setQuestion] = useState('');
  const [audit, setAudit] = useState(false);

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorText error={q.error} />;
  const n = q.data;
  const m = (v: number) => money(v, n.currency, locale);
  const left = n.checks.filter((c) => !c.done).length;
  const firstName = me.user.name.split(' ')[0] ?? me.user.name;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask.open(question.trim());
    setQuestion('');
  };
  const next = n.stillToArrive[0];

  return (
    <div className="flex flex-col gap-7">
      <section className="mx-auto flex w-full max-w-[820px] flex-col items-center gap-4 pt-4 text-center">
        <span className="text-sm text-muted">
          {t('night.mode')} · {n.now}
        </span>
        <h1 className="text-[40px] leading-[46px] font-medium tracking-[-0.02em] sm:text-[52px] sm:leading-[58px]">
          <Emph text={t('night.greeting', { name: firstName })} />
        </h1>
        <p className="text-[17px] text-muted">
          {left
            ? t('night.summary', { occupied: n.tonight.occupied, sellable: n.tonight.sellable, arrivals: n.stillToArrive.length, checks: left })
            : t('night.allClear')}
        </p>
        <form onSubmit={submit} className="flex min-h-16 w-full items-center gap-3 rounded-full border-[1.5px] border-line bg-surface pr-2.5 pl-5">
          <Sparkles size={20} className="shrink-0 text-sun" aria-hidden />
          <label htmlFor="night-ask" className="sr-only">
            {t('ask.title')}
          </label>
          <input
            id="night-ask"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t('ask.placeholder')}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-faint"
          />
          <button type="submit" aria-label={t('ask.ask')} className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-sun text-on-sun">
            <ArrowRight size={18} aria-hidden />
          </button>
        </form>
        <div className="flex flex-wrap justify-center gap-2">
          {t('ask.suggestions')
            .split('|')
            .map((s) => (
              <button key={s} type="button" onClick={() => ask.open(s)} className="min-h-10 rounded-full border border-line px-4 text-sm hover:border-line-strong">
                {s}
              </button>
            ))}
        </div>
      </section>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        <section className="flex flex-col gap-3 rounded-[26px] bg-surface p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[17px] font-semibold">{t('night.checklist')}</h2>
            <span className="text-xs text-muted">
              {n.checks.length - left} / {n.checks.length}
            </span>
          </div>
          {n.checks.map((c) => (
            <div key={c.key} className="flex items-center gap-2.5">
              <span className={clsx('grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full', c.done ? 'bg-success-soft text-success' : 'border-2 border-sun')}>
                {c.done && <Check size={12} strokeWidth={3} aria-hidden />}
              </span>
              <span className={clsx('flex-1 text-sm', c.done && 'text-muted line-through')}>{t(`night.checks.${c.key}`)}</span>
              {!c.done && <span className="text-xs font-semibold text-warning">{t('night.left', { n: c.count })}</span>}
            </div>
          ))}
          {can('property.manage') && (
            <>
              <Button className="mt-1.5" variant={n.ready ? 'primary' : 'secondary'} onClick={() => setAudit(true)}>
                {n.ready ? t('audit.run') : t('audit.checksLeft', { n: left })}
              </Button>
              <NightAuditDialog open={audit} onClose={() => setAudit(false)} />
            </>
          )}
        </section>

        <section className="flex flex-col gap-3.5 rounded-[26px] bg-surface p-5">
          <h2 className="text-[17px] font-semibold">{t('night.tonight')}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Figure label={t('night.roomsOccupied')} value={`${n.tonight.occupied}`} suffix={`/${n.tonight.sellable}`} />
            <Figure label={t('night.guests')} value={`${n.tonight.guests}`} />
            {n.tonight.revenueToday !== null && <Figure small label={t('night.revenueToday')} value={m(n.tonight.revenueToday)} />}
            <Figure small label={t('night.breakfast')} value={t('night.covers', { n: n.tonight.breakfastTomorrow })} />
          </div>
          <div aria-hidden className="grid gap-1 [grid-template-columns:repeat(12,minmax(0,1fr))]">
            {Array.from({ length: n.tonight.sellable }, (_, i) => (
              <span key={i} className={clsx('h-2.5 rounded-[3px]', i < n.tonight.occupied ? 'bg-lit' : 'bg-line')} />
            ))}
          </div>
          <span className="text-xs text-muted">{t('night.lights', { lit: n.tonight.occupied, dark: Math.max(0, n.tonight.sellable - n.tonight.occupied) })}</span>
        </section>

        {next ? (
          <section className="flex flex-col gap-2.5 rounded-[26px] bg-sun p-5 text-on-sun">
            <span className="text-xs font-semibold">{t('night.stillToArrive')}</span>
            <h2 className="text-[28px] leading-8 font-medium tracking-[-0.02em]">
              {next.guestName} · {next.time}
            </h2>
            <p className="text-sm">
              {next.room ? (next.roomReady ? t('night.roomReady', { room: next.room }) : t('night.roomNotReady', { room: next.room })) : t('night.noRoom')}{' '}
              {next.onlineCheckin && t('night.checkedInOnline')} {next.paid === true ? t('night.paid') : next.paid === false ? t('night.notPaid') : ''}
            </p>
            {next.requests && <p className="text-sm italic">“{next.requests}”</p>}
            {n.stillToArrive.length > 1 && (
              <ul className="text-sm">
                {n.stillToArrive.slice(1, 4).map((a) => (
                  <li key={a.reservationId}>
                    {a.time} · {a.guestName}
                  </li>
                ))}
              </ul>
            )}
            <Link href={`/reservations/${next.reservationId}`} className="mt-auto inline-flex min-h-11 items-center self-start rounded-full bg-[#15171c] px-5 text-sm font-semibold text-white">
              {t('house.open')}
            </Link>
          </section>
        ) : (
          <section className="flex items-center rounded-[26px] bg-surface p-5 text-sm text-muted">{t('night.everyoneArrived')}</section>
        )}
      </div>

      {can('folio.read') && n.owes.length > 0 && (
        <section className="flex flex-col gap-1 rounded-[26px] bg-surface p-5">
          <h2 className="mb-2 text-[17px] font-semibold">{t('night.owes')}</h2>
          {n.owes.map((o) => (
            <Link key={o.reservationId} href={`/reservations/${o.reservationId}`} className="flex flex-wrap items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-subtle">
              <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-lit font-semibold text-on-lit">{o.room ?? '—'}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">{o.guestName}</span>
                <span className="text-xs text-muted">{t('ask.leaves', { date: date(o.departure, locale) })}</span>
              </span>
              <span className="text-lg font-medium tabular-nums">{m(o.balance)}</span>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}

function Figure({ label, value, suffix, small }: { label: string; value: string; suffix?: string; small?: boolean }) {
  return (
    <div>
      <span className="text-xs text-muted">{label}</span>
      <div className={clsx('font-medium tracking-[-0.02em] tabular-nums', small ? 'text-xl' : 'text-[32px] leading-9')}>
        {value}
        {suffix && <span className="text-base text-muted">{suffix}</span>}
      </div>
    </div>
  );
}
