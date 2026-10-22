'use client';

import type { ReactNode } from 'react';
import type { Permission } from '@pms/shared';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Property } from '@/lib/types';
import { Alert, ButtonLink, Forbidden } from './ui';

/** Renders children only when the user has the permissions and a property is selected. */
export function PropertyGate({ perms, children }: { perms: Permission[]; children: (property: Property) => ReactNode }) {
  const { t } = useI18n();
  const { can, property } = useSession();
  if (!can(...perms)) return <Forbidden />;
  if (!property)
    return (
      <div className="space-y-3">
        <Alert tone="amber">{t('dashboard.noProperty')}</Alert>
        {can('property.manage') && <ButtonLink href="/settings/property">{t('settings.newProperty')}</ButtonLink>}
      </div>
    );
  return <>{children(property)}</>;
}
