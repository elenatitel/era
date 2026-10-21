'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { weekday } from '@pms/shared';
import { HouseHome } from '@/components/house';
import { NightHome } from '@/components/night-home';
import { PropertyGate } from '@/components/property-gate';
import { CheckOutDialog } from '@/components/stay-dialogs';
import { Badge, Button, Card, ErrorText, Spinner, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
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

const METHOD_FILL = ['bg-brand', 'bg-accent', 'bg-line-strong', 'bg-subtle', 'bg-muted'];

function Insights({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const [checkOut, setCheckOut] = useState<StayRow | null>(null);
  const q = useQuery({ queryKey: ['dashboard', property.id], queryFn: () => api.get<Overview>('/dashboard', { propertyId: property.id }), refetchInterval: 60_000 });
  const desk = useQuery({
    queryKey: ['front-desk', property.id],
    queryFn: () => api.get<FrontDesk>('/front-desk', { propertyId: property.id }),
    enabled: can('reservations.read'),
    refetchInterval: 60_000,
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const d = q.data!;
  const m = (v: number) => money(v, d.currency, locale);
  const loc = locale === 'en' ? 'en-GB' : 'ro-RO';
  const weekdayShort = new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' });
  const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const peak = d.forecast.reduce((a, b) => (b.percent > a.percent ? b : a), d.forecast[0] ?? { date: d.businessDate, percent: 0, booked: 0 });
  const departures = desk.data?.departures ?? [];

  return (
    <div className="flex flex-col gap-5">
      <h2 className="sr-only">{t('house.insights')}</h2>
      <div className="flex flex-wrap gap-5">
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

      </div>

      {can('reservations.read') && (
        <div className="flex flex-wrap gap-6">
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

function Home({ property }: { property: Property }) {
  const { night } = useTheme();
  if (night) return <NightHome property={property} />;
  return (
    <div className="flex flex-col gap-5">
      <HouseHome property={property} />
      <Insights property={property} />
    </div>
  );
}

export default function DashboardPage() {
  return <PropertyGate perms={['property.read']}>{(p) => <Home property={p} />}</PropertyGate>;
}
