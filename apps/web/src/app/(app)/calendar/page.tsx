'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { addDays, nightsBetween, weekday } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { Button, Card, ErrorText, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { Property } from '@/lib/types';

interface Cal {
  rooms: { id: string; number: string; roomTypeId: string; roomTypeCode: string; status: string }[];
  reservations: { id: string; code: string; status: string; roomId: string | null; roomTypeId: string; arrival: string; departure: string; guestName: string; segment: string }[];
}

const DAYS = 14;
const barColor: Record<string, string> = {
  tentative: 'border border-dashed border-warning bg-warning-soft text-warning',
  confirmed: 'bg-accent text-on-brand',
  checked_in: 'bg-brand text-on-brand',
  checked_out: 'bg-subtle text-muted',
};

function Calendar({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const [start, setStart] = useState(addDays(property.businessDate, -1));
  const end = addDays(start, DAYS);
  const q = useQuery({
    queryKey: ['calendar', property.id, start],
    queryFn: () => api.get<Cal>('/reservations/calendar', { propertyId: property.id, from: start, to: end }),
    placeholderData: (p) => p,
  });
  const days = Array.from({ length: DAYS }, (_, i) => addDays(start, i));
  const fmt = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ro-RO', { weekday: 'short', day: '2-digit', timeZone: 'UTC' });

  const types = q.data ? [...new Map(q.data.rooms.map((r) => [r.roomTypeId, r.roomTypeCode])).entries()] : [];
  const rows: { key: string; label: string; roomId: string | null; roomTypeId: string; muted?: boolean }[] = [];
  for (const [typeId, code] of types) {
    for (const r of q.data!.rooms.filter((x) => x.roomTypeId === typeId)) rows.push({ key: r.id, label: `${r.number}`, roomId: r.id, roomTypeId: typeId });
    if (q.data!.reservations.some((r) => !r.roomId && r.roomTypeId === typeId))
      rows.push({ key: `u-${typeId}`, label: `${code} · ${t('calendar.unassigned')}`, roomId: null, roomTypeId: typeId, muted: true });
  }

  return (
    <>
      <PageHeader
        title={t('calendar.title')}
        subtitle={property.name}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setStart(addDays(start, -7))} aria-label={t('common.previous')}>
              <ChevronLeft size={16} />
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setStart(addDays(property.businessDate, -1))}>
              {t('calendar.today')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setStart(addDays(start, 7))} aria-label={t('common.next')}>
              <ChevronRight size={16} />
            </Button>
          </>
        }
      />
      <ErrorText error={q.error} />
      {q.isLoading ? (
        <Spinner />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <div className="grid min-w-[900px]" style={{ gridTemplateColumns: `110px repeat(${DAYS}, minmax(56px, 1fr))` }}>
              <div className="sticky left-0 z-10 border-b border-line bg-surface" />
              {days.map((d) => (
                <div
                  key={d}
                  className={clsx(
                    'border-b border-l border-line px-1 py-2 text-center text-[11px]',
                    d === property.businessDate ? 'bg-brand-soft font-semibold text-on-brand-soft' : [0, 6].includes(weekday(d)) ? 'bg-subtle text-muted' : 'text-muted',
                  )}
                >
                  {fmt.format(new Date(`${d}T00:00:00Z`))}
                </div>
              ))}
              {rows.map((row) => {
                const bookings = q.data!.reservations.filter((r) => (row.roomId ? r.roomId === row.roomId : !r.roomId && r.roomTypeId === row.roomTypeId));
                return (
                  <Fragment key={row.key}>
                    <div className={clsx('sticky left-0 z-10 border-b border-line bg-surface px-3 py-2 text-sm', row.muted ? 'text-xs text-muted italic' : 'font-semibold')}>{row.label}</div>
                    <div className="relative border-b border-line" style={{ gridColumn: `2 / span ${DAYS}` }}>
                      <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)` }}>
                        {days.map((d) => (
                          <div key={d} className={clsx('border-l border-line', d === property.businessDate && 'bg-brand-soft/60')} />
                        ))}
                      </div>
                      <div className="relative h-10">
                        {bookings.map((b, i) => {
                          const from = Math.max(0, nightsBetween(start, b.arrival));
                          const to = Math.min(DAYS, nightsBetween(start, b.departure));
                          if (to <= 0 || from >= DAYS) return null;
                          // Stays run from mid-day of arrival to mid-day of departure.
                          const left = from + (b.arrival >= start ? 0.5 : 0);
                          const right = Math.min(DAYS, to + (b.departure <= end ? 0.5 : 0));
                          return (
                            <Link
                              key={b.id}
                              href={`/reservations/${b.id}`}
                              title={`${b.guestName} · ${b.code}`}
                              className={clsx('absolute truncate rounded-sm px-2 text-xs leading-7 font-medium hover:brightness-95', barColor[b.status] ?? 'bg-subtle text-muted')}
                              style={{
                                left: `${(left / DAYS) * 100}%`,
                                width: `calc(${((right - left) / DAYS) * 100}% - 3px)`,
                                top: row.roomId ? 6 : 4 + (i % 2) * 2,
                              }}
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
      )}
    </>
  );
}

export default function CalendarPage() {
  return <PropertyGate perms={['reservations.read']}>{(p) => <Calendar property={p} />}</PropertyGate>;
}
