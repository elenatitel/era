'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Card, ErrorText, Field, Input, PageHeader, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { type Locale, useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

function MfaCard() {
  const { t } = useI18n();
  const { me } = useSession();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const start = useMutation({ mutationFn: () => api.post<{ secret: string; qrDataUrl: string }>('/auth/mfa/setup'), onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code }),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.post('/auth/mfa/disable', { password, code }),
    onSuccess: () => {
      setPassword('');
      setCode('');
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {t('profile.mfa')}
          <Badge tone={me.user.mfaEnabled ? 'green' : 'amber'}>{me.user.mfaEnabled ? t('profile.mfaOn') : t('profile.mfaOff')}</Badge>
        </span>
      }
    >
      <div className="space-y-4">
        <ErrorText error={start.error ?? enable.error ?? disable.error} />
        {codes && (
          <Alert tone="amber">
            <p className="font-semibold">{t('profile.recoveryCodes')}</p>
            <p className="mb-2 text-xs">{t('profile.recoveryHint')}</p>
            <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Alert>
        )}
        {!me.user.mfaEnabled && !setup && (
          <Button loading={start.isPending} onClick={() => start.mutate()}>
            <ShieldCheck size={16} /> {t('profile.enableMfa')}
          </Button>
        )}
        {setup && (
          <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), enable.mutate())}>
            <p className="text-sm text-muted">{t('profile.scanQr')}</p>
            <Image src={setup.qrDataUrl} alt="QR" width={180} height={180} unoptimized className="rounded-lg border border-line bg-white p-2" />
            <p className="font-mono text-xs break-all text-muted">{setup.secret}</p>
            <Field label={t('auth.code')}>{(id) => <Input id={id} inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} className="max-w-40" />}</Field>
            <Button type="submit" loading={enable.isPending}>{t('auth.verify')}</Button>
          </form>
        )}
        {me.user.mfaEnabled && (
          <form className="grid max-w-md gap-3" onSubmit={(e) => (e.preventDefault(), disable.mutate())}>
            <p className="text-sm text-muted">{t('profile.recoveryLeft', { n: me.user.recoveryCodesLeft })}</p>
            <Field label={t('auth.password')}>{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            <Field label={t('auth.code')}>{(id) => <Input id={id} required value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <Button type="submit" variant="danger" loading={disable.isPending}>
              <ShieldOff size={16} /> {t('profile.disableMfa')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

export default function ProfilePage() {
  const { t, locale, setLocale } = useI18n();
  const { me } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState(me.user.name);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const profile = useMutation({
    mutationFn: () => api.patch('/auth/me', { name, locale }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const password = useMutation({
    mutationFn: () => {
      if (next !== confirmPw) throw new ApiError(422, 'VALIDATION', t('auth.passwordsDiffer'));
      return api.post('/auth/password/change', { currentPassword: current, newPassword: next });
    },
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirmPw('');
    },
  });
  const logoutAll = useMutation({
    mutationFn: () => api.post('/auth/logout-all'),
    onSuccess: () => {
      qc.clear();
      router.replace('/login');
    },
  });

  return (
    <>
      <PageHeader eyebrow={me.tenant?.name} title={t('profile.title')} subtitle={me.user.email} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('common.details')}>
          <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), profile.mutate())}>
            <ErrorText error={profile.error} />
            {profile.isSuccess && <Alert tone="green">{t('common.saved')}</Alert>}
            <Field label={t('common.name')}>{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label={t('profile.language')}>
              {(id) => (
                <Select id={id} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                  <option value="en">English</option>
                  <option value="ro">Română</option>
                </Select>
              )}
            </Field>
            <Button type="submit" loading={profile.isPending}>{t('common.save')}</Button>
          </form>
        </Card>
        <Card title={t('profile.changePassword')}>
          <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), password.mutate())}>
            <ErrorText error={password.error} />
            {password.isSuccess && <Alert tone="green">{t('common.saved')}</Alert>}
            <Field label={t('profile.currentPassword')}>{(id) => <Input id={id} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
            <Field label={t('auth.newPassword')} hint={t('auth.passwordRules')}>{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
            <Field label={t('auth.confirmPassword')}>{(id) => <Input id={id} type="password" autoComplete="new-password" required value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />}</Field>
            <Button type="submit" loading={password.isPending}>{t('profile.changePassword')}</Button>
          </form>
        </Card>
        <MfaCard />
        <Card title={t('nav.logout')}>
          <Button variant="secondary" loading={logoutAll.isPending} onClick={() => logoutAll.mutate()}>{t('profile.logoutAll')}</Button>
        </Card>
      </div>
    </>
  );
}
