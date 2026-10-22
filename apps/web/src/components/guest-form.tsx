'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DOCUMENT_TYPES, GUEST_SEGMENTS } from '@pms/shared';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Company, Guest, Paged } from '@/lib/types';
import { Button, Checkbox, ErrorText, Field, Input, Select, Textarea } from './ui';

const empty = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  nationality: '',
  birthDate: '',
  documentType: '',
  documentNumber: '',
  address: '',
  city: '',
  country: '',
  segment: 'standard',
  companyId: '',
  tags: '',
  notes: '',
  marketingConsent: false,
};

export function GuestForm({ guest, onSaved }: { guest?: Guest; onSaved: (g: Guest) => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const [f, setF] = useState(() =>
    guest
      ? {
          ...empty,
          ...Object.fromEntries(Object.entries(guest).map(([k, v]) => [k, v ?? ''])),
          tags: guest.tags.join(', '),
          // Masked values are never sent back.
          documentNumber: can('guests.pii') ? (guest.documentNumber ?? '') : '',
          marketingConsent: guest.marketingConsent,
        }
      : empty,
  );
  const companies = useQuery({ queryKey: ['companies-all'], queryFn: () => api.get<Paged<Company>>('/companies', { pageSize: 200 }) });
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => {
      const n = (v: string) => (v.trim() ? v.trim() : null);
      const body: Record<string, unknown> = {
        firstName: f.firstName,
        lastName: f.lastName,
        email: n(f.email),
        phone: n(f.phone),
        nationality: n(f.nationality)?.toUpperCase() ?? null,
        birthDate: n(f.birthDate),
        documentType: n(f.documentType),
        address: n(f.address),
        city: n(f.city),
        country: n(f.country)?.toUpperCase() ?? null,
        segment: f.segment,
        companyId: n(f.companyId),
        tags: f.tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        notes: n(f.notes),
        marketingConsent: f.marketingConsent,
      };
      if (can('guests.pii') || f.documentNumber) body.documentNumber = n(f.documentNumber);
      return guest ? api.patch<Guest>(`/guests/${guest.id}`, body) : api.post<Guest>('/guests', body);
    },
    onSuccess: onSaved,
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <ErrorText error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('reservations.firstName')}>{(id) => <Input id={id} required value={f.firstName} onChange={set('firstName')} />}</Field>
        <Field label={t('reservations.lastName')}>{(id) => <Input id={id} required value={f.lastName} onChange={set('lastName')} />}</Field>
        <Field label={t('common.email')}>{(id) => <Input id={id} type="email" value={f.email} onChange={set('email')} />}</Field>
        <Field label={t('common.phone')}>{(id) => <Input id={id} value={f.phone} onChange={set('phone')} />}</Field>
        <Field label={t('guests.segment')}>
          {(id) => (
            <Select id={id} value={f.segment} onChange={set('segment')}>
              {GUEST_SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {t(`segments.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('reservations.company')}>
          {(id) => (
            <Select id={id} value={f.companyId} onChange={set('companyId')}>
              <option value="">—</option>
              {companies.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('guests.nationality')} hint="ISO, ex. RO">
          {(id) => <Input id={id} maxLength={2} value={f.nationality} onChange={set('nationality')} />}
        </Field>
        <Field label={t('guests.birthDate')}>{(id) => <Input id={id} type="date" value={f.birthDate} onChange={set('birthDate')} />}</Field>
        <Field label={t('guests.documentType')}>
          {(id) => (
            <Select id={id} value={f.documentType} onChange={set('documentType')}>
              <option value="">—</option>
              {DOCUMENT_TYPES.map((d) => (
                <option key={d} value={d}>
                  {t(`docTypes.${d}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('guests.documentNumber')} hint={!can('guests.pii') && guest?.documentNumber ? guest.documentNumber : undefined}>
          {(id) => <Input id={id} autoComplete="off" value={f.documentNumber} onChange={set('documentNumber')} />}
        </Field>
        <Field label={t('common.address')} className="sm:col-span-2">
          {(id) => <Input id={id} value={f.address} onChange={set('address')} />}
        </Field>
        <Field label={t('common.city')}>{(id) => <Input id={id} value={f.city} onChange={set('city')} />}</Field>
        <Field label={t('common.country')} hint="ISO, ex. RO">
          {(id) => <Input id={id} maxLength={2} value={f.country} onChange={set('country')} />}
        </Field>
        <Field label={t('guests.tags')} className="sm:col-span-2" hint="vegetarian, late check-out, …">
          {(id) => <Input id={id} value={f.tags} onChange={set('tags')} />}
        </Field>
        <Field label={t('common.notes')} className="sm:col-span-2">
          {(id) => <Textarea id={id} value={f.notes} onChange={set('notes')} />}
        </Field>
      </div>
      <Checkbox label={t('guests.marketing')} checked={f.marketingConsent} onChange={(v) => setF({ ...f, marketingConsent: v })} />
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
