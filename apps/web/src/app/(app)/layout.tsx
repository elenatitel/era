'use client';

import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BedDouble,
  Building2,
  CalendarDays,
  ClipboardList,
  ConciergeBell,
  CreditCard,
  FileText,
  Gift,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Tags,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import type { Permission } from '@pms/shared';
import { Alert } from '@/components/ui';
import { Wordmark } from '@/components/wordmark';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { SessionProvider, useSession } from '@/lib/session';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  perms?: Permission[];
}

function useNav(): { title: string; items: NavItem[] }[] {
  const { t } = useI18n();
  return [
    {
      title: t('nav.operations'),
      items: [
        { href: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard, perms: ['property.read'] },
        { href: '/front-desk', label: t('nav.frontDesk'), icon: ConciergeBell, perms: ['reservations.read'] },
        { href: '/reservations', label: t('nav.reservations'), icon: ClipboardList, perms: ['reservations.read'] },
        { href: '/calendar', label: t('nav.calendar'), icon: CalendarDays, perms: ['reservations.read'] },
        { href: '/housekeeping', label: t('nav.housekeeping'), icon: Sparkles, perms: ['housekeeping.read'] },
      ],
    },
    {
      title: t('nav.crm'),
      items: [
        { href: '/guests', label: t('nav.guests'), icon: Users, perms: ['guests.read'] },
        { href: '/companies', label: t('nav.companies'), icon: Building2, perms: ['guests.read'] },
      ],
    },
    {
      title: t('nav.finance'),
      items: [
        { href: '/invoices', label: t('nav.invoices'), icon: Receipt, perms: ['invoices.read'] },
        { href: '/payments', label: t('nav.payments'), icon: CreditCard, perms: ['reports.read'] },
      ],
    },
    {
      title: t('nav.settings'),
      items: [
        { href: '/settings/property', label: t('nav.property'), icon: Settings, perms: ['property.read'] },
        { href: '/settings/rooms', label: t('nav.rooms'), icon: BedDouble, perms: ['rooms.read'] },
        { href: '/settings/rates', label: t('nav.rates'), icon: Tags, perms: ['rates.read'] },
        { href: '/settings/extras', label: t('nav.extras'), icon: Gift, perms: ['rates.read'] },
        { href: '/settings/online-booking', label: t('nav.onlineBooking'), icon: Globe, perms: ['property.manage'] },
        { href: '/settings/team', label: t('nav.team'), icon: UserCog, perms: ['users.read'] },
        { href: '/settings/roles', label: t('nav.roles'), icon: ShieldCheck, perms: ['users.read'] },
        { href: '/settings/organization', label: t('nav.organization'), icon: FileText, perms: ['tenant.settings'] },
        { href: '/settings/audit', label: t('nav.audit'), icon: ScrollText, perms: ['audit.read'] },
      ],
    },
  ];
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { me, can } = useSession();
  const groups = useNav()
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.perms || (me.tenant && can(...i.perms))) }))
    .filter((g) => g.items.length);
  return (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-5">
      <Link href="/dashboard" onClick={onNavigate} className="px-2">
        <Wordmark tagline />
      </Link>
      {groups.map((g) => (
        <div key={g.title}>
          <p className="eyebrow mb-1 px-2">{g.title}</p>
          <ul className="space-y-0.5">
            {g.items.map((i) => {
              const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
              return (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    onClick={onNavigate}
                    className={clsx(
                      'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm',
                      active ? 'bg-brand-soft font-semibold text-on-brand-soft' : 'text-muted hover:bg-subtle hover:text-ink',
                    )}
                  >
                    <i.icon size={17} />
                    {i.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {me.user.isPlatformAdmin && (
        <Link href="/platform" onClick={onNavigate} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-subtle">
          <Globe size={17} /> {t('nav.platform')}
        </Link>
      )}
      <Link href="/profile" onClick={onNavigate} className="mt-auto flex items-center gap-2.5 border-t border-line px-2 pt-4 hover:text-accent">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-on-brand">
          {me.user.name
            .split(' ')
            .map((p) => p[0])
            .slice(0, 2)
            .join('')}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{me.user.name}</span>
          <span className="truncate text-xs text-muted">{me.tenant?.name ?? me.user.email}</span>
        </span>
      </Link>
    </nav>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const { me, properties, property, setPropertyId } = useSession();

  async function logout() {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur">
      <button className="rounded-md p-1.5 text-muted hover:bg-subtle lg:hidden" onClick={onMenu} aria-label="Menu">
        <Menu size={20} />
      </button>
      {me.tenant && (
        <Link href="/select-organization" className="hidden truncate text-sm font-medium text-ink sm:block" title={t('nav.switchOrg')}>
          {me.tenant.name}
        </Link>
      )}
      {properties.length > 0 && (
        <select
          aria-label={t('common.property')}
          value={property?.id ?? ''}
          onChange={(e) => setPropertyId(e.target.value)}
          className="max-w-48 truncate rounded-lg border border-line bg-surface px-2 py-1 text-sm"
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={() => setLocale(locale === 'ro' ? 'en' : 'ro')}
          className="rounded-md px-2 py-1 text-xs font-semibold text-muted uppercase hover:bg-subtle"
          aria-label="Language"
        >
          {locale === 'ro' ? 'EN' : 'RO'}
        </button>
        <Link href="/profile" className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-subtle lg:hidden">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-xs font-semibold text-on-brand">
            {me.user.name
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')}
          </span>
          <span className="hidden md:inline">{me.user.name}</span>
        </Link>
        <button onClick={logout} className="rounded-md p-1.5 text-muted hover:bg-subtle" aria-label={t('nav.logout')} title={t('nav.logout')}>
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const { me } = useSession();
  return (
    <div className="min-h-screen lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-surface shadow-xl">
            <button className="absolute top-4 right-3 p-1 text-muted" onClick={() => setOpen(false)} aria-label="Close">
              <X size={18} />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <Topbar onMenu={() => setOpen(true)} />
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {me.tenant?.requireMfa && !me.user.mfaEnabled && (
          <div className="mb-4">
            <Alert tone="amber">{t('profile.mfaRequiredBanner')}</Alert>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
