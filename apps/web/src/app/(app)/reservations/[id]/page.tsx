'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { CHARGE_CATEGORIES, parseMoney } from '@pms/shared';
import { CheckInDialog, CheckOutDialog, PaymentForm } from '@/components/stay-dialogs';
import { Badge, Button, Card, ErrorText, Field, Forbidden, Input, Modal, PageHeader, Select, Spinner, Table, Td, statusTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { date, dateTime, money, percent } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { ReservationDetail } from '@/lib/types';

function ChargeDialog({ r, onClose }: { r: ReservationDetail; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [category, setCategory] = useState('food_beverage');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const unitPrice = parseMoney(price);
      if (unitPrice === null || unitPrice < 0) throw new ApiError(422, 'VALIDATION', t('reservations.unitPrice'));
      return api.post(`/reservations/${r.id}/charges`, { category, description: description || t(`charges.${category}`), quantity, unitPrice });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', r.id] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={t('reservations.postCharge')}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <ErrorText error={m.error} />
        <Field label={t('reservations.category')}>
          {(id) => (
            <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CHARGE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`charges.${c}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('common.description')}>{(id) => <Input id={id} value={description} placeholder={t(`charges.${category}`)} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('reservations.quantity')}>{(id) => <Input id={id} type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />}</Field>
          <Field label={`${t('reservations.unitPrice')} (${r.currency})`}>{(id) => <Input id={id} inputMode="decimal" required value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={m.isPending}>
            {t('reservations.postCharge')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function ReservationPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useI18n();
  const { can } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['reservation', id], queryFn: () => api.get<ReservationDetail>(`/reservations/${id}`) });
  const [dialog, setDialog] = useState<'checkin' | 'checkout' | 'charge' | 'payment' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['reservation', id] });

  const cancel = useMutation({
    mutationFn: (noShow: boolean) => api.post(`/reservations/${id}/${noShow ? 'no-show' : 'cancel'}`, { reason: prompt(t('common.reason')) || null }),
    onSuccess: refresh,
  });
  const voidItem = useMutation({
    mutationFn: (itemId: string) => {
      const reason = prompt(t('common.reason'));
      if (!reason) throw new ApiError(422, 'VALIDATION', t('common.reason'));
      return api.post(`/folio-items/${itemId}/void`, { reason });
    },
    onSuccess: refresh,
  });
  const invoice = useMutation({
    mutationFn: (type: 'invoice' | 'proforma') => api.post<{ id: string }>('/invoices', { propertyId: q.data!.property.id, type, reservationId: id }),
    onSuccess: (inv) => router.push(`/invoices/${inv.id}`),
  });

  if (!can('reservations.read')) return <Forbidden />;
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const r = q.data!;
  const m = (v: number) => money(v, r.currency, locale);
  const active = ['tentative', 'confirmed'].includes(r.status);

  return (
    <>
      <PageHeader
        eyebrow={`${t('nav.reservations')} · ${r.property.name}`}
        title={`${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="code">{r.code}</span>
            <Badge tone={statusTone[r.status]}>{t(`resStatus.${r.status}`)}</Badge>
            <span>
              {t(`sources.${r.source}`)} · {dateTime(r.createdAt, locale)}
            </span>
          </span>
        }
        actions={
          <>
            {active && can('frontdesk.checkin') && <Button onClick={() => setDialog('checkin')}>{t('frontDesk.checkIn')}</Button>}
            {r.status === 'checked_in' && can('frontdesk.checkout') && <Button onClick={() => setDialog('checkout')}>{t('frontDesk.checkOut')}</Button>}
            {active && can('reservations.cancel') && (
              <>
                <Button variant="secondary" onClick={() => cancel.mutate(true)}>
                  {t('reservations.noShow')}
                </Button>
                <Button variant="danger" onClick={() => confirm(t('reservations.cancel') + '?') && cancel.mutate(false)}>
                  {t('reservations.cancel')}
                </Button>
              </>
            )}
          </>
        }
      />
      <ErrorText error={cancel.error ?? invoice.error ?? voidItem.error} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={t('reservations.guestDetails')}>
          {r.guest && (
            <dl className="space-y-2 text-sm">
              <div>
                <Link href={`/guests/${r.guest.id}`} className="font-medium text-accent hover:underline">
                  {r.guest.firstName} {r.guest.lastName}
                </Link>{' '}
                {r.guest.segment !== 'standard' && <Badge tone={statusTone[r.guest.segment]}>{t(`segments.${r.guest.segment}`)}</Badge>}
              </div>
              {r.guest.email && <div className="text-muted">{r.guest.email}</div>}
              {r.guest.phone && <div className="text-muted">{r.guest.phone}</div>}
              {r.company && <div>{r.company.name}</div>}
            </dl>
          )}
        </Card>
        <Card title={t('common.details')}>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted">{t('reservations.arrival')}</dt>
            <dd>{date(r.arrival, locale)}</dd>
            <dt className="text-muted">{t('reservations.departure')}</dt>
            <dd>{date(r.departure, locale)}</dd>
            <dt className="text-muted">{t('reservations.nights')}</dt>
            <dd>{r.nightlyRates.length}</dd>
            <dt className="text-muted">{t('reservations.adults')}</dt>
            <dd>
              {r.adults}
              {r.children ? ` + ${r.children}` : ''}
            </dd>
          </dl>
        </Card>
        <Card title={t('reservations.room')}>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted">{t('reservations.roomType')}</dt>
            <dd>{r.roomType.name}</dd>
            <dt className="text-muted">{t('reservations.room')}</dt>
            <dd className="font-semibold">{r.room?.number ?? '—'}</dd>
            <dt className="text-muted">{t('reservations.ratePlan')}</dt>
            <dd>{r.ratePlan.name}</dd>
            <dt className="text-muted">{t('common.total')}</dt>
            <dd className="font-semibold">{m(r.totalAmount)}</dd>
          </dl>
        </Card>
      </div>

      {(r.onlineCheckinAt || r.estimatedArrival || r.guestRequests || r.companions.length > 0) && (
        <Card
          className="mt-6"
          title={
            <span className="flex items-center gap-2">
              {t('online.checkedInOnline')}
              {r.onlineCheckinAt ? <Badge tone="green" dot>{dateTime(r.onlineCheckinAt, locale)}</Badge> : <Badge tone="gray">{t('guest.notStarted')}</Badge>}
            </span>
          }
        >
          <div className="grid gap-4 md:grid-cols-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {r.estimatedArrival && (
                <>
                  <dt className="text-muted">{t('online.estimatedArrival')}</dt>
                  <dd>{r.estimatedArrival}</dd>
                </>
              )}
              {r.guestRequests && (
                <>
                  <dt className="text-muted">{t('online.requests')}</dt>
                  <dd className="whitespace-pre-wrap">{r.guestRequests}</dd>
                </>
              )}
            </dl>
            {r.companions.length > 0 && (
              <div>
                <p className="eyebrow mb-2">{t('online.companions')}</p>
                <ul className="divide-y divide-line text-sm">
                  {r.companions.map((c) => (
                    <li key={c.id} className="flex justify-between gap-3 py-1.5">
                      <span>
                        {c.firstName} {c.lastName}
                        {c.birthDate && <span className="block text-xs text-muted">{date(c.birthDate, locale)}</span>}
                      </span>
                      <span className="text-right text-xs text-muted">
                        {c.documentType && t(`docTypes.${c.documentType}`)}
                        {c.documentNumber && <span className="code block">{c.documentNumber}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {r.notes && (
        <Card className="mt-6" title={t('common.notes')}>
          <p className="text-sm whitespace-pre-wrap">{r.notes}</p>
        </Card>
      )}

      {r.totals && (
        <Card
          className="mt-6"
          padded={false}
          title={
            <span className="flex items-center gap-3">
              {t('reservations.folio')}
              <Badge tone={r.totals.balance > 0 ? 'amber' : 'green'}>
                {t('reservations.balance')}: {m(r.totals.balance)}
              </Badge>
            </span>
          }
          actions={
            <>
              {can('folio.post') && (
                <Button size="sm" variant="secondary" onClick={() => setDialog('charge')}>
                  {t('reservations.postCharge')}
                </Button>
              )}
              {can('payments.create') && (
                <Button size="sm" variant="secondary" onClick={() => setDialog('payment')}>
                  {t('reservations.addPayment')}
                </Button>
              )}
              {can('invoices.issue') && (
                <>
                  <Button size="sm" variant="secondary" loading={invoice.isPending} onClick={() => invoice.mutate('proforma')}>
                    {t('reservations.issueProforma')}
                  </Button>
                  <Button size="sm" loading={invoice.isPending} onClick={() => invoice.mutate('invoice')}>
                    {t('reservations.issueInvoice')}
                  </Button>
                </>
              )}
            </>
          }
        >
          <Table
            head={[t('common.date'), t('common.description'), t('reservations.quantity'), t('reservations.unitPrice'), t('reservations.vat'), t('common.amount'), '']}
            empty={!r.folio.length}
          >
            {r.folio.map((f) => (
              <tr key={f.id} className={f.voidedAt ? 'text-faint line-through' : ''}>
                <Td>{date(f.serviceDate, locale)}</Td>
                <Td>
                  {f.description}
                  {f.invoiceId && (
                    <span className="ml-2">
                      <Badge tone="blue">{t('invoices.invoice')}</Badge>
                    </span>
                  )}
                </Td>
                <Td>{f.quantity}</Td>
                <Td>{m(f.unitPrice)}</Td>
                <Td>{percent(f.vatRate)}</Td>
                <Td className="font-medium">{m(f.amount)}</Td>
                <Td className="text-right">
                  {!f.voidedAt && !f.invoiceId && can('folio.void') && (
                    <Button size="sm" variant="ghost" onClick={() => voidItem.mutate(f.id)}>
                      {t('reservations.void')}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <div className="grid gap-6 border-t border-line p-5 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold">{t('reservations.payments')}</h3>
              <ul className="divide-y divide-line text-sm">
                {r.payments.map((p) => (
                  <li key={p.id} className="flex justify-between py-1.5">
                    <span>
                      {t(`methods.${p.method}`)} <span className="text-xs text-muted">{p.reference}</span>
                      <span className="block text-xs text-muted">{dateTime(p.createdAt, locale)}</span>
                    </span>
                    <span className={p.amount < 0 ? 'text-danger' : 'font-medium'}>{m(p.amount)}</span>
                  </li>
                ))}
                {!r.payments.length && <li className="py-1.5 text-muted">—</li>}
              </ul>
            </div>
            <div>
              <dl className="ml-auto max-w-xs space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">{t('reservations.charges')}</dt>
                  <dd>{m(r.totals.charges)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">{t('reservations.paid')}</dt>
                  <dd>{m(r.totals.payments)}</dd>
                </div>
                <div className="flex justify-between border-t border-line pt-1 text-base font-semibold">
                  <dt>{t('reservations.balance')}</dt>
                  <dd>{m(r.totals.balance)}</dd>
                </div>
              </dl>
              {r.invoices.length > 0 && (
                <ul className="mt-4 space-y-1 text-sm">
                  {r.invoices.map((i) => (
                    <li key={i.id} className="flex justify-between">
                      <Link href={`/invoices/${i.id}`} className="text-accent hover:underline">
                        {t(`invoices.${i.type}`)} {i.fullNumber}
                      </Link>
                      <Badge tone={statusTone[i.status]}>{t(`invoices.${i.status}`)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card className="mt-6" title={t('reservations.nightlyRates')}>
        <div className="flex flex-wrap gap-2">
          {r.nightlyRates.map((n) => (
            <div key={n.date} className="rounded-lg border border-line px-3 py-1.5 text-xs">
              <span className="text-muted">{date(n.date, locale)}</span> <strong>{m(n.amount)}</strong>
            </div>
          ))}
        </div>
      </Card>

      {dialog === 'checkin' && <CheckInDialog reservationId={r.id} title={t('frontDesk.checkIn')} onClose={() => setDialog(null)} />}
      {dialog === 'checkout' && <CheckOutDialog reservationId={r.id} title={t('frontDesk.checkOut')} onClose={() => setDialog(null)} />}
      {dialog === 'charge' && <ChargeDialog r={r} onClose={() => setDialog(null)} />}
      {dialog === 'payment' && (
        <Modal open onClose={() => setDialog(null)} title={t('reservations.addPayment')}>
          <PaymentForm
            reservationId={r.id}
            currency={r.currency}
            suggested={r.totals && r.totals.balance > 0 ? r.totals.balance : undefined}
            onDone={() => {
              void refresh();
              setDialog(null);
            }}
          />
        </Modal>
      )}
    </>
  );
}
