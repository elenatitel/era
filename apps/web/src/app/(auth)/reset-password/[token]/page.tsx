'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert, Button, ErrorText, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function ResetPasswordPage() {
  const { t } = useI18n();
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError(new Error(t('auth.passwordsDiffer')));
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <h1 className="text-2xl font-semibold">{t('auth.forgotTitle')}</h1>
      {error instanceof Error && !('status' in error) ? <Alert>{error.message}</Alert> : <ErrorText error={error} />}
      {done ? (
        <Alert tone="green">{t('auth.passwordReset')}</Alert>
      ) : (
        <>
          <Field label={t('auth.newPassword')} hint={t('auth.passwordRules')}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field label={t('auth.confirmPassword')}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            {t('auth.setPassword')}
          </Button>
        </>
      )}
      <p className="text-center text-sm">
        <Link href="/login" className="text-brand-600 hover:underline">
          {t('auth.backToLogin')}
        </Link>
      </p>
    </form>
  );
}
