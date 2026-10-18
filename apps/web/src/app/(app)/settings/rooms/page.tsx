'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { parseMoney } from '@pms/shared';
import { PropertyGate } from '@/components/property-gate';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, statusTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Property, Room, RoomType } from '@/lib/types';

function RoomTypeForm({ property, rt, onDone }: { property: Property; rt?: RoomType; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({
    name: rt?.name ?? '',
    code: rt?.code ?? '',
    description: rt?.description ?? '',
    baseOccupancy: rt?.baseOccupancy ?? 2,
    maxOccupancy: rt?.maxOccupancy ?? 2,
    baseRate: rt ? (rt.baseRate / 100).toFixed(2) : '',
    active: rt?.active ?? true,
  });
  const m = useMutation({
    mutationFn: () => {
      const baseRate = parseMoney(f.baseRate);
      if (baseRate === null) throw new ApiError(422, 'VALIDATION', t('settings.baseRate'));
      const body = { name: f.name, code: f.code.toUpperCase(), description: f.description || null, baseOccupancy: Number(f.baseOccupancy), maxOccupancy: Number(f.maxOccupancy), baseRate };
      return rt ? api.patch(`/room-types/${rt.id}`, { ...body, active: f.active }) : api.post('/room-types', { ...body, propertyId: property.id });
    },
    onSuccess: onDone,
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <ErrorText error={m.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')}>{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('common.code')}>{(id) => <Input id={id} required maxLength={12} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
        <Field label={t('settings.baseOccupancy')}>{(id) => <Input id={id} type="number" min={1} value={f.baseOccupancy} onChange={(e) => setF({ ...f, baseOccupancy: Number(e.target.value) })} />}</Field>
        <Field label={t('settings.maxOccupancy')}>{(id) => <Input id={id} type="number" min={1} value={f.maxOccupancy} onChange={(e) => setF({ ...f, maxOccupancy: Number(e.target.value) })} />}</Field>
        <Field label={`${t('settings.baseRate')} (${property.currency})`}>{(id) => <Input id={id} required inputMode="decimal" value={f.baseRate} onChange={(e) => setF({ ...f, baseRate: e.target.value })} />}</Field>
        {rt && (
          <Field label={t('common.status')}>
            {(id) => (
              <Select id={id} value={f.active ? '1' : '0'} onChange={(e) => setF({ ...f, active: e.target.value === '1' })}>
                <option value="1">{t('common.active')}</option>
                <option value="0">{t('common.inactive')}</option>
              </Select>
            )}
          </Field>
        )}
        <Field label={t('common.description')} className="sm:col-span-2">
          {(id) => <Input id={id} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={m.isPending}>{t('common.save')}</Button>
      </div>
    </form>
  );
}

function RoomForm({ property, types, room, onDone }: { property: Property; types: RoomType[]; room?: Room; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ number: room?.number ?? '', floor: room?.floor ?? '', roomTypeId: room?.roomTypeId ?? types[0]?.id ?? '', notes: room?.notes ?? '', active: room?.active ?? true });
  const m = useMutation({
    mutationFn: () => {
      const body = { number: f.number, floor: f.floor || null, roomTypeId: f.roomTypeId, notes: f.notes || null };
      return room ? api.patch(`/rooms/${room.id}`, { ...body, active: f.active }) : api.post('/rooms', { ...body, propertyId: property.id });
    },
    onSuccess: onDone,
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <ErrorText error={m.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('settings.number')}>{(id) => <Input id={id} required value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />}</Field>
        <Field label={t('settings.floor')}>{(id) => <Input id={id} value={f.floor} onChange={(e) => setF({ ...f, floor: e.target.value })} />}</Field>
        <Field label={t('reservations.roomType')}>
          {(id) => (
            <Select id={id} value={f.roomTypeId} onChange={(e) => setF({ ...f, roomTypeId: e.target.value })}>
              {types.map((rt) => (
                <option key={rt.id} value={rt.id}>{rt.name} ({rt.code})</option>
              ))}
            </Select>
          )}
        </Field>
        {room && (
          <Field label={t('common.status')}>
            {(id) => (
              <Select id={id} value={f.active ? '1' : '0'} onChange={(e) => setF({ ...f, active: e.target.value === '1' })}>
                <option value="1">{t('common.active')}</option>
                <option value="0">{t('common.inactive')}</option>
              </Select>
            )}
          </Field>
        )}
        <Field label={t('common.notes')} className="sm:col-span-2">{(id) => <Input id={id} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={m.isPending}>{t('common.save')}</Button>
      </div>
    </form>
  );
}

function Rooms({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const manage = can('rooms.manage');
  const types = useQuery({ queryKey: ['room-types', property.id], queryFn: () => api.get<RoomType[]>('/room-types', { propertyId: property.id }) });
  const rooms = useQuery({ queryKey: ['rooms', property.id], queryFn: () => api.get<Room[]>('/rooms', { propertyId: property.id }) });
  const [editType, setEditType] = useState<RoomType | 'new' | null>(null);
  const [editRoom, setEditRoom] = useState<Room | 'new' | null>(null);
  const done = () => {
    setEditType(null);
    setEditRoom(null);
    void qc.invalidateQueries({ queryKey: ['room-types'] });
    void qc.invalidateQueries({ queryKey: ['rooms'] });
  };
  if (types.isLoading || rooms.isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title={t('nav.rooms')} subtitle={property.name} />
      <ErrorText error={types.error ?? rooms.error} />
      <Card
        title={t('settings.roomTypes')}
        padded={false}
        actions={manage && <Button size="sm" onClick={() => setEditType('new')}><Plus size={14} /> {t('settings.newRoomType')}</Button>}
      >
        <Table head={[t('common.code'), t('common.name'), t('settings.maxOccupancy'), t('settings.baseRate'), t('settings.rooms'), '']} empty={!types.data?.length}>
          {types.data?.map((rt) => (
            <tr key={rt.id} className={rt.active ? '' : 'opacity-50'}>
              <Td className="font-mono text-xs font-semibold">{rt.code}</Td>
              <Td>{rt.name}</Td>
              <Td>{rt.baseOccupancy} / {rt.maxOccupancy}</Td>
              <Td>{money(rt.baseRate, property.currency, locale)}</Td>
              <Td>{rooms.data?.filter((r) => r.roomTypeId === rt.id).length}</Td>
              <Td className="text-right">{manage && <Button size="sm" variant="ghost" onClick={() => setEditType(rt)}>{t('common.edit')}</Button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card
        className="mt-6"
        title={t('settings.rooms')}
        padded={false}
        actions={manage && Boolean(types.data?.length) && <Button size="sm" onClick={() => setEditRoom('new')}><Plus size={14} /> {t('settings.newRoom')}</Button>}
      >
        <Table head={[t('settings.number'), t('settings.floor'), t('reservations.roomType'), t('common.status'), '']} empty={!rooms.data?.length}>
          {rooms.data?.map((r) => (
            <tr key={r.id} className={r.active ? '' : 'opacity-50'}>
              <Td className="font-semibold">{r.number}</Td>
              <Td>{r.floor ?? '—'}</Td>
              <Td>{r.roomTypeName}</Td>
              <Td>
                <Badge tone={statusTone[r.status]}>{t(`roomStatus.${r.status}`)}</Badge>{' '}
                <Badge tone={r.occupancy === 'occupied' ? 'brand' : 'gray'}>{t(`roomStatus.${r.occupancy}`)}</Badge>
              </Td>
              <Td className="text-right">{manage && <Button size="sm" variant="ghost" onClick={() => setEditRoom(r)}>{t('common.edit')}</Button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Modal open={editType !== null} onClose={() => setEditType(null)} title={editType === 'new' ? t('settings.newRoomType') : t('common.edit')}>
        {editType && <RoomTypeForm property={property} rt={editType === 'new' ? undefined : editType} onDone={done} />}
      </Modal>
      <Modal open={editRoom !== null} onClose={() => setEditRoom(null)} title={editRoom === 'new' ? t('settings.newRoom') : t('common.edit')}>
        {editRoom && <RoomForm property={property} types={types.data ?? []} room={editRoom === 'new' ? undefined : editRoom} onDone={done} />}
      </Modal>
    </>
  );
}

export default function RoomsPage() {
  return <PropertyGate perms={['rooms.read']}>{(p) => <Rooms property={p} />}</PropertyGate>;
}
