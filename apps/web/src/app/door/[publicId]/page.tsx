'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DoorOpen, LockKeyhole } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { Wordmark } from '@/components/wordmark';
import { useI18n } from '@/lib/i18n';

type Key = {
  room: string;
  property: string;
  validUntil: string;
  timezone: string;
};
/** Guest-only transport: NEVER refresh staff tokens or automatically retry unlocks. */
async function doorRequest<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) {
    const csrf = await fetch('/api/auth/csrf', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!csrf.ok) throw new Error('Unable to prepare request. Please try again.');
    headers['x-csrf-token'] = (await csrf.json()).csrfToken;
    headers['content-type'] = 'application/json';
  }
  const r = await fetch('/api/public/doors/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok)
    throw Object.assign(
      new Error(data?.error?.message ?? 'Unable to complete the request. Please contact reception.'),
      { status: r.status },
    );
  return data as T;
}

export default function GuestDoorPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const { locale, setLocale } = useI18n();
  const text = (en: string, ro: string) => (locale === 'ro' ? ro : en);
  const [key, setKey] = useState<Key | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let alive = true;
    setKey(null);
    setPin('');
    setError('');
    setSuccess(false);
    setLoading(true);
    doorRequest<Key>(publicId + '/session')
      .then((k) => {
        if (alive) setKey(k);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [publicId]);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      if ((e as { status?: number }).status === 401) setKey(null);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-canvas px-5 py-10 text-ink">
      <div className="mb-8">
        <Wordmark size="md" tagline />
      </div>
      <section className="w-full max-w-sm space-y-6 text-center">
        <div className="flex justify-end gap-3 text-xs">
          <button onClick={() => setLocale('en')} aria-pressed={locale === 'en'}>
            EN
          </button>
          <button onClick={() => setLocale('ro')} aria-pressed={locale === 'ro'}>
            RO
          </button>
        </div>
        {loading ? (
          <p role="status">{text('Checking your guest key…', 'Verificăm cheia…')}</p>
        ) : key ? (
          <>
            <DoorOpen className="mx-auto h-12 w-12 text-accent" />
            <div>
              <p className="text-sm text-muted">{key.property}</p>
              <h1 className="mt-2 font-display text-4xl">
                {text('Room', 'Camera')} {key.room}
              </h1>
            </div>
            <p className="text-sm text-muted">
              {text('Valid until', 'Valabil până la')} {key.validUntil} · {key.timezone}
            </p>
            <UnlockSlider
              disabled={busy || success}
              label={
                busy
                  ? text('Sending command…', 'Trimitem comanda…')
                  : text('Slide to unlock', 'Glisează pentru deschidere')
              }
              onUnlock={() =>
                run(async () => {
                  await doorRequest(publicId + '/unlock', {});
                  setSuccess(true);
                })
              }
            />
            {success && (
              <div role="status" className="space-y-3">
                <p>{text('Unlock command accepted.', 'Comanda de deschidere a fost acceptată.')}</p>
                <p className="text-sm text-muted">
                  {text(
                    'If the door remains closed, contact reception.',
                    'Dacă ușa rămâne închisă, contactează recepția.',
                  )}
                </p>
                <Button variant="secondary" onClick={() => setSuccess(false)}>
                  {text('Back to key', 'Înapoi la cheie')}
                </Button>
              </div>
            )}
            <button
              className="text-sm text-muted underline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await doorRequest(publicId + '/forget', {});
                  setKey(null);
                  setPin('');
                  setSuccess(false);
                })
              }
            >
              {text('Forget this device', 'Șterge cheia de pe acest dispozitiv')}
            </button>
          </>
        ) : (
          <>
            <LockKeyhole className="mx-auto h-12 w-12 text-accent" />
            <h1 className="font-display text-3xl">{text('Activate your guest key', 'Activează cheia de oaspete')}</h1>
            <p className="text-sm text-muted">
              {text(
                'Enter your six-digit stay PIN once on each phone, after check-in.',
                'Introdu PIN-ul de șase cifre o singură dată pe fiecare telefon, după check-in.',
              )}
            </p>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const k = await doorRequest<Key>(publicId + '/session', {
                    pin,
                  });
                  setKey(k);
                  setPin('');
                });
              }}
            >
              <label htmlFor="door-pin" className="block text-sm font-medium">
                {text('Stay PIN', 'PIN sejur')}
              </label>
              <Input
                id="door-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                className="text-center text-2xl tracking-widest"
              />
              <Button type="submit" className="w-full" disabled={pin.length !== 6} loading={busy}>
                {text('Activate this phone', 'Activează acest telefon')}
              </Button>
            </form>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
function UnlockSlider({
  disabled,
  label,
  onUnlock,
}: {
  disabled: boolean;
  label: string;
  onUnlock: () => Promise<void>;
}) {
  const [position, setPosition] = useState(0);
  const dragging = useRef<{ start: number; travel: number } | null>(null);
  const submitting = useRef(false);
  const finish = async (value: number) => {
    setPosition(0);
    if (value < 95 || disabled || submitting.current) return;
    submitting.current = true;
    try {
      await onUnlock();
    } finally {
      submitting.current = false;
    }
  };
  return (
    <div className="relative flex h-16 items-center justify-center rounded-full bg-brand text-on-brand">
      <span aria-hidden className="pointer-events-none pl-8 text-sm">
        {label} →
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={position}
        disabled={disabled}
        aria-label={label}
        className="door-slider absolute inset-0 h-16 w-full touch-none"
        onChange={(e) => setPosition(Number(e.target.value))}
        onPointerDown={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          if (disabled || e.clientX > b.left + 60) {
            e.preventDefault();
            return;
          }
          e.preventDefault();
          dragging.current = { start: e.clientX, travel: b.width - 60 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          setPosition(
            Math.max(0, Math.min(100, ((e.clientX - dragging.current.start) / dragging.current.travel) * 100)),
          );
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          const value = Math.max(
            0,
            Math.min(100, ((e.clientX - dragging.current.start) / dragging.current.travel) * 100),
          );
          dragging.current = null;
          void finish(value);
        }}
        onPointerCancel={() => {
          dragging.current = null;
          setPosition(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void finish(position);
          }
        }}
      />
    </div>
  );
}
