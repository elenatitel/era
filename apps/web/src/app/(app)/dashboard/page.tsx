'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, LogIn, LogOut, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import { PropertyGate } from '@/components/property-gate';
import { Alert, Badge, Button, Card, ErrorText, PageHeader, Spinner, Stat, statusTone } from '@/components/ui';
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
  financial: { revenueToday: number; revenueMonth: number; adr: number; revpar: number; openBalance: number } | null;
}

function Dashboard({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['dashboard', property.id], queryFn: () => api.get<Overview>('/dashboard', { propertyId: property.id }), refetchInterval: 60_000 });
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

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={
          <>
            {property.name} · {t('dashboard.businessDate')}: <strong>{date(d.businessDate, locale)}</strong>
          </>
        }
        actions={
          can('property.manage') && (
            <Button
              variant="secondary"
              loading={audit.isPending}
              onClick={() => confirm(t('dashboard.nightAuditConfirm', { date: date(d.businessDate, locale) })) && audit.mutate()}
            >
              {t('dashboard.nightAudit')}
            </Button>
          )
        }
      />
      {notice && (
        <div className="mb-4">
          <Alert tone="green">{notice}</Alert>
        </div>
      )}
      <ErrorText error={audit.error} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t('dashboard.occupancy')} value={`${d.occupancy.percent}%`} hint={`${d.occupancy.inHouse} / ${d.rooms.sellable}`} icon={<BedDouble size={18} />} />
        <Stat label={t('dashboard.arrivals')} value={`${d.arrivals.arrived} / ${d.arrivals.expected}`} icon={<LogIn size={18} />} />
        <Stat label={t('dashboard.departures')} value={`${d.departures.departed} / ${d.departures.expected}`} icon={<LogOut size={18} />} />
        {d.financial ? (
          <Stat label={t('dashboard.revenueToday')} value={m(d.financial.revenueToday)} hint={`${t('dashboard.revenueMonth')}: ${m(d.financial.revenueMonth)}`} icon={<Wallet size={18} />} />
        ) : (
          <Stat label={t('dashboard.inHouse')} value={d.occupancy.inHouse} icon={<TrendingUp size={18} />} />
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title={t('dashboard.forecast')} className="lg:col-span-2">
          <div className="flex h-48 gap-1.5">
            {d.forecast.map((f) => (
              <div key={f.date} className="flex flex-1 flex-col items-center gap-1" title={`${date(f.date, locale)}: ${f.booked} (${f.percent}%)`}>
                <span className="text-[10px] text-muted">{f.percent}%</span>
                <div className="relative w-full flex-1 rounded-md bg-subtle">
                  <div className="absolute inset-x-0 bottom-0 rounded-md bg-brand-500" style={{ height: `${Math.max(2, Math.min(100, f.percent))}%` }} />
                </div>
                <span className="text-[10px] text-faint">{f.date.slice(8)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title={t('dashboard.roomStatus')}>
          <ul className="space-y-3">
            {Object.entries(d.rooms.byStatus).map(([s, n]) => (
              <li key={s} className="flex items-center justify-between text-sm">
                <Badge tone={statusTone[s]}>{t(`roomStatus.${s}`)}</Badge>
                <span className="font-semibold">{n}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {d.financial && (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Stat label={t('dashboard.adr')} value={m(d.financial.adr)} />
          <Stat label={t('dashboard.revpar')} value={m(d.financial.revpar)} />
          <Stat label={t('dashboard.openBalance')} value={m(d.financial.openBalance)} />
        </div>
      )}
    </>
  );
}

export default function DashboardPage() {
  return <PropertyGate perms={['property.read']}>{(p) => <Dashboard property={p} />}</PropertyGate>;
}
