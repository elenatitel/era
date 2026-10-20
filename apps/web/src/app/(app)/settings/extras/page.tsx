'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { CHARGE_CATEGORIES, EXTRA_UNITS, parseMoney } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { Badge, Button, Card, Checkbox, ErrorText, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { date, money, percent } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Extra, PromoCode, Property, RatePlan } from '@/lib/types';

const toInput = (minor: number) => (minor / 100).toFixed(2);

function ExtraForm({ property, extra, onDone }: { property: Property; extra?: Extra; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({
    name: extra?.name ?? '',
    description: extra?.description ?? '',
    category: extra?.category ?? 'other',
    unit: extra?.unit ?? 'per_stay',
    price: extra ? toInput(extra.price) : '',
    vat: String((extra?.vatRate ?? property.standardVatRate) / 100),
    bookableOnline: extra?.bookableOnline ?? true,
    sortOrder: extra?.sortOrder ?? 0,
    active: extra?.active ?? true,
  });
  const m = useMutation({
    mutationFn: () => {
      const price = parseMoney(f.price);
      if (price === null || price < 0) throw new ApiError(422, 'VALIDATION', `${t('extras.price')}: ${f.price || '—'}`);
      const body = {
        name: f.name,
        description: f.description || null,
        category: f.category,
        unit: f.unit,
        price,
        vatRate: Math.round(Number(f.vat.replace(',', '.')) * 100),
        bookableOnline: f.bookableOnline,
        sortOrder: Number(f.sortOrder),
        active: f.active,
      };
      return extra ? api.patch(`/extras/${extra.id}`, body) : api.post('/extras', { ...body, propertyId: property.id });
    },
    onSuccess: onDone,
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <ErrorText error={m.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')} className="sm:col-span-2">
          {(id) => <Input id={id} required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
        </Field>
        <Field label={t('common.description')} hint={t('common.optional')} className="sm:col-span-2">
          {(id) => <Input id={id} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}
        </Field>
        <Field label={`${t('extras.price')} (${property.currency})`}>
          {(id) => <Input id={id} required inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />}
        </Field>
        <Field label={t('extras.unit')}>
          {(id) => (
            <Select id={id} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as Extra['unit'] })}>
              {EXTRA_UNITS.map((u) => <option key={u} value={u}>{t(`extras.units.${u}`)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('extras.vat')}>
          {(id) => <Input id={id} required inputMode="decimal" value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value })} />}
        </Field>
        <Field label={t('extras.category')}>
          {(id) => (
            <Select id={id} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {CHARGE_CATEGORIES.filter((c) => c !== 'accommodation').map((c) => <option key={c} value={c}>{t(`charges.${c}`)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('extras.order')}>
          {(id) => <Input id={id} type="number" min={0} max={999} value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} />}
        </Field>
      </div>
      <Checkbox label={t('extras.bookableOnline')} checked={f.bookableOnline} onChange={(v) => setF({ ...f, bookableOnline: v })} />
      <Checkbox label={t('common.active')} checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      <div className="flex justify-end">
        <Button type="submit" loading={m.isPending}>{t('common.save')}</Button>
      </div>
    </form>
  );
}

function PromoForm({ property, promo, plans, onDone }: { property: Property; promo?: PromoCode; plans: RatePlan[]; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({
    code: promo?.code ?? '',
    description: promo?.description ?? '',
    discountType: promo?.discountType ?? 'percent',
    value: promo ? (promo.discountType === 'percent' ? String(promo.value) : toInput(promo.value)) : '',
    stayFrom: promo?.stayFrom ?? '',
    stayTo: promo?.stayTo ?? '',
    minNights: promo?.minNights ?? 1,
    ratePlanId: promo?.ratePlanId ?? '',
    maxUses: promo?.maxUses != null ? String(promo.maxUses) : '',
    active: promo?.active ?? true,
  });
  const m = useMutation({
    mutationFn: () => {
      const common = {
        description: f.description || null,
        stayFrom: f.stayFrom || null,
        stayTo: f.stayTo || null,
        minNights: Number(f.minNights),
        maxUses: f.maxUses ? Number(f.maxUses) : null,
        active: f.active,
      };
      // Code, type, value and rate plan are fixed once a code exists: guests may already hold it.
      if (promo) return api.patch(`/promo-codes/${promo.id}`, common);
      const value = f.discountType === 'percent' ? Number(f.value) : parseMoney(f.value);
      if (!value || value < 0) throw new ApiError(422, 'VALIDATION', `${t('extras.value')}: ${f.value || '—'}`);
      return api.post('/promo-codes', {
        ...common,
        propertyId: property.id,
        code: f.code,
        discountType: f.discountType,
        value,
        ratePlanId: f.ratePlanId || null,
      });
    },
    onSuccess: onDone,
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <ErrorText error={m.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.code')}>
          {(id) => (
            <Input
              id={id}
              required
              disabled={Boolean(promo)}
              pattern="[A-Za-z0-9_\-]{3,24}"
              className="font-mono uppercase"
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
            />
          )}
        </Field>
        <Field label={t('extras.onlyPlan')}>
          {(id) => (
            <Select id={id} disabled={Boolean(promo)} value={f.ratePlanId} onChange={(e) => setF({ ...f, ratePlanId: e.target.value })}>
              <option value="">{t('extras.anyPlan')}</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('extras.discountType')}>
          {(id) => (
            <Select id={id} disabled={Boolean(promo)} value={f.discountType} onChange={(e) => setF({ ...f, discountType: e.target.value as PromoCode['discountType'] })}>
              <option value="percent">{t('extras.percent')}</option>
              <option value="fixed">{t('extras.fixed')}</option>
            </Select>
          )}
        </Field>
        <Field label={f.discountType === 'percent' ? `${t('extras.value')} (%)` : `${t('extras.value')} (${property.currency})`}>
          {(id) => <Input id={id} required disabled={Boolean(promo)} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}
        </Field>
        <Field label={`${t('extras.arrivals')} · ${t('common.from')}`} hint={t('common.optional')}>
          {(id) => <Input id={id} type="date" value={f.stayFrom} onChange={(e) => setF({ ...f, stayFrom: e.target.value })} />}
        </Field>
        <Field label={t('common.to')} hint={t('common.optional')}>
          {(id) => <Input id={id} type="date" min={f.stayFrom || undefined} value={f.stayTo} onChange={(e) => setF({ ...f, stayTo: e.target.value })} />}
        </Field>
        <Field label={t('settings.minNights')}>
          {(id) => <Input id={id} type="number" min={1} max={60} value={f.minNights} onChange={(e) => setF({ ...f, minNights: Number(e.target.value) })} />}
        </Field>
        <Field label={t('extras.maxUses')} hint={t('extras.unlimited')}>
          {(id) => <Input id={id} type="number" min={1} value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} />}
        </Field>
        <Field label={t('common.description')} hint={t('common.optional')} className="sm:col-span-2">
          {(id) => <Input id={id} maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}
        </Field>
      </div>
      <Checkbox label={t('common.active')} checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      <p className="text-xs text-muted">{t('extras.promoHint')}</p>
      <div className="flex justify-end">
        <Button type="submit" loading={m.isPending}>{t('common.save')}</Button>
      </div>
    </form>
  );
}

function ExtrasAndPromos({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const manage = can('rates.manage');
  const m = (v: number) => money(v, property.currency, locale);
  const extras = useQuery({ queryKey: ['extras', property.id], queryFn: () => api.get<Extra[]>('/extras', { propertyId: property.id }) });
  const promos = useQuery({ queryKey: ['promo-codes', property.id], queryFn: () => api.get<PromoCode[]>('/promo-codes', { propertyId: property.id }) });
  const plans = useQuery({ queryKey: ['rate-plans', property.id], queryFn: () => api.get<RatePlan[]>('/rate-plans', { propertyId: property.id }) });
  const [editExtra, setEditExtra] = useState<Extra | 'new' | null>(null);
  const [editPromo, setEditPromo] = useState<PromoCode | 'new' | null>(null);

  if (extras.isLoading || promos.isLoading || plans.isLoading) return <Spinner />;
  const planName = (id: string | null) => plans.data?.find((p) => p.id === id)?.name;
  const packagesOf = (extraId: string) => plans.data?.filter((p) => p.includedExtraIds.includes(extraId)).map((p) => p.name) ?? [];

  return (
    <>
      <PageHeader title={t('extras.title')} eyebrow={property.name} />
      <ErrorText error={extras.error ?? promos.error ?? plans.error} />
      <Card
        title={t('extras.extras')}
        padded={false}
        actions={manage && <Button size="sm" onClick={() => setEditExtra('new')}><Plus size={14} /> {t('extras.newExtra')}</Button>}
      >
        <p className="px-4 pt-3 text-sm text-muted">{t('extras.extrasHint')}</p>
        <Table head={[t('common.name'), t('extras.price'), t('extras.unit'), t('extras.vat'), t('settings.ratePlans'), t('common.status'), '']} empty={!extras.data?.length}>
          {extras.data?.map((e) => (
            <tr key={e.id}>
              <Td>
                <span className="font-medium">{e.name}</span>
                {e.description && <span className="block text-xs text-muted">{e.description}</span>}
              </Td>
              <Td className="tabular-nums">{m(e.price)}</Td>
              <Td>{t(`extras.units.${e.unit}`)}</Td>
              <Td>{percent(e.vatRate)}</Td>
              <Td className="text-xs text-muted">{packagesOf(e.id).join(', ') || '—'}</Td>
              <Td>
                <span className="flex flex-wrap gap-1">
                  <Badge tone={e.active ? 'green' : 'gray'}>{e.active ? t('common.active') : t('common.inactive')}</Badge>
                  <Badge tone={e.bookableOnline ? 'blue' : 'gray'}>{e.bookableOnline ? t('extras.online') : t('extras.packageOnly')}</Badge>
                </span>
              </Td>
              <Td className="text-right">{manage && <Button size="sm" variant="ghost" onClick={() => setEditExtra(e)}>{t('common.edit')}</Button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card
        className="mt-6"
        title={t('extras.promos')}
        padded={false}
        actions={manage && <Button size="sm" onClick={() => setEditPromo('new')}><Plus size={14} /> {t('extras.newPromo')}</Button>}
      >
        <Table head={[t('common.code'), t('extras.discount'), t('extras.arrivals'), t('extras.onlyPlan'), t('extras.uses'), t('common.status'), '']} empty={!promos.data?.length}>
          {promos.data?.map((p) => (
            <tr key={p.id}>
              <Td>
                <span className="code">{p.code}</span>
                {p.description && <span className="block text-xs text-muted">{p.description}</span>}
              </Td>
              <Td>{p.discountType === 'percent' ? t('extras.percentOff', { n: p.value }) : t('extras.amountOff', { amount: m(p.value) })}</Td>
              <Td className="text-xs">{p.stayFrom || p.stayTo ? `${date(p.stayFrom, locale)} – ${date(p.stayTo, locale)}` : t('extras.anyDates')}</Td>
              <Td className="text-xs">{planName(p.ratePlanId) ?? t('extras.anyPlan')}</Td>
              <Td className="tabular-nums">
                {p.usedCount}
                {p.maxUses != null && ` / ${p.maxUses}`}
              </Td>
              <Td><Badge tone={p.active ? 'green' : 'gray'}>{p.active ? t('common.active') : t('common.inactive')}</Badge></Td>
              <Td className="text-right">{manage && <Button size="sm" variant="ghost" onClick={() => setEditPromo(p)}>{t('common.edit')}</Button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Modal open={editExtra !== null} onClose={() => setEditExtra(null)} title={editExtra === 'new' ? t('extras.newExtra') : t('common.edit')}>
        {editExtra && (
          <ExtraForm
            property={property}
            extra={editExtra === 'new' ? undefined : editExtra}
            onDone={() => {
              setEditExtra(null);
              void qc.invalidateQueries({ queryKey: ['extras'] });
            }}
          />
        )}
      </Modal>
      <Modal open={editPromo !== null} onClose={() => setEditPromo(null)} title={editPromo === 'new' ? t('extras.newPromo') : t('common.edit')}>
        {editPromo && (
          <PromoForm
            property={property}
            plans={plans.data ?? []}
            promo={editPromo === 'new' ? undefined : editPromo}
            onDone={() => {
              setEditPromo(null);
              void qc.invalidateQueries({ queryKey: ['promo-codes'] });
            }}
          />
        )}
      </Modal>
    </>
  );
}

export default function ExtrasPage() {
  return <PropertyGate perms={['rates.read']}>{(p) => <ExtrasAndPromos property={p} />}</PropertyGate>;
}
