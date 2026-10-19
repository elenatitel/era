'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Coffee } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RESERVATION_SOURCES, addDays } from '@pms/shared';
import { GuestPicker } from '@/components/guest-picker';
import { PropertyGate } from '@/components/property-gate';
import { Alert, Badge, Button, Card, ErrorText, Field, Input, PageHeader, Select, Spinner, Tabs, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Guest, Property, RoomType } from '@/lib/types';

interface Offer {
  ratePlanId: string;
  ratePlanName: string;
  includesBreakfast: boolean;
  total: number;
  sellable: boolean;
  minNights: number;
}
interface Availability {
  nights: number;
  roomTypes: { roomType: RoomType; available: number; fitsOccupancy: boolean; offers: Offer[] }[];
}

function NewReservation({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [arrival, setArrival] = useState(property.businessDate);
  const [departure, setDeparture] = useState(addDays(property.businessDate, 1));
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [search, setSearch] = useState<{ arrival: string; departure: string; adults: number } | null>(null);
  const [choice, setChoice] = useState<{ roomTypeId: string; ratePlanId: string; total: number } | null>(null);
  const [guestMode, setGuestMode] = useState<'existing' | 'new'>('new');
  const [guest, setGuest] = useState<Guest | null>(null);
  const [newGuest, setNewGuest] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [source, setSource] = useState('direct');
  const [status, setStatus] = useState<'confirmed' | 'tentative'>('confirmed');
  const [notes, setNotes] = useState('');

  const avail = useQuery({
    queryKey: ['availability', property.id, search],
    queryFn: () => api.get<Availability>('/availability', { propertyId: property.id, ...search! }),
    enabled: Boolean(search),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; code: string }>('/reservations', {
        propertyId: property.id,
        roomTypeId: choice!.roomTypeId,
        ratePlanId: choice!.ratePlanId,
        arrival: search!.arrival,
        departure: search!.departure,
        adults,
        children,
        source,
        status,
        notes: notes || null,
        ...(guestMode === 'existing' && guest
          ? { guestId: guest.id }
          : { guest: { ...newGuest, email: newGuest.email || null, phone: newGuest.phone || null } }),
      }),
    onSuccess: (r) => router.push(`/reservations/${r.id}`),
  });

  const guestReady = guestMode === 'existing' ? Boolean(guest) : newGuest.firstName.trim() && newGuest.lastName.trim();

  return (
    <>
      <PageHeader title={t('reservations.new')} eyebrow={property.name} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <form
              className="grid gap-3 sm:grid-cols-5"
              onSubmit={(e) => {
                e.preventDefault();
                setChoice(null);
                setSearch({ arrival, departure, adults: adults + children });
              }}
            >
              <Field label={t('reservations.arrival')} className="sm:col-span-1">
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    min={property.businessDate}
                    value={arrival}
                    onChange={(e) => {
                      setArrival(e.target.value);
                      if (e.target.value >= departure) setDeparture(addDays(e.target.value, 1));
                    }}
                  />
                )}
              </Field>
              <Field label={t('reservations.departure')}>
                {(id) => <Input id={id} type="date" min={addDays(arrival, 1)} value={departure} onChange={(e) => setDeparture(e.target.value)} />}
              </Field>
              <Field label={t('reservations.adults')}>
                {(id) => <Input id={id} type="number" min={1} max={20} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />}
              </Field>
              <Field label={t('reservations.children')}>
                {(id) => <Input id={id} type="number" min={0} max={20} value={children} onChange={(e) => setChildren(Number(e.target.value))} />}
              </Field>
              <div className="flex items-end">
                <Button type="submit" className="w-full">
                  {t('reservations.searchAvailability')}
                </Button>
              </div>
            </form>
          </Card>

          {avail.isFetching && <Spinner />}
          <ErrorText error={avail.error} />
          {avail.data && (
            <div className="space-y-3">
              {avail.data.roomTypes.map(({ roomType, available, fitsOccupancy, offers }) => (
                <Card key={roomType.id}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-semibold">
                        {roomType.name} <span className="text-xs text-muted">{roomType.code}</span>
                      </h3>
                      <p className="text-xs text-muted">
                        max {roomType.maxOccupancy} · {available > 0 ? `${available} ${t('reservations.available')}` : t('reservations.soldOut')}
                      </p>
                    </div>
                    {available <= 0 ? <Badge tone="red">{t('reservations.soldOut')}</Badge> : !fitsOccupancy && <Badge tone="amber">max {roomType.maxOccupancy}</Badge>}
                  </div>
                  <ul className="divide-y divide-line">
                    {offers.map((o) => {
                      const selectable = available > 0 && fitsOccupancy && o.sellable;
                      const selected = choice?.roomTypeId === roomType.id && choice.ratePlanId === o.ratePlanId;
                      return (
                        <li key={o.ratePlanId} className="flex items-center justify-between gap-3 py-2">
                          <div className="text-sm">
                            <span className="font-medium">{o.ratePlanName}</span>
                            {o.includesBreakfast && (
                              <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted">
                                <Coffee size={12} /> {t('reservations.breakfast')}
                              </span>
                            )}
                            {o.minNights > 1 && <span className="ml-2 text-xs text-muted">{t('reservations.minNights', { n: o.minNights })}</span>}
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-semibold">{money(o.total, property.currency, locale)}</span>
                            <Button
                              size="sm"
                              variant={selected ? 'primary' : 'secondary'}
                              disabled={!selectable}
                              onClick={() => setChoice({ roomTypeId: roomType.id, ratePlanId: o.ratePlanId, total: o.total })}
                            >
                              {selected ? <Check size={14} /> : t('reservations.select')}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <Card title={t('reservations.guestDetails')}>
            <Tabs
              value={guestMode}
              onChange={setGuestMode}
              items={[
                { value: 'new', label: t('reservations.newGuest') },
                { value: 'existing', label: t('reservations.existingGuest') },
              ]}
            />
            {guestMode === 'existing' ? (
              <GuestPicker value={guest} onChange={setGuest} />
            ) : (
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('reservations.firstName')}>
                    {(id) => <Input id={id} required value={newGuest.firstName} onChange={(e) => setNewGuest({ ...newGuest, firstName: e.target.value })} />}
                  </Field>
                  <Field label={t('reservations.lastName')}>
                    {(id) => <Input id={id} required value={newGuest.lastName} onChange={(e) => setNewGuest({ ...newGuest, lastName: e.target.value })} />}
                  </Field>
                </div>
                <Field label={t('common.email')}>
                  {(id) => <Input id={id} type="email" value={newGuest.email} onChange={(e) => setNewGuest({ ...newGuest, email: e.target.value })} />}
                </Field>
                <Field label={t('common.phone')}>{(id) => <Input id={id} value={newGuest.phone} onChange={(e) => setNewGuest({ ...newGuest, phone: e.target.value })} />}</Field>
              </div>
            )}
          </Card>
          <Card>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('reservations.source')}>
                  {(id) => (
                    <Select id={id} value={source} onChange={(e) => setSource(e.target.value)}>
                      {RESERVATION_SOURCES.map((s) => (
                        <option key={s} value={s}>
                          {t(`sources.${s}`)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={t('common.status')}>
                  {(id) => (
                    <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as 'confirmed' | 'tentative')}>
                      <option value="confirmed">{t('resStatus.confirmed')}</option>
                      <option value="tentative">{t('resStatus.tentative')}</option>
                    </Select>
                  )}
                </Field>
              </div>
              <Field label={t('common.notes')}>{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
              {choice && (
                <Alert tone="blue">
                  {t('common.total')}: <strong>{money(choice.total, property.currency, locale)}</strong> · {avail.data?.nights} {t('reservations.nights').toLowerCase()}
                </Alert>
              )}
              <ErrorText error={create.error} />
              <Button className="w-full" disabled={!choice || !guestReady} loading={create.isPending} onClick={() => create.mutate()}>
                {t('reservations.confirm')}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

export default function NewReservationPage() {
  return <PropertyGate perms={['reservations.create']}>{(p) => <NewReservation property={p} />}</PropertyGate>;
}
