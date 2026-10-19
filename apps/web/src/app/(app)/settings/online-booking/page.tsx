'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PropertyGate } from '@/components/property-gate';
import { Alert, Badge, Button, Card, Checkbox, ErrorText, Field, Input, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { Property } from '@/lib/types';

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
    </>
  );
}

export default function OnlineBookingPage() {
  return <PropertyGate perms={['property.manage']}>{(p) => <OnlineBooking property={p} />}</PropertyGate>;
}
