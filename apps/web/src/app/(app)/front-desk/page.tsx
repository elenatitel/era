'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { PropertyGate } from '@/components/property-gate';
import { CheckInDialog, CheckOutDialog } from '@/components/stay-dialogs';
import { Badge, Button, ButtonLink, Card, ErrorText, PageHeader, Spinner, Table, Td, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Property } from '@/lib/types';

interface Row {
  id: string;
  code: string;
  status: string;
  guestName: string;
  guestSegment?: string;
  roomNumber: string | null;
  roomStatus?: string | null;
  roomTypeCode?: string;
  arrival?: string;
  departure: string;
  adults?: number;
  children?: number;
}
interface FrontDesk {
  date: string;
  businessDate: string;
  arrivals: Row[];
  departures: Row[];
  inHouse: Row[];
}

function FrontDeskView({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const q = useQuery({ queryKey: ['front-desk', property.id], queryFn: () => api.get<FrontDesk>('/front-desk', { propertyId: property.id }) });
  const [checkIn, setCheckIn] = useState<Row | null>(null);
  const [checkOut, setCheckOut] = useState<Row | null>(null);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const d = q.data!;
  const guestCell = (r: Row) => (
    <Link href={`/reservations/${r.id}`} className="font-medium text-ink hover:text-accent">
      {r.guestName}
      {r.guestSegment && r.guestSegment !== 'standard' && (
        <span className="ml-2">
          <Badge tone={statusTone[r.guestSegment]}>{t(`segments.${r.guestSegment}`)}</Badge>
        </span>
      )}
      <span className="block text-xs font-normal text-muted">{r.code}</span>
    </Link>
  );

  return (
    <>
      <PageHeader
        title={t('frontDesk.title')}
        eyebrow={`${property.name} · ${date(d.businessDate, locale)}`}
        actions={can('reservations.create') && <ButtonLink href="/reservations/new">{t('reservations.new')}</ButtonLink>}
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={`${t('frontDesk.arrivals')} (${d.arrivals.length})`} padded={false}>
          <Table head={[t('reservations.guest'), t('reservations.roomType'), t('reservations.room'), '']} empty={!d.arrivals.length}>
            {d.arrivals.map((r) => (
              <tr key={r.id}>
                <Td>{guestCell(r)}</Td>
                <Td>{r.roomTypeCode}</Td>
                <Td>
                  {r.roomNumber ?? '—'}
                  {r.roomStatus && r.roomStatus !== 'clean' && r.roomStatus !== 'inspected' && (
                    <span className="ml-1">
                      <Badge tone={statusTone[r.roomStatus]}>{t(`roomStatus.${r.roomStatus}`)}</Badge>
                    </span>
                  )}
                </Td>
                <Td className="text-right">
                  {r.status === 'checked_in' ? (
                    <Badge tone="green">{t('resStatus.checked_in')}</Badge>
                  ) : (
                    can('frontdesk.checkin') && (
                      <Button size="sm" onClick={() => setCheckIn(r)}>
                        {t('frontDesk.checkIn')}
                      </Button>
                    )
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title={`${t('frontDesk.departures')} (${d.departures.length})`} padded={false}>
          <Table head={[t('reservations.guest'), t('reservations.room'), t('reservations.departure'), '']} empty={!d.departures.length}>
            {d.departures.map((r) => (
              <tr key={r.id}>
                <Td>{guestCell(r)}</Td>
                <Td>{r.roomNumber ?? '—'}</Td>
                <Td>{date(r.departure, locale)}</Td>
                <Td className="text-right">
                  {r.status === 'checked_out' ? (
                    <Badge tone="gray">{t('dashboard.departed')}</Badge>
                  ) : (
                    can('frontdesk.checkout') && (
                      <Button size="sm" variant="secondary" onClick={() => setCheckOut(r)}>
                        {t('frontDesk.checkOut')}
                      </Button>
                    )
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      <Card title={`${t('frontDesk.inHouse')} (${d.inHouse.length})`} padded={false} className="mt-6">
        <Table head={[t('reservations.room'), t('reservations.guest'), t('reservations.arrival'), t('reservations.departure')]} empty={!d.inHouse.length}>
          {d.inHouse.map((r) => (
            <tr key={r.id}>
              <Td className="font-semibold">{r.roomNumber ?? '—'}</Td>
              <Td>{guestCell(r)}</Td>
              <Td>{date(r.arrival, locale)}</Td>
              <Td>{date(r.departure, locale)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      {checkIn && <CheckInDialog reservationId={checkIn.id} title={`${t('frontDesk.checkIn')} · ${checkIn.guestName}`} onClose={() => setCheckIn(null)} />}
      {checkOut && <CheckOutDialog reservationId={checkOut.id} title={`${t('frontDesk.checkOut')} · ${checkOut.guestName}`} onClose={() => setCheckOut(null)} />}
    </>
  );
}

export default function FrontDeskPage() {
  return <PropertyGate perms={['reservations.read']}>{(p) => <FrontDeskView property={p} />}</PropertyGate>;
}

