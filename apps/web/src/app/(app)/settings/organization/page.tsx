'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, ErrorText, Field, Forbidden, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Settings {
  id: string;
  name: string;
  slug: string;
  requireMfa: boolean;
  defaultLocale: 'ro' | 'en';
}

export default function OrganizationPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tenant-settings'], queryFn: () => api.get<Settings>('/tenant/settings'), enabled: can('tenant.settings') });
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.patch('/tenant/settings', { name: f!.name, requireMfa: f!.requireMfa, defaultLocale: f!.defaultLocale }),
    onSuccess: () => qc.invalidateQueries(),
  });
  if (!can('tenant.settings')) return <Forbidden />;
  if (!f) return <Spinner />;
  return (
    <>
      <PageHeader title={t('settings.organization')} subtitle={f.slug} />
      <Card>
        <form className="max-w-xl space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
          <ErrorText error={save.error} />
          {save.isSuccess && <Alert tone="green">{t('common.saved')}</Alert>}
          <Field label={t('common.name')}>{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label={t('settings.defaultLocale')}>
            {(id) => (
              <Select id={id} value={f.defaultLocale} onChange={(e) => setF({ ...f, defaultLocale: e.target.value as 'ro' | 'en' })}>
                <option value="ro">Română</option>
                <option value="en">English</option>
              </Select>
            )}
          </Field>
          <Checkbox label={t('settings.requireMfa')} checked={f.requireMfa} onChange={(v) => setF({ ...f, requireMfa: v })} />
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
