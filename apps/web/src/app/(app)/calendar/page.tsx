'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { addDays, nightsBetween, weekday } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { Badge, Button, Card, ErrorText, Input, PageHeader, Spinner, Tabs, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Property } from '@/lib/types';

interface Cal {
  rooms: { id: string; number: string; roomTypeId: string; roomTypeCode: string; status: string }[];
  reservations: { id: string; code: string; status: string; roomId: string | null; roomTypeId: string; arrival: string; departure: string; guestName: string; segment: string }[];
}
interface Year {
  year: number;
  rooms: number;
  days: { date: string; sold: number }[];
}
interface Found {
  id: string;
  code: string;
  status: string;
  arrival: string;
  departure: string;
  guestName: string;
  roomNumber: string | null;
}

type View = 'week' | 'fortnight' | 'month' | 'year';

const barColor: Record<string, string> = {
  tentative: 'border border-dashed border-warning bg-warning-soft text-warning',
  confirmed: 'bg-accent text-on-brand',
  checked_in: 'bg-brand text-on-brand',
  checked_out: 'bg-subtle text-muted',
};

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
function addMonths(first: string, n: number) {
  const [y, m] = first.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1 + n, 1)).toISOString().slice(0, 10);
}
const utc = (d: string) => new Date(`${d}T00:00:00Z`);

/** Unassigned stays share a row, so overlapping ones go on separate lines. */
function stack(bookings: Cal['reservations']) {
  const ends: string[] = [];
  const lane = new Map<string, number>();
  for (const b of [...bookings].sort((x, y) => x.arrival.localeCompare(y.arrival))) {
    const free = ends.findIndex((end) => end <= b.arrival);
    const i = free < 0 ? ends.length : free;
    ends[i] = b.departure;
    lane.set(b.id, i);
  }
  return { lane, lanes: Math.max(1, ends.length) };
}

function Timeline({ property, start, length, highlight }: { property: Property; start: string; length: number; highlight: string | null }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const end = addDays(start, length);
  const q = useQuery({
    queryKey: ['calendar', property.id, start, length],
    queryFn: () => api.get<Cal>('/reservations/calendar', { propertyId: property.id, from: start, to: end }),
    placeholderData: (p) => p,
  });
  const loaded = Boolean(q.data);
  useEffect(() => {
    if (highlight && loaded) document.querySelector('[data-found]')?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [highlight, start, loaded]);
  const days = Array.from({ length }, (_, i) => addDays(start, i));
  const dense = length > 14;
  const lang = locale === 'en' ? 'en-GB' : 'ro-RO';
  const dayName = new Intl.DateTimeFormat(lang, { weekday: dense ? 'narrow' : 'short', timeZone: 'UTC' });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const types = [...new Map(q.data!.rooms.map((r) => [r.roomTypeId, r.roomTypeCode])).entries()];
  const rows: { key: string; label: string; roomId: string | null; roomTypeId: string; muted?: boolean }[] = [];
  for (const [typeId, code] of types) {
    for (const r of q.data!.rooms.filter((x) => x.roomTypeId === typeId)) rows.push({ key: r.id, label: r.number, roomId: r.id, roomTypeId: typeId });
    if (q.data!.reservations.some((r) => !r.roomId && r.roomTypeId === typeId))
      rows.push({ key: `u-${typeId}`, label: `${code} · ${t('calendar.unassigned')}`, roomId: null, roomTypeId: typeId, muted: true });
  }

  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <div className={clsx('grid', dense ? 'min-w-[1180px]' : 'min-w-[820px]')} style={{ gridTemplateColumns: `104px repeat(${length}, minmax(0, 1fr))` }}>
          <div className="sticky left-0 z-20 border-b border-line bg-surface" />
          {days.map((d) => (
            <div
              key={d}
              className={clsx(
                'border-b border-l border-line px-0.5 py-2 text-center text-[11px] leading-tight',
                d === property.businessDate ? 'bg-brand-soft font-semibold text-on-brand-soft' : [0, 6].includes(weekday(d)) ? 'bg-subtle text-muted' : 'text-muted',
              )}
            >
              <span className="block">{dayName.format(utc(d))}</span>
              <span className="block font-medium">{d.slice(8)}</span>
            </div>
          ))}
          {rows.map((row) => {
            const bookings = q.data!.reservations.filter((r) => (row.roomId ? r.roomId === row.roomId : !r.roomId && r.roomTypeId === row.roomTypeId));
            const { lane, lanes } = row.roomId ? { lane: new Map<string, number>(), lanes: 1 } : stack(bookings);
            return (
              <Fragment key={row.key}>
                <div className={clsx('sticky left-0 z-20 border-b border-line bg-surface px-3 py-2 text-sm', row.muted ? 'text-xs text-muted italic' : 'font-semibold')}>{row.label}</div>
                <div className="relative border-b border-line" style={{ gridColumn: `2 / span ${length}` }}>
                  <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${length}, 1fr)` }}>
                    {days.map((d) =>
                      d >= property.businessDate && can('reservations.create') ? (
                        <Link
                          key={d}
                          href={`/reservations/new?arrival=${d}`}
                          aria-label={`${t('reservations.new')} ${date(d, locale)}`}
                          className={clsx('border-l border-line hover:bg-brand-soft', d === property.businessDate && 'bg-brand-soft/60')}
                        />
                      ) : (
                        <div key={d} className={clsx('border-l border-line', d === property.businessDate && 'bg-brand-soft/60')} />
                      ),
                    )}
                  </div>
                  <div className="pointer-events-none relative" style={{ height: 8 + lanes * 32 }}>
                    {bookings.map((b) => {
                      const from = Math.max(0, nightsBetween(start, b.arrival));
                      const to = Math.min(length, nightsBetween(start, b.departure));
                      if (to <= 0 || from >= length) return null;
                      // Stays run from mid-day of arrival to mid-day of departure.
                      const left = from + (b.arrival >= start ? 0.5 : 0);
                      const right = Math.min(length, to + (b.departure <= end ? 0.5 : 0));
                      return (
                        <Link
                          key={b.id}
                          href={`/reservations/${b.id}`}
                          data-found={b.id === highlight ? '' : undefined}
                          title={`${b.guestName} · ${b.code} · ${date(b.arrival, locale)} – ${date(b.departure, locale)}`}
                          className={clsx(
                            'pointer-events-auto absolute truncate rounded-sm px-2 text-xs leading-7 font-medium hover:brightness-95',
                            barColor[b.status] ?? 'bg-subtle text-muted',
                            b.id === highlight && 'z-10 ring-2 ring-focus ring-offset-1 ring-offset-surface',
                          )}
                          style={{ left: `${(left / length) * 100}%`, width: `calc(${((right - left) / length) * 100}% - 3px)`, top: 6 + (lane.get(b.id) ?? 0) * 32 }}
                        >
                          {b.guestName}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

const shade = (share: number) => (share === 0 ? 'text-faint' : share < 0.4 ? 'bg-brand-soft text-on-brand-soft' : share < 0.75 ? 'bg-accent/60 text-ink' : 'bg-brand text-on-brand');

/** A whole year at a glance: how full each day is. Picking a day opens its month. */
function YearView({ property, year, onPick }: { property: Property; year: number; onPick: (day: string) => void }) {
  const { t, locale } = useI18n();
  const q = useQuery({
    queryKey: ['calendar-year', property.id, year],
    queryFn: () => api.get<Year>('/reservations/calendar/year', { propertyId: property.id, year }),
    placeholderData: (p) => p,
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const { days, rooms } = q.data!;
  const monthName = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ro-RO', { month: 'long', timeZone: 'UTC' });
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {months.map((m) => {
          const inMonth = days.filter((d) => d.date.startsWith(m));
          const sold = inMonth.reduce((s, d) => s + d.sold, 0);
          const share = rooms ? Math.round((sold / (rooms * inMonth.length)) * 100) : 0;
          return (
            <Card key={m}>
              <div className="mb-3 flex items-baseline justify-between">
                <button className="font-semibold capitalize hover:text-accent" onClick={() => onPick(`${m}-01`)}>
                  {monthName.format(utc(`${m}-01`))}
                </button>
                <span className="text-xs text-muted">{share}%</span>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center text-[11px]">
                {Array.from({ length: (weekday(`${m}-01`) + 6) % 7 }, (_, i) => (
                  <span key={i} />
                ))}
                {inMonth.map((d) => (
                  <button
                    key={d.date}
                    title={`${date(d.date, locale)}: ${d.sold} / ${rooms}`}
                    onClick={() => onPick(d.date)}
                    className={clsx('aspect-square rounded-sm hover:ring-2 hover:ring-focus', shade(rooms ? d.sold / rooms : 0), d.date === property.businessDate && 'ring-2 ring-focus')}
                  >
                    {Number(d.date.slice(8))}
                  </button>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        {t('calendar.occupancy')}:
        {[
          ['bg-brand-soft', '< 40%'],
          ['bg-accent/60', '40–75%'],
          ['bg-brand', '> 75%'],
        ].map(([c, label]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className={clsx('h-3 w-3 rounded-sm', c)} /> {label}
          </span>
        ))}
      </p>
    </>
  );
}

function CalendarSearch({ property, onPick }: { property: Property; onPick: (r: Found) => void }) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState('');
  const term = q.trim();
  const results = useQuery({
    queryKey: ['calendar-search', property.id, term],
    queryFn: () => api.get<{ items: Found[] }>('/reservations', { propertyId: property.id, q: term, pageSize: 8 }),
    enabled: term.length >= 2,
  });
  return (
    <div className="relative min-w-56 flex-1">
      <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <Input className="pl-9" aria-label={t('calendar.search')} placeholder={t('calendar.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {term.length >= 2 && results.data && (
        <ul className="absolute z-30 mt-1 max-h-72 w-full min-w-72 overflow-auto rounded-lg border border-line bg-surface shadow-lg">
          {results.data.items.map((r) => (
            <li key={r.id}>
              <button
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-subtle"
                onClick={() => {
                  setQ('');
                  onPick(r);
                }}
              >
                <span>
                  <span className="font-medium">{r.guestName}</span>
                  <span className="block text-xs text-muted">
                    {date(r.arrival, locale)} – {date(r.departure, locale)}
                    {r.roomNumber && ` · ${r.roomNumber}`}
                  </span>
                </span>
                <Badge tone={statusTone[r.status]}>{t(`resStatus.${r.status}`)}</Badge>
              </button>
            </li>
          ))}
          {!results.data.items.length && <li className="px-3 py-2 text-sm text-muted">{t('calendar.noResults')}</li>}
        </ul>
      )}
    </div>
  );
}

function Calendar({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const home = addDays(property.businessDate, -1);
  const [view, setView] = useState<View>('fortnight');
  const [anchor, setAnchor] = useState(home);
  const [highlight, setHighlight] = useState<string | null>(null);

  const start = view === 'month' ? monthStart(anchor) : anchor;
  const year = Number(anchor.slice(0, 4));
  const length = view === 'week' ? 7 : view === 'fortnight' ? 14 : nightsBetween(start, addMonths(start, 1));
  const move = (dir: number) =>
    setAnchor(view === 'year' ? `${year + dir}-${anchor.slice(5)}` : view === 'month' ? addMonths(start, dir) : addDays(anchor, dir * 7));
  /** Shows a day in the current view; the year has no bars, so it opens the month instead. */
  const goTo = (day: string) => {
    if (view === 'year') setView('month');
    setAnchor(view === 'week' || view === 'fortnight' ? addDays(day, -1) : day);
  };
  const lang = locale === 'en' ? 'en-GB' : 'ro-RO';
  const period =
    view === 'year'
      ? String(year)
      : view === 'month'
        ? new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(start))
        : `${date(start, locale)} – ${date(addDays(start, length - 1), locale)}`;

  return (
    <>
      <PageHeader title={t('calendar.title')} eyebrow={property.name} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="[&>div]:mb-0">
          <Tabs
            value={view}
            onChange={(v) => {
              setView(v);
              setAnchor(v === 'week' || v === 'fortnight' ? (anchor.endsWith('-01') ? anchor : home) : anchor);
            }}
            items={[
              { value: 'week', label: t('calendar.week') },
              { value: 'fortnight', label: t('calendar.fortnight') },
              { value: 'month', label: t('calendar.month') },
              { value: 'year', label: t('calendar.year') },
            ]}
          />
        </div>
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => move(-1)} aria-label={t('common.previous')}>
            <ChevronLeft size={16} />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAnchor(home)}>
            {t('calendar.today')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => move(1)} aria-label={t('common.next')}>
            <ChevronRight size={16} />
          </Button>
        </div>
        <span className="text-sm font-medium capitalize">{period}</span>
        <div className="ml-auto flex flex-1 flex-wrap items-center justify-end gap-2">
          <div className="w-44">
            <Input type="date" aria-label={t('calendar.goToDate')} title={t('calendar.goToDate')} onChange={(e) => e.target.value && goTo(e.target.value)} />
          </div>
          <CalendarSearch
            property={property}
            onPick={(r) => {
              setHighlight(r.id);
              goTo(r.arrival);
            }}
          />
        </div>
      </div>
      {view === 'year' ? (
        <YearView
          property={property}
          year={year}
          onPick={(d) => {
            setView('month');
            setAnchor(d);
          }}
        />
      ) : (
        <Timeline property={property} start={start} length={length} highlight={highlight} />
      )}
    </>
  );
}

export default function CalendarPage() {
  return <PropertyGate perms={['reservations.read']}>{(p) => <Calendar key={p.id} property={p} />}</PropertyGate>;
}
