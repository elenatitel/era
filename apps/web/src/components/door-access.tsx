'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorText, Field, Input, Modal } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

function useText() {
  const { locale } = useI18n();
  return (en: string, ro: string) => (locale === 'ro' ? ro : en);
}
type Integration = { url: string; enabled: boolean; tokenConfigured: boolean };
export function HomeAssistantSettings({ propertyId }: { propertyId: string }) {
  const text = useText();
  const q = useQuery({
    queryKey: ['home-assistant', propertyId],
    queryFn: () => api.get<Integration>(`/properties/${propertyId}/home-assistant`),
  });
  return (
    <Card className="mt-6" title="Home Assistant">
      <ErrorText error={q.error} />
      {q.data && <IntegrationForm key={propertyId + JSON.stringify(q.data)} propertyId={propertyId} initial={q.data} />}
      <p className="mt-4 text-sm text-muted">
        {text(
          'Used only for the rooms of this property. Connection tests never unlock a door.',
          'Folosit doar pentru camerele acestei proprietăți. Testarea conexiunii nu deschide ușa.',
        )}
      </p>
    </Card>
  );
}
function IntegrationForm({ propertyId, initial }: { propertyId: string; initial: Integration }) {
  const text = useText();
  const qc = useQueryClient();
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(initial.enabled);
  const save = useMutation({
    mutationFn: () =>
      api.put(`/properties/${propertyId}/home-assistant`, {
        url,
        enabled,
        ...(token ? { token } : {}),
      }),
    onSuccess: () => {
      setToken('');
      void qc.invalidateQueries({ queryKey: ['home-assistant', propertyId] });
    },
  });
  const test = useMutation({
    mutationFn: () => api.post(`/properties/${propertyId}/home-assistant/test`),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <ErrorText error={save.error ?? test.error} />
      <Field label="Home Assistant URL">
        {(id) => (
          <Input
            id={id}
            type="url"
            required
            placeholder="https://home.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <Field label={text('Access token', 'Token de acces')}>
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            value={token}
            placeholder={
              initial.tokenConfigured
                ? text('Configured — leave empty to keep', 'Configurat — lasă gol pentru a păstra')
                : ''
            }
            onChange={(e) => setToken(e.target.value)}
          />
        )}
      </Field>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {text('Enable door integration', 'Activează integrarea pentru uși')}
      </label>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={save.isPending}>
          {text('Save', 'Salvează')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!initial.tokenConfigured || url !== initial.url || !!token}
          loading={test.isPending}
          onClick={() => test.mutate()}
        >
          {text('Test saved connection', 'Testează conexiunea salvată')}
        </Button>
      </div>
      {save.isSuccess && <p role="status">{text('Saved.', 'Salvat.')}</p>}
      {test.isSuccess && (
        <p role="status">
          {text('Connected. No door command was sent.', 'Conectat. Nu a fost trimisă nicio comandă de deschidere.')}
        </p>
      )}
    </form>
  );
}
type DoorRoom = { entityId: string; enabled: boolean; url: string; qr: string };
export function RoomDoorSettings({ roomId, number, onClose }: { roomId: string; number: string; onClose: () => void }) {
  const text = useText();
  const q = useQuery({
    queryKey: ['room-door', roomId],
    queryFn: () => api.get<DoorRoom>(`/rooms/${roomId}/door`),
  });
  return (
    <Modal open onClose={onClose} title={text('Door access', 'Acces ușă') + ' · ' + number}>
      <ErrorText error={q.error} />
      {q.data && <RoomDoorForm roomId={roomId} initial={q.data} number={number} />}
    </Modal>
  );
}
function RoomDoorForm({ roomId, initial, number }: { roomId: string; initial: DoorRoom; number: string }) {
  const text = useText();
  const [entityId, setEntityId] = useState(initial.entityId);
  const [enabled, setEnabled] = useState(initial.enabled);
  const save = useMutation({
    mutationFn: () => api.put(`/rooms/${roomId}/door`, { entityId, enabled }),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <ErrorText error={save.error} />
      <Field label="Home Assistant entity_id">
        {(id) => (
          <Input
            id={id}
            required
            placeholder="lock.room_101"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          />
        )}
      </Field>
      <p className="text-sm text-muted">
        {text(
          'An individual lock.* or script.* entity. Changing the entity revokes existing guest keys.',
          'O entitate individuală lock.* sau script.*. Schimbarea entității revocă cheile existente.',
        )}
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {text('Enable digital door access', 'Activează accesul digital')}
      </label>
      <Button type="submit" loading={save.isPending}>
        {text('Save', 'Salvează')}
      </Button>
      {save.isSuccess && <p role="status">{text('Saved.', 'Salvat.')}</p>}
      <div className="border-t border-line pt-4 text-center">
        <img src={initial.qr} width={240} height={240} alt={'QR · ' + number} className="mx-auto" />
        <a href={initial.qr} download={`room-${number}-door-QR.png`} className="text-accent underline">
          {text('Download QR to print', 'Descarcă QR pentru imprimare')}
        </a>
        <p className="mt-2 break-all text-xs text-muted">{initial.url}</p>
        <p className="mt-2 text-sm">
          {text(
            'This public QR requires the stay PIN. Scanning alone never unlocks the door.',
            'Acest QR public cere PIN-ul sejurului. Simpla scanare nu deschide ușa.',
          )}
        </p>
      </div>
    </form>
  );
}
type Access = {
  configured: boolean;
  revoked: boolean;
  devices: {
    id: string;
    name: string;
    active: boolean;
    lastUsedAt: string | null;
  }[];
};
export function ReservationDoorAccess({ reservationId, status }: { reservationId: string; status: string }) {
  const text = useText();
  const qc = useQueryClient();
  const [issued, setIssued] = useState<{ pin: string; url: string } | null>(null);
  useEffect(() => setIssued(null), [status]);
  const q = useQuery({
    queryKey: ['door-access', reservationId, status],
    queryFn: () => api.get<Access>(`/reservations/${reservationId}/door-access`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['door-access', reservationId] });
  const issue = useMutation({
    mutationFn: () => api.post<{ pin: string; url: string }>(`/reservations/${reservationId}/door-access/pin`),
    onSuccess: (r) => {
      setIssued(r);
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (deviceId?: string) =>
      api.post(`/reservations/${reservationId}/door-access/${deviceId ? `devices/${deviceId}/revoke` : 'revoke'}`),
    onSuccess: () => {
      setIssued(null);
      void refresh();
    },
  });
  const active = ['confirmed', 'checked_in'].includes(status);
  return (
    <Card className="mt-6" title={text('Door access', 'Acces la ușă')}>
      <ErrorText error={q.error ?? issue.error ?? revoke.error} />
      <p className="mb-3 text-sm text-muted">
        {text(
          'PIN activation is available after check-in. Rotating the PIN invalidates all previous device keys.',
          'Activarea prin PIN este disponibilă după check-in. Regenerarea PIN-ului invalidează toate cheile dispozitivelor.',
        )}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={!active}
          loading={issue.isPending}
          onClick={() => {
            if (
              !q.data?.configured ||
              confirm(
                text(
                  'Replace the PIN and revoke all existing devices?',
                  'Înlocuiești PIN-ul și revoci toate dispozitivele?',
                ),
              )
            )
              issue.mutate();
          }}
        >
          {text('Generate / rotate PIN', 'Generează / schimbă PIN')}
        </Button>
        <Button
          variant="danger"
          disabled={!q.data?.configured || q.data.revoked}
          loading={revoke.isPending}
          onClick={() => {
            if (confirm(text('Revoke guest door access?', 'Revoci accesul oaspeților?'))) revoke.mutate(undefined);
          }}
        >
          {text('Revoke access', 'Revocă accesul')}
        </Button>
      </div>
      {issued && (
        <div className="mt-4 rounded-lg bg-brand-soft p-4 text-on-brand-soft">
          <p className="text-3xl font-semibold tracking-widest">{issued.pin}</p>
          <p className="mt-2 text-sm">
            {text(
              'Copy now: the PIN is shown only once. The same PIN can activate each guest’s phone.',
              'Copiază acum: PIN-ul este afișat o singură dată. Același PIN poate activa telefonul fiecărui oaspete.',
            )}
          </p>
          <a className="mt-2 block break-all underline" href={issued.url} target="_blank" rel="noreferrer">
            {issued.url}
          </a>
          <Button className="mt-3" variant="secondary" onClick={() => setIssued(null)}>
            {text('Hide PIN', 'Ascunde PIN')}
          </Button>
        </div>
      )}
      {q.data?.revoked && <p className="mt-3">{text('Access revoked.', 'Acces revocat.')}</p>}
      <ul className="mt-4 divide-y divide-line">
        {q.data?.devices.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{d.name}</p>
              <p className="text-xs text-muted">
                {d.active ? text('Active device', 'Dispozitiv activ') : text('Inactive device', 'Dispozitiv inactiv')}
                {d.lastUsedAt ? ' · ' + new Date(d.lastUsedAt).toLocaleString() : ''}
              </p>
            </div>
            {d.active && (
              <Button size="sm" variant="secondary" onClick={() => revoke.mutate(d.id)}>
                {text('Revoke', 'Revocă')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
