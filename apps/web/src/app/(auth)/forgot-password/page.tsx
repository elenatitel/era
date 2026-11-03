'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { Alert, Button, ErrorText, Field, Input } from '@/components/ui';
import { useAuthConfig } from '@/lib/auth-config';
import { ManagedCredentials } from '@/components/managed-credentials';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const auth=useAuthConfig();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password/forgot', { email });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if(auth.isPending) return null;
  if(auth.error) return <ErrorText error={auth.error} />;
  if(auth.data.provider==='keycloak') return <ManagedCredentials />;
  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h1 className="font-display text-[32px] leading-[38px] font-medium">{t('auth.forgotTitle')}</h1>
        <p className="mt-1 text-sm text-muted">{t('auth.forgotHint')}</p>
      </div>
      <ErrorText error={error} />
      {sent ? (
        <Alert tone="green">{t('auth.linkSent')}</Alert>
      ) : (
        <>
          <Field label={t('auth.email')}>{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" loading={busy} className="w-full">
            {t('auth.sendLink')}
          </Button>
        </>
      )}
      <p className="text-center text-sm">
        <Link href="/login" className="text-accent hover:underline">
          {t('auth.backToLogin')}
        </Link>
      </p>
    </form>
  );
}
