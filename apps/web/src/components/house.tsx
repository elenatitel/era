'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ChevronRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Emph } from '@/components/night-audit';
import { CheckInDialog } from '@/components/stay-dialogs';
import { Badge, Button, ErrorText, Spinner, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { House, HouseRoom, RoomState } from '@/lib/live-types';
import { useSession } from '@/lib/session';
import type { Property } from '@/lib/types';

const WINDOW: Record<RoomState, string> = {
  in_house: 'bg-lit text-on-lit',
  ready: 'bg-sun text-on-sun',
  dirty: 'border border-[#c9a47c] bg-warning-soft text-warning',
  free: 'bg-glass-dark text-white',
  out: 'border-[1.5px] border-dashed border-line-strong bg-[repeating-linear-gradient(135deg,var(--line)_0_2px,transparent_2px_8px)] text-muted',
};
const SWATCH: Record<RoomState, string> = {
  in_house: 'bg-lit',
  ready: 'bg-sun',
  dirty: 'border border-[#c9a47c] bg-warning-soft',
  free: 'bg-glass-dark',
  out: 'border-[1.5px] border-dashed border-line-strong',
};
const STATES: RoomState[] = ['in_house', 'ready', 'dirty', 'free', 'out'];

export function useHouse(propertyId: string) {
  return useQuery({
    queryKey: ['house', propertyId],
    queryFn: () => api.get<House>('/dashboard/house', { propertyId }),
    refetchInterval: 60_000,
  });
}

/** The home screen: the hotel drawn as a building, every window a room in its live state. */
export function HouseHome({ property }: { property: Property }) {
  const { t } = useI18n();
  const { can } = useSession();
  const q = useHouse(property.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkIn, setCheckIn] = useState<{ id: string; name: string } | null>(null);

  const floors = useMemo(() => {
    const map = new Map<string, HouseRoom[]>();
    for (const r of q.data?.rooms ?? []) map.set(r.floor, [...(map.get(r.floor) ?? []), r]);
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }));
  }, [q.data]);

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorText error={q.error} />;
  const h = q.data;
  const selected = h.rooms.find((r) => r.id === selectedId) ?? h.rooms.find((r) => r.arrival) ?? null;
  const arrivalsLeft = h.arrivals.length;

  return (
    <div className="flex flex-col gap-5">
      <section aria-label={t('house.insights')} className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <Stat highlight label={t('dashboard.occupancy')} value={`${h.counts.occupancy}%`} hint={`${t('house.occupiedTonight')} · ${h.counts.occupied}/${h.counts.sellable}`} />
        <Stat label={t('house.arrivalsLeft')} value={arrivalsLeft} hint={t('house.legend.ready').toLowerCase() + ` · ${h.counts.ready}`} />
        <Stat label={t('house.departuresLeft')} value={h.counts.departuresLeft} />
        <Stat label={t('house.guestsInHouse')} value={h.counts.guestsInHouse} />
        <Stat label={t('house.free')} value={h.counts.free} hint={`${t('house.legend.dirty').toLowerCase()} · ${h.counts.dirty}`} />
      </section>

      <div className="flex flex-wrap items-stretch gap-5">
        {/* The building */}
        <section aria-label={t('house.title', { property: property.name }).replace(/<\/?em>/g, '')} className="flex min-w-0 flex-[999_1_520px] flex-col items-center overflow-hidden rounded-[36px] bg-[#dce4ea] px-5 pt-6 sm:px-7 night:bg-[#161b26]">
          <div className="mb-5 flex w-full flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-[30px] leading-9 font-semibold tracking-[-0.02em] sm:text-[34px] sm:leading-10">
                <Emph text={t('house.title', { property: property.name })} />
              </h1>
              <p className="text-sm text-muted">{t('house.summary', { occupied: h.counts.occupied, ready: h.counts.ready, dirty: h.counts.dirty })}</p>
            </div>
          </div>
          <div aria-hidden className="h-5 w-[min(100%,720px)] rounded-t-[10px] rounded-b-[4px] bg-[#1b2438] night:bg-[#0b0e14]" />
          <div className="flex w-[min(calc(100%-32px),680px)] flex-col bg-[#f5f2eb] px-3 pt-2 sm:px-4 night:bg-[#222836]">
            {floors.map(([floor, list]) => (
              <div key={floor} className="flex items-center gap-2.5 border-b-[6px] border-[#d4cbbb] py-2.5 night:border-[#2c3343]">
                <span className="w-5 shrink-0 text-xs font-semibold text-muted" aria-label={t('house.floor', { n: floor })}>
                  {floor}
                </span>
                <div className="grid flex-1 gap-2 [grid-template-columns:repeat(auto-fill,minmax(68px,1fr))]">
                  {list.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      aria-pressed={selected?.id === r.id}
                      aria-label={`${r.number}, ${t(`house.states.${r.state}`)}`}
                      className={clsx(
                        'flex min-h-[76px] flex-col items-start justify-between rounded-[10px] px-2.5 py-2 text-left transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                        WINDOW[r.state],
                        selected?.id === r.id && 'outline-[3px] outline-offset-[3px] outline-[#1b2438] night:outline-sun',
                      )}
                    >
                      <span className="text-[15px] font-semibold tabular-nums">{r.number}</span>
                      <span className="text-[11px] leading-tight">{t(`house.states.${r.state}`)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex items-end gap-2.5 pt-3">
              <span className="w-5 shrink-0" />
              <div className="flex flex-1 flex-wrap items-center gap-2.5 rounded-t-[14px] bg-glass-dark px-3.5 py-3 text-white">
                <span className="text-sm font-semibold">{t('house.lobby')}</span>
                <span className="flex-1 text-xs text-[#d6dcea]">{arrivalsLeft ? t('house.lobbyText', { n: arrivalsLeft }) : t('house.lobbyEmpty')}</span>
                {h.arrivals[0] && (
                  <span className="rounded-full bg-sun px-3 py-1.5 text-xs font-semibold text-on-sun">
                    {h.arrivals[0].time} · {h.arrivals[0].guestName}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="-mx-7 flex w-[calc(100%+56px)] flex-wrap justify-center gap-x-4 gap-y-2 bg-[#d6cab4] px-7 pt-3.5 pb-4 text-xs text-[#3e3a33] night:bg-[#2a2f3b] night:text-[#d6dcea]">
            {STATES.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={clsx('h-3 w-3 rounded-[3px]', SWATCH[s])} />
                {t(`house.legend.${s}`)}
              </span>
            ))}
          </div>
        </section>

        {/* Selected room */}
        <aside className="flex min-w-0 flex-[1_1_250px] flex-col gap-5 min-[1380px]:-order-1">
          <RoomPanel room={selected} currency={h.currency} onCheckIn={(id, name) => setCheckIn({ id, name })} />
          <section className="flex flex-col gap-2.5 rounded-[28px] bg-surface p-5">
            <h2 className="text-base font-semibold">{t('house.onFloors')}</h2>
            {h.housekeeping.length === 0 && <p className="text-sm text-muted">{t('house.hkNone')}</p>}
            {h.housekeeping.map((c) => (
              <div key={c.name ?? '-'} className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning-soft text-xs font-semibold text-warning">
                  {(c.name ?? '?')
                    .split(' ')
                    .map((p) => p[0])
                    .slice(0, 2)
                    .join('')}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {c.name ?? t('house.unassigned')}
                  {c.floors.length > 0 && <span className="text-muted"> · {t('house.floors', { list: c.floors.join(', ') })}</span>}
                </span>
                <span className="text-xs text-muted">{c.open ? t('house.roomsLeft', { n: c.open }) : t('house.roomsDone')}</span>
              </div>
            ))}
          </section>
        </aside>

        {/* Coming in + what era. noticed */}
        <aside className="flex min-w-0 flex-[1_1_250px] flex-col gap-5">
          {can('reservations.read') && (
            <section className="flex flex-col rounded-[28px] bg-surface p-5">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-base font-semibold">{t('house.comingIn')}</h2>
                <span className="text-xs text-muted">{t('house.today', { n: arrivalsLeft })}</span>
              </div>
              {h.arrivals.length === 0 && <p className="text-sm text-muted">{t('house.noneComing')}</p>}
              {h.arrivals.slice(0, 6).map((a) => {
                const room = h.rooms.find((r) => r.arrival?.reservationId === a.reservationId);
                return (
                  <button
                    key={a.reservationId}
                    type="button"
                    onClick={() => room && setSelectedId(room.id)}
                    className="flex items-center gap-3 border-t border-line py-2.5 text-left first-of-type:border-t-0"
                  >
                    <span className="w-12 shrink-0 font-semibold tabular-nums">{a.time}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-semibold">{a.guestName}</span>
                      <span className="truncate text-xs text-muted">
                        {a.roomNumber ? `${a.roomNumber} · ${a.roomReady ? t('house.states.ready') : t('house.states.dirty')}` : t('day.noRoom')}
                      </span>
                    </span>
                    {a.onlineCheckin && (
                      <span className="grid h-7 w-7 place-items-center rounded-full bg-success-soft text-success" title={t('online.checkedInOnline')}>
                        <Check size={14} strokeWidth={3} aria-label={t('online.checkedInOnline')} />
                      </span>
                    )}
                  </button>
                );
              })}
              {h.arrivals.length > 6 && (
                <Link href="/front-desk" className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent">
                  {t('dashboard.openFrontDesk')} <ChevronRight size={15} aria-hidden />
                </Link>
              )}
            </section>
          )}
          {h.suggestions[0] && <Noticed house={h} propertyId={property.id} />}
        </aside>
      </div>
      {checkIn && <CheckInDialog reservationId={checkIn.id} title={`${t('frontDesk.checkIn')} · ${checkIn.name}`} onClose={() => setCheckIn(null)} />}
    </div>
  );
}

function RoomPanel({ room, currency, onCheckIn }: { room: HouseRoom | null; currency: string; onCheckIn: (id: string, name: string) => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  if (!room) return <section className="rounded-[28px] bg-surface p-5 text-sm text-muted">{t('house.pick')}</section>;
  const guest = room.stay?.guestName ?? room.arrival?.guestName;
  const reservationId = room.stay?.reservationId ?? room.arrival?.reservationId;
  return (
    <section className="flex flex-col gap-4 rounded-[28px] bg-surface p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{t('house.selected', { floor: room.floor })}</span>
        <span className={clsx('rounded-full px-3 py-1.5 text-xs font-semibold', WINDOW[room.state])}>{t(`house.states.${room.state}`)}</span>
      </div>
      <div>
        <h2 className="text-[44px] leading-[44px] font-medium tracking-[-0.03em] tabular-nums">{room.number}</h2>
        <span className="text-sm text-muted">{room.roomType}</span>
      </div>
      {guest ? (
        <div className="flex items-center gap-3 rounded-[20px] bg-subtle p-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-line font-semibold">
            {guest
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold">{guest}</span>
            <span className="text-xs text-muted">
              {room.stay
                ? room.stay.departsToday
                  ? t('house.leavesToday')
                  : t('house.stayingUntil', { date: date(room.stay.departure, locale) })
                : t('house.arrivesAt', { time: room.arrival!.time })}
            </span>
          </span>
        </div>
      ) : (
        <p className="rounded-[20px] bg-subtle p-3 text-sm text-muted">{room.state === 'free' ? t('house.freeTonight') : t('house.noGuest')}</p>
      )}
      {room.stay && room.stay.balance !== null && (
        <div className="rounded-[18px] border border-line p-3">
          <span className="text-xs text-muted">{t('house.balance')}</span>
          <div className={clsx('text-xl font-semibold tabular-nums', room.stay.balance > 0 ? 'text-warning' : 'text-success')}>
            {room.stay.balance > 0 ? money(room.stay.balance, currency, locale) : t('house.settled')}
          </div>
        </div>
      )}
      {room.arrival?.onlineCheckin && (
        <Badge tone="green" dot>
          {t('online.checkedInOnline')}
        </Badge>
      )}
      {reservationId && (
        <div className="flex flex-col gap-2">
          {room.arrival && room.state === 'ready' && can('frontdesk.checkin') && (
            <Button onClick={() => onCheckIn(room.arrival!.reservationId, guest ?? room.number)}>
              {t('house.checkIn')}
            </Button>
          )}
          <Link href={`/reservations/${reservationId}`} className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-subtle">
            {t('house.open')}
          </Link>
        </div>
      )}
    </section>
  );
}

/** The first arrival without a room, with era.'s pick of a free room of the booked type. */
function Noticed({ house, propertyId }: { house: House; propertyId: string }) {
  const { t } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const s = house.suggestions[0]!;
  const assign = useMutation({
    mutationFn: () => api.patch(`/reservations/${s.reservationId}`, { roomId: s.roomId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['house', propertyId] });
      void qc.invalidateQueries({ queryKey: ['front-desk'] });
    },
  });
  return (
    <section className="flex flex-col gap-3 rounded-[28px] bg-[#1b2438] p-5 text-white night:bg-[#262c3a]">
      <span className="inline-flex items-center gap-1.5 text-xs text-[#d6dcea]">
        <Sparkles size={14} aria-hidden /> {t('house.noticed')}
      </span>
      <p className="text-[17px] leading-6">
        {t('house.suggestion', { guest: s.guestName ?? '—', time: s.time, room: s.number })} {s.ready ? t('house.suggestionReady') : t('house.suggestionDirty')}
      </p>
      <ErrorText error={assign.error} />
      {assign.isSuccess ? (
        <span className="text-sm text-sun">{t('house.assigned', { room: s.number })}</span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {can('reservations.update') && (
            <button
              type="button"
              disabled={assign.isPending}
              onClick={() => assign.mutate()}
              className="min-h-11 flex-1 rounded-full bg-sun px-4 text-sm font-semibold text-on-sun disabled:opacity-60"
            >
              {t('house.assign', { room: s.number })}
            </button>
          )}
          <Link href={`/reservations/${s.reservationId}`} className="inline-flex min-h-11 items-center rounded-full border border-white/30 px-4 text-sm">
            {t('house.open')}
          </Link>
        </div>
      )}
    </section>
  );
}
