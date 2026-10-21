'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import type { Permission } from '@pms/shared';
import { ApiError, api } from './api';
import { useI18n } from './i18n';
import type { Me, Property } from './types';

export function useMe() {
  return useQuery<Me, ApiError>({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), retry: false, staleTime: 60_000 });
}

interface Session {
  me: Me;
  can: (...perms: Permission[]) => boolean;
  properties: Property[];
  property: Property | null;
  setPropertyId: (id: string) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionProvider missing');
  return s;
}

export function useCan() {
  return useSession().can;
}

/** Guards the authenticated app: redirects to login / organization picker as needed. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { setLocale } = useI18n();
  const me = useMe();
  const [propertyId, setPropertyIdState] = useState<string | null>(null);

  const perms = useMemo(() => new Set(me.data?.permissions ?? []), [me.data]);
  const can = (...p: Permission[]) => p.every((x) => perms.has(x));

  const properties = useQuery<Property[]>({
    queryKey: ['properties', me.data?.tenant?.id],
    queryFn: () => api.get<Property[]>('/properties'),
    enabled: Boolean(me.data?.tenant) && perms.has('property.read'),
  });

  useEffect(() => {
    if (me.error?.status === 401) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.error, router, pathname]);

  useEffect(() => {
    const d = me.data;
    if (!d) return;
    if (d.user.locale === 'en' || d.user.locale === 'ro') {
      try {
        if (!localStorage.getItem('pms_locale')) setLocale(d.user.locale);
      } catch {}
    }
    const platformPath = pathname.startsWith('/platform') || pathname.startsWith('/profile');
    if (!d.tenant && !platformPath) router.replace(d.user.isPlatformAdmin && d.memberships.length === 0 ? '/platform' : '/select-organization');
  }, [me.data, pathname, router, setLocale]);

  useEffect(() => {
    if (!properties.data?.length) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(`pms_property_${me.data?.tenant?.id}`);
    } catch {}
    const valid = properties.data.find((p) => p.id === (propertyId ?? saved));
    setPropertyIdState(valid?.id ?? properties.data[0]!.id);
  }, [properties.data, me.data?.tenant?.id, propertyId]);

  if (me.isLoading || (me.data?.tenant && perms.has('property.read') && properties.isLoading)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-focus border-t-transparent" />
      </div>
    );
  }
  if (!me.data) return null;

  const value: Session = {
    me: me.data,
    can,
    properties: properties.data ?? [],
    property: properties.data?.find((p) => p.id === propertyId) ?? null,
    setPropertyId: (id) => {
      setPropertyIdState(id);
      try {
        localStorage.setItem(`pms_property_${me.data?.tenant?.id}`, id);
      } catch {}
    },
    refresh: async () => {
      await qc.invalidateQueries();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
