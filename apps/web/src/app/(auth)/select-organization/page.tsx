'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Badge, ErrorText, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useMe } from '@/lib/session';

export default function SelectOrganizationPage() {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (me.error?.status === 401) router.replace('/login');
  }, [me.error, router]);

  async function choose(tenantId: string) {
    setError(null);
    try {
      await api.post('/auth/switch-tenant', { tenantId });
      qc.clear();
      router.replace('/dashboard');
    } catch (err) {
      setError(err);
    }
  }

  if (me.isLoading || !me.data) return <Spinner />;
  const list = me.data.memberships;
  return (
    <div className="space-y-5">
      <h1 className="font-display text-[32px] leading-[38px] font-medium">{t('auth.chooseOrg')}</h1>
      <ErrorText error={error} />
      {list.length === 0 && <Alert tone="amber">{t('auth.noOrgs')}</Alert>}
      <ul className="space-y-2">
        {list.map((m) => (
          <li key={m.tenantId}>
            <button
              onClick={() => choose(m.tenantId)}
              disabled={m.status !== 'active'}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-4 text-left hover:border-accent disabled:opacity-50"
            >
              <span className="rounded-lg bg-brand-soft p-2 text-accent">
                <Building2 size={18} />
              </span>
              <span className="flex-1">
                <span className="block font-medium">{m.name}</span>
                <span className="text-xs text-muted">{m.roleName}</span>
              </span>
              {m.status !== 'active' && <Badge tone="red">{m.status}</Badge>}
              {m.requireMfa && !me.data.user.mfaEnabled && <Badge tone="amber">2FA</Badge>}
              <ChevronRight size={16} className="text-faint" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-between text-sm">
        <Link href="/profile" className="text-accent hover:underline">
          {t('nav.profile')}
        </Link>
        {me.data.user.isPlatformAdmin && (
          <Link href="/platform" className="text-accent hover:underline">
            {t('nav.platform')}
          </Link>
        )}
      </div>
    </div>
  );
}
