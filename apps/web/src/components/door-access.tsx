"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, Card, ErrorText, Field, Input, Modal } from "@/components/ui";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
function useText() {
  const { locale } = useI18n();
  return (en: string, ro: string) => (locale === "ro" ? ro : en);
}
type Reader = {
  wireId: number;
  publicKey: string;
  name: string;
  enabled: boolean;
};
export function RoomDoorSettings({
  roomId,
  number,
  onClose,
}: {
  roomId: string;
  number: string;
  onClose: () => void;
}) {
  const t = useText();
  const q = useQuery({
    queryKey: ["doorkey-room", roomId],
    queryFn: () => api.get<Reader | null>(`/rooms/${roomId}/doorkey`),
  });
  return (
    <Modal open onClose={onClose} title={`DoorKey · ${number}`}>
      <ErrorText error={q.error} />
      {q.isSuccess && (
        <ReaderForm
          key={JSON.stringify(q.data)}
          roomId={roomId}
          initial={
            q.data ?? {
              wireId: 12,
              publicKey: "",
              name: `Door-${number}`,
              enabled: true,
            }
          }
        />
      )}
      <p className="mt-4 text-sm text-muted">
        {t(
          "Register the public identity read from the ESP32 console. The label here does not rename BLE advertising. Matter events and the door automation stay in Home Assistant.",
          "Înregistrează identitatea publică din consola ESP32. Eticheta de aici nu schimbă numele BLE. Evenimentele Matter și automatizarea ușii rămân în Home Assistant.",
        )}
      </p>
    </Modal>
  );
}
function ReaderForm({ roomId, initial }: { roomId: string; initial: Reader }) {
  const t = useText();
  const [value, set] = useState(initial);
  const save = useMutation({
    mutationFn: () => api.put(`/rooms/${roomId}/doorkey`, value),
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
      <Field label={t("Door ID (firmware)", "ID ușă (firmware)")}>
        {(id) => (
          <Input
            id={id}
            type="number"
            required
            min={1}
            max={4294967295}
            value={value.wireId}
            onChange={(e) => set({ ...value, wireId: Number(e.target.value) })}
          />
        )}
      </Field>
      <Field label={t("Door label", "Etichetă ușă")}>
        {(id) => (
          <Input
            id={id}
            required
            maxLength={29}
            value={value.name}
            onChange={(e) => set({ ...value, name: e.target.value })}
          />
        )}
      </Field>
      <Field
        label={t(
          "ESP32 public key (P-256, hexadecimal)",
          "Cheie publică ESP32 (P-256, hexazecimal)",
        )}
      >
        {(id) => (
          <Input
            id={id}
            required
            pattern="04[0-9a-fA-F]{128}"
            value={value.publicKey}
            onChange={(e) =>
              set({ ...value, publicKey: e.target.value.trim() })
            }
          />
        )}
      </Field>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => set({ ...value, enabled: e.target.checked })}
        />
        {t("Enable this reader", "Activează cititorul")}
      </label>
      <Button type="submit" loading={save.isPending}>
        {t("Save reader", "Salvează cititorul")}
      </Button>
      {save.isSuccess && (
        <p role="status">
          {t(
            "Saved. Reader identities are immutable; labels can be edited.",
            "Salvat. Identitatea cititorului este fixă; eticheta poate fi modificată.",
          )}
        </p>
      )}
    </form>
  );
}
type Device = {
  id: string;
  version: number;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
type Access = { enabled: boolean; version: number; devices: Device[] };
export function ReservationDoorAccess({
  reservationId,
  status,
}: {
  reservationId: string;
  status: string;
}) {
  const t = useText(),
    qc = useQueryClient();
  const [issued, setIssued] = useState<{
    url: string;
    qr: string;
    expiresAt: string;
  } | null>(null);
  useEffect(() => setIssued(null), [status, reservationId]);
  const q = useQuery({
    queryKey: ["doorkey-access", reservationId, status],
    queryFn: () => api.get<Access>(`/reservations/${reservationId}/doorkey`),
  });
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["doorkey-access", reservationId] });
  const issue = useMutation({
    mutationFn: () =>
      api.post<{ url: string; qr: string; expiresAt: string }>(
        `/reservations/${reservationId}/doorkey/invitations`,
      ),
    onSuccess: (r) => {
      setIssued(r);
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id?: string) =>
      api.post(
        `/reservations/${reservationId}/doorkey/${id ? `devices/${id}/revoke` : "revoke"}`,
      ),
    onSuccess: () => {
      setIssued(null);
      void refresh();
    },
  });
  return (
    <Card className="mt-6" title="DoorKey · BLE">
      <ErrorText error={q.error ?? issue.error ?? revoke.error} />
      <p className="mb-4 text-sm text-muted">
        {t(
          "After check-in, issue one invitation per phone. The QR enrolls the phone; approaching the reader uses its private key. Checkout, room changes and revocation stop new authorizations.",
          "După check-in, emite o invitație pentru fiecare telefon. QR-ul înscrie telefonul; apropierea de cititor folosește cheia lui privată. Check-out, schimbarea camerei și revocarea opresc autorizările noi.",
        )}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={status !== "checked_in"}
          loading={issue.isPending}
          onClick={() => issue.mutate()}
        >
          {t("Create phone invitation", "Creează invitație telefon")}
        </Button>
        <Button
          variant="danger"
          disabled={!q.data?.enabled}
          loading={revoke.isPending}
          onClick={() => {
            if (
              confirm(
                t(
                  "Revoke all phone keys and pending invitations for this stay?",
                  "Revoci toate telefoanele și invitațiile în așteptare pentru acest sejur?",
                ),
              )
            )
              revoke.mutate(undefined);
          }}
        >
          {t("Revoke all access", "Revocă tot accesul")}
        </Button>
      </div>
      {issued && (
        <div className="mt-4 rounded-lg border border-line p-4 text-center">
          <img
            src={issued.qr}
            width={240}
            height={240}
            alt="DoorKey invitation"
            className="mx-auto"
          />
          <p>
            {t("One phone · expires", "Un telefon · expiră")}{" "}
            {new Date(issued.expiresAt).toLocaleTimeString()}
          </p>
          <p className="mt-2 text-sm">
            {t(
              "Scan in DoorKey. Treat this invitation as a secret. Create another QR for the next phone.",
              "Scanează în DoorKey. Păstrează invitația confidențială. Creează alt QR pentru următorul telefon.",
            )}
          </p>
          <Button
            className="mt-3"
            variant="secondary"
            onClick={() => navigator.clipboard.writeText(issued.url)}
          >
            {t("Copy invitation link", "Copiază invitația")}
          </Button>
          <Button
            className="mt-3 ml-2"
            variant="secondary"
            onClick={() => setIssued(null)}
          >
            {t("Hide", "Ascunde")}
          </Button>
        </div>
      )}
      {q.data && !q.data.enabled && (
        <p className="mt-3 text-sm">
          {t("No active access grant.", "Nu există acces activ.")}
        </p>
      )}
      <ul className="mt-4 divide-y divide-line">
        {q.data?.devices.map((d) => {
          const active =
            q.data.enabled &&
            !d.revokedAt &&
            d.version === q.data.version &&
            Date.parse(d.expiresAt) > Date.now();
          return (
            <li key={d.id} className="flex justify-between gap-3 py-3">
              <div>
                <p className="text-sm">
                  {t("Phone", "Telefon")} · {d.id.slice(0, 8)}
                </p>
                <p className="text-xs text-muted">
                  {active ? t("Active", "Activ") : t("Inactive", "Inactiv")}
                  {d.lastUsedAt
                    ? " · " + new Date(d.lastUsedAt).toLocaleString()
                    : ""}
                </p>
              </div>
              {active && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => revoke.mutate(d.id)}
                >
                  {t("Revoke", "Revocă")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
