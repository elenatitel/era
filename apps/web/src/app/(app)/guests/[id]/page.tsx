'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { GuestForm } from '@/components/guest-form';
import { Badge, Button, Card, ErrorText, Modal, PageHeader, Spinner, Table, Td, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Guest } from '@/lib/types';

type Detail = Guest & {
  lifetimeValue: number;
  history: { id: string; code: string; status: string; arrival: string; departure: string; totalAmount: number; currency: string }[];
};

export default function GuestPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useI18n();
  const { can, property } = useSession();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['guest', id], queryFn: () => api.get<Detail>(`/guests/${id}`) });
  const anonymize = useMutation({ mutationFn: () => api.post(`/guests/${id}/anonymize`), onSuccess: () => qc.invalidateQueries({ queryKey: ['guest', id] }) });
  const exportData = useMutation({
    mutationFn: () => api.get<unknown>(`/guests/${id}/gdpr-export`),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `guest-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const g = q.data!;
  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <>
        <dt className="text-muted">{label}</dt>
        <dd>{value}</dd>
      </>
    ) : null;

  return (
    <>
      <PageHeader
        eyebrow={t('nav.guests')}
        title={`${g.firstName} ${g.lastName}`}
        subtitle={<Badge tone={statusTone[g.segment]}>{t(`segments.${g.segment}`)}</Badge>}
        actions={
          <>
            {can('guests.manage') && !g.anonymizedAt && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
            )}
            {can('guests.gdpr') && (
              <>
                <Button variant="secondary" loading={exportData.isPending} onClick={() => exportData.mutate()}>
                  {t('guests.gdprExport')}
                </Button>
                {!g.anonymizedAt && (
                  <Button variant="danger" onClick={() => confirm(t('guests.anonymizeConfirm')) && anonymize.mutate()}>
                    {t('guests.anonymize')}
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      <ErrorText error={anonymize.error ?? exportData.error} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={t('common.details')}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {row(t('common.email'), g.email)}
            {row(t('common.phone'), g.phone)}
            {row(t('guests.nationality'), g.nationality)}
            {row(t('guests.birthDate'), g.birthDate && date(g.birthDate, locale))}
            {row(t('guests.document'), g.documentType && `${t(`docTypes.${g.documentType}`)} ${g.documentNumber ?? ''}`)}
            {row(t('common.address'), [g.address, g.city, g.country].filter(Boolean).join(', '))}
            {row(t('guests.tags'), g.tags.length ? g.tags.join(', ') : null)}
            {row(t('guests.marketing'), g.marketingConsent ? t('common.yes') : t('common.no'))}
          </dl>
          {g.notes && <p className="mt-4 rounded-lg bg-subtle p-3 text-sm whitespace-pre-wrap">{g.notes}</p>}
        </Card>
        <Card title={t('guests.history')} className="lg:col-span-2" padded={false}>
          <div className="border-b border-line px-5 py-3 text-sm">
            {t('guests.lifetimeValue')}: <strong>{money(g.lifetimeValue, property?.currency ?? 'RON', locale)}</strong>
          </div>
          <Table head={[t('reservations.code'), t('reservations.arrival'), t('reservations.departure'), t('common.status'), t('common.total')]} empty={!g.history.length}>
            {g.history.map((h) => (
              <tr key={h.id}>
                <Td>
                  <Link href={`/reservations/${h.id}`} className="code hover:underline">
                    {h.code}
                  </Link>
                </Td>
                <Td>{date(h.arrival, locale)}</Td>
                <Td>{date(h.departure, locale)}</Td>
                <Td>
                  <Badge tone={statusTone[h.status]}>{t(`resStatus.${h.status}`)}</Badge>
                </Td>
                <Td>{money(h.totalAmount, h.currency, locale)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      <Modal open={editing} onClose={() => setEditing(false)} title={t('common.edit')} wide>
        <GuestForm
          guest={g}
          onSaved={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: ['guest', id] });
          }}
        />
      </Modal>
    </>
  );
}
