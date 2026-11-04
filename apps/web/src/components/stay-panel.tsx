'use client';

import { useQuery } from '@tanstack/react-query';
import { Lightbulb, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { ReservationDetail } from '@/lib/types';
import { CheckInDialog, CheckOutDialog } from './stay-dialogs';
import { Alert, Badge, Button, ButtonLink, ErrorText, Spinner, statusTone } from './ui';

/** The stay at a glance beside the calendar: who, what they owe, what they want, and the next step. */
export function StayPanel({ reservationId, onClose }: { reservationId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const [dialog, setDialog] = useState<'checkin' | 'checkout' | null>(null);
  const q = useQuery({ queryKey: ['reservation', reservationId], queryFn: () => api.get<ReservationDetail>(`/reservations/${reservationId}`) });
  const r = q.data;
  const today = r?.property.businessDate ?? '';
  const arriving = r && ['tentative', 'confirmed'].includes(r.status);
  const canCheckIn = arriving && r.arrival <= today && today < r.departure && can('frontdesk.checkin');
  const canCheckOut = r?.status === 'checked_in' && can('frontdesk.checkout');
  const due = r?.totals?.due ?? 0;
  const guestName = r?.guest ? `${r.guest.firstName} ${r.guest.lastName}` : '';

  return (
    <aside className="fixed inset-x-3 bottom-3 z-40 max-h-[75vh] overflow-auto rounded-2xl border border-line bg-surface shadow-lg xl:sticky xl:inset-x-auto xl:top-4 xl:bottom-auto xl:z-auto xl:w-80 xl:shrink-0 xl:shadow-none">
      <div className="flex items-start justify-between gap-2 p-5 pb-3">
        <div className="min-w-0">
          {r?.guest ? (
            <Link href={`/guests/${r.guest.id}`} className="block truncate text-lg font-semibold hover:text-accent">
              {guestName}
            </Link>
          ) : (
            <span className="block h-7" />
          )}
          {r && (
            <span className="mt-1 inline-flex items-center gap-2 text-xs text-muted">
              <span className="code">{r.code}</span>
              <Badge tone={statusTone[r.status]}>{t(`resStatus.${r.status}`)}</Badge>
            </span>
          )}
        </div>
        <button onClick={onClose} aria-label={t('common.close')} className="rounded-full p-1 text-muted hover:bg-subtle hover:text-ink">
          <X size={18} />
        </button>
      </div>

      {q.isLoading && <Spinner />}
      <div className="px-5">
        <ErrorText error={q.error} />
      </div>
      {r && (
        <>
          {r.guest?.smartTip && (
            <div className="mx-5 mb-3 flex gap-2 rounded-xl bg-info-soft p-3 text-xs text-info">
              <Lightbulb size={14} className="mt-0.5 shrink-0" />
              <span>{r.guest.smartTip}</span>
            </div>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-line px-5 py-3 text-sm">
            <dt className="text-muted">{t('common.date')}</dt>
            <dd>
              {date(r.arrival, locale)} – {date(r.departure, locale)}
            </dd>
            <dt className="text-muted">{t('reservations.nights')}</dt>
            <dd>{r.nightlyRates.length}</dd>
            <dt className="text-muted">{t('reservations.room')}</dt>
            <dd>
              {r.roomType.name}
              {r.room && <strong> · {r.room.number}</strong>}
            </dd>
            <dt className="text-muted">{t('reservations.adults')}</dt>
            <dd>
              {r.adults}
              {r.children ? ` + ${r.children}` : ''}
            </dd>
            {r.guest?.phone && (
              <>
                <dt className="text-muted">{t('common.phone')}</dt>
                <dd>
                  <a href={`tel:${r.guest.phone.replace(/\s/g, '')}`} className="hover:text-accent">
                    {r.guest.phone}
                  </a>
                </dd>
              </>
            )}
          </dl>
          {(r.guestRequests || r.notes) && <p className="border-t border-line px-5 py-3 text-sm whitespace-pre-wrap text-muted">{r.guestRequests ?? r.notes}</p>}
          {r.totals && (
            <div className={`flex items-center justify-between px-5 py-3 text-sm font-semibold ${due > 0 ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success'}`}>
              <span>{due > 0 ? t('reservations.stayDue') : t('calendar.paid')}</span>
              <span>{money(Math.max(due, 0), r.currency, locale)}</span>
            </div>
          )}
          <div className="space-y-3 p-5">
            {['cancelled', 'no_show'].includes(r.status) && <Alert tone="amber">{t('calendar.notInCalendar')}</Alert>}
            {arriving && r.arrival > today && <Alert tone="blue">{t('reservations.checkInFrom', { date: date(r.arrival, locale) })}</Alert>}
            <div className="flex flex-wrap justify-end gap-2">
              <ButtonLink variant="secondary" href={`/reservations/${r.id}`}>
                {t('calendar.openFull')}
              </ButtonLink>
              {canCheckIn && (
                <Button size="sm" onClick={() => setDialog('checkin')}>
                  {t('frontDesk.checkIn')}
                </Button>
              )}
              {canCheckOut && (
                <Button size="sm" onClick={() => setDialog('checkout')}>
                  {t('frontDesk.checkOut')}
                </Button>
              )}
            </div>
          </div>
          {dialog === 'checkin' && <CheckInDialog reservationId={r.id} roomId={r.room?.id} title={`${t('frontDesk.checkIn')} · ${guestName}`} onClose={() => setDialog(null)} />}
          {dialog === 'checkout' && <CheckOutDialog reservationId={r.id} title={`${t('frontDesk.checkOut')} · ${guestName}`} onClose={() => setDialog(null)} />}
        </>
      )}
    </aside>
  );
}
