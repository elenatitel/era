'use client';

import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BedDouble,
  Building2,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  ConciergeBell,
  CreditCard,
  FileText,
  Gift,
  Globe,
  House as HouseIcon,
  LogOut,
  Menu,
  Moon,
  Plus,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  SunMoon,
  Tags,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import type { Permission } from '@pms/shared';
import { AskBar, AskProvider } from '@/components/ask-era';
import { NightAuditCard } from '@/components/night-audit';
import { Alert } from '@/components/ui';
import { Wordmark } from '@/components/wordmark';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { SessionProvider, useSession } from '@/lib/session';
import { type ThemeMode, ThemeProvider, useTheme } from '@/lib/theme';

interface NavItem {
  href: string;
  label: string;
  icon: typeof HouseIcon;
  perms?: Permission[];
}

function useNav(): { title: string; items: NavItem[] }[] {
  const { t } = useI18n();
  return [
    {
      title: t('nav.operations'),
      items: [
        { href: '/dashboard', label: t('nav.home'), icon: HouseIcon, perms: ['property.read'] },
        { href: '/day', label: t('nav.day'), icon: CalendarClock, perms: ['property.read'] },
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

const initials = (name: string) =>
  name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { me, can } = useSession();
  const groups = useNav()
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.perms || (me.tenant && can(...i.perms))) }))
    .filter((g) => g.items.length);
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-5 overflow-y-auto px-4 py-5">
      <Link href="/dashboard" onClick={onNavigate} className="px-2">
        <Wordmark tagline />
      </Link>
      {groups.map((g, gi) => (
        <div key={g.title}>
          {gi > 0 && <p className="mb-1 px-3.5 text-xs text-muted">{g.title}</p>}
          <ul className="space-y-0.5">
            {g.items.map((i) => {
              const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
              return (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'flex min-h-10 items-center gap-3 rounded-full px-3.5 text-sm',
                      active ? 'bg-brand font-semibold text-on-brand' : 'text-ink hover:bg-subtle',
                    )}
                  >
                    <i.icon size={18} aria-hidden />
                    {i.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {me.user.isPlatformAdmin && (
        <Link href="/platform" onClick={onNavigate} className="flex min-h-10 items-center gap-3 rounded-full px-3.5 text-sm hover:bg-subtle">
          <Globe size={18} aria-hidden /> {t('nav.platform')}
        </Link>
      )}
      <div className="mt-auto flex flex-col gap-2.5">
        <NightAuditCard />
        <Link href="/profile" onClick={onNavigate} className="flex items-center gap-2.5 rounded-[18px] bg-subtle px-2.5 py-2 hover:bg-line">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-on-brand">{initials(me.user.name)}</span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{me.user.name}</span>
            <span className="truncate text-xs text-muted">{me.tenant?.name ?? me.user.email}</span>
          </span>
        </Link>
      </div>
    </nav>
  );
}

function ThemeSwitch() {
  const { t } = useI18n();
  const { mode, setMode } = useTheme();
  const options: { value: ThemeMode; icon: typeof Sun; label: string }[] = [
    { value: 'auto', icon: SunMoon, label: `${t('theme.auto')} · ${t('theme.autoHint')}` },
    { value: 'day', icon: Sun, label: t('theme.day') },
    { value: 'night', icon: Moon, label: t('theme.night') },
  ];
  return (
    <div role="group" aria-label={t('theme.label')} className="flex rounded-full bg-surface p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => setMode(o.value)}
          aria-pressed={mode === o.value}
          aria-label={o.label}
          title={o.label}
          className={clsx('grid h-10 w-10 place-items-center rounded-full', mode === o.value ? 'bg-brand text-on-brand' : 'text-muted hover:text-ink')}
        >
          <o.icon size={17} aria-hidden />
        </button>
      ))}
    </div>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const { me, properties, property, setPropertyId, can } = useSession();

  async function logout() {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }

  return (
    <header className="flex flex-wrap items-center gap-2.5">
      <button className="grid h-12 w-12 place-items-center rounded-full bg-surface text-ink lg:hidden" onClick={onMenu} aria-label="Menu">
        <Menu size={20} />
      </button>
      {properties.length > 0 && (
        <label className="flex min-h-12 items-center gap-2 rounded-full bg-surface pr-2 pl-5 text-sm">
          {me.tenant && (
            <Link href="/select-organization" className="hidden max-w-40 truncate text-muted hover:text-ink sm:block" title={t('nav.switchOrg')}>
              {me.tenant.name}
            </Link>
          )}
          <span className="sr-only">{t('common.property')}</span>
          <select
            value={property?.id ?? ''}
            onChange={(e) => setPropertyId(e.target.value)}
            className="max-w-48 truncate rounded-full bg-transparent py-2 pr-1 font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <AskBar className="min-w-0 flex-[1_1_260px]" />
      <ThemeSwitch />
      <button
        onClick={() => setLocale(locale === 'ro' ? 'en' : 'ro')}
        className="grid h-12 w-12 place-items-center rounded-full bg-surface text-xs font-semibold text-ink uppercase"
        aria-label="Language"
      >
        {locale === 'ro' ? 'EN' : 'RO'}
      </button>
      <button onClick={logout} className="grid h-12 w-12 place-items-center rounded-full bg-surface text-muted hover:text-ink" aria-label={t('nav.logout')} title={t('nav.logout')}>
        <LogOut size={18} />
      </button>
      {can('reservations.create') && (
        <Link href="/reservations/new" className="flex min-h-12 items-center gap-2 rounded-full bg-brand px-5 text-sm font-semibold text-on-brand hover:bg-brand-hover">
          <Plus size={18} aria-hidden />
          <span className="hidden sm:inline">{t('reservations.new')}</span>
        </Link>
      )}
    </header>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const { me, property } = useSession();
  return (
    <ThemeProvider timezone={property?.timezone ?? 'Europe/Bucharest'}>
      <AskProvider>
        <div className="min-h-screen bg-canvas p-3 sm:p-5 lg:pl-[284px]">
          <aside className="fixed top-5 bottom-5 left-5 z-30 hidden w-[248px] rounded-[28px] bg-surface lg:block">
            <Sidebar />
          </aside>
          {open && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
              <aside className="absolute inset-y-3 left-3 w-[264px] rounded-[28px] bg-surface shadow-pop">
                <button className="absolute top-4 right-3 grid h-10 w-10 place-items-center rounded-full text-muted hover:bg-subtle" onClick={() => setOpen(false)} aria-label="Close">
                  <X size={18} />
                </button>
                <Sidebar onNavigate={() => setOpen(false)} />
              </aside>
            </div>
          )}
          <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
            <Topbar onMenu={() => setOpen(true)} />
            <main className="min-w-0">
              {me.tenant?.requireMfa && !me.user.mfaEnabled && (
                <div className="mb-4">
                  <Alert tone="amber">{t('profile.mfaRequiredBanner')}</Alert>
                </div>
              )}
              {children}
            </main>
          </div>
        </div>
      </AskProvider>
    </ThemeProvider>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
