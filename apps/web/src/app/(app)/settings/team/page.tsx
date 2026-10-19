'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Checkbox, ErrorText, Field, Forbidden, Input, Modal, PageHeader, Select, Spinner, Table, Td, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  status: string;
  propertyIds: string[];
  roleId: string;
  roleName: string;
  roleKey: string | null;
}
interface Role {
  id: string;
  name: string;
  key: string | null;
}

function AccessForm({ roles, initial, onSubmit, submitLabel, withEmail, pending, error }: {
  roles: Role[];
  initial: { email?: string; roleId: string; propertyIds: string[] };
  onSubmit: (v: { email: string; roleId: string; propertyIds: string[] }) => void;
  submitLabel: string;
  withEmail?: boolean;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useI18n();
  const { properties } = useSession();
  const [email, setEmail] = useState(initial.email ?? '');
  const [roleId, setRoleId] = useState(initial.roleId);
  const [propertyIds, setPropertyIds] = useState<string[]>(initial.propertyIds);
  return (
    <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), onSubmit({ email, roleId, propertyIds }))}>
      <ErrorText error={error} />
      {withEmail && <Field label={t('common.email')}>{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>}
      <Field label={t('settings.role')}>
        {(id) => (
          <Select id={id} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}
      </Field>
      <div>
        <p className="mb-2 text-sm font-medium">{t('settings.properties')}</p>
        <div className="space-y-1.5">
          <Checkbox label={t('settings.allProperties')} checked={propertyIds.length === 0} onChange={(v) => v && setPropertyIds([])} />
          {properties.map((p) => (
            <Checkbox
              key={p.id}
              label={p.name}
              checked={propertyIds.includes(p.id)}
              onChange={(v) => setPropertyIds(v ? [...propertyIds, p.id] : propertyIds.filter((x) => x !== p.id))}
            />
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>{submitLabel}</Button>
      </div>
    </form>
  );
}

export default function TeamPage() {
  const { t, locale } = useI18n();
  const { can, me, properties } = useSession();
  const qc = useQueryClient();
  const manage = can('users.manage');
  const members = useQuery({ queryKey: ['members'], queryFn: () => api.get<Member[]>('/members'), enabled: can('users.read') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles'), enabled: can('users.read') });
  const invites = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api.get<{ id: string; email: string; roleId: string; expiresAt: string }[]>('/invitations'),
    enabled: manage,
  });
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members'] });
    void qc.invalidateQueries({ queryKey: ['invitations'] });
  };
  const invite = useMutation({ mutationFn: (v: { email: string; roleId: string; propertyIds: string[] }) => api.post('/invitations', v), onSuccess: () => (setInviting(false), refresh()) });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; roleId?: string; propertyIds?: string[]; status?: string }) => api.patch(`/members/${id}`, body),
    onSuccess: () => (setEditing(null), refresh()),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/members/${id}`), onSuccess: refresh });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/invitations/${id}`), onSuccess: refresh });

  if (!can('users.read')) return <Forbidden />;
  if (members.isLoading || roles.isLoading) return <Spinner />;
  const propName = (ids: string[]) => (ids.length ? ids.map((id) => properties.find((p) => p.id === id)?.name ?? '?').join(', ') : t('settings.allProperties'));
  const roleName = (id: string) => roles.data?.find((r) => r.id === id)?.name ?? '';

  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('settings.team')} actions={manage && <Button onClick={() => setInviting(true)}><UserPlus size={16} /> {t('settings.invite')}</Button>} />
      <ErrorText error={members.error ?? update.error ?? remove.error ?? revoke.error} />
      <Card padded={false}>
        <Table head={[t('common.name'), t('settings.role'), t('settings.properties'), t('settings.lastLogin'), t('common.status'), '']}>
          {members.data?.map((m) => (
            <tr key={m.id}>
              <Td>
                <span className="font-medium">{m.name}</span>
                {m.mfaEnabled && <ShieldCheck size={14} className="ml-1 inline text-success" aria-label="2FA" />}
                <span className="block text-xs text-muted">{m.email}</span>
              </Td>
              <Td>{m.roleName}</Td>
              <Td className="max-w-48 truncate text-muted">{propName(m.propertyIds)}</Td>
              <Td className="text-muted">{dateTime(m.lastLoginAt, locale)}</Td>
              <Td><Badge tone={statusTone[m.status]}>{m.status === 'active' ? t('common.active') : t('common.inactive')}</Badge></Td>
              <Td className="text-right whitespace-nowrap">
                {manage && m.userId !== me.user.id && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>{t('common.edit')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: m.id, status: m.status === 'active' ? 'disabled' : 'active' })}>
                      {m.status === 'active' ? t('settings.disable') : t('settings.enable')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => confirm(`${t('settings.remove')} ${m.name}?`) && remove.mutate(m.id)}>{t('settings.remove')}</Button>
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {manage && Boolean(invites.data?.length) && (
        <Card className="mt-6" title={t('settings.pendingInvites')} padded={false}>
          <Table head={[t('common.email'), t('settings.role'), '']}>
            {invites.data?.map((i) => (
              <tr key={i.id}>
                <Td>{i.email}</Td>
                <Td>{roleName(i.roleId)}</Td>
                <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>{t('common.cancel')}</Button></Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <Modal open={inviting} onClose={() => setInviting(false)} title={t('settings.invite')}>
        {inviting && roles.data && (
          <AccessForm roles={roles.data} withEmail initial={{ roleId: roles.data.find((r) => r.key === 'front_desk')?.id ?? roles.data[0]!.id, propertyIds: [] }} onSubmit={(v) => invite.mutate(v)} submitLabel={t('settings.invite')} pending={invite.isPending} error={invite.error} />
        )}
      </Modal>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing?.name ?? ''}>
        {editing && roles.data && (
          <AccessForm roles={roles.data} initial={{ roleId: editing.roleId, propertyIds: editing.propertyIds }} onSubmit={(v) => update.mutate({ id: editing.id, roleId: v.roleId, propertyIds: v.propertyIds })} submitLabel={t('common.save')} pending={update.isPending} error={update.error} />
        )}
      </Modal>
    </>
  );
}
