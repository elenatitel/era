'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, ErrorText, Field, Input, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function InvitePage() {
  const { t } = useI18n();
  const { token } = useParams<{ token: string }>();
  const info = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<{ email: string; organization: string; accountExists: boolean }>(`/auth/invitations/${token}`),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/invitations/accept', info.data?.accountExists ? { token } : { token, name, password });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (info.isLoading) return <Spinner />;
  if (info.error) return <ErrorText error={info.error} />;
  const d = info.data!;
  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">{t('auth.inviteTitle', { org: d.organization })}</h1>
        <p className="mt-1 text-sm text-muted">{t('auth.inviteHint', { email: d.email })}</p>
      </div>
      <ErrorText error={error} />
      {done ? (
        <>
          <Alert tone="green">{t('auth.inviteAccepted')}</Alert>
          <Link href="/login" className="block text-center text-sm text-accent hover:underline">
            {t('auth.signIn')}
          </Link>
        </>
      ) : (
        <>
          {!d.accountExists && (
            <>
              <Field label={t('auth.yourName')}>{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
              <Field label={t('auth.password')} hint={t('auth.passwordRules')}>
                {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />}
              </Field>
            </>
          )}
          <Button type="submit" loading={busy} className="w-full">
            {t('auth.acceptInvite')}
          </Button>
        </>
      )}
    </form>
  );
}
