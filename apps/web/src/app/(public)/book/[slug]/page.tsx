'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { BedDouble, ChevronLeft, Coffee, Lock } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';
import { addDays, vatFromGross } from '@pms/shared';
import { GuestCard, HotelHeader, PoweredBy, StepNav, stayDate } from '@/components/guest/guest-ui';
import { Alert, Badge, Button, Checkbox, ErrorText, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

interface Site {
  slug: string;
  name: string;
  city: string | null;
  country: string;
  address: string | null;
  currency: string;
  checkInTime: string;
  checkOutTime: string;
  earliestArrival: string;
  accommodationVatRate: number;
  payments: { provider: 'stripe'; publishableKey: string } | null;
}
interface Offer {
  ratePlanId: string;
  name: string;
  includesBreakfast: boolean;
  total: number;
  perNight: number;
}
interface RoomType {
  id: string;
  name: string;
  description: string | null;
  maxOccupancy: number;
  available: number;
  offers: Offer[];
}
interface Availability {
  arrival: string;
  departure: string;
  nights: number;
  currency: string;
  roomTypes: RoomType[];
}
interface Booked {
  code: string;
  token: string;
  status: 'confirmed' | 'awaiting_payment';
  total: number;
  currency: string;
  payment: { clientSecret: string; publishableKey: string } | null;
}
interface Search {
  arrival: string;
  departure: string;
  adults: number;
  children: number;
}

const HOLD_MINUTES = 30;
// Stripe Elements styled with the era. design tokens (light theme values).
const appearance = {
  theme: 'stripe' as const,
  variables: {
    colorPrimary: '#2c3a5a',
    colorText: '#1b2438',
    colorTextSecondary: '#55607a',
    colorDanger: '#a61f30',
    colorBackground: '#ffffff',
    fontFamily: 'Figtree, "Segoe UI", system-ui, sans-serif',
    borderRadius: '8px',
    spacingUnit: '4px',
  },
  rules: { '.Input': { border: '1px solid #7f889e', boxShadow: 'none' }, '.Label': { fontWeight: '500', color: '#1b2438' } },
};

function PayForm({ amount, token, hotel }: { amount: string; token: string; hotel: string }) {
  const { t } = useI18n();
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function pay(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/stay/${token}?new=1&paid=1` },
      redirect: 'if_required',
    });
    if (result.error) {
      setError(result.error.message ?? t('errors.generic'));
      setBusy(false);
      return;
    }
    router.push(`/stay/${token}?new=1&paid=1`);
  }
  return (
    <form onSubmit={pay} className="flex flex-col gap-4">
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && <Alert>{error}</Alert>}
      <Button type="submit" loading={busy} disabled={!stripe} className="min-h-12 text-base">
        {t('guest.pay', { amount })}
      </Button>
      <p className="text-center text-xs text-muted">{t('guest.cardCharged', { hotel })}</p>
    </form>
  );
}

function Summary({ site, avail, room, offer }: { site: Site; avail: Availability; room: RoomType; offer: Offer }) {
  const { t, locale } = useI18n();
  const m = (v: number) => money(v, avail.currency, locale);
  const nightsLabel = avail.nights === 1 ? t('guest.night') : t('guest.nights', { n: avail.nights });
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">
          {room.name} · {offer.name}
        </span>
        <span className="text-xs text-muted">
          {stayDate(avail.arrival, locale, false)} – {stayDate(avail.departure, locale)} · {nightsLabel}
        </span>
      </div>
      <div className="flex justify-between border-t border-line pt-2.5 text-sm text-muted">
        <span>
          {avail.nights} × {m(offer.perNight)}
        </span>
        <span className="tabular-nums">{m(offer.total)}</span>
      </div>
      <div className="flex justify-between text-xs text-muted">
        <span>{t('guest.vatIncluded')}</span>
        <span className="tabular-nums">{m(vatFromGross(offer.total, site.accommodationVatRate))}</span>
      </div>
      <div className="flex justify-between text-base font-semibold">
        <span>{t('guest.total')}</span>
        <span className="tabular-nums">{m(offer.total)}</span>
      </div>
      <span className="text-xs text-muted">
        {t('guest.checkInFrom', { time: site.checkInTime })} · {t('guest.checkOutUntil', { time: site.checkOutTime })}
      </span>
    </div>
  );
}

export default function BookingPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, locale } = useI18n();
  const router = useRouter();
  const site = useQuery({ queryKey: ['public-site', slug], queryFn: () => api.get<Site>(`/public/sites/${slug}`), retry: false });
  const [draft, setDraft] = useState<Search | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [pick, setPick] = useState<{ room: RoomType; offer: Offer } | null>(null);
  const [step, setStep] = useState<'rooms' | 'details' | 'payment'>('rooms');
  const [booked, setBooked] = useState<Booked | null>(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', estimatedArrival: '', requests: '', acceptTerms: false });

  const defaults: Search | null = site.data
    ? { arrival: site.data.earliestArrival, departure: addDays(site.data.earliestArrival, 2), adults: 2, children: 0 }
    : null;
  const current = search ?? defaults;
  const editing = draft ?? current;

  const avail = useQuery({
    queryKey: ['public-avail', slug, current],
    queryFn: () => api.get<Availability>(`/public/sites/${slug}/availability`, { ...current! }),
    enabled: Boolean(current),
  });

  const book = useMutation({
    mutationFn: () =>
      api.post<Booked>(`/public/sites/${slug}/bookings`, {
        roomTypeId: pick!.room.id,
        ratePlanId: pick!.offer.ratePlanId,
        arrival: avail.data!.arrival,
        departure: avail.data!.departure,
        adults: current!.adults,
        children: current!.children,
        guest: { firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone || null },
        estimatedArrival: form.estimatedArrival || null,
        requests: form.requests || null,
        acceptTerms: form.acceptTerms,
        locale,
      }),
    onSuccess: (r) => {
      setBooked(r);
      if (r.payment) setStep('payment');
      else router.push(`/stay/${r.token}?new=1`);
    },
  });

  const stripePromise = useMemo(() => (booked?.payment ? loadStripe(booked.payment.publishableKey) : null), [booked?.payment]);

  if (site.isLoading) return <Spinner />;
  if (site.error || !site.data)
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorText error={site.error ?? new ApiError(404, 'NOT_FOUND', t('errors.notFound'))} />
      </div>
    );
  const s = site.data;
  const place = [s.city, s.country === 'RO' ? 'Romania' : s.country].filter(Boolean).join(' · ');
  const m = (v: number) => money(v, s.currency, locale);
  const slots = t('guest.arrivalSlots').split('|');
  const nightsLabel = (n: number) => (n === 1 ? t('guest.night') : t('guest.nights', { n }));
  const back = (to: 'rooms' | 'details') => (
    <button type="button" onClick={() => setStep(to)} aria-label={t('guest.backToRooms')} className="-ml-3 grid h-11 w-11 place-items-center rounded-lg text-white hover:bg-white/10">
      <ChevronLeft size={20} />
    </button>
  );

  return (
    <div className="min-h-screen bg-canvas">
      <HotelHeader name={s.name} place={place} compact={step !== 'rooms'} back={step === 'rooms' ? undefined : step === 'details' ? back('rooms') : undefined} />
      <StepNav step={step === 'rooms' ? 1 : 2} />

      {step === 'rooms' && (
        <>
          <div className="border-b border-line bg-surface">
            <form
              className="mx-auto grid max-w-5xl gap-3 px-4 py-4 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (editing) setSearch(editing);
                setDraft(null);
                setPick(null);
              }}
            >
              <Field label={t('guest.arrival')}>
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    min={s.earliestArrival}
                    value={editing?.arrival ?? ''}
                    onChange={(e) =>
                      setDraft({ ...editing!, arrival: e.target.value, departure: e.target.value >= editing!.departure ? addDays(e.target.value, 1) : editing!.departure })
                    }
                  />
                )}
              </Field>
              <Field label={t('guest.departure')}>
                {(id) => <Input id={id} type="date" min={editing ? addDays(editing.arrival, 1) : undefined} value={editing?.departure ?? ''} onChange={(e) => setDraft({ ...editing!, departure: e.target.value })} />}
              </Field>
              <Field label={t('guest.adults')}>
                {(id) => (
                  <Select id={id} value={editing?.adults ?? 2} onChange={(e) => setDraft({ ...editing!, adults: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('guest.children')}>
                {(id) => (
                  <Select id={id} value={editing?.children ?? 0} onChange={(e) => setDraft({ ...editing!, children: Number(e.target.value) })}>
                    {[0, 1, 2, 3, 4].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button type="submit" className="min-h-10">
                {t('guest.search')}
              </Button>
            </form>
          </div>

          <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-6 px-4 py-6">
            <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
              {avail.data && (
                <div className="flex flex-col gap-1">
                  <span className="eyebrow">
                    {stayDate(avail.data.arrival, locale, false)} – {stayDate(avail.data.departure, locale)} · {nightsLabel(avail.data.nights)} · {current!.adults + current!.children} {t('guest.guests').toLowerCase()}
                  </span>
                  <h1 className="font-display text-4xl leading-10 font-medium">{t('guest.chooseRoom')}</h1>
                </div>
              )}
              <ErrorText error={avail.error} />
              {avail.isLoading && <Spinner />}
              {avail.data && avail.data.roomTypes.every((r) => r.offers.length === 0) && <Alert tone="amber">{t('guest.noRooms')}</Alert>}
              {avail.data?.roomTypes.map((room) => (
                <GuestCard key={room.id} className="flex flex-wrap overflow-hidden">
                  <div className="flex min-h-40 flex-[1_1_240px] flex-col items-center justify-center gap-1.5 bg-subtle text-muted">
                    <BedDouble size={30} strokeWidth={1.75} aria-hidden />
                  </div>
                  <div className="flex min-w-0 flex-[2_1_340px] flex-col gap-3 p-4 sm:p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-col gap-0.5">
                        <h2 className="text-lg leading-6 font-semibold">{room.name}</h2>
                        <span className="text-xs text-muted">
                          {t('guest.upTo', { n: room.maxOccupancy })} · {t('guest.totalFor', { nights: nightsLabel(avail.data!.nights) })}
                        </span>
                        {room.description && <span className="mt-1 text-sm text-muted">{room.description}</span>}
                      </div>
                      {room.available > 0 && room.available <= 2 && <Badge tone="amber">{t('guest.onlyLeft', { n: room.available })}</Badge>}
                    </div>
                    {room.offers.length === 0 ? (
                      <p className="border-t border-line pt-3 text-sm text-muted">{t('guest.soldOut')}</p>
                    ) : (
                      <ul className="flex flex-col">
                        {room.offers.map((o) => {
                          const chosen = pick?.room.id === room.id && pick.offer.ratePlanId === o.ratePlanId;
                          return (
                            <li key={o.ratePlanId} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3">
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="font-medium">{o.name}</span>
                                <span className="flex items-center gap-1 text-xs text-muted">
                                  {o.includesBreakfast && <Coffee size={12} aria-hidden />}
                                  {o.includesBreakfast ? t('guest.breakfast') : t('guest.roomOnly')}
                                </span>
                              </div>
                              <div className="flex items-center gap-4">
                                <div className="flex flex-col items-end">
                                  <span className="font-semibold tabular-nums">{m(o.total)}</span>
                                  <span className="text-xs text-muted tabular-nums">{t('guest.perNight', { price: m(o.perNight) })}</span>
                                </div>
                                <Button
                                  size="sm"
                                  variant={chosen ? 'primary' : 'secondary'}
                                  className="min-h-9"
                                  aria-pressed={chosen}
                                  onClick={() => {
                                    setPick({ room, offer: o });
                                    if (window.matchMedia('(max-width: 1023px)').matches) setStep('details');
                                  }}
                                >
                                  {chosen ? t('guest.selected') : t('guest.select')}
                                </Button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </GuestCard>
              ))}
            </main>
            <aside className="hidden min-w-0 flex-[1_1_300px] lg:block">
              <GuestCard className="flex flex-col gap-4 p-5">
                <h2 className="text-base font-semibold">{t('guest.yourStay')}</h2>
                {pick && avail.data ? (
                  <>
                    <Summary site={s} avail={avail.data} room={pick.room} offer={pick.offer} />
                    <Button className="min-h-12" onClick={() => setStep('details')}>
                      {t('guest.continue')}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted">{t('guest.chooseRoom')}</p>
                )}
              </GuestCard>
            </aside>
          </div>
        </>
      )}

      {step === 'details' && pick && avail.data && (
        <form
          className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6"
          onSubmit={(e) => {
            e.preventDefault();
            book.mutate();
          }}
        >
          <GuestCard className="p-4">
            <Summary site={s} avail={avail.data} room={pick.room} offer={pick.offer} />
          </GuestCard>
          <GuestCard className="flex flex-col gap-3.5 p-4">
            <h2 className="text-base font-semibold">{t('guest.guestDetails')}</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('guest.firstName')}>{(id) => <Input id={id} required autoComplete="given-name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />}</Field>
              <Field label={t('guest.lastName')}>{(id) => <Input id={id} required autoComplete="family-name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />}</Field>
            </div>
            <Field label={t('guest.email')} hint={t('guest.emailHint')}>
              {(id) => <Input id={id} type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
            </Field>
            <Field label={t('guest.phone')}>{(id) => <Input id={id} type="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
            <Field label={t('guest.estimatedArrival')}>
              {(id) => (
                <Select id={id} value={form.estimatedArrival} onChange={(e) => setForm({ ...form, estimatedArrival: e.target.value })}>
                  <option value="">{t('guest.selectOption')}</option>
                  {slots.map((slot) => (
                    <option key={slot}>{slot}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('guest.requests')} hint={t('guest.requestsHint')}>
              {(id) => <Textarea id={id} placeholder={t('guest.requestsPlaceholder')} value={form.requests} onChange={(e) => setForm({ ...form, requests: e.target.value })} />}
            </Field>
            <Checkbox label={t('guest.acceptTerms')} checked={form.acceptTerms} onChange={(v) => setForm({ ...form, acceptTerms: v })} />
          </GuestCard>
          <ErrorText error={book.error} />
          <Button type="submit" loading={book.isPending} disabled={!form.acceptTerms} className="min-h-12 text-base">
            {s.payments ? t('guest.toPayment') : t('guest.confirmBooking')}
          </Button>
          {!s.payments && <p className="text-center text-xs text-muted">{t('guest.payAtHotel')}</p>}
        </form>
      )}

      {step === 'payment' && booked?.payment && stripePromise && pick && avail.data && (
        <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6">
          <GuestCard className="p-4">
            <Summary site={s} avail={avail.data} room={pick.room} offer={pick.offer} />
          </GuestCard>
          <GuestCard className="flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('guest.payment')}</h2>
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                <Lock size={14} aria-hidden /> {t('guest.securedBy')}
              </span>
            </div>
            <Alert tone="blue">{t('guest.holding', { min: HOLD_MINUTES })}</Alert>
            <Elements stripe={stripePromise} options={{ clientSecret: booked.payment.clientSecret, appearance, locale: locale === 'ro' ? 'ro' : 'en' }}>
              <PayForm amount={m(booked.total)} token={booked.token} hotel={s.name} />
            </Elements>
          </GuestCard>
        </div>
      )}

      <PoweredBy />
    </div>
  );
}
