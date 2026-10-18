'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { CURRENCIES } from '@pms/shared';
import { Alert, Button, Card, ErrorText, Field, Forbidden, Input, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Property } from '@/lib/types';

const blank = {
  name: '', legalName: '', taxId: '', registrationNumber: '', address: '', city: '', country: 'RO', phone: '', email: '',
  timezone: 'Europe/Bucharest', currency: 'RON', checkInTime: '14:00', checkOutTime: '12:00',
  accommodationVatRate: '11', standardVatRate: '21', invoicePrefix: 'INV', proformaPrefix: 'PRO',
};

function PropertyForm({ property, onSaved }: { property: Property | null; onSaved: (p: Property) => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const editable = can('property.manage');
  const [f, setF] = useState(() =>
    property
      ? {
          ...blank,
          ...Object.fromEntries(Object.entries(property).map(([k, v]) => [k, v ?? ''])),
          accommodationVatRate: String(property.accommodationVatRate / 100),
          standardVatRate: String(property.standardVatRate / 100),
          invoicePrefix: '',
          proformaPrefix: '',
        }
      : blank,
  );
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => {
      const n = (v: string) => (String(v).trim() ? String(v).trim() : null);
      const body: Record<string, unknown> = {
        name: f.name, legalName: n(f.legalName), taxId: n(f.taxId), registrationNumber: n(f.registrationNumber), address: n(f.address),
        city: n(f.city), country: f.country.toUpperCase(), phone: n(f.phone), email: n(f.email), timezone: f.timezone,
        currency: f.currency, checkInTime: f.checkInTime, checkOutTime: f.checkOutTime,
        accommodationVatRate: Math.round(Number(f.accommodationVatRate) * 100), standardVatRate: Math.round(Number(f.standardVatRate) * 100),
      };
      if (f.invoicePrefix) body.invoicePrefix = f.invoicePrefix.toUpperCase();
      if (f.proformaPrefix) body.proformaPrefix = f.proformaPrefix.toUpperCase();
      return property ? api.patch<Property>(`/properties/${property.id}`, body) : api.post<Property>('/properties', body);
    },
    onSuccess: onSaved,
  });
  const fields: [keyof typeof blank, string, string?][] = [
    ['name', t('common.name')], ['legalName', t('settings.legalName')], ['taxId', t('settings.taxId')], ['registrationNumber', t('settings.regNo')],
    ['address', t('common.address')], ['city', t('common.city')], ['country', t('common.country')], ['phone', t('common.phone')], ['email', t('common.email')],
    ['timezone', t('settings.timezone')], ['checkInTime', t('settings.checkIn'), 'time'], ['checkOutTime', t('settings.checkOut'), 'time'],
    ['accommodationVatRate', t('settings.accommodationVat'), 'number'], ['standardVatRate', t('settings.standardVat'), 'number'],
    ['invoicePrefix', t('settings.invoicePrefix')], ['proformaPrefix', t('settings.proformaPrefix')],
  ];
  return (
    <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <ErrorText error={save.error} />
      {save.isSuccess && <Alert tone="green">{t('common.saved')}</Alert>}
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([k, label, type]) => (
          <Field key={k} label={label}>
            {(id) => (
              <Input
                id={id}
                type={type ?? 'text'}
                step={type === 'number' ? '0.01' : undefined}
                required={k === 'name'}
                placeholder={property && (k === 'invoicePrefix' || k === 'proformaPrefix') ? '—' : undefined}
                value={f[k]}
                onChange={set(k)}
              />
            )}
          </Field>
        ))}
        <Field label={t('settings.currency')}>
          {(id) => (
            <Select id={id} value={f.currency} onChange={set('currency')}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          )}
        </Field>
      </fieldset>
      {editable && (
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

export default function PropertySettingsPage() {
  const { t } = useI18n();
  const { can, property, properties, setPropertyId } = useSession();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(properties.length === 0);
  if (!can('property.read')) return <Forbidden />;
  return (
    <>
      <PageHeader
        title={t('settings.propertyTitle')}
        actions={
          can('property.manage') &&
          !creating && (
            <Button variant="secondary" onClick={() => setCreating(true)}>
              <Plus size={16} /> {t('settings.newProperty')}
            </Button>
          )
        }
      />
      <Card title={creating ? t('settings.newProperty') : property?.name}>
        {(creating || property) && (
          <PropertyForm
            key={creating ? 'new' : property!.id}
            property={creating ? null : property}
            onSaved={async (p) => {
              await qc.invalidateQueries({ queryKey: ['properties'] });
              setPropertyId(p.id);
              setCreating(false);
            }}
          />
        )}
      </Card>
    </>
  );
}
