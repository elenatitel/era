'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, ErrorText, Forbidden, PageHeader, Select, Spinner, Table, Td } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Entry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
}

const ENTITIES = ['reservation', 'invoice', 'guest', 'membership', 'role', 'room', 'property', 'rate_plan', 'housekeeping_task', 'tenant', 'invitation'];

export default function AuditPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['audit', entityType, page],
    queryFn: () => api.get<{ items: Entry[] }>('/audit-log', { entityType, page, pageSize: 50 }),
    enabled: can('audit.read'),
    placeholderData: (p) => p,
  });
  if (!can('audit.read')) return <Forbidden />;
  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('settings.audit')} />
      <Card padded={false}>
        <div className="border-b border-line p-3">
          <Select className="w-56" value={entityType} onChange={(e) => (setEntityType(e.target.value), setPage(1))}>
            <option value="">{t('common.all')}</option>
            {ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
        </div>
        <ErrorText error={q.error} />
        {q.isLoading ? (
          <Spinner />
        ) : (
          <Table head={[t('common.date'), t('settings.user'), t('settings.action'), t('settings.entity'), t('common.details'), t('settings.ip')]} empty={!q.data?.items.length}>
            {q.data?.items.map((e) => (
              <tr key={e.id} className="align-top">
                <Td className="whitespace-nowrap text-muted">{dateTime(e.createdAt, locale)}</Td>
                <Td>{e.userName ?? '—'}<span className="block text-xs text-muted">{e.userEmail}</span></Td>
                <Td><Badge tone="brand">{e.action}</Badge></Td>
                <Td className="text-xs">{e.entityType}</Td>
                <Td><code className="block max-w-md truncate text-xs text-muted" title={JSON.stringify(e.metadata)}>{JSON.stringify(e.metadata)}</code></Td>
                <Td className="text-xs text-muted">{e.ip}</Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="flex justify-end gap-2 border-t border-line p-3">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.previous')}</Button>
          <Button size="sm" variant="secondary" disabled={(q.data?.items.length ?? 0) < 50} onClick={() => setPage(page + 1)}>{t('common.next')}</Button>
        </div>
      </Card>
    </>
  );
}
