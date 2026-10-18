'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { addDays } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { Card, ErrorText, Field, Input, PageHeader, Spinner, Stat, Table, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Payment, Property } from '@/lib/types';

interface Report {
  items: Payment[];
  byMethod: { method: string; total: number; n: number }[];
  total: number;
}

function Payments({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const [from, setFrom] = useState(addDays(property.businessDate, -6));
  const [to, setTo] = useState(property.businessDate);
  const q = useQuery({ queryKey: ['payments', property.id, from, to], queryFn: () => api.get<Report>('/payments', { propertyId: property.id, from, to }) });
  const m = (v: number) => money(v, property.currency, locale);
  return (
    <>
      <PageHeader
        title={t('paymentsReport.title')}
        subtitle={property.name}
        actions={
          <div className="flex gap-2">
            <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
        }
      />
      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Spinner />
      ) : (
        q.data && (
          <>
            <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('common.total')} value={m(q.data.total)} />
              {q.data.byMethod.map((b) => (
                <Stat key={b.method} label={t(`methods.${b.method}`)} value={m(b.total)} hint={`${b.n}×`} />
              ))}
            </div>
            <Card padded={false}>
              <Table head={[t('common.date'), t('reservations.method'), t('reservations.guest'), t('reservations.reference'), t('common.amount')]} empty={!q.data.items.length}>
                {q.data.items.map((p) => (
                  <tr key={p.id}>
                    <Td>{dateTime(p.createdAt, locale)}</Td>
                    <Td>{t(`methods.${p.method}`)}</Td>
                    <Td>
                      {p.guestName ?? '—'} <span className="text-xs text-muted">{p.reservationCode}</span>
                    </Td>
                    <Td className="text-muted">{p.reference ?? '—'}</Td>
                    <Td className={p.amount < 0 ? 'text-right text-red-600' : 'text-right font-medium'}>{m(p.amount)}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )
      )}
    </>
  );
}

export default function PaymentsPage() {
  return <PropertyGate perms={['reports.read']}>{(p) => <Payments property={p} />}</PropertyGate>;
}
