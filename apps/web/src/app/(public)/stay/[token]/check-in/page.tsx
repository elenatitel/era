'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { DOCUMENT_TYPES } from '@pms/shared';
import { GuestCard, HotelHeader, PoweredBy, stayDate } from '@/components/guest/guest-ui';
import { Alert, Button, Checkbox, ErrorText, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { countryOptions } from '@/lib/countries';
import type { StayView } from '@/lib/guest-types';
import { useI18n } from '@/lib/i18n';

interface Person {
  firstName: string;
  lastName: string;
  birthDate: string;
  nationality: string;
  documentType: string;
  documentNumber: string;
}
const emptyPerson: Person = { firstName: '', lastName: '', birthDate: '', nationality: '', documentType: '', documentNumber: '' };
const orNull = (v: string) => (v.trim() ? v.trim() : null);

function Verify({ token, email, onVerified }: { token: string; email: string | null; onVerified: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const send = useMutation({ mutationFn: () => api.post<{ sentTo: string }>(`/public/stay/${token}/code`) });
  const verify = useMutation({ mutationFn: () => api.post(`/public/stay/${token}/verify`, { code }), onSuccess: onVerified });
  return (
    <GuestCard className="flex flex-col gap-4 p-5">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-soft text-on-brand-soft">
        <ShieldCheck size={22} aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">{t('guest.verifyTitle')}</h1>
        <p className="text-sm text-muted">{t('guest.verifyText', { email: email ?? '' })}</p>
      </div>
      <ErrorText error={send.error ?? verify.error} />
      {!send.data ? (
        <Button className="min-h-12" loading={send.isPending} onClick={() => send.mutate()}>
          {t('guest.sendCode')}
        </Button>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate();
          }}
        >
          <Alert tone="green">{t('guest.codeSent', { email: send.data.sentTo })}</Alert>
          <Field label={t('guest.code')}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="text-center text-lg tracking-[0.4em]"
              />
            )}
          </Field>
          <Button type="submit" className="min-h-12" loading={verify.isPending} disabled={code.length !== 6}>
            {t('guest.verify')}
          </Button>
          <button type="button" className="min-h-11 text-sm text-accent hover:underline" onClick={() => send.mutate()}>
            {t('guest.resend')}
          </button>
        </form>
      )}
    </GuestCard>
  );
}

function Done({ token, view }: { token: string; view: StayView }) {
  const { t, locale } = useI18n();
  const b = view.booking;
  const steps = [
    { done: true, title: t('guest.stepBooked'), detail: `${b.code}` },
    { done: true, title: t('guest.stepCheckedIn'), detail: b.estimatedArrival ?? '' },
    { done: false, title: t('guest.stepKey'), detail: `${stayDate(b.arrival, locale, false)}, ${t('guest.checkInFrom', { time: view.hotel.checkInTime })}` },
    { done: false, title: t('guest.stepCheckout'), detail: `${stayDate(b.departure, locale, false)}, ${t('guest.checkOutUntil', { time: view.hotel.checkOutTime })}` },
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-success-soft text-success">
          <Check size={28} strokeWidth={2} aria-hidden />
        </span>
        <h1 className="font-display text-[34px] leading-[38px] font-medium">{t('guest.doneTitle')}</h1>
        <p className="max-w-xs text-muted">{t('guest.doneText')}</p>
      </div>
      <GuestCard className="flex flex-col items-center gap-1.5 px-4 py-6">
        <span className="eyebrow">{t('guest.bookingCode')}</span>
        <span className="font-mono text-3xl font-medium tracking-[0.12em] text-ink">{b.code}</span>
      </GuestCard>
      <GuestCard className="p-4">
        <ol className="flex flex-col gap-3.5">
          {steps.map((s) => (
            <li key={s.title} className="flex gap-3">
              {s.done ? (
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success-soft text-success">
                  <Check size={14} strokeWidth={2.5} aria-hidden />
                </span>
              ) : (
                <span className="h-6 w-6 shrink-0 rounded-full border border-line-strong" />
              )}
              <span className="flex flex-col">
                <span className="font-medium">{s.title}</span>
                {s.detail && <span className="text-xs text-muted">{s.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      </GuestCard>
      <Link href={`/stay/${token}`} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-subtle">
        {t('guest.backToStay')}
      </Link>
    </div>
  );
}

export default function CheckInPage() {
  const { token } = useParams<{ token: string }>();
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stay', token], queryFn: () => api.get<StayView>(`/public/stay/${token}`), retry: false });
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const [main, setMain] = useState({ birthDate: '', nationality: '', documentType: '', documentNumber: '', address: '', country: '' });
  const [companions, setCompanions] = useState<Person[]>([]);
  const [arrival, setArrival] = useState('');
  const [requests, setRequests] = useState('');
  const [marketing, setMarketing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState<StayView | null>(null);

  const data = q.data;
  useEffect(() => {
    if (!data?.checkin) return;
    const g = data.checkin.mainGuest;
    setMain((m) => ({
      ...m,
      birthDate: g.birthDate ?? '',
      nationality: g.nationality ?? '',
      documentType: g.documentType ?? '',
      address: g.address ?? '',
      country: g.country ?? '',
    }));
    const others = Math.max(0, data.booking.adults + data.booking.children - 1);
    setCompanions(
      Array.from({ length: others }, (_, i) => {
        const c = data.checkin!.companions[i];
        return c
          ? { firstName: c.firstName, lastName: c.lastName, birthDate: c.birthDate ?? '', nationality: c.nationality ?? '', documentType: c.documentType ?? '', documentNumber: '' }
          : { ...emptyPerson };
      }),
    );
    setArrival(data.booking.estimatedArrival ?? '');
    setRequests(data.booking.requests ?? '');
  }, [data]);

  const submit = useMutation({
    mutationFn: () =>
      api.post<StayView>(`/public/stay/${token}/check-in`, {
        mainGuest: {
          birthDate: main.birthDate,
          nationality: main.nationality,
          documentType: main.documentType,
          documentNumber: main.documentNumber,
          address: orNull(main.address),
          country: orNull(main.country),
        },
        companions: companions
          .filter((c) => c.firstName.trim() && c.lastName.trim())
          .map((c) => ({
            firstName: c.firstName,
            lastName: c.lastName,
            birthDate: orNull(c.birthDate),
            nationality: orNull(c.nationality),
            documentType: orNull(c.documentType),
            documentNumber: orNull(c.documentNumber),
          })),
        estimatedArrival: orNull(arrival),
        requests: orNull(requests),
        marketingConsent: marketing,
        confirm: confirmed,
      }),
    onSuccess: (view) => {
      qc.setQueryData(['stay', token], view);
      setDone(view);
      window.scrollTo({ top: 0 });
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error || !data)
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert>{t('guest.linkInvalid')}</Alert>
      </div>
    );
  const b = data.booking;
  const slots = t('guest.arrivalSlots').split('|');
  const total = b.adults + b.children;
  const countrySelect = (id: string, value: string, onChange: (v: string) => void, required?: boolean) => (
    <Select id={id} required={required} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('guest.selectOption')}</option>
      {countries.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </Select>
  );
  const documentSelect = (id: string, value: string, onChange: (v: string) => void, required?: boolean) => (
    <Select id={id} required={required} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('guest.selectOption')}</option>
      {DOCUMENT_TYPES.map((d) => (
        <option key={d} value={d}>
          {t(`docTypes.${d}`)}
        </option>
      ))}
    </Select>
  );
  const setCompanion = (i: number, patch: Partial<Person>) => setCompanions((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <div className="min-h-screen bg-canvas">
      <HotelHeader
        name={t('guest.onlineCheckin')}
        compact
        back={
          <Link href={`/stay/${token}`} aria-label={t('guest.backToStay')} className="-ml-3 grid h-11 w-11 place-items-center rounded-lg text-white hover:bg-white/10">
            <ChevronLeft size={20} />
          </Link>
        }
      />
      <div className="bg-navy-800 px-4 pb-3 text-xs text-[#c7d1ea]">
        <div className="mx-auto max-w-xl">
          {data.hotel.name} · {stayDate(b.arrival, locale, false)} – {stayDate(b.departure, locale, false)} · {b.code}
        </div>
      </div>

      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6">
        {done ? (
          <Done token={token} view={done} />
        ) : !data.verified ? (
          <Verify token={token} email={data.guest.email} onVerified={() => void q.refetch()} />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              submit.mutate();
            }}
          >
            <GuestCard className="flex flex-col gap-3.5 p-4">
              <div className="flex flex-col gap-0.5">
                <span className="eyebrow">
                  {t('guest.guestNofM', { n: 1, m: total })} · {t('guest.mainGuest').toLowerCase()}
                </span>
                <h2 className="text-base font-semibold">
                  {data.guest.firstName} {data.guest.lastName}
                </h2>
              </div>
              <Field label={t('guest.birthDate')}>{(id) => <Input id={id} type="date" required value={main.birthDate} onChange={(e) => setMain({ ...main, birthDate: e.target.value })} />}</Field>
              <Field label={t('guest.nationality')}>{(id) => countrySelect(id, main.nationality, (v) => setMain({ ...main, nationality: v }), true)}</Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('guest.idDocument')}>{(id) => documentSelect(id, main.documentType, (v) => setMain({ ...main, documentType: v }), true)}</Field>
                <Field label={t('guest.documentNumber')} hint={data.checkin?.mainGuest.documentNumber ?? undefined}>
                  {(id) => <Input id={id} required autoComplete="off" value={main.documentNumber} onChange={(e) => setMain({ ...main, documentNumber: e.target.value })} />}
                </Field>
              </div>
              <Field label={t('guest.homeAddress')}>{(id) => <Input id={id} autoComplete="street-address" value={main.address} onChange={(e) => setMain({ ...main, address: e.target.value })} />}</Field>
              <Field label={t('guest.residence')}>{(id) => countrySelect(id, main.country, (v) => setMain({ ...main, country: v }))}</Field>
            </GuestCard>

            {companions.map((c, i) => (
              <GuestCard key={i} className="flex flex-col gap-3.5 p-4">
                <span className="eyebrow">{t('guest.guestNofM', { n: i + 2, m: total })}</span>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('guest.firstName')}>{(id) => <Input id={id} value={c.firstName} onChange={(e) => setCompanion(i, { firstName: e.target.value })} />}</Field>
                  <Field label={t('guest.lastName')}>{(id) => <Input id={id} value={c.lastName} onChange={(e) => setCompanion(i, { lastName: e.target.value })} />}</Field>
                </div>
                <Field label={t('guest.birthDate')}>{(id) => <Input id={id} type="date" value={c.birthDate} onChange={(e) => setCompanion(i, { birthDate: e.target.value })} />}</Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('guest.idDocument')}>{(id) => documentSelect(id, c.documentType, (v) => setCompanion(i, { documentType: v }))}</Field>
                  <Field label={t('guest.documentNumber')}>{(id) => <Input id={id} autoComplete="off" value={c.documentNumber} onChange={(e) => setCompanion(i, { documentNumber: e.target.value })} />}</Field>
                </div>
                <p className="text-xs text-muted">{t('guest.companionOptional')}</p>
              </GuestCard>
            ))}

            <GuestCard className="flex flex-col gap-3.5 p-4">
              <h2 className="text-base font-semibold">{t('guest.yourArrival')}</h2>
              <Field label={t('guest.estimatedArrival')}>
                {(id) => (
                  <Select id={id} value={arrival} onChange={(e) => setArrival(e.target.value)}>
                    <option value="">{t('guest.selectOption')}</option>
                    {[...new Set([...(arrival && !slots.includes(arrival) ? [arrival] : []), ...slots])].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('guest.prepare')}>{(id) => <Textarea id={id} value={requests} onChange={(e) => setRequests(e.target.value)} />}</Field>
            </GuestCard>

            <div className="flex flex-col gap-3 px-1">
              <Checkbox label={t('guest.confirmDetails')} checked={confirmed} onChange={setConfirmed} />
              <Checkbox label={t('guest.offers', { hotel: data.hotel.name })} checked={marketing} onChange={setMarketing} />
            </div>
            <ErrorText error={submit.error} />
            <Button type="submit" className="min-h-12 text-base" loading={submit.isPending} disabled={!confirmed}>
              {t('guest.completeCheckin')}
            </Button>
            <p className="flex gap-2 text-xs text-muted">
              <ShieldCheck size={16} className="shrink-0" aria-hidden />
              {t('guest.idPrivacy')}
            </p>
          </form>
        )}
      </main>
      <PoweredBy />
    </div>
  );
}
