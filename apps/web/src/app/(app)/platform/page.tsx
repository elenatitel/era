'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ErrorText, Field, Forbidden, Input, Modal, PageHeader, Select, Spinner, Table, Td, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  requireMfa: boolean;
  createdAt: string;
  activeSessions: number;
}

export default function PlatformPage() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [f, setF] = useState({ name: '', slug: '', ownerEmail: '', ownerName: '', locale: 'ro' });
  const list = useQuery({ queryKey: ['platform-tenants'], queryFn: () => api.get<Tenant[]>('/platform/tenants'), enabled: me.user.isPlatformAdmin, retry: false });
  const create = useMutation({
    mutationFn: () => api.post('/platform/tenants', f),
    onSuccess: () => {
      setCreating(false);
      setNotice(t('platform.created'));
      setF({ name: '', slug: '', ownerEmail: '', ownerName: '', locale: 'ro' });
      void qc.invalidateQueries({ queryKey: ['platform-tenants'] });
    },
  });
  const status = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/platform/tenants/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-tenants'] }),
  });

  if (!me.user.isPlatformAdmin) return <Forbidden />;
  const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

  return (
    <>
      <PageHeader eyebrow={t('nav.platform')} title={t('platform.title')} actions={<Button onClick={() => setCreating(true)} disabled={Boolean(list.error)}><Plus size={16} /> {t('platform.newTenant')}</Button>} />
      {notice && <div className="mb-4"><Alert tone="green">{notice}</Alert></div>}
      <ErrorText error={list.error ?? status.error} />
      {list.isLoading ? (
        <Spinner />
      ) : (
        list.data && (
          <Card padded={false}>
            <Table head={[t('common.name'), t('platform.slug'), t('common.status'), t('platform.sessions'), t('common.date'), '']} empty={!list.data.length}>
              {list.data.map((tn) => (
                <tr key={tn.id}>
                  <Td className="font-medium">{tn.name} {tn.requireMfa && <Badge tone="green">2FA</Badge>}</Td>
                  <Td><span className="code">{tn.slug}</span></Td>
                  <Td><Badge tone={statusTone[tn.status]}>{tn.status}</Badge></Td>
                  <Td>{tn.activeSessions}</Td>
                  <Td className="text-muted">{dateTime(tn.createdAt, locale)}</Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      variant={tn.status === 'active' ? 'ghost' : 'secondary'}
                      onClick={() => confirm(`${tn.status === 'active' ? t('platform.suspend') : t('platform.activate')} ${tn.name}?`) && status.mutate({ id: tn.id, status: tn.status === 'active' ? 'suspended' : 'active' })}
                    >
                      {tn.status === 'active' ? t('platform.suspend') : t('platform.activate')}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title={t('platform.newTenant')}>
        <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), create.mutate())}>
          <ErrorText error={create.error} />
          <Field label={t('common.name')}>{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: f.slug || slugify(e.target.value) })} />}</Field>
          <Field label={t('platform.slug')}>{(id) => <Input id={id} required pattern="[a-z0-9][a-z0-9-]{1,46}[a-z0-9]" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} />}</Field>
          <Field label={t('platform.ownerName')}>{(id) => <Input id={id} required value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} />}</Field>
          <Field label={t('platform.ownerEmail')}>{(id) => <Input id={id} type="email" required value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} />}</Field>
          <Field label={t('settings.defaultLocale')}>
            {(id) => (
              <Select id={id} value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value })}>
                <option value="ro">Română</option>
                <option value="en">English</option>
              </Select>
            )}
          </Field>
          <div className="flex justify-end"><Button type="submit" loading={create.isPending}>{t('common.create')}</Button></div>
        </form>
      </Modal>
    </>
  );
}
