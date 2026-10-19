'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Permission } from '@pms/shared';
import { Badge, Button, Card, Checkbox, ErrorText, Field, Forbidden, Input, Modal, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Role {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  permissions: string[];
  system: boolean;
  members: number;
}
interface Catalogue {
  permissions: { key: Permission; description: string }[];
  groups: Record<string, Permission[]>;
}

function RoleEditor({ role, catalogue, onDone }: { role?: Role; catalogue: Catalogue; onDone: () => void }) {
  const { t } = useI18n();
  const { can, me } = useSession();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: description || null, permissions: perms };
      return role ? api.put(`/roles/${role.id}`, body) : api.post('/roles', body);
    },
    onSuccess: onDone,
  });
  const desc = Object.fromEntries(catalogue.permissions.map((p) => [p.key, p.description]));
  const isOwner = me.role?.key === 'owner';
  return (
    <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <ErrorText error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')}>{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t('common.description')}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {Object.entries(catalogue.groups).map(([group, list]) => (
          <fieldset key={group} className="rounded-xl border border-line p-3">
            <legend className="px-1 text-sm font-semibold">{t(`perm.${group}`)}</legend>
            <div className="space-y-1.5">
              {list.map((p) => (
                <Checkbox
                  key={p}
                  // You can only grant permissions you hold (enforced server-side too).
                  disabled={!isOwner && !can(p)}
                  checked={perms.includes(p)}
                  onChange={(v) => setPerms(v ? [...perms, p] : perms.filter((x) => x !== p))}
                  label={
                    <span>
                      <span className="code">{p}</span>
                      <span className="block text-xs text-muted">{desc[p]}</span>
                    </span>
                  }
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
      </div>
    </form>
  );
}

export default function RolesPage() {
  const { t } = useI18n();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const manage = can('roles.manage');
  const roles = useQuery({ queryKey: ['roles-full'], queryFn: () => api.get<Role[]>('/roles'), enabled: can('users.read') });
  const catalogue = useQuery({ queryKey: ['permission-catalogue'], queryFn: () => api.get<Catalogue>('/permissions'), enabled: manage });
  const [edit, setEdit] = useState<Role | 'new' | null>(null);
  const del = useMutation({ mutationFn: (id: string) => api.del(`/roles/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['roles-full'] }) });

  if (!can('users.read')) return <Forbidden />;
  if (roles.isLoading) return <Spinner />;
  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('settings.roles')} actions={manage && <Button onClick={() => setEdit('new')}><Plus size={16} /> {t('settings.newRole')}</Button>} />
      <ErrorText error={roles.error ?? del.error} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {roles.data?.map((r) => (
          <Card key={r.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{r.name}</h3>
                <p className="text-xs text-muted">{r.description}</p>
              </div>
              {r.system ? <Badge tone="brand"><Lock size={10} className="mr-1" />{t('settings.system')}</Badge> : null}
            </div>
            <p className="mt-3 text-xs text-muted">
              {r.permissions.length} {t('settings.permissions').toLowerCase()} · {r.members} {t('settings.members')}
            </p>
            {manage && !r.system && r.id !== me.role?.id && (
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEdit(r)}>{t('common.edit')}</Button>
                {r.members === 0 && <Button size="sm" variant="ghost" onClick={() => confirm(`${t('common.delete')} ${r.name}?`) && del.mutate(r.id)}>{t('common.delete')}</Button>}
              </div>
            )}
          </Card>
        ))}
      </div>
      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === 'new' ? t('settings.newRole') : (edit?.name ?? '')} wide>
        {edit && catalogue.data && (
          <RoleEditor
            role={edit === 'new' ? undefined : edit}
            catalogue={catalogue.data}
            onDone={() => {
              setEdit(null);
              void qc.invalidateQueries({ queryKey: ['roles-full'] });
            }}
          />
        )}
      </Modal>
    </>
  );
}
