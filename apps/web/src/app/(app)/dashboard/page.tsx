'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { weekday } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { CheckInDialog, CheckOutDialog } from '@/components/stay-dialogs';
import { Alert, Badge, Button, ButtonLink, Card, ErrorText, Spinner, Stat, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Property } from '@/lib/types';

interface Overview {
  businessDate: string;
  currency: string;
  rooms: { total: number; sellable: number; byStatus: Record<string, number> };
  occupancy: { inHouse: number; percent: number };
  arrivals: { expected: number; arrived: number };
  departures: { expected: number; departed: number };
  forecast: { date: string; booked: number; percent: number }[];
  attention: { roomsNotReady: { number: string; status: string }[] };
  housekeeping: { total: number; done: number; inProgress: number; unassigned: number };
  financial: {
    revenueToday: number;
    revenueMonth: number;
    adr: number;
    revpar: number;
    openBalance: number;
    paymentsToday: { total: number; byMethod: { method: string; total: number }[] };
  } | null;
}

interface StayRow {
  id: string;
  code: string;
  status: string;
  guestName: string;
  guestSegment?: string;
  roomNumber: string | null;
  roomStatus?: string | null;
  roomTypeCode?: string;
  balance?: number | null;
  onlineCheckinAt?: string | null;
}
interface FrontDesk {
  arrivals: StayRow[];
  departures: StayRow[];
}

const ROOM_ORDER = ['clean', 'inspected', 'dirty', 'out_of_order'] as const;
const SEGMENT_FILL: Record<string, string> = { clean: 'bg-success', inspected: 'bg-info', dirty: 'bg-warning', out_of_order: 'bg-danger' };
const METHOD_FILL = ['bg-brand', 'bg-accent', 'bg-line-strong', 'bg-subtle', 'bg-muted'];

function greetingKey() {
  const h = new Date().getHours();
  return h < 12 ? 'dashboard.greetingMorning' : h < 18 ? 'dashboard.greetingAfternoon' : 'dashboard.greetingEvening';
}

function Dashboard({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [checkIn, setCheckIn] = useState<StayRow | null>(null);
  const [checkOut, setCheckOut] = useState<StayRow | null>(null);
  const q = useQuery({ queryKey: ['dashboard', property.id], queryFn: () => api.get<Overview>('/dashboard', { propertyId: property.id }), refetchInterval: 60_000 });
  const desk = useQuery({
    queryKey: ['front-desk', property.id],
    queryFn: () => api.get<FrontDesk>('/front-desk', { propertyId: property.id }),
    enabled: can('reservations.read'),
    refetchInterval: 60_000,
  });
  const audit = useMutation({
    mutationFn: () => api.post<{ newBusinessDate: string }>(`/properties/${property.id}/night-audit`),
    onSuccess: (r) => {
      setNotice(t('dashboard.nightAuditDone', { date: date(r.newBusinessDate, locale) }));
      void qc.invalidateQueries();
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const d = q.data!;
  const m = (v: number) => money(v, d.currency, locale);
  const loc = locale === 'en' ? 'en-GB' : 'ro-RO';
  const weekdayLong = new Intl.DateTimeFormat(loc, { weekday: 'long', timeZone: 'UTC' });
  const weekdayShort = new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' });
  const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const firstName = me.user.name.split(' ')[0] ?? me.user.name;
  const peak = d.forecast.reduce((a, b) => (b.percent > a.percent ? b : a), d.forecast[0] ?? { date: d.businessDate, percent: 0, booked: 0 });
  const roomsTotal = ROOM_ORDER.reduce((s, k) => s + (d.rooms.byStatus[k] ?? 0), 0);
  const hkPct = d.housekeeping.total ? Math.round((d.housekeeping.done / d.housekeeping.total) * 100) : 0;
  const arrivals = desk.data?.arrivals ?? [];
  const departures = desk.data?.departures ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">
            {weekdayLong.format(asDate(d.businessDate))} · {t('dashboard.businessDate').toLowerCase()} {date(d.businessDate, locale)}
          </span>
          <h1 className="text-[28px] leading-9 font-semibold tracking-tight">{t(greetingKey(), { name: firstName })}</h1>
          <p className="text-sm text-muted">
            {t('dashboard.summary', { property: property.name, arrivals: d.arrivals.expected, departures: d.departures.expected, inHouse: d.occupancy.inHouse })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('property.manage') && (
            <Button
              variant="secondary"
              loading={audit.isPending}
              onClick={() => confirm(t('dashboard.nightAuditConfirm', { date: date(d.businessDate, locale) })) && audit.mutate()}
            >
              {t('dashboard.nightAudit')}
            </Button>
          )}
          {can('reservations.create') && <ButtonLink href="/reservations/new">{t('reservations.new')}</ButtonLink>}
        </div>
      </div>

      {notice && <Alert tone="green">{notice}</Alert>}
      <ErrorText error={audit.error} />
      {d.attention.roomsNotReady.length > 0 && (
        <Alert tone="amber">{t('dashboard.notReady', { rooms: d.attention.roomsNotReady.map((r) => r.number).join(', ') })}</Alert>
      )}

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
        <Stat label={t('dashboard.occupancy')} value={`${d.occupancy.percent}%`} hint={t('dashboard.roomsOf', { n: d.occupancy.inHouse, total: d.rooms.sellable })} />
        <Stat
          label={t('dashboard.arrivals')}
          value={`${d.arrivals.arrived} / ${d.arrivals.expected}`}
          hint={t('dashboard.waitingCheckIn', { n: Math.max(0, d.arrivals.expected - d.arrivals.arrived) })}
        />
        <Stat
          label={t('dashboard.departures')}
          value={`${d.departures.departed} / ${d.departures.expected}`}
          hint={t('dashboard.stillToLeave', { n: Math.max(0, d.departures.expected - d.departures.departed) })}
        />
        {d.financial ? (
          <Stat label={t('dashboard.revenueToday')} value={m(d.financial.revenueToday)} hint={`${t('dashboard.revenueMonth')}: ${m(d.financial.revenueMonth)}`} />
        ) : (
          <Stat label={t('dashboard.inHouse')} value={d.occupancy.inHouse} />
        )}
      </div>

      <div className="flex flex-wrap gap-6">
        <Card
          className="min-w-0 flex-[2_1_560px]"
          title={t('dashboard.forecastTitle')}
          actions={
            peak && (
              <span className="text-xs text-muted">
                {t('dashboard.forecastPeak', { pct: peak.percent, date: `${weekdayShort.format(asDate(peak.date))} ${peak.date.slice(8)}` })}
              </span>
            )
          }
        >
          <div
            role="img"
            aria-label={d.forecast.map((f) => `${f.date}: ${f.percent}%`).join(', ')}
            className="grid h-56 grid-cols-7 gap-2 sm:grid-cols-[repeat(14,minmax(0,1fr))]"
          >
            {d.forecast.map((f, i) => {
              const today = f.date === d.businessDate;
              const weekend = [5, 6].includes(weekday(f.date));
              return (
                <div key={f.date} className={clsx('min-w-0 flex-col gap-1.5', i >= 7 ? 'hidden sm:flex' : 'flex', weekend && '-mx-0.5 -my-1 rounded-lg bg-subtle px-0.5 py-1')}>
                  <span className={clsx('text-center text-[11px] leading-[14px] tabular-nums', today ? 'font-semibold text-ink' : 'text-muted')}>{f.percent}%</span>
                  <div className={clsx('relative flex-1 rounded-md', weekend ? 'bg-surface' : 'bg-subtle')}>
                    <div
                      className={clsx('absolute inset-x-0 bottom-0 rounded-md', today ? 'bg-brand' : 'bg-accent opacity-85')}
                      style={{ height: `${Math.max(2, Math.min(100, f.percent))}%` }}
                    />
                  </div>
                  <span className="text-center text-[11px] leading-[14px] text-muted capitalize">{weekdayShort.format(asDate(f.date)).replace('.', '')}</span>
                  <span className="text-center text-xs font-semibold tabular-nums">{f.date.slice(8)}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card
          className="min-w-0 flex-[1_1_300px]"
          title={t('dashboard.roomStatus')}
          actions={
            can('housekeeping.read') && (
              <Link href="/housekeeping" className="text-xs text-accent hover:underline">
                {t('dashboard.openHousekeeping')}
              </Link>
            )
          }
        >
          <div className="flex flex-col gap-5">
            <div aria-hidden className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-subtle">
              {ROOM_ORDER.filter((k) => (d.rooms.byStatus[k] ?? 0) > 0).map((k) => (
                <span key={k} className={SEGMENT_FILL[k]} style={{ flex: `${d.rooms.byStatus[k]} 1 0` }} />
              ))}
            </div>
            <ul className="flex flex-col gap-2.5">
              {ROOM_ORDER.map((k) => (
                <li key={k} className="flex items-center justify-between">
                  <Badge tone={statusTone[k]} dot>
                    {t(`roomStatus.${k}`)}
                  </Badge>
                  <span className="font-semibold tabular-nums">
                    {d.rooms.byStatus[k] ?? 0}
                    <span className="ml-1 text-xs font-normal text-muted">/ {roomsTotal}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <div className="flex justify-between text-sm">
                <span>{t('dashboard.hkTasks')}</span>
                <strong className="tabular-nums">
                  {d.housekeeping.done} / {d.housekeeping.total}
                </strong>
              </div>
              <div aria-hidden className="h-2 overflow-hidden rounded-full bg-subtle">
                <div className="h-full rounded-full bg-brand" style={{ width: `${hkPct}%` }} />
              </div>
              <span className="text-xs text-muted">{t('dashboard.hkDetail', { inProgress: d.housekeeping.inProgress, unassigned: d.housekeeping.unassigned })}</span>
            </div>
          </div>
        </Card>
      </div>

      {can('reservations.read') && (
        <div className="flex flex-wrap gap-6">
          <Card
            className="min-w-0 flex-[1_1_480px]"
            padded={false}
            title={t('dashboard.arrivalsToday', { n: arrivals.length })}
            actions={
              <Link href="/front-desk" className="text-xs text-accent hover:underline">
                {t('dashboard.openFrontDesk')}
              </Link>
            }
          >
            <StayTable
              rows={arrivals}
              head={[t('reservations.guest'), t('reservations.roomType'), t('reservations.room'), '']}
              cells={(r) => [
                <span key="t">{r.roomTypeCode}</span>,
                <span key="r" className="flex items-center gap-2">
                  <span className="font-semibold">{r.roomNumber ?? '—'}</span>
                  {r.roomNumber &&
                    (r.status === 'checked_in' ? (
                      <Badge tone="gray">{t('dashboard.occupiedRoom')}</Badge>
                    ) : (
                      r.roomStatus && <Badge tone={statusTone[r.roomStatus]}>{t(`roomStatus.${r.roomStatus}`)}</Badge>
                    ))}
                </span>,
                r.status === 'checked_in' ? (
                  <Badge key="a" tone="green" dot>
                    {t('dashboard.checkedIn')}
                  </Badge>
                ) : can('frontdesk.checkin') ? (
                  <Button key="a" size="sm" onClick={() => setCheckIn(r)}>
                    {t('frontDesk.checkIn')}
                  </Button>
                ) : null,
              ]}
            />
          </Card>
          <Card
            className="min-w-0 flex-[1_1_400px]"
            padded={false}
            title={t('dashboard.departuresToday', { n: departures.length })}
            actions={
              <Link href="/front-desk" className="text-xs text-accent hover:underline">
                {t('dashboard.openFrontDesk')}
              </Link>
            }
          >
            <StayTable
              rows={departures}
              head={[t('reservations.guest'), t('reservations.room'), ...(can('folio.read') ? [t('reservations.balance')] : []), '']}
              cells={(r) => [
                <span key="r" className="font-semibold">
                  {r.roomNumber ?? '—'}
                </span>,
                ...(can('folio.read')
                  ? [
                      <span key="b" className={clsx('block text-right tabular-nums', (r.balance ?? 0) > 0 ? 'font-semibold text-warning' : 'text-muted')}>
                        {m(r.balance ?? 0)}
                      </span>,
                    ]
                  : []),
                r.status === 'checked_out' ? (
                  <Badge key="a" tone="gray">
                    {t('dashboard.departed')}
                  </Badge>
                ) : can('frontdesk.checkout') ? (
                  <Button key="a" size="sm" variant="secondary" onClick={() => setCheckOut(r)}>
                    {t('frontDesk.checkOut')}
                  </Button>
                ) : null,
              ]}
            />
          </Card>
        </div>
      )}

      {d.financial && (
        <Card
          title={t('dashboard.financeTitle')}
          actions={
            can('reports.read') && (
              <Link href="/payments" className="text-xs text-accent hover:underline">
                {t('dashboard.paymentsReport')}
              </Link>
            )
          }
        >
          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <Figure label={t('dashboard.adrLong')} value={m(d.financial.adr)} />
            <Figure label={t('dashboard.revparLong')} value={m(d.financial.revpar)} />
            <Figure label={t('dashboard.openBalanceLong')} value={m(d.financial.openBalance)} warn={d.financial.openBalance > 0} />
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted">{t('dashboard.paymentsToday')}</span>
                <strong className="tabular-nums">{m(d.financial.paymentsToday.total)}</strong>
              </div>
              {d.financial.paymentsToday.total > 0 ? (
                <>
                  <div aria-hidden className="flex h-2 gap-0.5 overflow-hidden rounded-full">
                    {d.financial.paymentsToday.byMethod
                      .filter((p) => p.total > 0)
                      .map((p, i) => (
                        <span key={p.method} className={METHOD_FILL[i % METHOD_FILL.length]} style={{ flex: `${p.total} 1 0` }} />
                      ))}
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-muted">
                    {d.financial.paymentsToday.byMethod.map((p) => (
                      <span key={p.method}>
                        {t(`methods.${p.method}`)} {m(p.total)}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <span className="text-xs text-muted">{t('dashboard.noPayments')}</span>
              )}
            </div>
          </div>
        </Card>
      )}

      {checkIn && <CheckInDialog reservationId={checkIn.id} title={`${t('frontDesk.checkIn')} · ${checkIn.guestName}`} onClose={() => setCheckIn(null)} />}
      {checkOut && <CheckOutDialog reservationId={checkOut.id} title={`${t('frontDesk.checkOut')} · ${checkOut.guestName}`} onClose={() => setCheckOut(null)} />}
    </div>
  );
}

function Figure({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <span className={clsx('text-[22px] leading-7 font-semibold tabular-nums', warn && 'text-warning')}>{value}</span>
    </div>
  );
}

function StayTable({ rows, head, cells }: { rows: StayRow[]; head: string[]; cells: (r: StayRow) => React.ReactNode[] }) {
  const { t } = useI18n();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] leading-4 font-semibold tracking-[0.08em] text-muted uppercase">
            {head.map((h, i) => (
              <th key={i} className={clsx('px-4 py-2.5 whitespace-nowrap', i === head.length - 1 && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const c = cells(r);
            return (
              <tr key={r.id} className="hover:bg-subtle">
                <td className="px-4 py-2.5">
                  <Link href={`/reservations/${r.id}`} className="flex flex-col hover:text-accent">
                    <span className="font-medium">
                      {r.guestName}
                      {r.guestSegment && r.guestSegment !== 'standard' && (
                        <span className="ml-2 align-middle">
                          <Badge tone={statusTone[r.guestSegment]}>{t(`segments.${r.guestSegment}`)}</Badge>
                        </span>
                      )}
                    </span>
                    <span className="code">{r.code}</span>
                    {r.onlineCheckinAt && r.status !== 'checked_in' && r.status !== 'checked_out' && (
                      <span className="mt-1">
                        <Badge tone="green" dot>
                          {t('online.checkedInOnline')}
                        </Badge>
                      </span>
                    )}
                  </Link>
                </td>
                {c.map((cell, i) => (
                  <td key={i} className={clsx('px-4 py-2.5', i === c.length - 1 && 'text-right')}>
                    {cell}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="px-4 py-10 text-center font-display text-xl text-muted italic">{t('common.none')}</p>}
    </div>
  );
}

export default function DashboardPage() {
  return <PropertyGate perms={['property.read']}>{(p) => <Dashboard property={p} />}</PropertyGate>;
}
