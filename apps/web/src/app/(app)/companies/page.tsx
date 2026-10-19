'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Checkbox, ErrorText, Field, Forbidden, Input, Modal, PageHeader, Spinner, Table, Td, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Company, Paged } from '@/lib/types';

const blank = { name: '', taxId: '', registrationNumber: '', address: '', city: '', country: 'RO', email: '', phone: '', isAgency: false, commissionPercent: 0, notes: '' };

function CompanyForm({ company, onDone }: { company?: Company; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState(() => (company ? { ...blank, ...Object.fromEntries(Object.entries(company).map(([k, v]) => [k, v ?? ''])) } : blank) as typeof blank);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => {
      const n = (v: string) => (v.trim() ? v.trim() : null);
      const body = {
        name: f.name,
        taxId: n(f.taxId),
        registrationNumber: n(f.registrationNumber),
        address: n(f.address),
        city: n(f.city),
        country: f.country.toUpperCase() || 'RO',
        email: n(f.email),
        phone: n(f.phone),
        isAgency: f.isAgency,
        commissionPercent: Number(f.commissionPercent) || 0,
        notes: n(f.notes),
      };
      return company ? api.patch(`/companies/${company.id}`, body) : api.post('/companies', body);
    },
    onSuccess: onDone,
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <ErrorText error={m.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')} className="sm:col-span-2">
          {(id) => <Input id={id} required value={f.name} onChange={set('name')} />}
        </Field>
        <Field label={t('companies.taxId')}>{(id) => <Input id={id} value={f.taxId} onChange={set('taxId')} />}</Field>
        <Field label={t('companies.regNo')}>{(id) => <Input id={id} value={f.registrationNumber} onChange={set('registrationNumber')} />}</Field>
        <Field label={t('common.address')} className="sm:col-span-2">
          {(id) => <Input id={id} value={f.address} onChange={set('address')} />}
        </Field>
        <Field label={t('common.city')}>{(id) => <Input id={id} value={f.city} onChange={set('city')} />}</Field>
        <Field label={t('common.country')}>{(id) => <Input id={id} maxLength={2} value={f.country} onChange={set('country')} />}</Field>
        <Field label={t('common.email')}>{(id) => <Input id={id} type="email" value={f.email} onChange={set('email')} />}</Field>
        <Field label={t('common.phone')}>{(id) => <Input id={id} value={f.phone} onChange={set('phone')} />}</Field>
        <Field label={t('companies.commission')}>
          {(id) => <Input id={id} type="number" min={0} max={100} step="0.5" value={f.commissionPercent} onChange={set('commissionPercent')} />}
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox label={t('companies.agency')} checked={f.isAgency} onChange={(v) => setF({ ...f, isAgency: v })} />
        </div>
        <Field label={t('common.notes')} className="sm:col-span-2">
          {(id) => <Textarea id={id} value={f.notes} onChange={set('notes')} />}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={m.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

export default function CompaniesPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Company | 'new' | null>(null);
  const list = useQuery({ queryKey: ['companies', q], queryFn: () => api.get<Paged<Company>>('/companies', { q, pageSize: 100 }), enabled: can('guests.read') });
  if (!can('guests.read')) return <Forbidden />;
  return (
    <>
      <PageHeader
        eyebrow={t('nav.crm')}
        title={t('companies.title')}
        actions={
          can('guests.manage') && (
            <Button onClick={() => setEdit('new')}>
              <Plus size={16} /> {t('companies.new')}
            </Button>
          )
        }
      />
      <Card padded={false}>
        <div className="border-b border-line p-3">
          <div className="relative">
            <Search size={16} className="absolute top-2.5 left-3 text-faint" />
            <Input className="pl-9" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {list.isLoading ? (
          <Spinner />
        ) : (
          <Table head={[t('common.name'), t('companies.taxId'), t('common.city'), t('common.email'), '']} empty={!list.data?.items.length}>
            {list.data?.items.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">
                  {c.name} {c.isAgency && <Badge tone="amber">{t('companies.agency')}</Badge>}
                </Td>
                <Td>{c.taxId ?? '—'}</Td>
                <Td>{c.city ?? '—'}</Td>
                <Td className="text-muted">{c.email ?? '—'}</Td>
                <Td className="text-right">
                  {can('guests.manage') && (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(c)}>
                      {t('common.edit')}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === 'new' ? t('companies.new') : t('common.edit')} wide>
        {edit && (
          <CompanyForm
            company={edit === 'new' ? undefined : edit}
            onDone={() => {
              setEdit(null);
              void qc.invalidateQueries({ queryKey: ['companies'] });
            }}
          />
        )}
      </Modal>
    </>
  );
}
