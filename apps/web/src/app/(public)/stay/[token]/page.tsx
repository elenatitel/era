'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Coffee, Lock, MapPin, Phone } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { GuestCard, HotelHeader, PoweredBy, stayDate } from '@/components/guest/guest-ui';
import { Alert, Badge, Button, ErrorText, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import type { StayView } from '@/lib/guest-types';
import { useI18n } from '@/lib/i18n';

function daysUntil(iso: string) {
  const today = new Date();
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - start) / 86_400_000);
}

function Stay() {
  const { token } = useParams<{ token: string }>();
  const params = useSearchParams();
  const isNew = params.get('new') === '1';
  const paid = params.get('paid') === '1' || params.has('payment_intent');
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stay', token], queryFn: () => api.get<StayView>(`/public/stay/${token}`), retry: false });
  const confirm = useMutation({
    mutationFn: () => api.post<StayView>(`/public/stay/${token}/confirm-payment`),
    onSuccess: (data) => qc.setQueryData(['stay', token], data),
  });

  // Back from Stripe: confirm now, then poll briefly in case the payment settles a moment later.
  const tries = useRef(0);
  const awaiting = q.data?.booking.awaitingPayment;
  useEffect(() => {
    if (!awaiting || !paid || tries.current >= 6) return;
    const timer = setTimeout(() => {
      tries.current += 1;
      confirm.mutate();
    }, tries.current === 0 ? 0 : 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, paid, confirm.isPending]);

  // Guests read the portal in the language they booked in, unless they switched.
  const localeSet = useRef(false);
  useEffect(() => {
    if (!q.data || localeSet.current) return;
    localeSet.current = true;
    try {
      if (!localStorage.getItem('pms_locale') && (q.data.booking.locale === 'ro' || q.data.booking.locale === 'en')) setLocale(q.data.booking.locale);
    } catch {}
  }, [q.data, setLocale]);

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data)
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert>{t('guest.linkInvalid')}</Alert>
      </div>
    );
  const { hotel, booking: b, guest } = q.data;
  const m = (v: number) => money(v, b.currency, locale);
  const days = daysUntil(b.arrival);
  const when =
    b.status === 'checked_in' ? t('guest.inHouse') : days > 1 ? t('guest.startsIn', { n: days }) : days === 1 ? t('guest.startsTomorrow') : t('guest.startsToday');
  const canCheckin = ['tentative', 'confirmed'].includes(b.status) && !b.awaitingPayment;
  const statusTone = b.status === 'confirmed' ? 'blue' : b.status === 'checked_in' ? 'green' : b.status === 'cancelled' ? 'red' : 'amber';
  const place = [hotel.city, hotel.country === 'RO' ? 'Romania' : hotel.country].filter(Boolean).join(' · ');

  return (
    <div className="min-h-screen bg-canvas">
      {isNew && !b.awaitingPayment ? (
        <HotelHeader name={hotel.name} compact />
      ) : (
        <div className="bg-navy-800 text-white">
          <HotelHeader name={hotel.name} place={place} />
          <div className="mx-auto -mt-3 max-w-xl px-4 pb-7">
            <h1 className="font-display text-[34px] leading-[38px] font-medium">{t('guest.hello', { name: guest.firstName })}</h1>
            <p className="mt-1 text-sm text-[#dde3f2]">{when}</p>
          </div>
        </div>
      )}

      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6">
        {b.awaitingPayment && (
          <Alert tone="amber">
            <p className="font-semibold">{t('guest.awaitingTitle')}</p>
            <p className="mt-1">{t('guest.awaitingText')}</p>
            <Button size="sm" variant="secondary" className="mt-3" loading={confirm.isPending} onClick={() => confirm.mutate()}>
              {t('guest.refresh')}
            </Button>
          </Alert>
        )}
        <ErrorText error={confirm.error} />

        {isNew && !b.awaitingPayment && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-full bg-success-soft text-success">
              <Check size={28} strokeWidth={2} aria-hidden />
            </span>
            <h1 className="font-display text-[34px] leading-[38px] font-medium">{t('guest.confirmedTitle', { date: stayDate(b.arrival, locale, false) })}</h1>
            <p className="max-w-xs text-muted">{t('guest.confirmedText', { email: guest.email ?? '' })}</p>
          </div>
        )}

        <GuestCard className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="flex flex-col">
              <span className="text-xs text-muted">{t('guest.bookingCode')}</span>
              <span className="code text-sm">{b.code}</span>
            </span>
            <Badge tone={statusTone}>{t(`resStatus.${b.status}`)}</Badge>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col">
              <span className="text-xs text-muted">{t('guest.arrival')}</span>
              <span className="font-semibold">{stayDate(b.arrival, locale, false)}</span>
              <span className="text-xs text-muted">{t('guest.checkInFrom', { time: hotel.checkInTime })}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted">{t('guest.departure')}</span>
              <span className="font-semibold">{stayDate(b.departure, locale, false)}</span>
              <span className="text-xs text-muted">{t('guest.checkOutUntil', { time: hotel.checkOutTime })}</span>
            </div>
          </div>
          <span className="flex items-center gap-1.5 border-t border-line pt-3 text-sm">
            {b.includesBreakfast && <Coffee size={14} aria-hidden />}
            {b.roomType} · {b.ratePlan} · {b.adults + b.children} {t('guest.guests').toLowerCase()}
          </span>
        </GuestCard>

        {canCheckin && (
          <section className="flex flex-col gap-3 rounded-2xl border border-accent bg-brand-soft p-4 text-on-brand-soft">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">{isNew ? t('guest.skipQueue') : t('guest.onlineCheckin')}</h2>
              <Badge tone={b.onlineCheckinAt ? 'green' : 'amber'}>{b.onlineCheckinAt ? t('guest.completed') : t('guest.notStarted')}</Badge>
            </div>
            <p className="text-sm">{isNew ? t('guest.skipQueueText') : t('guest.checkinText')}</p>
            <Link href={`/stay/${token}/check-in`} className="inline-flex min-h-12 items-center justify-center rounded-lg bg-brand px-4 font-medium text-on-brand hover:bg-brand-hover">
              {b.onlineCheckinAt ? t('guest.editCheckin') : t('guest.startCheckin')}
            </Link>
          </section>
        )}

        <GuestCard className="flex flex-col gap-2.5 p-4">
          <h2 className="text-base font-semibold">{t('guest.payment')}</h2>
          {b.discount > 0 && (
            <div className="flex justify-between text-sm text-success">
              <span>{t('guest.discountLine', { code: b.promoCode ?? '' })}</span>
              <span className="tabular-nums">−{m(b.discount)}</span>
            </div>
          )}
          {b.extras.map((e) => (
            <div key={e.name} className="flex justify-between text-sm">
              <span className="text-muted">
                {e.name}
                {e.quantity > 1 && ` × ${e.quantity}`}
                {e.included && ` · ${t('guest.included')}`}
              </span>
              <span className="tabular-nums">{m(e.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between text-sm">
            <span className="text-muted">{t('guest.stayTotal')}</span>
            <span className="tabular-nums">{m(b.total)}</span>
          </div>
          {b.paid > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted">{t('guest.paid')}</span>
              <span className="tabular-nums">−{m(b.paid)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-line pt-2.5 font-semibold">
            <span>{t('guest.balance')}</span>
            <span className={b.balance > 0 ? 'text-warning tabular-nums' : 'text-success tabular-nums'}>{m(b.balance)}</span>
          </div>
          <span className="text-xs text-muted">{t('guest.invoiceNote')}</span>
        </GuestCard>

        <GuestCard className="flex flex-col px-4 py-1">
          {(hotel.address || hotel.city) && (
            <span className="flex min-h-13 items-center gap-3 border-b border-line py-3 text-sm">
              <MapPin size={18} className="shrink-0 text-muted" aria-hidden />
              {[hotel.address, hotel.city].filter(Boolean).join(', ')}
            </span>
          )}
          <span className="flex min-h-13 items-center gap-3 py-3 text-sm">
            <Phone size={18} className="shrink-0 text-muted" aria-hidden />
            <span className="flex-1">
              {t('guest.contact')}
              <span className="block text-xs text-muted">{[hotel.phone, hotel.email].filter(Boolean).join(' · ')}</span>
            </span>
            <ChevronRight size={18} className="text-faint" aria-hidden />
          </span>
        </GuestCard>

        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted">
          <Lock size={14} aria-hidden /> {t('guest.privateLink')}
        </p>
      </main>
      <PoweredBy />
    </div>
  );
}

export default function StayPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Stay />
    </Suspense>
  );
}
