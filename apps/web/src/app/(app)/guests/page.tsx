'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GUEST_SEGMENTS } from '@pms/shared';
import { GuestForm } from '@/components/guest-form';
import { Badge, Button, Card, ErrorText, Forbidden, Input, Modal, PageHeader, Pager, Select, Spinner, Table, Td, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Guest, Paged } from '@/lib/types';

export default function GuestsPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['guests', q, segment, page],
    queryFn: () => api.get<Paged<Guest>>('/guests', { q, segment, page, pageSize: 25 }),
    placeholderData: (p) => p,
    enabled: can('guests.read'),
  });
  if (!can('guests.read')) return <Forbidden />;
  return (
    <>
      <PageHeader
        title={t('guests.title')}
        actions={
          can('guests.manage') && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} /> {t('guests.new')}
            </Button>
          )
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <div className="relative min-w-60 flex-1">
            <Search size={16} className="absolute top-2.5 left-3 text-faint" />
            <Input className="pl-9" placeholder={t('common.search')} value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
          </div>
          <Select className="w-40" value={segment} onChange={(e) => (setSegment(e.target.value), setPage(1))}>
            <option value="">{t('common.all')}</option>
            {GUEST_SEGMENTS.map((s) => (
              <option key={s} value={s}>
                {t(`segments.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        {list.isLoading ? (
          <Spinner />
        ) : (
          <>
            <ErrorText error={list.error} />
            <Table head={[t('common.name'), t('common.email'), t('common.phone'), t('guests.segment'), t('reservations.company'), t('guests.stays')]} empty={!list.data?.items.length}>
              {list.data?.items.map((g) => (
                <tr key={g.id} className="hover:bg-subtle">
                  <Td>
                    <Link href={`/guests/${g.id}`} className="font-medium hover:text-accent">
                      {g.lastName} {g.firstName}
                    </Link>
                  </Td>
                  <Td className="text-muted">{g.email ?? '—'}</Td>
                  <Td className="text-muted">{g.phone ?? '—'}</Td>
                  <Td>
                    <Badge tone={statusTone[g.segment]}>{t(`segments.${g.segment}`)}</Badge>
                  </Td>
                  <Td>{g.companyName ?? '—'}</Td>
                  <Td>{g.stays}</Td>
                </tr>
              ))}
            </Table>
            <Pager page={page} pageSize={25} total={list.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title={t('guests.new')} wide>
        <GuestForm onSaved={(g) => router.push(`/guests/${g.id}`)} />
      </Modal>
    </>
  );
}
