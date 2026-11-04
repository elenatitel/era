'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { addDays, nightsBetween, weekday } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { MoveStayDialog, type StayMove } from '@/components/stay-dialogs';
import { StayPanel } from '@/components/stay-panel';
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
  guestPhone: string | null;
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

type Booking = Cal['reservations'][number];
type Row = { key: string; label: string; roomId: string | null; roomTypeId: string; muted?: boolean };
interface Drag {
  booking: Booking;
  /** Which part is held: the whole stay, or one of its ends. */
  part: 'move' | 'start' | 'end';
  fromX: number;
  dayWidth: number;
  days: number;
  rowKey: string;
  x: number;
  y: number;
  moved: boolean;
}

/** Unassigned stays share a row, so overlapping ones go on separate lines. */
function stack(bookings: Booking[]) {
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

function Timeline({ property, start, length, selected, scrollTo, onSelect }: { property: Property; start: string; length: number; selected: string | null; scrollTo: string | null; onSelect: (id: string) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pendingMove, setPendingMove] = useState<StayMove | null>(null);
  // A drag ends in a click on the bar, which must not also open the stay.
  const justDragged = useRef(false);
  const end = addDays(start, length);
  const q = useQuery({
    queryKey: ['calendar', property.id, start, length],
    queryFn: () => api.get<Cal>('/reservations/calendar', { propertyId: property.id, from: start, to: end }),
    placeholderData: (p) => p,
  });
  // Waits for this period's bars: while it loads, the previous period is still on screen.
  const ready = Boolean(q.data) && !q.isPlaceholderData;
  useEffect(() => {
    if (scrollTo && ready) document.querySelector('[data-selected]')?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }, [scrollTo, ready]);
  useEffect(() => {
    if (!drag) return;
    const cancel = (e: KeyboardEvent) => e.key === 'Escape' && setDrag(null);
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [drag]);
  const days = Array.from({ length }, (_, i) => addDays(start, i));
  const dense = length > 14;
  const lang = locale === 'en' ? 'en-GB' : 'ro-RO';
  const dayName = new Intl.DateTimeFormat(lang, { weekday: dense ? 'narrow' : 'short', timeZone: 'UTC' });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const types = [...new Map(q.data!.rooms.map((r) => [r.roomTypeId, r.roomTypeCode])).entries()];
  const rows: Row[] = [];
  for (const [typeId, code] of types) {
    for (const r of q.data!.rooms.filter((x) => x.roomTypeId === typeId)) rows.push({ key: r.id, label: r.number, roomId: r.id, roomTypeId: typeId });
    if (q.data!.reservations.some((r) => !r.roomId && r.roomTypeId === typeId))
      rows.push({ key: `u-${typeId}`, label: `${code} · ${t('calendar.unassigned')}`, roomId: null, roomTypeId: typeId, muted: true });
  }

  const movable = can('reservations.update');
  const inHouse = (b: Booking) => b.status === 'checked_in';
  const canDrag = (b: Booking) => movable && ['tentative', 'confirmed', 'checked_in'].includes(b.status);

  const box = (arrival: string, departure: string) => {
    const from = Math.max(0, nightsBetween(start, arrival));
    const to = Math.min(length, nightsBetween(start, departure));
    if (to <= 0 || from >= length) return null;
    // Stays run from mid-day of arrival to mid-day of departure.
    const left = from + (arrival >= start ? 0.5 : 0);
    const right = Math.min(length, to + (departure <= end ? 0.5 : 0));
    return { left: `${(left / length) * 100}%`, width: `calc(${((right - left) / length) * 100}% - 3px)` };
  };

  /** Where the held stay would land now, and why it could not, checked against what is on screen. */
  const landing = (d: Drag) => {
    const { booking: b, part, days: n } = d;
    const arrival = part === 'end' ? b.arrival : addDays(b.arrival, n);
    const departure = part === 'start' ? b.departure : addDays(b.departure, n);
    const row = rows.find((r) => r.key === d.rowKey)!;
    const taken = row.roomId && q.data!.reservations.some((r) => r.id !== b.id && r.roomId === row.roomId && r.arrival < departure && r.departure > arrival);
    const room = q.data!.rooms.find((r) => r.id === row.roomId);
    const problem =
      row.roomTypeId !== b.roomTypeId
        ? 'calendar.dropOtherType'
        : room?.status === 'out_of_order'
          ? 'calendar.dropOutOfOrder'
          : (inHouse(b) ? departure <= property.businessDate : arrival < property.businessDate)
            ? 'calendar.dropPast'
            : taken
              ? 'calendar.dropTaken'
              : null;
    return { arrival, departure, row, problem };
  };

  const grab = (e: ReactPointerEvent<HTMLAnchorElement>, b: Booking, rowKey: string) => {
    justDragged.current = false;
    if (e.button !== 0 || e.pointerType === 'touch' || e.metaKey || e.ctrlKey || e.shiftKey || !canDrag(b)) return;
    const part = ((e.target as HTMLElement).dataset.edge ?? 'move') as Drag['part'];
    if (inHouse(b) && part !== 'end') return;
    const track = e.currentTarget.closest<HTMLElement>('[data-row]')!;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ booking: b, part, fromX: e.clientX, dayWidth: track.offsetWidth / length, days: 0, rowKey, x: e.clientX, y: e.clientY, moved: false });
  };

  const follow = (e: ReactPointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.fromX;
    if (!drag.moved && Math.abs(dx) < 5 && Math.abs(e.clientY - drag.y) < 5) return;
    const nights = nightsBetween(drag.booking.arrival, drag.booking.departure);
    const n = Math.round(dx / drag.dayWidth);
    const over = drag.part === 'move' ? document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-row]')?.dataset.row : undefined;
    setDrag({
      ...drag,
      moved: true,
      // Pulling an end never leaves a stay with less than one night.
      days: drag.part === 'start' ? Math.min(n, nights - 1) : drag.part === 'end' ? Math.max(n, 1 - nights) : n,
      rowKey: over ?? drag.rowKey,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const release = () => {
    if (!drag) return;
    setDrag(null);
    if (!drag.moved) return;
    justDragged.current = true;
    const { arrival, departure, row, problem } = landing(drag);
    const b = drag.booking;
    const roomChanged = row.roomId !== b.roomId;
    if (problem || (arrival === b.arrival && departure === b.departure && !roomChanged)) return;
    setPendingMove({
      id: b.id,
      guestName: b.guestName,
      ...(arrival !== b.arrival && { arrival }),
      ...(departure !== b.departure && { departure }),
      ...(roomChanged && { roomId: row.roomId }),
    } as StayMove);
  };

  const held = drag?.moved ? { ...landing(drag), drag } : null;

  return (
    <>
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
                  <div data-row={row.key} className="relative border-b border-line" style={{ gridColumn: `2 / span ${length}` }}>
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
                        const position = box(b.arrival, b.departure);
                        if (!position) return null;
                        return (
                          <Link
                            key={b.id}
                            href={`/reservations/${b.id}`}
                            draggable={false}
                            data-selected={b.id === selected ? '' : undefined}
                            onPointerDown={(e) => grab(e, b, row.key)}
                            onPointerMove={follow}
                            onPointerUp={release}
                            onPointerCancel={() => setDrag(null)}
                            onClick={(e) => {
                              if (justDragged.current) return e.preventDefault();
                              // Ctrl/Cmd+click still opens the full reservation in a new tab.
                              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                              e.preventDefault();
                              onSelect(b.id);
                            }}
                            title={`${b.guestName} · ${b.code} · ${date(b.arrival, locale)} – ${date(b.departure, locale)}`}
                            className={clsx(
                              'pointer-events-auto absolute truncate rounded-sm px-2 text-xs leading-7 font-medium select-none hover:brightness-95',
                              canDrag(b) && !inHouse(b) && 'cursor-grab active:cursor-grabbing',
                              held?.drag.booking.id === b.id && 'opacity-40',
                              b.id === selected ? 'z-10 bg-orange-500 text-white shadow-md ring-2 ring-orange-300' : (barColor[b.status] ?? 'bg-subtle text-muted'),
                            )}
                            style={{ ...position, top: 6 + (lane.get(b.id) ?? 0) * 32 }}
                          >
                            {canDrag(b) && !inHouse(b) && b.arrival >= start && <span data-edge="start" className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />}
                            {b.guestName}
                            {canDrag(b) && b.departure <= end && <span data-edge="end" className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />}
                          </Link>
                        );
                      })}
                      {held?.row.key === row.key && box(held.arrival, held.departure) && (
                        <div
                          className={clsx('absolute z-10 h-7 rounded-sm border-2 border-dashed', held.problem ? 'border-danger bg-danger-soft' : 'border-orange-500 bg-orange-500/20')}
                          style={{ ...box(held.arrival, held.departure), top: 6 }}
                        />
                      )}
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </Card>
      {movable && <p className="mt-2 text-xs text-muted">{t('calendar.dragHint')}</p>}
      {held && (
        <div
          className={clsx('pointer-events-none fixed z-50 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap shadow-md', held.problem ? 'bg-danger text-on-danger' : 'bg-ink text-surface')}
          style={{ left: held.drag.x + 14, top: held.drag.y + 16 }}
        >
          {held.problem
            ? t(held.problem)
            : `${date(held.arrival, locale)} – ${date(held.departure, locale)} · ${nightsBetween(held.arrival, held.departure)} ${t('calendar.nights')} · ${held.row.label}`}
        </div>
      )}
      {pendingMove && (
        <MoveStayDialog
          key={pendingMove.id}
          move={pendingMove}
          onClose={() => setPendingMove(null)}
          onMoved={() => {
            onSelect(pendingMove.id);
            return Promise.all(['calendar', 'calendar-year', 'reservation'].map((key) => qc.invalidateQueries({ queryKey: [key] })));
          }}
        />
      )}
    </>
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
  const pick = (r: Found) => {
    setQ('');
    onPick(r);
  };
  return (
    <div className="relative min-w-56 flex-1">
      <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <Input
        className="pl-9"
        aria-label={t('calendar.search')}
        placeholder={t('calendar.search')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setQ('');
          const first = results.data?.items[0];
          if (e.key === 'Enter' && term.length >= 2 && first) pick(first);
        }}
      />
      {term.length >= 2 && results.data && (
        <ul className="absolute right-0 z-30 mt-1 max-h-72 w-full min-w-80 overflow-auto rounded-lg border border-line bg-surface shadow-lg">
          {results.data.items.map((r) => (
            <li key={r.id}>
              <button
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-subtle"
                onClick={() => pick(r)}
              >
                <span>
                  <span className="font-medium">{r.guestName}</span>
                  <span className="block text-xs text-muted">
                    {date(r.arrival, locale)} – {date(r.departure, locale)}
                    {r.roomNumber && ` · ${r.roomNumber}`}
                    {r.guestPhone && ` · ${r.guestPhone}`}
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
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);

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
              setSelected(r.id);
              setScrollTo(r.id);
              goTo(r.arrival);
            }}
          />
        </div>
      </div>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
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
            <Timeline property={property} start={start} length={length} selected={selected} scrollTo={scrollTo} onSelect={setSelected} />
          )}
        </div>
        {selected && <StayPanel key={selected} reservationId={selected} onClose={() => setSelected(null)} />}
      </div>
    </>
  );
}

export default function CalendarPage() {
  return <PropertyGate perms={['reservations.read']}>{(p) => <Calendar key={p.id} property={p} />}</PropertyGate>;
}
