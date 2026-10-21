'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { addDays } from '@pms/shared';
import { Emph } from '@/components/night-audit';
import { PropertyGate } from '@/components/property-gate';
import { ErrorText, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Day, DayItem, DayLane } from '@/lib/live-types';
import type { Property } from '@/lib/types';

const LANES: DayLane[] = ['arrivals', 'departures', 'housekeeping', 'money'];
const PILL_WIDTH = 12.5; // % of the axis; rows are packed so pills never overlap
const ROW_HEIGHT = 48;

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const LOOK: Record<DayItem['state'] | 'next', string> = {
  done: 'border border-line bg-surface text-muted',
  plan: 'border border-line-strong bg-surface text-ink',
  warn: 'bg-warning-soft text-warning',
  span: 'bg-info-soft text-info',
  key: 'bg-brand text-on-brand',
  next: 'bg-sun text-on-sun',
};

function TheDay({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const [day, setDay] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['day', property.id, day],
    queryFn: () => api.get<Day>('/dashboard/day', day ? { propertyId: property.id, date: day } : { propertyId: property.id }),
    refetchInterval: 60_000,
  });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorText error={q.error} />;
  const d = q.data;
  const loc = locale === 'ro' ? 'ro-RO' : 'en-GB';
  const asDate = new Date(`${d.date}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat(loc, { weekday: 'long', timeZone: 'UTC' }).format(asDate);
  const dayMonth = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(asDate);

  // Axis: 06:00 to midnight, stretched if anything happened earlier.
  const earliest = Math.min(6 * 60, ...d.items.map((i) => minutes(i.time)));
  const start = Math.floor(earliest / 60) * 60;
  const end = 24 * 60;
  const pct = (hhmm: string) => ((Math.min(minutes(hhmm), end) - start) / (end - start)) * 100;
  const ticks = Array.from({ length: Math.floor((end - start) / 120) + 1 }, (_, i) => start + i * 120);
  const nowPct = d.now ? pct(d.now) : null;
  const upcoming = d.items.filter((i) => i.state !== 'done' && (!d.now || i.time >= d.now));
  const nextItem = upcoming.find((i) => i.state !== 'key') ?? null;
  const done = d.items.filter((i) => i.state === 'done').length;

  const label = (i: DayItem) => {
    if (i.title === 'night_audit') return { title: t('day.nightAudit'), sub: '' };
    if (i.lane === 'money') return { title: money(Number(i.title), d.currency, locale), sub: t(`methods.${i.sub}`) };
    if (i.lane === 'housekeeping' && i.sub.includes(',')) return { title: i.title === '—' ? t('day.unassigned') : i.title, sub: i.sub };
    if (i.lane === 'arrivals' && !i.sub) return { title: i.title, sub: `${i.time} · ${t('day.noRoom')}` };
    if (i.lane === 'departures' && i.state !== 'done') return { title: i.title, sub: `${i.sub} · ${t('day.checkOutBy', { time: i.time })}` };
    return { title: i.title, sub: [i.time, i.sub].filter(Boolean).join(' · ') };
  };

  const lanes = LANES.map((lane) => {
    const rows: number[] = [];
    const placed = d.items
      .filter((i) => i.lane === lane)
      .map((i) => {
        const left = Math.min(pct(i.time), 100 - PILL_WIDTH);
        let row = rows.findIndex((edge) => edge <= left);
        if (row === -1) row = rows.push(0) - 1;
        rows[row] = left + PILL_WIDTH + 0.5;
        return { item: i, left, row };
      });
    return { lane, placed, rows: Math.max(1, rows.length) };
  }).filter((l) => l.lane !== 'money' || l.placed.length > 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4 px-1">
        <div className="min-w-0 flex-[1_1_420px]">
          <span className="text-sm text-muted">
            {property.name} · {t('dashboard.businessDate').toLowerCase()}
          </span>
          <h1 className="text-[40px] leading-[46px] font-semibold tracking-[-0.03em] capitalize sm:text-[52px] sm:leading-[56px]">
            <Emph text={`${weekday}, <em>${dayMonth}</em>`} />
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 rounded-full bg-surface p-1">
            <button type="button" aria-label={t('day.previous')} onClick={() => setDay(addDays(d.date, -1))} className="grid h-10 w-10 place-items-center rounded-full hover:bg-subtle">
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => setDay(null)}
              aria-pressed={d.date === d.businessDate}
              className={clsx('min-h-10 rounded-full px-4 text-sm font-semibold', d.date === d.businessDate ? 'bg-brand text-on-brand' : 'hover:bg-subtle')}
            >
              {t('day.today')}
            </button>
            <button type="button" aria-label={t('day.next')} onClick={() => setDay(addDays(d.date, 1))} className="grid h-10 w-10 place-items-center rounded-full hover:bg-subtle">
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="min-w-32 rounded-[22px] bg-surface px-4 py-2.5">
            <span className="text-xs text-muted">{t('day.legendDone')}</span>
            <div className="text-2xl font-medium tabular-nums">
              {done} <span className="text-sm text-muted">/ {d.items.length}</span>
            </div>
          </div>
          {nextItem && (
            <div className="min-w-32 rounded-[22px] bg-sun px-4 py-2.5 text-on-sun">
              <span className="text-xs">{t('day.comingUp')}</span>
              <div className="text-2xl font-medium tabular-nums">
                {nextItem.time} <span className="text-sm">{label(nextItem).title}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <section aria-label={t('day.title')} className="overflow-x-auto rounded-[32px] bg-surface p-5">
        <div className="flex min-w-[980px] flex-col gap-2.5">
          <div className="flex gap-3.5">
            <span className="w-[150px] shrink-0" />
            <div className="relative h-12 flex-1">
              {ticks.map((m) => (
                <span
                  key={m}
                  className="absolute top-7 text-xs text-muted tabular-nums"
                  style={{ left: `${((m - start) / (end - start)) * 100}%`, transform: m === start ? 'none' : m === end ? 'translateX(-100%)' : 'translateX(-50%)' }}
                >
                  {String(Math.floor(m / 60) % 24).padStart(2, '0')}:00
                </span>
              ))}
              {nowPct !== null && (
                <span className="absolute top-0 -translate-x-1/2 rounded-full bg-brand px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-on-brand" style={{ left: `${nowPct}%` }}>
                  {t('day.now', { time: d.now! })}
                </span>
              )}
            </div>
          </div>
          {lanes.map((l) => (
            <div key={l.lane} className="flex gap-3.5">
              <div className="flex w-[150px] shrink-0 flex-col justify-center pl-1">
                <span className="font-semibold">{t(`day.lanes.${l.lane}`)}</span>
                <span className="text-xs text-muted">{l.placed.length}</span>
              </div>
              <div className="relative flex-1 overflow-hidden rounded-[18px] bg-subtle" style={{ height: l.rows * ROW_HEIGHT + 12 }}>
                {nowPct !== null && <span aria-hidden className="absolute inset-y-0 left-0 bg-ink/[0.035]" style={{ width: `${nowPct}%` }} />}
                {l.placed.length === 0 && <span className="absolute inset-0 grid place-items-center text-xs text-muted">—</span>}
                {l.placed.map(({ item, left, row }, idx) => {
                  const { title, sub } = label(item);
                  const style = item === nextItem ? 'next' : item.state;
                  const box = (
                    <>
                      <span className="truncate font-semibold">{title}</span>
                      {sub && <span className="truncate text-[11px]">{sub}</span>}
                    </>
                  );
                  const cls = clsx('absolute flex h-[42px] flex-col justify-center overflow-hidden rounded-[14px] px-3 text-left text-[12.5px]', LOOK[style]);
                  const pos = { left: `calc(${left}% + 2px)`, top: 6 + row * ROW_HEIGHT, width: `calc(${PILL_WIDTH}% - 4px)` };
                  return item.reservationId ? (
                    <Link key={idx} href={`/reservations/${item.reservationId}`} className={clsx(cls, 'hover:brightness-95')} style={pos}>
                      {box}
                    </Link>
                  ) : (
                    <div key={idx} className={cls} style={pos}>
                      {box}
                    </div>
                  );
                })}
                {nowPct !== null && <span aria-hidden className="absolute inset-y-0 border-l-2 border-dashed border-brand" style={{ left: `${nowPct}%` }} />}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
        <section className="flex flex-col rounded-[28px] bg-surface p-5">
          <h2 className="mb-2 text-lg font-semibold">{t('day.comingUp')}</h2>
          {upcoming.length === 0 && <p className="text-sm text-muted">{t('day.nothingNext')}</p>}
          {upcoming.slice(0, 6).map((i, idx) => {
            const { title, sub } = label(i);
            return (
              <div key={idx} className="flex items-center gap-3.5 border-t border-line py-2.5 first-of-type:border-t-0">
                <span className="w-12 shrink-0 font-semibold tabular-nums">{i.time}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{title}</span>
                  <span className="truncate text-xs text-muted">
                    {t(`day.lanes.${i.lane}`)}
                    {sub ? ` · ${sub}` : ''}
                  </span>
                </span>
                {i.reservationId && (
                  <Link href={`/reservations/${i.reservationId}`} className="text-sm font-semibold text-accent">
                    {t('house.open')}
                  </Link>
                )}
              </div>
            );
          })}
        </section>
        <section className="flex flex-wrap content-start gap-x-5 gap-y-2.5 rounded-[28px] bg-surface p-5 text-sm">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className={clsx('h-4 w-8 rounded-md', LOOK.done)} /> {t('day.legendDone')}
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className={clsx('h-4 w-8 rounded-md', LOOK.plan)} /> {t('day.legendPlan')}
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className={clsx('h-4 w-8 rounded-md', LOOK.warn)} /> {t('day.legendWarn')}
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className={clsx('h-4 w-8 rounded-md', LOOK.next)} /> {t('day.comingUp')}
          </span>
        </section>
      </div>
    </div>
  );
}

export default function DayPage() {
  return <PropertyGate perms={['property.read']}>{(p) => <TheDay property={p} />}</PropertyGate>;
}
