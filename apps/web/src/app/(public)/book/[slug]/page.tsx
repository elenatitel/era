'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import clsx from 'clsx';
import { BedDouble, ChevronLeft, Coffee, Lock, Tag } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { addDays, extraQuantity, nightsBetween, vatFromGross } from '@pms/shared';
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
  extras: SiteExtra[];
}
interface SiteExtra {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  price: number;
  vatRate: number;
}
interface Offer {
  ratePlanId: string;
  name: string;
  includesBreakfast: boolean;
  nightly: { date: string; amount: number }[];
  roomTotal: number;
  discount: number;
  totalBeforeDiscount: number;
  included: { name: string; amount: number; vatRate: number }[];
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
  promo: { code: string; valid: boolean; reason: string | null; description: string | null } | null;
  roomTypes: RoomType[];
}
interface CalendarDay {
  date: string;
  from: number | null;
  minNights: number | null;
  closed: boolean;
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
  promo?: string;
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

/** Price of each optional extra for this stay, as the API will charge it. */
const priceExtras = (extras: SiteExtra[], nights: number, guests: number) =>
  extras.map((e) => ({ ...e, quantity: extraQuantity(e.unit, nights, guests), amount: e.price * extraQuantity(e.unit, nights, guests) }));

function Summary({ site, avail, room, offer, chosen, guests, promoCode }: { site: Site; avail: Availability; room: RoomType; offer: Offer; chosen: SiteExtra[]; guests: number; promoCode?: string | null }) {
  const { t, locale } = useI18n();
  const m = (v: number) => money(v, avail.currency, locale);
  const nightsLabel = avail.nights === 1 ? t('guest.night') : t('guest.nights', { n: avail.nights });
  const added = priceExtras(chosen, avail.nights, guests);
  const total = offer.total + added.reduce((sum, e) => sum + e.amount, 0);
  const vat =
    vatFromGross(offer.roomTotal, site.accommodationVatRate) +
    offer.included.reduce((sum, e) => sum + vatFromGross(e.amount, e.vatRate), 0) +
    added.reduce((sum, e) => sum + vatFromGross(e.amount, e.vatRate), 0);
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
      <div className="flex flex-col gap-1.5 border-t border-line pt-2.5 text-sm">
        <div className="flex justify-between text-muted">
          <span>{t('guest.roomLine', { nights: nightsLabel })}</span>
          <span className="tabular-nums">{m(offer.roomTotal + offer.discount)}</span>
        </div>
        {offer.discount > 0 && (
          <div className="flex justify-between text-success">
            <span>{t('guest.discountLine', { code: promoCode ?? '' })}</span>
            <span className="tabular-nums">−{m(offer.discount)}</span>
          </div>
        )}
        {offer.included.map((e) => (
          <div key={e.name} className="flex justify-between text-muted">
            <span>
              {e.name} · {t('guest.included')}
            </span>
            <span className="tabular-nums">{m(e.amount)}</span>
          </div>
        ))}
        {added.map((e) => (
          <div key={e.id} className="flex justify-between text-muted">
            <span>
              {e.name}
              {e.quantity > 1 && ` × ${e.quantity}`}
            </span>
            <span className="tabular-nums">{m(e.amount)}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted">
        <span>{t('guest.vatIncluded')}</span>
        <span className="tabular-nums">{m(vat)}</span>
      </div>
      <div className="flex justify-between text-base font-semibold">
        <span>{t('guest.total')}</span>
        <span className="tabular-nums">{m(total)}</span>
      </div>
      <span className="text-xs text-muted">
        {t('guest.checkInFrom', { time: site.checkInTime })} · {t('guest.checkOutUntil', { time: site.checkOutTime })}
      </span>
    </div>
  );
}

/**
 * Two weeks of one-night prices: guests see cheaper nights, closed dates and minimum
 * stays before they search. Picking a day starts a search from it.
 */
function DateStrip({ slug, site, current, onPick }: { slug: string; site: Site; current: Search; onPick: (arrival: string, minNights: number) => void }) {
  const { t, locale } = useI18n();
  const back = addDays(current.arrival, -3);
  const from = back < site.earliestArrival ? site.earliestArrival : back;
  const to = addDays(from, 14);
  const cal = useQuery({
    queryKey: ['public-calendar', slug, from],
    queryFn: () => api.get<{ currency: string; days: CalendarDay[] }>(`/public/sites/${slug}/calendar`, { from, to }),
  });
  const short = new Intl.NumberFormat(locale === 'ro' ? 'ro-RO' : 'en-GB', { style: 'currency', currency: site.currency, maximumFractionDigits: 0 });
  const day = new Intl.DateTimeFormat(locale === 'ro' ? 'ro-RO' : 'en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!cal.data?.days.length) return null;
  return (
    <div className="mx-auto max-w-5xl px-4 pt-4">
      <p className="mb-2 text-xs text-muted">{t('guest.pickDate')}</p>
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="list">
        {cal.data.days.map((d) => {
          const inStay = d.date >= current.arrival && d.date < current.departure;
          return (
            <button
              key={d.date}
              type="button"
              role="listitem"
              disabled={d.closed}
              onClick={() => onPick(d.date, d.minNights ?? 1)}
              aria-pressed={inStay}
              className={clsx(
                'flex min-w-[76px] flex-col items-center gap-0.5 rounded-lg border px-2 py-2 text-xs',
                inStay ? 'border-focus bg-brand-soft text-on-brand-soft' : 'border-line bg-surface hover:border-focus',
                d.closed && 'cursor-not-allowed opacity-60 hover:border-line',
              )}
            >
              <span className="text-muted">{day.format(new Date(`${d.date}T00:00:00Z`))}</span>
              <span className={clsx('font-semibold tabular-nums', d.closed && 'line-through')}>{d.from != null ? short.format(d.from / 100) : t('guest.closedDay')}</span>
              {d.minNights != null && d.minNights > 1 && <span className="text-[11px] text-muted">{t('guest.minStay', { n: d.minNights })}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const isDate = (v: string | null): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)));
const count = (v: string | null, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

function Booking() {
  const { slug } = useParams<{ slug: string }>();
  const params = useSearchParams();
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const site = useQuery({ queryKey: ['public-site', slug], queryFn: () => api.get<Site>(`/public/sites/${slug}`), retry: false });
  const [draft, setDraft] = useState<Search | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [pick, setPick] = useState<{ room: RoomType; offer: Offer } | null>(null);
  const [step, setStep] = useState<'rooms' | 'details' | 'payment'>('rooms');
  const [booked, setBooked] = useState<Booked | null>(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', estimatedArrival: '', requests: '', acceptTerms: false, marketing: false });
  const [extraIds, setExtraIds] = useState<string[]>([]);

  // Deep links: ?arrival=&departure=&adults=&children=&room=&rate=&promo=&lang=
  const defaults: Search | null = useMemo(() => {
    if (!site.data) return null;
    const earliest = site.data.earliestArrival;
    const arrival = isDate(params.get('arrival')) && params.get('arrival')! >= earliest ? params.get('arrival')! : earliest;
    const asked = params.get('departure');
    const departure = isDate(asked) && asked > arrival && nightsBetween(arrival, asked) <= 60 ? asked : addDays(arrival, 2);
    const promo = params.get('promo')?.trim().toUpperCase().slice(0, 24) || undefined;
    return { arrival, departure, adults: count(params.get('adults'), 1, 6, 2), children: count(params.get('children'), 0, 4, 0), promo };
  }, [site.data, params]);
  const linkPick = useRef({ room: params.get('room'), rate: params.get('rate') });
  useEffect(() => {
    const lang = params.get('lang');
    if (lang === 'en' || lang === 'ro') setLocale(lang);
  }, [params, setLocale]);
  const current = search ?? defaults;
  const editing = draft ?? current;

  const avail = useQuery({
    queryKey: ['public-avail', slug, current],
    queryFn: () => {
      const { promo, ...q } = current!;
      return api.get<Availability>(`/public/sites/${slug}/availability`, promo ? { ...q, promo } : q);
    },
    enabled: Boolean(current),
  });

  // A link naming a room and rate pre-selects that offer once, if it is on sale.
  useEffect(() => {
    const want = linkPick.current;
    if (!avail.data || !want.room) return;
    linkPick.current = { room: null, rate: null };
    const room = avail.data.roomTypes.find((r) => r.id === want.room);
    const offer = room?.offers.find((o) => o.ratePlanId === want.rate) ?? room?.offers[0];
    if (room && offer) setPick({ room, offer });
  }, [avail.data]);

  // Prices may change with a new search (dates, promo): keep the pick pointing at fresh numbers.
  useEffect(() => {
    if (!avail.data) return;
    setPick((p) => {
      if (!p) return p;
      const room = avail.data.roomTypes.find((r) => r.id === p.room.id);
      const offer = room?.offers.find((o) => o.ratePlanId === p.offer.ratePlanId);
      return room && offer ? { room, offer } : null;
    });
  }, [avail.data]);

  const chosenExtras = site.data?.extras.filter((e) => extraIds.includes(e.id)) ?? [];
  const guestCount = (current?.adults ?? 0) + (current?.children ?? 0);
  const appliedPromo = avail.data?.promo?.valid ? avail.data.promo.code : null;

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
        extraIds,
        promoCode: appliedPromo,
        marketingConsent: form.marketing,
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
              <Field label={t('guest.promoCode')} hint={t('common.optional')}>
                {(id) => (
                  <Input
                    id={id}
                    maxLength={24}
                    autoComplete="off"
                    className="font-mono uppercase"
                    value={editing?.promo ?? ''}
                    onChange={(e) => setDraft({ ...editing!, promo: e.target.value.toUpperCase() || undefined })}
                  />
                )}
              </Field>
              <Button type="submit" className="min-h-10">
                {t('guest.search')}
              </Button>
            </form>
          </div>
          {current && (
            <DateStrip
              slug={slug}
              site={s}
              current={current}
              onPick={(arrival, minNights) => {
                const nights = Math.max(minNights, nightsBetween(current.arrival, current.departure));
                const next = { ...current, ...(draft?.promo !== undefined ? { promo: draft.promo } : {}), arrival, departure: addDays(arrival, nights) };
                setSearch(next);
                setDraft(null);
              }}
            />
          )}

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
              {avail.data?.promo &&
                (avail.data.promo.valid ? (
                  <Alert tone="green">
                    <span className="inline-flex items-center gap-1.5 font-semibold">
                      <Tag size={14} aria-hidden /> {t('guest.promoApplied', { code: avail.data.promo.code })}
                    </span>
                    {avail.data.promo.description && <span className="mt-0.5 block">{avail.data.promo.description}</span>}
                  </Alert>
                ) : (
                  <Alert tone="amber">{t(`guest.promoReason.${avail.data.promo.reason ?? 'not_found'}`)}</Alert>
                ))}
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
                                {o.included.length > 0 && (
                                  <span className="text-xs text-muted">{t('guest.includes', { items: o.included.map((e) => e.name).join(', ') })}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-4">
                                <div className="flex flex-col items-end">
                                  {o.discount > 0 && <span className="text-xs text-muted tabular-nums line-through">{m(o.totalBeforeDiscount)}</span>}
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
                    <Summary site={s} avail={avail.data} room={pick.room} offer={pick.offer} chosen={chosenExtras} guests={guestCount} promoCode={appliedPromo} />
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
            <Summary site={s} avail={avail.data} room={pick.room} offer={pick.offer} chosen={chosenExtras} guests={guestCount} promoCode={appliedPromo} />
          </GuestCard>
          {s.extras.length > 0 && (
            <GuestCard className="flex flex-col gap-3 p-4">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-base font-semibold">{t('guest.extrasTitle')}</h2>
                <p className="text-xs text-muted">{t('guest.extrasHint')}</p>
              </div>
              {priceExtras(s.extras, avail.data.nights, guestCount).map((e) => (
                <Checkbox
                  key={e.id}
                  checked={extraIds.includes(e.id)}
                  onChange={(v) => setExtraIds(v ? [...extraIds, e.id] : extraIds.filter((x) => x !== e.id))}
                  label={
                    <span className="flex w-full flex-wrap justify-between gap-x-3">
                      <span>
                        <span className="font-medium">{e.name}</span>
                        <span className="text-muted"> · {t(`extras.units.${e.unit}`).toLowerCase()}</span>
                        {e.description && <span className="block text-xs text-muted">{e.description}</span>}
                      </span>
                      <span className="tabular-nums">+{m(e.amount)}</span>
                    </span>
                  }
                />
              ))}
            </GuestCard>
          )}
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
            <Checkbox label={t('guest.marketing', { hotel: s.name })} checked={form.marketing} onChange={(v) => setForm({ ...form, marketing: v })} />
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
            <Summary site={s} avail={avail.data} room={pick.room} offer={pick.offer} chosen={chosenExtras} guests={guestCount} promoCode={appliedPromo} />
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

export default function BookingPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Booking />
    </Suspense>
  );
}
