'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { RESERVATION_STATUSES } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { Badge, ButtonLink, Card, ErrorText, Input, PageHeader, Pager, Select, Spinner, Table, Td, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Paged, Property, ReservationListItem } from '@/lib/types';

function List({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['reservations', property.id, q, status, page],
    queryFn: () => api.get<Paged<ReservationListItem>>('/reservations', { propertyId: property.id, q, status, page, pageSize: 25 }),
    placeholderData: (prev) => prev,
  });
  return (
    <>
      <PageHeader
        title={t('reservations.title')}
        actions={
          can('reservations.create') && (
            <ButtonLink href="/reservations/new">
              <Plus size={16} /> {t('reservations.new')}
            </ButtonLink>
          )
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <div className="relative min-w-60 flex-1">
            <Search size={16} className="absolute top-2.5 left-3 text-faint" />
            <Input
              className="pl-9"
              placeholder={t('reservations.searchHint')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select
            className="w-44"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('common.all')}</option>
            {RESERVATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`resStatus.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <ErrorText error={list.error} />
          </div>
        ) : (
          <>
            <Table
              head={[t('reservations.code'), t('reservations.guest'), t('reservations.arrival'), t('reservations.departure'), t('reservations.room'), t('common.status'), t('common.total')]}
              empty={!list.data?.items.length}
            >
              {list.data?.items.map((r) => (
                <tr key={r.id} className="hover:bg-subtle">
                  <Td>
                    <Link href={`/reservations/${r.id}`} className="font-mono text-xs font-semibold text-brand-600 hover:underline">
                      {r.code}
                    </Link>
                  </Td>
                  <Td>
                    <Link href={`/reservations/${r.id}`} className="hover:text-brand-600">
                      {r.guestName}
                    </Link>
                  </Td>
                  <Td>{date(r.arrival, locale)}</Td>
                  <Td>{date(r.departure, locale)}</Td>
                  <Td>
                    {r.roomNumber ?? '—'} <span className="text-xs text-muted">{r.roomTypeCode}</span>
                  </Td>
                  <Td>
                    <Badge tone={statusTone[r.status]}>{t(`resStatus.${r.status}`)}</Badge>
                  </Td>
                  <Td className="text-right whitespace-nowrap">{money(r.totalAmount, r.currency, locale)}</Td>
                </tr>
              ))}
            </Table>
            <Pager page={page} pageSize={25} total={list.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export default function ReservationsPage() {
  return <PropertyGate perms={['reservations.read']}>{(p) => <List property={p} />}</PropertyGate>;
}
