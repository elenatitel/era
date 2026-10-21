'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PAYMENT_METHODS, parseMoney } from '@pms/shared';
import { ApiError, api } from '@/lib/api';
import { money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Room } from '@/lib/types';
import { Alert, Badge, Button, Checkbox, ErrorText, Field, Input, Modal, Select, Spinner, statusTone } from './ui';

export function CheckInDialog({ reservationId, title, onClose }: { reservationId: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const rooms = useQuery({ queryKey: ['free-rooms', reservationId], queryFn: () => api.get<Room[]>(`/reservations/${reservationId}/free-rooms`) });
  const [roomId, setRoomId] = useState('');
  const [allowDirty, setAllowDirty] = useState(false);
  const m = useMutation({
    mutationFn: () => api.post(`/reservations/${reservationId}/check-in`, { roomId, allowDirtyRoom: allowDirty }),
    onSuccess: () => {
      void qc.invalidateQueries();
      onClose();
    },
  });
  const selected = rooms.data?.find((r) => r.id === roomId);
  return (
    <Modal open onClose={onClose} title={title}>
      {rooms.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <ErrorText error={m.error} />
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {rooms.data?.map((r) => (
              <button
                key={r.id}
                onClick={() => setRoomId(r.id)}
                className={`rounded-lg border p-2 text-left text-sm ${roomId === r.id ? 'border-focus ring-2 ring-focus/25' : 'border-line hover:border-accent'}`}
              >
                <span className="block font-semibold">{r.number}</span>
                <Badge tone={statusTone[r.status]}>{t(`roomStatus.${r.status}`)}</Badge>
              </button>
            ))}
          </div>
          {selected?.status === 'dirty' && <Checkbox label={t('frontDesk.allowDirty')} checked={allowDirty} onChange={setAllowDirty} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!roomId || (selected?.status === 'dirty' && !allowDirty)} loading={m.isPending} onClick={() => m.mutate()}>
              {t('frontDesk.checkIn')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function PaymentForm({ reservationId, currency, suggested, onDone }: { reservationId: string; currency: string; suggested?: number; onDone: () => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const [method, setMethod] = useState('card');
  const [amount, setAmount] = useState(suggested ? (suggested / 100).toFixed(2) : '');
  const [reference, setReference] = useState('');
  const [refund, setRefund] = useState(false);
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

export function CheckOutDialog({ reservationId, title, onClose }: { reservationId: string; title: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { can, property } = useSession();
  const qc = useQueryClient();
  const [allowBalance, setAllowBalance] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const currency = property?.currency ?? 'RON';
  const m = useMutation({
    mutationFn: () => api.post(`/reservations/${reservationId}/check-out`, { allowOpenBalance: allowBalance }),
    onSuccess: () => {
      void qc.invalidateQueries();
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'OUTSTANDING_BALANCE') setBalance((err.details as { balance: number }).balance);
    },
  });
  const outstanding = m.error instanceof ApiError && m.error.code === 'OUTSTANDING_BALANCE';
  return (
    <Modal open onClose={onClose} title={title}>
      <div className="space-y-4">
        {outstanding && balance !== null ? (
          <>
            <Alert tone="amber">
              {t('frontDesk.openBalance')}: <strong>{money(balance, currency, locale)}</strong>
            </Alert>
            {can('payments.create') && (
              <PaymentForm
                reservationId={reservationId}
                currency={currency}
                suggested={balance}
                onDone={() => {
                  m.reset();
                  setBalance(null);
                  void qc.invalidateQueries({ queryKey: ['reservation', reservationId] });
                }}
              />
            )}
            {can('invoices.issue') && <Checkbox label={t('frontDesk.allowBalance')} checked={allowBalance} onChange={setAllowBalance} />}
          </>
        ) : (
          <ErrorText error={m.error} />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} disabled={outstanding && !allowBalance} onClick={() => m.mutate()}>
            {t('frontDesk.checkOut')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
