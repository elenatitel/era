'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PAYMENT_METHODS, parseMoney } from '@pms/shared';
import { ApiError, api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Room } from '@/lib/types';
import { Alert, Badge, Button, Checkbox, ErrorText, Field, Input, Modal, Select, Spinner, statusTone } from './ui';

export function CheckInDialog({ reservationId, roomId: assigned, title, onClose }: { reservationId: string; roomId?: string | null; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const rooms = useQuery({ queryKey: ['free-rooms', reservationId], queryFn: () => api.get<Room[]>(`/reservations/${reservationId}/free-rooms`) });
  const [roomId, setRoomId] = useState(assigned ?? '');
  const [allowDirty, setAllowDirty] = useState(false);
  const m = useMutation({
    mutationFn: () => api.post(`/reservations/${reservationId}/check-in`, { roomId: selected!.id, allowDirtyRoom: allowDirty }),
    onSuccess: () => {
      void qc.invalidateQueries();
      onClose();
    },
  });
  // A guest still in the room blocks check-in until they leave, even if the room is free from tonight.
  const occupied = (r: Room) => r.occupancy === 'occupied';
  // Offers the first ready room, so a plain arrival needs no choosing.
  const chosen = roomId || rooms.data?.find((r) => !occupied(r) && r.status !== 'dirty')?.id;
  const selected = rooms.data?.find((r) => r.id === chosen && !occupied(r));
  return (
    <Modal open onClose={onClose} title={title}>
      {rooms.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <ErrorText error={m.error} />
          {rooms.data?.every(occupied) && <Alert tone="amber">{t('frontDesk.noVacantRoom')}</Alert>}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {rooms.data?.map((r) => (
              <button
                key={r.id}
                disabled={occupied(r)}
                onClick={() => setRoomId(r.id)}
                className={`rounded-lg border p-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${selected?.id === r.id ? 'border-focus ring-2 ring-focus/25' : 'border-line enabled:hover:border-accent'}`}
              >
                <span className="block font-semibold">{r.number}</span>
                {occupied(r) ? <Badge tone="amber">{t('frontDesk.occupied')}</Badge> : <Badge tone={statusTone[r.status]}>{t(`roomStatus.${r.status}`)}</Badge>}
              </button>
            ))}
          </div>
          {selected?.status === 'dirty' && <Checkbox label={t('frontDesk.allowDirty')} checked={allowDirty} onChange={setAllowDirty} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!selected || (selected.status === 'dirty' && !allowDirty)} loading={m.isPending} onClick={() => m.mutate()}>
              {t('frontDesk.checkIn')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function PaymentForm({ reservationId, currency, suggested, refund: startAsRefund = false, onDone }: { reservationId: string; currency: string; suggested?: number; refund?: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const [method, setMethod] = useState('card');
  const [amount, setAmount] = useState(suggested ? (suggested / 100).toFixed(2) : '');
  const [reference, setReference] = useState('');
  const [refund, setRefund] = useState(startAsRefund);
  const m = useMutation({
    mutationFn: () => {
      const minor = parseMoney(amount);
      if (!minor || minor <= 0) throw new ApiError(422, 'VALIDATION', t('common.amount'));
      return api.post(`/reservations/${reservationId}/payments`, { method, amount: refund ? -minor : minor, reference: reference || null });
    },
    onSuccess: onDone,
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <ErrorText error={m.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('reservations.method')}>
          {(id) => (
            <Select id={id} value={method} onChange={(e) => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map((p) => (
                <option key={p} value={p}>
                  {t(`methods.${p}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={`${t('common.amount')} (${currency})`}>{(id) => <Input id={id} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label={t('reservations.reference')}>{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
      </div>
      <div className="flex items-center justify-between">
        {can('payments.refund') ? <Checkbox label={t('reservations.refund')} checked={refund} onChange={setRefund} /> : <span />}
        <Button type="submit" loading={m.isPending}>
          {t('reservations.addPayment')}
        </Button>
      </div>
    </form>
  );
}

interface CheckOutPreview {
  propertyId: string;
  departure: string;
  nightsReleased: number;
  charges: number;
  payments: number;
  balance: number;
}

/** Shows the final bill first; the last step offers the invoice while the guest is still at the desk. */
export function CheckOutDialog({ reservationId, title, onClose }: { reservationId: string; title: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { can, property } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [allowBalance, setAllowBalance] = useState(false);
  const [done, setDone] = useState(false);
  const currency = property?.currency ?? 'RON';
  const m_ = (v: number) => money(v, currency, locale);
  const preview = useQuery({
    queryKey: ['check-out-preview', reservationId],
    queryFn: () => api.get<CheckOutPreview>(`/reservations/${reservationId}/check-out-preview`),
    enabled: !done,
    gcTime: 0,
  });
  const m = useMutation({
    mutationFn: () => api.post(`/reservations/${reservationId}/check-out`, { allowOpenBalance: allowBalance }),
    onSuccess: () => {
      setDone(true);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'check-out-preview' });
    },
    onError: () => void preview.refetch(),
  });
  const invoice = useMutation({
    mutationFn: () => api.post<{ id: string }>('/invoices', { propertyId: preview.data!.propertyId, type: 'invoice', reservationId }),
    onSuccess: (inv) => router.push(`/invoices/${inv.id}`),
  });
  const p = preview.data;
  const paymentDone = () => {
    m.reset();
    void preview.refetch();
    void qc.invalidateQueries({ queryKey: ['reservation', reservationId] });
  };

  if (done)
    return (
      <Modal open onClose={onClose} title={title}>
        <div className="space-y-4">
          <Alert tone="green">{t('frontDesk.checkedOut')}</Alert>
          <ErrorText error={invoice.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            {can('invoices.issue') && (
              <Button loading={invoice.isPending} onClick={() => invoice.mutate()}>
                {t('reservations.issueInvoice')}
              </Button>
            )}
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal open onClose={onClose} title={title}>
      {preview.isLoading ? (
        <Spinner />
      ) : !p ? (
        <ErrorText error={preview.error} />
      ) : (
        <div className="space-y-4">
          <ErrorText error={m.error} />
          {p.nightsReleased > 0 && <Alert tone="blue">{t('frontDesk.earlyDeparture', { n: p.nightsReleased, date: date(p.departure, locale) })}</Alert>}
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">{t('reservations.charges')}</dt>
              <dd>{m_(p.charges)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">{t('reservations.paid')}</dt>
              <dd>{m_(p.payments)}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-1 text-base font-semibold">
              <dt>{t('reservations.balance')}</dt>
              <dd>{m_(p.balance)}</dd>
            </div>
          </dl>
          {p.balance > 0 && (
            <>
              {can('payments.create') && <PaymentForm key={p.balance} reservationId={reservationId} currency={currency} suggested={p.balance} onDone={paymentDone} />}
              {can('invoices.issue') && <Checkbox label={t('frontDesk.allowBalance')} checked={allowBalance} onChange={setAllowBalance} />}
            </>
          )}
          {p.balance < 0 && (
            <>
              <Alert tone="amber">{t('frontDesk.creditBalance', { amount: m_(-p.balance) })}</Alert>
              {can('payments.refund') && <PaymentForm key={p.balance} reservationId={reservationId} currency={currency} suggested={-p.balance} refund onDone={paymentDone} />}
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button loading={m.isPending} disabled={p.balance > 0 && !allowBalance} onClick={() => m.mutate()}>
              {t('frontDesk.checkOut')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export interface StayMove {
  id: string;
  guestName: string;
  arrival: string;
  departure: string;
  /** Left out when the room stays the same; null takes the stay off its room. */
  roomId?: string | null;
}

interface MovePreview {
  currency: string;
  source: string;
  guestMoves: boolean;
  roomNotReady: boolean;
  needsNewDoorPin: boolean;
  before: { arrival: string; departure: string; roomNumber: string | null; total: number };
  after: { arrival: string; departure: string; roomNumber: string | null; total: number };
}

/** Confirms a move from the calendar, showing what changes, the price above all. */
export function MoveStayDialog({ move, onClose, onMoved }: { move: StayMove; onClose: () => void; onMoved: () => Promise<unknown> }) {
  const { t, locale } = useI18n();
  const { id, guestName, ...change } = move;
  const preview = useQuery({
    queryKey: ['move-preview', move],
    queryFn: () => api.post<MovePreview>(`/reservations/${id}/move-preview`, change),
    retry: false,
    gcTime: 0,
  });
  const save = useMutation({
    mutationFn: () => api.patch(`/reservations/${id}`, { ...change, allowDirtyRoom: preview.data?.roomNotReady }),
    onSuccess: async () => {
      await onMoved();
      onClose();
    },
  });
  const friendly = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'ROOM_CONFLICT') return new ApiError(error.status, error.code, t('calendar.moveRoomTaken'));
    if (error instanceof ApiError && error.code === 'NO_AVAILABILITY') return new ApiError(error.status, error.code, t('calendar.moveNoRooms'));
    return error;
  };
  const p = preview.data;
  const stay = (s: MovePreview['before']) => `${date(s.arrival, locale)} – ${date(s.departure, locale)}`;
  const room = (s: MovePreview['before']) => s.roomNumber ?? t('calendar.noRoom');
  const rows = p && ([
    [t('calendar.period'), stay(p.before), stay(p.after)],
    [t('calendar.room'), room(p.before), room(p.after)],
    [t('calendar.total'), money(p.before.total, p.currency, locale), money(p.after.total, p.currency, locale)],
  ] as const).filter(([, before, after]) => before !== after);
  return (
    <Modal open onClose={onClose} title={t('calendar.moveTitle')}>
      <div className="space-y-4">
        <p className="font-medium">{guestName}</p>
        <ErrorText error={friendly(preview.error ?? save.error)} />
        {preview.isLoading && <Spinner />}
        {p && (
          <>
            <dl className="space-y-2 text-sm">
              {rows!.map(([label, before, after]) => (
                <div key={label} className="flex flex-wrap justify-between gap-x-4">
                  <dt className="text-muted">{label}</dt>
                  <dd>
                    <span className="text-muted line-through">{before}</span> <span className="font-semibold">{after}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted">{t(p.before.total === p.after.total ? 'calendar.samePrice' : 'calendar.priceRule')}</p>
            {p.guestMoves && <p className="text-xs text-muted">{t('calendar.moveFreesRoom')}</p>}
            {p.roomNotReady && <Alert tone="amber">{t('calendar.moveDirtyRoom')}</Alert>}
            {p.needsNewDoorPin && <Alert tone="amber">{t('calendar.moveDoorPin')}</Alert>}
            {['ota', 'agent'].includes(p.source) && stay(p.before) !== stay(p.after) && <Alert tone="amber">{t('calendar.moveChannel', { source: t(`sources.${p.source}`) })}</Alert>}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button autoFocus disabled={!p} loading={save.isPending} onClick={() => save.mutate()}>{t('calendar.moveConfirm')}</Button>
        </div>
      </div>
    </Modal>
  );
}
