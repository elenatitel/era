'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PAYMENT_METHODS, parseMoney } from '@pms/shared';
import { Alert, Badge, Button, ErrorText, Field, Input, Modal, Select, Spinner, statusTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { date, money, percent } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Invoice, Party } from '@/lib/types';

function PartyBlock({ title, p }: { title: string; p: Party }) {
  return (
    <div className="text-sm">
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{title}</p>
      <p className="font-semibold">{p.name}</p>
      {p.taxId && <p>CUI: {p.taxId}</p>}
      {p.registrationNumber && <p>Reg. Com.: {p.registrationNumber}</p>}
      {(p.address || p.city) && <p>{[p.address, p.city, p.country].filter(Boolean).join(', ')}</p>}
      {p.email && <p>{p.email}</p>}
    </div>
  );
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useI18n();
  const { can } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState('bank_transfer');
  const [amount, setAmount] = useState('');
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/invoices/${id}`) });
  const cancel = useMutation({
    mutationFn: () => {
      const reason = prompt(t('common.reason'));
      if (!reason) throw new ApiError(422, 'VALIDATION', t('common.reason'));
      return api.post<{ creditNote: { id: string } | null }>(`/invoices/${id}/cancel`, { reason });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries();
      if (r.creditNote) router.push(`/invoices/${r.creditNote.id}`);
    },
  });
  const pay = useMutation({
    mutationFn: () => {
      const minor = parseMoney(amount);
      if (!minor || minor <= 0) throw new ApiError(422, 'VALIDATION', t('common.amount'));
      return api.post(`/invoices/${id}/payments`, { method, amount: minor });
    },
    onSuccess: () => {
      setPaying(false);
      void qc.invalidateQueries({ queryKey: ['invoice', id] });
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorText error={q.error} />;
  const inv = q.data!;
  const m = (v: number) => money(v, inv.currency, locale);
  const vatGroups = Object.entries(
    (inv.lines ?? []).reduce<Record<number, { net: number; vat: number }>>((acc, l) => {
      acc[l.vatRate] ??= { net: 0, vat: 0 };
      acc[l.vatRate]!.net += l.net;
      acc[l.vatRate]!.vat += l.vat;
      return acc;
    }, {}),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link href="/invoices" className="text-sm text-accent hover:underline">
          ← {t('invoices.title')}
        </Link>
        <div className="flex gap-2">
          {inv.type === 'invoice' && inv.status === 'issued' && can('payments.create') && (
            <Button variant="secondary" onClick={() => (setAmount((inv.total / 100).toFixed(2)), setPaying(true))}>
              {t('invoices.registerPayment')}
            </Button>
          )}
          {inv.status !== 'cancelled' && inv.type !== 'credit_note' && can('invoices.cancel') && (
            <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              {t('invoices.cancel')}
            </Button>
          )}
          <Button onClick={() => window.print()}>
            <Printer size={16} /> {t('common.print')}
          </Button>
        </div>
      </div>
      <ErrorText error={cancel.error} />
      {inv.status === 'cancelled' && (
        <div className="no-print mb-4">
          <Alert tone="amber">
            {t('invoices.cancelled')}: {inv.cancelReason}
          </Alert>
        </div>
      )}
      <article className="rounded-2xl border border-line bg-surface p-8 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-6 border-b border-line pb-6">
          <div>
            <h1 className="text-2xl font-semibold">{t(`invoices.${inv.type}`)}</h1>
            <p className="mt-1 font-mono text-lg">{inv.fullNumber}</p>
          </div>
          <div className="text-right text-sm">
            <p>
              {t('invoices.issueDate')}: <strong>{date(inv.issueDate, locale)}</strong>
            </p>
            <p>
              {t('invoices.dueDate')}: <strong>{date(inv.dueDate, locale)}</strong>
            </p>
            <p className="mt-2">
              <Badge tone={statusTone[inv.status]}>{t(`invoices.${inv.status}`)}</Badge>
            </p>
          </div>
        </header>
        <div className="grid gap-6 py-6 sm:grid-cols-2">
          <PartyBlock title={t('invoices.seller')} p={inv.seller} />
          <PartyBlock title={t('invoices.billTo')} p={inv.billTo} />
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-line text-left text-xs text-muted uppercase">
              <th className="py-2">#</th>
              <th className="py-2">{t('common.description')}</th>
              <th className="py-2 text-right">{t('reservations.quantity')}</th>
              <th className="py-2 text-right">{t('reservations.unitPrice')}</th>
              <th className="py-2 text-right">{t('invoices.vatRate')}</th>
              <th className="py-2 text-right">{t('invoices.net')}</th>
              <th className="py-2 text-right">{t('invoices.vat')}</th>
              <th className="py-2 text-right">{t('common.total')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {inv.lines?.map((l) => (
              <tr key={l.id}>
                <td className="py-2">{l.position}</td>
                <td className="py-2">{l.description}</td>
                <td className="py-2 text-right">{l.quantity}</td>
                <td className="py-2 text-right">{m(l.unitPrice)}</td>
                <td className="py-2 text-right">{percent(l.vatRate)}</td>
                <td className="py-2 text-right">{m(l.net)}</td>
                <td className="py-2 text-right">{m(l.vat)}</td>
                <td className="py-2 text-right font-medium">{m(l.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-6 flex flex-wrap justify-between gap-6">
          <div className="text-xs text-muted">
            {vatGroups.map(([rate, g]) => (
              <p key={rate}>
                {t('invoices.vat')} {percent(Number(rate))}: {m(g.net)} + {m(g.vat)}
              </p>
            ))}
            {inv.notes && <p className="mt-2 max-w-sm whitespace-pre-wrap">{inv.notes}</p>}
          </div>
          <dl className="w-64 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">{t('invoices.subtotal')}</dt>
              <dd>{m(inv.subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">{t('invoices.vat')}</dt>
              <dd>{m(inv.vatTotal)}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold">
              <dt>{t('invoices.total')}</dt>
              <dd>{m(inv.total)}</dd>
            </div>
          </dl>
        </div>
      </article>
      <Modal open={paying} onClose={() => setPaying(false)} title={t('invoices.registerPayment')}>
        <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), pay.mutate())}>
          <ErrorText error={pay.error} />
          <Field label={t('reservations.method')}>
            {(fid) => (
              <Select id={fid} value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map((p) => (
                  <option key={p} value={p}>
                    {t(`methods.${p}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={`${t('common.amount')} (${inv.currency})`}>{(fid) => <Input id={fid} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <div className="flex justify-end">
            <Button type="submit" loading={pay.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
