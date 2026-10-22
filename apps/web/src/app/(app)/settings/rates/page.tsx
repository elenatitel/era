'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { addDays, parseMoney, weekday } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { Alert, Badge, Button, Card, Checkbox, ErrorText, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Extra, Property, RatePlan, RoomType } from '@/lib/types';

interface Grid {
  roomTypes: RoomType[];
  overrides: { roomTypeId: string; ratePlanId: string | null; date: string; price: number | null; closed: boolean }[];
}

function PlanForm({ property, plan, extras, onDone }: { property: Property; plan?: RatePlan; extras: Extra[]; onDone: () => void }) {
  const { t, locale } = useI18n();
  const [f, setF] = useState({
    name: plan?.name ?? '',
    code: plan?.code ?? '',
    description: plan?.description ?? '',
    includesBreakfast: plan?.includesBreakfast ?? false,
    adjustmentPercent: plan?.adjustmentPercent ?? 0,
    minNights: plan?.minNights ?? 1,
    active: plan?.active ?? true,
    includedExtraIds: plan?.includedExtraIds ?? [],
  });
  const offered = extras.filter((e) => e.active || f.includedExtraIds.includes(e.id));
  const m = useMutation({
    mutationFn: () => {
      const body = { ...f, code: f.code.toUpperCase(), description: f.description || null, adjustmentPercent: Number(f.adjustmentPercent), minNights: Number(f.minNights) };
      return plan ? api.patch(`/rate-plans/${plan.id}`, body) : api.post('/rate-plans', { ...body, propertyId: property.id });
    },
    onSuccess: onDone,
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <ErrorText error={m.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')}>{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('common.code')}>{(id) => <Input id={id} required maxLength={16} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
        <Field label={t('settings.adjustment')}>{(id) => <Input id={id} type="number" step="0.5" value={f.adjustmentPercent} onChange={(e) => setF({ ...f, adjustmentPercent: Number(e.target.value) })} />}</Field>
        <Field label={t('settings.minNights')}>{(id) => <Input id={id} type="number" min={1} value={f.minNights} onChange={(e) => setF({ ...f, minNights: Number(e.target.value) })} />}</Field>
        <Field label={t('common.description')} className="sm:col-span-2">{(id) => <Input id={id} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      </div>
      <Checkbox label={t('settings.breakfast')} checked={f.includesBreakfast} onChange={(v) => setF({ ...f, includesBreakfast: v })} />
      <Checkbox label={t('common.active')} checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      <fieldset className="space-y-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-medium">{t('extras.packageExtras')}</legend>
        <p className="text-xs text-muted">{t('extras.packageHint')}</p>
        {offered.length === 0 && <p className="text-xs text-muted">{t('extras.noExtras')}</p>}
        {offered.map((e) => (
          <Checkbox
            key={e.id}
            label={`${e.name} · ${money(e.price, property.currency, locale)} ${t(`extras.units.${e.unit}`).toLowerCase()}`}
            checked={f.includedExtraIds.includes(e.id)}
            onChange={(v) => setF({ ...f, includedExtraIds: v ? [...f.includedExtraIds, e.id] : f.includedExtraIds.filter((x) => x !== e.id) })}
          />
        ))}
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" loading={m.isPending}>{t('common.save')}</Button>
      </div>
    </form>
  );
}

function RangeForm({ property, types, plans, onDone }: { property: Property; types: RoomType[]; plans: RatePlan[]; onDone: () => void }) {
  const { t, locale } = useI18n();
  const [f, setF] = useState({ roomTypeId: types[0]?.id ?? '', ratePlanId: '', from: property.businessDate, to: addDays(property.businessDate, 6), price: '', closed: false, weekdays: [] as number[] });
  const fmt = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ro-RO', { weekday: 'short', timeZone: 'UTC' });
  const m = useMutation({
    mutationFn: () => {
      const price = f.price.trim() ? parseMoney(f.price) : null;
      if (f.price.trim() && price === null) throw new ApiError(422, 'VALIDATION', t('settings.price'));
      return api.put<{ updated: number }>('/rates', { roomTypeId: f.roomTypeId, ratePlanId: f.ratePlanId || null, from: f.from, to: f.to, price, closed: f.closed, weekdays: f.weekdays });
    },
    onSuccess: onDone,
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <ErrorText error={m.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('reservations.roomType')}>
          {(id) => (
            <Select id={id} value={f.roomTypeId} onChange={(e) => setF({ ...f, roomTypeId: e.target.value })}>
              {types.map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('reservations.ratePlan')}>
          {(id) => (
            <Select id={id} value={f.ratePlanId} onChange={(e) => setF({ ...f, ratePlanId: e.target.value })}>
              <option value="">{t('settings.allPlans')}</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" min={f.from} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
        <Field label={`${t('settings.price')} (${property.currency})`} hint={t('common.optional')}>
          {(id) => <Input id={id} inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />}
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox label={t('settings.closed')} checked={f.closed} onChange={(v) => setF({ ...f, closed: v })} />
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-sm font-medium">{t('settings.weekdays')}</p>
        <div className="flex flex-wrap gap-1">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => {
            const on = f.weekdays.includes(d);
            return (
              <button
                type="button"
                key={d}
                onClick={() => setF({ ...f, weekdays: on ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] })}
                className={clsx('rounded-md border px-2.5 py-1 text-xs', on ? 'border-focus bg-brand-soft text-on-brand-soft' : 'border-line text-muted')}
              >
                {fmt.format(new Date(Date.UTC(2024, 0, 7 + d)))}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={m.isPending}>{t('settings.applyRates')}</Button>
      </div>
    </form>
  );
}

function Rates({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const manage = can('rates.manage');
  const [start, setStart] = useState(property.businessDate);
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));
  const plans = useQuery({ queryKey: ['rate-plans', property.id], queryFn: () => api.get<RatePlan[]>('/rate-plans', { propertyId: property.id }) });
  const extras = useQuery({ queryKey: ['extras', property.id], queryFn: () => api.get<Extra[]>('/extras', { propertyId: property.id }) });
  const extraName = (id: string) => extras.data?.find((e) => e.id === id)?.name;
  const grid = useQuery({ queryKey: ['rates', property.id, start], queryFn: () => api.get<Grid>('/rates', { propertyId: property.id, from: start, to: days[13]! }) });
  const [editPlan, setEditPlan] = useState<RatePlan | 'new' | null>(null);
  const [range, setRange] = useState(false);
  const [notice, setNotice] = useState('');
  const fmt = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ro-RO', { weekday: 'short', day: '2-digit', timeZone: 'UTC' });

  if (plans.isLoading || grid.isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title={t('nav.rates')} eyebrow={property.name} />
      <ErrorText error={plans.error ?? grid.error} />
      <Card title={t('settings.ratePlans')} padded={false} actions={manage && <Button size="sm" onClick={() => setEditPlan('new')}><Plus size={14} /> {t('settings.newRatePlan')}</Button>}>
        <Table head={[t('common.code'), t('common.name'), t('settings.adjustment'), t('settings.minNights'), t('common.status'), '']} empty={!plans.data?.length}>
          {plans.data?.map((p) => (
            <tr key={p.id}>
              <Td><span className="code">{p.code}</span></Td>
              <Td>
                {p.name} {p.includesBreakfast && <Badge tone="amber">{t('reservations.breakfast')}</Badge>}
                {p.includedExtraIds.length > 0 && (
                  <span className="block text-xs text-muted">{t('extras.includes', { items: p.includedExtraIds.map(extraName).filter(Boolean).join(', ') })}</span>
                )}
              </Td>
              <Td>{p.adjustmentPercent > 0 ? '+' : ''}{p.adjustmentPercent}%</Td>
              <Td>{p.minNights}</Td>
              <Td><Badge tone={p.active ? 'green' : 'gray'}>{p.active ? t('common.active') : t('common.inactive')}</Badge></Td>
              <Td className="text-right">{manage && <Button size="sm" variant="ghost" onClick={() => setEditPlan(p)}>{t('common.edit')}</Button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card
        className="mt-6"
        title={t('settings.dynamicRates')}
        padded={false}
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setStart(addDays(start, -14))} aria-label={t('common.previous')}><ChevronLeft size={14} /></Button>
            <Button size="sm" variant="secondary" onClick={() => setStart(addDays(start, 14))} aria-label={t('common.next')}><ChevronRight size={14} /></Button>
            {manage && <Button size="sm" onClick={() => setRange(true)}>{t('settings.applyRates')}</Button>}
          </>
        }
      >
        {notice && <div className="p-3"><Alert tone="green">{notice}</Alert></div>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="px-3 py-2 text-left">{t('reservations.roomType')}</th>
                {days.map((d) => (
                  <th key={d} className={clsx('px-1 py-2 text-center font-medium', [0, 6].includes(weekday(d)) && 'bg-subtle')}>{fmt.format(new Date(`${d}T00:00:00Z`))}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {grid.data?.roomTypes.map((rt) => (
                <tr key={rt.id}>
                  <td className="px-3 py-2 font-semibold whitespace-nowrap">{rt.code}</td>
                  {days.map((d) => {
                    const o = grid.data!.overrides.find((x) => x.roomTypeId === rt.id && x.ratePlanId === null && x.date === d);
                    const specific = grid.data!.overrides.some((x) => x.roomTypeId === rt.id && x.ratePlanId !== null && x.date === d);
                    return (
                      <td key={d} className={clsx('px-1 py-2 text-center', o?.closed && 'bg-danger-soft text-danger line-through', o?.price != null && 'font-semibold text-on-brand-soft')}>
                        {money(o?.price ?? rt.baseRate, property.currency, locale).replace(/\s?[A-Z]{3}$|^[A-Z]{3}\s?/, '')}
                        {specific && <span className="text-accent">*</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={editPlan !== null} onClose={() => setEditPlan(null)} title={editPlan === 'new' ? t('settings.newRatePlan') : t('common.edit')}>
        {editPlan && (
          <PlanForm
            property={property}
            plan={editPlan === 'new' ? undefined : editPlan}
            extras={extras.data ?? []}
            onDone={() => {
              setEditPlan(null);
              void qc.invalidateQueries({ queryKey: ['rate-plans'] });
            }}
          />
        )}
      </Modal>
      <Modal open={range} onClose={() => setRange(false)} title={t('settings.dynamicRates')}>
        {range && (
          <RangeForm
            property={property}
            types={grid.data?.roomTypes ?? []}
            plans={plans.data ?? []}
            onDone={() => {
              setRange(false);
              setNotice(t('common.saved'));
              void qc.invalidateQueries({ queryKey: ['rates'] });
            }}
          />
        )}
      </Modal>
    </>
  );
}

export default function RatesPage() {
  return <PropertyGate perms={['rates.read']}>{(p) => <Rates property={p} />}</PropertyGate>;
}
