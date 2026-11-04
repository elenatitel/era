'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lightbulb, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { GuestForm } from '@/components/guest-form';
import { Badge, Button, Card, ErrorText, Modal, PageHeader, Spinner, Table, Tabs, Td, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date, dateTime, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Guest } from '@/lib/types';

type Detail = Guest & {
  lifetimeValue: number;
  stats: { stays: number; nights: number; lastStay: string | null };
  history: { id: string; code: string; status: string; arrival: string; departure: string; totalAmount: number; currency: string; propertyName: string; roomNumber: string | null; guestRequests: string | null }[];
  invoices: { id: string; fullNumber: string; type: string; status: string; issueDate: string; total: number; currency: string }[];
  payments: { id: string; method: string; amount: number; currency: string; reference: string | null; createdAt: string }[];
  activity: { id: string; action: string; createdAt: string; userName: string | null }[];
  smartTipEnabled: boolean;
};
type Tab = 'overview' | 'profile' | 'stays' | 'billing' | 'activity';

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </Card>
  );
}

function Facts({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  const { t } = useI18n();
  const filled = rows.filter(([, v]) => v);
  return (
    <Card title={title}>
      {filled.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {filled.map(([label, value]) => (
            <Fact key={label} label={label} value={value} />
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted">{t('guests.nothingYet')}</p>
      )}
    </Card>
  );
}
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** What the guest told the hotel, summarized on demand. Always marked as AI, so staff check it. */
function SmartTip({ g }: { g: Detail }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const [empty, setEmpty] = useState(false);
  const refresh = useMutation({
    mutationFn: () => api.post<{ smartTip: string | null }>(`/guests/${g.id}/smart-tip`, { locale }),
    onSuccess: (r) => {
      setEmpty(!r.smartTip);
      void qc.invalidateQueries({ queryKey: ['guest', g.id] });
    },
  });
  if (!g.smartTip && !g.smartTipEnabled) return null;
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-info-soft p-2 text-info">
          <Lightbulb size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow text-info">{t('guests.smartTip')}</p>
          <ErrorText error={refresh.error} />
          {g.smartTip ? (
            <>
              <p className="mt-1 text-sm whitespace-pre-wrap">{g.smartTip}</p>
              <p className="mt-2 text-xs text-muted">
                {t('guests.smartTipCheck')}
                {g.smartTipAt && ` · ${dateTime(g.smartTipAt, locale)}`}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">{t(empty ? 'guests.smartTipEmpty' : 'guests.smartTipHint')}</p>
          )}
        </div>
        {g.smartTipEnabled && can('guests.manage') && !g.anonymizedAt && (
          <Button size="sm" variant="secondary" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            <Sparkles size={14} /> {t(g.smartTip ? 'guests.smartTipRefresh' : 'guests.smartTipCreate')}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function GuestPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useI18n();
  const { can, property } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
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
  const currency = property?.currency ?? 'RON';
  const upcoming = g.history.filter((h) => ['tentative', 'confirmed', 'checked_in'].includes(h.status)).at(-1);
  const requests = g.history.filter((h) => h.guestRequests);
  const stays = (
    <Table head={[t('reservations.code'), t('nav.property'), t('reservations.room'), t('reservations.arrival'), t('reservations.departure'), t('common.status'), t('common.total')]} empty={!g.history.length}>
      {g.history.map((h) => (
        <tr key={h.id}>
          <Td>
            <Link href={`/reservations/${h.id}`} className="code hover:underline">
              {h.code}
            </Link>
          </Td>
          <Td>{h.propertyName}</Td>
          <Td>{h.roomNumber ?? '—'}</Td>
          <Td>{date(h.arrival, locale)}</Td>
          <Td>{date(h.departure, locale)}</Td>
          <Td>
            <Badge tone={statusTone[h.status]}>{t(`resStatus.${h.status}`)}</Badge>
          </Td>
          <Td>{money(h.totalAmount, h.currency, locale)}</Td>
        </tr>
      ))}
    </Table>
  );

  return (
    <>
      <PageHeader
        eyebrow={t('nav.guests')}
        title={`${g.firstName} ${g.lastName}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge tone={statusTone[g.segment]}>{t(`segments.${g.segment}`)}</Badge>
            {g.tags.map((tag) => (
              <Badge key={tag} tone="gray">
                {tag}
              </Badge>
            ))}
          </span>
        }
        actions={
          can('guests.manage') &&
          !g.anonymizedAt && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t('common.edit')}
            </Button>
          )
        }
      />
      <ErrorText error={anonymize.error ?? exportData.error} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: t('guests.overview') },
          { value: 'profile', label: t('guests.profile') },
          { value: 'stays', label: `${t('guests.stays')} (${g.history.length})` },
          ...(can('invoices.read') || can('folio.read') ? [{ value: 'billing' as const, label: t('guests.billing') }] : []),
          { value: 'activity', label: t('guests.activity') },
        ]}
      />

      {tab === 'overview' && (
        <div className="space-y-6">
          <SmartTip g={g} />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label={t('guests.stays')} value={g.stats.stays} />
            <Stat label={t('reservations.nights')} value={g.stats.nights} />
            <Stat label={t('guests.lifetimeValue')} value={money(g.lifetimeValue, currency, locale)} />
            <Stat label={t('guests.lastStay')} value={g.stats.lastStay ? date(g.stats.lastStay, locale) : '—'} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Facts
              title={t('guests.contact')}
              rows={[
                [t('common.email'), g.email],
                [t('common.phone'), g.phone],
                [t('reservations.company'), g.companyName],
                [t('guests.language'), g.language],
              ]}
            />
            <Card title={t('guests.nextStay')}>
              {upcoming ? (
                <Link href={`/reservations/${upcoming.id}`} className="block text-sm hover:text-accent">
                  <span className="font-medium">
                    {date(upcoming.arrival, locale)} – {date(upcoming.departure, locale)}
                  </span>
                  <span className="block text-muted">
                    {upcoming.propertyName}
                    {upcoming.roomNumber && ` · ${upcoming.roomNumber}`}
                  </span>
                </Link>
              ) : (
                <p className="text-sm text-muted">{t('guests.noNextStay')}</p>
              )}
            </Card>
          </div>
          {(g.notes || requests.length > 0) && (
            <Card title={t('guests.saidByGuest')}>
              {g.notes && <p className="mb-3 rounded-lg bg-subtle p-3 text-sm whitespace-pre-wrap">{g.notes}</p>}
              <ul className="divide-y divide-line text-sm">
                {requests.map((h) => (
                  <li key={h.id} className="py-2">
                    <span className="block text-xs text-muted">{date(h.arrival, locale)}</span>
                    <span className="whitespace-pre-wrap">{h.guestRequests}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {tab === 'profile' && (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <Facts
              title={t('guests.personal')}
              rows={[
                [t('guests.nationality'), g.nationality],
                [t('guests.birthDate'), g.birthDate && date(g.birthDate, locale)],
                [t('guests.birthPlace'), g.birthPlace],
                [t('guests.language'), g.language],
                [t('guests.occupation'), g.occupation],
                [t('guests.marketing'), g.marketingConsent ? t('common.yes') : t('common.no')],
              ]}
            />
            <Facts title={t('guests.identity')} rows={[[t('guests.documentType'), g.documentType && t(`docTypes.${g.documentType}`)], [t('guests.documentNumber'), g.documentNumber]]} />
            <Facts
              title={t('guests.address')}
              rows={[
                [t('common.address'), g.address],
                [t('common.city'), g.city],
                [t('common.country'), g.country],
              ]}
            />
            <Facts
              title={t('guests.additional')}
              rows={[
                [t('guests.taxId'), g.taxId],
                [t('guests.carRegistration'), g.carRegistration],
                [t('reservations.company'), g.companyName],
              ]}
            />
          </div>
          {can('guests.gdpr') && (
            <Card title="GDPR">
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" loading={exportData.isPending} onClick={() => exportData.mutate()}>
                  {t('guests.gdprExport')}
                </Button>
                {!g.anonymizedAt && (
                  <Button variant="danger" onClick={() => confirm(t('guests.anonymizeConfirm')) && anonymize.mutate()}>
                    {t('guests.anonymize')}
                  </Button>
                )}
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'stays' && <Card padded={false}>{stays}</Card>}

      {tab === 'billing' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={t('nav.invoices')} padded={false}>
            <Table head={[t('invoices.number'), t('common.date'), t('common.status'), t('common.total')]} empty={!g.invoices.length}>
              {g.invoices.map((i) => (
                <tr key={i.id}>
                  <Td>
                    <Link href={`/invoices/${i.id}`} className="code hover:underline">
                      {i.fullNumber}
                    </Link>
                  </Td>
                  <Td>{date(i.issueDate, locale)}</Td>
                  <Td>
                    <Badge tone={statusTone[i.status]}>{t(`invoices.${i.status}`)}</Badge>
                  </Td>
                  <Td>{money(i.total, i.currency, locale)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title={t('reservations.payments')} padded={false}>
            <Table head={[t('common.date'), t('reservations.method'), t('common.amount')]} empty={!g.payments.length}>
              {g.payments.map((p) => (
                <tr key={p.id}>
                  <Td>{dateTime(p.createdAt, locale)}</Td>
                  <Td>{t(`methods.${p.method}`)}</Td>
                  <Td>{money(p.amount, p.currency, locale)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}

      {tab === 'activity' && (
        <Card padded={false}>
          <Table head={[t('common.date'), t('guests.activity'), t('guests.by')]} empty={!g.activity.length}>
            {g.activity.map((a) => {
              const key = `activity.${a.action.replace('.', '_')}`;
              const label = t(key);
              return (
                <tr key={a.id}>
                  <Td>{dateTime(a.createdAt, locale)}</Td>
                  <Td>{label === key ? a.action : label}</Td>
                  <Td>{a.userName ?? t('guests.system')}</Td>
                </tr>
              );
            })}
          </Table>
        </Card>
      )}

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
