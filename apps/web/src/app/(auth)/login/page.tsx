'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ErrorText, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function done(tenantSelected: boolean) {
    qc.clear();
    router.replace(tenantSelected ? safeNext(params.get('next')) : '/select-organization');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!mfaToken) {
        const r = await api.post<{ mfaRequired: boolean; mfaToken?: string; tenantSelected?: boolean }>('/auth/login', { email, password });
        if (r.mfaRequired) setMfaToken(r.mfaToken!);
        else await done(Boolean(r.tenantSelected));
      } else {
        const r = await api.post<{ tenantSelected: boolean }>('/auth/login/mfa', { mfaToken, code: code.trim() });
        await done(r.tenantSelected);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{mfaToken ? t('auth.mfaTitle') : t('auth.welcome')}</h1>
        <p className="mt-1 text-sm text-muted">{mfaToken ? t('auth.mfaHint') : t('auth.signInHint')}</p>
      </div>
      <ErrorText error={error} />
      {!mfaToken ? (
        <>
          <Field label={t('auth.email')}>
            {(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label={t('auth.password')}>
            {(id) => (
              <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Field>
        </>
      ) : (
        <Field label={t('auth.code')}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={11}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="text-center text-lg tracking-[0.4em]"
            />
          )}
        </Field>
      )}
      <Button type="submit" loading={busy} className="w-full">
        {mfaToken ? t('auth.verify') : t('auth.signIn')}
      </Button>
      <p className="text-center text-sm">
        <Link href="/forgot-password" className="text-brand-600 hover:underline">
          {t('auth.forgot')}
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
