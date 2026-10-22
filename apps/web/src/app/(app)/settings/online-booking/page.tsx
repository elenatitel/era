'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PropertyGate } from '@/components/property-gate';
import { Alert, Badge, Button, Card, Checkbox, ErrorText, Field, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { PromoCode, Property, RatePlan, RoomType } from '@/lib/types';

interface Settings {
  slug: string | null;
  enabled: boolean;
  stripePublishableKey: string | null;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  paymentsEnabled: boolean;
  bookingUrl: string | null;
  webhookUrl: string | null;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label}>
      {(id) => (
        <div className="flex gap-2">
          <Input id={id} readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {}
            }}
          >
            <Copy size={14} /> {copied ? t('online.copied') : t('online.copy')}
          </Button>
        </div>
      )}
    </Field>
  );
}

/** Builds booking links with dates, guests, room, rate, promo code and language pre-filled. */
function LinkBuilder({ property, bookingUrl }: { property: Property; bookingUrl: string }) {
  const { t } = useI18n();
  const rooms = useQuery({ queryKey: ['room-types', property.id], queryFn: () => api.get<RoomType[]>('/room-types', { propertyId: property.id }) });
  const plans = useQuery({ queryKey: ['rate-plans', property.id], queryFn: () => api.get<RatePlan[]>('/rate-plans', { propertyId: property.id }) });
  const promos = useQuery({ queryKey: ['promo-codes', property.id], queryFn: () => api.get<PromoCode[]>('/promo-codes', { propertyId: property.id }) });
  const [f, setF] = useState({ arrival: '', departure: '', adults: '2', children: '0', room: '', rate: '', promo: '', lang: '' });
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === 'adults' && v === '2') && !(k === 'children' && v === '0')) params.set(k, v);
  const url = params.size ? `${bookingUrl}?${params}` : bookingUrl;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title={t('extras.linkBuilder')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('extras.linkHint')}</p>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
          <Field label={t('guest.arrival')}>{(id) => <Input id={id} type="date" min={property.businessDate} value={f.arrival} onChange={set('arrival')} />}</Field>
          <Field label={t('guest.departure')}>{(id) => <Input id={id} type="date" min={f.arrival || property.businessDate} value={f.departure} onChange={set('departure')} />}</Field>
          <Field label={t('guest.adults')}>
            {(id) => <Select id={id} value={f.adults} onChange={set('adults')}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n}>{n}</option>)}</Select>}
          </Field>
          <Field label={t('guest.children')}>
            {(id) => <Select id={id} value={f.children} onChange={set('children')}>{[0, 1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</Select>}
          </Field>
          <Field label={t('reservations.roomType')}>
            {(id) => (
              <Select id={id} value={f.room} onChange={set('room')}>
                <option value="">{t('extras.anyRoom')}</option>
                {rooms.data?.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('reservations.ratePlan')}>
            {(id) => (
              <Select id={id} value={f.rate} onChange={set('rate')}>
                <option value="">{t('extras.anyRate')}</option>
                {plans.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('guest.promoCode')}>
            {(id) => (
              <Select id={id} value={f.promo} onChange={set('promo')}>
                <option value="">{t('extras.noPromo')}</option>
                {promos.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.code}>{p.code}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('extras.language')}>
            {(id) => (
              <Select id={id} value={f.lang} onChange={set('lang')}>
                <option value="">—</option>
                <option value="en">English</option>
                <option value="ro">Română</option>
              </Select>
            )}
          </Field>
        </div>
        <CopyField label={t('online.bookingUrl')} value={url} />
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-sm text-accent hover:underline">
          <ExternalLink size={14} /> {t('extras.open')}
        </a>
      </div>
    </Card>
  );
}

function OnlineBooking({ property }: { property: Property }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['online-booking', property.id], queryFn: () => api.get<Settings>(`/properties/${property.id}/online-booking`) });
  const [slug, setSlug] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [pk, setPk] = useState('');
  const [sk, setSk] = useState('');
  const [whsec, setWhsec] = useState('');
  useEffect(() => {
    if (!q.data) return;
    setSlug(q.data.slug ?? slugify(property.name));
    setEnabled(q.data.enabled);
    setPk(q.data.stripePublishableKey ?? '');
  }, [q.data, property.name]);
  const save = useMutation({
    mutationFn: () =>
      api.put<Settings>(`/properties/${property.id}/online-booking`, {
        slug,
        enabled,
        stripePublishableKey: pk.trim() || null,
        ...(sk.trim() ? { stripeSecretKey: sk.trim() } : {}),
        ...(whsec.trim() ? { stripeWebhookSecret: whsec.trim() } : {}),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['online-booking', property.id], data);
      setSk('');
      setWhsec('');
    },
  });

  if (q.isLoading) return <Spinner />;
  const d = q.data!;
  return (
    <>
      <PageHeader eyebrow={property.name} title={t('online.title')} />
      <form
        className="flex max-w-3xl flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <ErrorText error={q.error ?? save.error} />
        {save.isSuccess && <Alert tone="green">{t('common.saved')}</Alert>}
        <Card title={t('online.bookingUrl')} actions={<Badge tone={d.enabled ? 'green' : 'gray'}>{d.enabled ? t('common.active') : t('common.inactive')}</Badge>}>
          <div className="flex flex-col gap-4">
            <Field label={t('online.address')} hint={t('online.addressHint')}>
              {(id) => <Input id={id} required pattern="[a-z0-9][a-z0-9\-]{1,46}[a-z0-9]" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />}
            </Field>
            <Checkbox label={t('online.enabled')} checked={enabled} onChange={setEnabled} />
            {d.bookingUrl && (
              <div className="flex flex-col gap-2">
                <CopyField label={t('online.bookingUrl')} value={d.bookingUrl} />
                <a href={d.bookingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                  <ExternalLink size={14} /> {d.bookingUrl}
                </a>
              </div>
            )}
          </div>
        </Card>

        <Card title={t('online.stripe')} actions={<Badge tone={d.paymentsEnabled ? 'green' : 'gray'}>{d.paymentsEnabled ? t('online.paymentsOn') : t('common.inactive')}</Badge>}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">{t('online.stripeHint')}</p>
            {!d.paymentsEnabled && <Alert tone="blue">{t('online.paymentsOff')}</Alert>}
            <Field label={t('online.publishableKey')}>{(id) => <Input id={id} placeholder="pk_live_…" autoComplete="off" value={pk} onChange={(e) => setPk(e.target.value)} />}</Field>
            <Field label={t('online.secretKey')} hint={d.hasSecretKey ? t('online.saved') : undefined}>
              {(id) => <Input id={id} type="password" placeholder={d.hasSecretKey ? '••••••••' : 'sk_live_…'} autoComplete="new-password" value={sk} onChange={(e) => setSk(e.target.value)} />}
            </Field>
            {d.webhookUrl && <CopyField label={t('online.webhookUrl')} value={d.webhookUrl} />}
            <p className="text-xs text-muted">{t('online.webhookHint')}</p>
            <Field label={t('online.webhookSecret')} hint={d.hasWebhookSecret ? t('online.saved') : undefined}>
              {(id) => <Input id={id} type="password" placeholder={d.hasWebhookSecret ? '••••••••' : 'whsec_…'} autoComplete="new-password" value={whsec} onChange={(e) => setWhsec(e.target.value)} />}
            </Field>
          </div>
        </Card>
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      {d.bookingUrl && d.enabled && (
        <div className="mt-6 max-w-3xl">
          <LinkBuilder property={property} bookingUrl={d.bookingUrl} />
        </div>
      )}
    </>
  );
}

export default function OnlineBookingPage() {
  return <PropertyGate perms={['property.manage']}>{(p) => <OnlineBooking property={p} />}</PropertyGate>;
}
