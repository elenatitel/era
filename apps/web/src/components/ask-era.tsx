'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BedDouble, ClipboardList, Coffee, Sparkles, User, X } from 'lucide-react';
import Link from 'next/link';
import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { NightAuditDialog, useNight } from '@/components/night-audit';
import { Button, ErrorText, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { House } from '@/lib/live-types';
import { useSession } from '@/lib/session';

type Intent = 'owes' | 'arrivals' | 'breakfast' | 'audit' | 'search';

/**
 * What the question is about. Ask era. answers a fixed set of questions from live data
 * (no AI provider, nothing leaves the system); anything else becomes a search.
 */
export function intentOf(question: string): Intent {
  const q = question
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (/\b(owe|owes|owing|balance|debt|unpaid|plata|platit|datore|sold)/.test(q)) return 'owes';
  if (/(breakfast|mic dejun|micul dejun)/.test(q)) return 'breakfast';
  if (/(night audit|audit|close the day|inchiderea|inchide ziua)/.test(q)) return 'audit';
  if (/\b(arriv|coming|sosire|sosiri|soseste|sosesc)/.test(q)) return 'arrivals';
  return 'search';
}

const AskContext = createContext<{ open: (question?: string) => void }>({ open: () => undefined });
export const useAsk = () => useContext(AskContext);

export function AskProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; question: string }>({ open: false, question: '' });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setState((s) => ({ open: !s.open, question: '' }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <AskContext.Provider value={{ open: (question = '') => setState({ open: true, question }) }}>
      {children}
      {state.open && <AskPanel initial={state.question} onClose={() => setState({ open: false, question: '' })} />}
    </AskContext.Provider>
  );
}

/** The bar in the top of every screen; clicking it opens the panel. */
export function AskBar({ className }: { className?: string }) {
  const { t } = useI18n();
  const ask = useAsk();
  return (
    <button
      type="button"
      onClick={() => ask.open()}
      className={`flex min-h-12 items-center gap-3 rounded-full bg-surface px-5 text-left text-sm text-muted transition hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${className ?? ''}`}
    >
      <Sparkles size={18} className="shrink-0 text-ink" aria-hidden />
      <span className="flex-1 truncate">{t('ask.placeholder')}</span>
      <kbd className="hidden rounded-md bg-subtle px-2 py-0.5 font-sans text-xs text-muted sm:inline">{t('ask.shortcut')}</kbd>
    </button>
  );
}

function AskPanel({ initial, onClose }: { initial: string; onClose: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const [asked, setAsked] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(draft.trim());
  };
  const suggestions = t('ask.suggestions').split('|');
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={t('ask.title')} className="flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] bg-surface text-ink shadow-pop">
        <form onSubmit={submit} className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Sparkles size={20} className="shrink-0" aria-hidden />
          <label htmlFor="ask-era" className="sr-only">
            {t('ask.title')}
          </label>
          <input
            id="ask-era"
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('ask.placeholder')}
            autoComplete="off"
            className="min-h-12 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
          />
          <button type="submit" aria-label={t('ask.ask')} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sun text-on-sun">
            <ArrowRight size={18} aria-hidden />
          </button>
          <button type="button" onClick={onClose} aria-label={t('ask.close')} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-subtle">
            <X size={18} aria-hidden />
          </button>
        </form>
        <div className="overflow-y-auto p-5">
          {asked ? (
            <Answer question={asked} onDone={onClose} />
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">{t('ask.hint')}</p>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setDraft(s);
                      setAsked(s);
                    }}
                    className="min-h-10 rounded-full border border-line px-4 text-sm hover:border-line-strong hover:bg-subtle"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ href, icon, title, sub, end, onDone }: { href: string; icon: ReactNode; title: ReactNode; sub?: ReactNode; end?: ReactNode; onDone: () => void }) {
  return (
    <Link href={href} onClick={onDone} className="flex items-center gap-3 rounded-2xl px-3 py-2.5 hover:bg-subtle">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-subtle text-sm font-semibold">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold">{title}</span>
        {sub && <span className="truncate text-xs text-muted">{sub}</span>}
      </span>
      {end}
    </Link>
  );
}

function Answer({ question, onDone }: { question: string; onDone: () => void }) {
  const intent = intentOf(question);
  if (intent === 'owes' || intent === 'breakfast' || intent === 'audit') return <NightAnswer intent={intent} onDone={onDone} />;
  if (intent === 'arrivals') return <ArrivalsAnswer onDone={onDone} />;
  return <SearchAnswer q={question} onDone={onDone} />;
}

function NightAnswer({ intent, onDone }: { intent: 'owes' | 'breakfast' | 'audit'; onDone: () => void }) {
  const { t, locale } = useI18n();
  const { property, can } = useSession();
  const night = useNight(property?.id);
  const [audit, setAudit] = useState(false);
  if (night.isLoading) return <Spinner />;
  if (night.error || !night.data) return <ErrorText error={night.error} />;
  const n = night.data;
  if (intent === 'breakfast')
    return (
      <div className="flex items-center gap-4 rounded-2xl bg-subtle p-4">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-sun text-on-sun">
          <Coffee size={20} aria-hidden />
        </span>
        <span className="flex flex-col">
          <span className="text-xl font-semibold">{t('ask.breakfast', { n: n.tonight.breakfastTomorrow })}</span>
          <span className="text-sm text-muted">{t('ask.breakfastHint')}</span>
        </span>
      </div>
    );
  if (intent === 'audit') {
    if (!can('property.manage')) return <p className="text-sm text-muted">{t('ask.noAccess')}</p>;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">{n.ready ? t('audit.allClear') : t('audit.checksLeft', { n: n.checks.filter((c) => !c.done).length })}</p>
        <Button className="self-start" onClick={() => setAudit(true)}>
          {t('audit.title')}
        </Button>
        <NightAuditDialog
          open={audit}
          onClose={() => {
            setAudit(false);
            onDone();
          }}
        />
      </div>
    );
  }
  if (!can('folio.read')) return <p className="text-sm text-muted">{t('ask.noAccess')}</p>;
  return (
    <div className="flex flex-col gap-1">
      <p className="mb-2 text-sm text-muted">{n.owes.length ? t('ask.owes') : t('ask.nobodyOwes')}</p>
      {n.owes.map((o) => (
        <Row
          key={o.reservationId}
          href={`/reservations/${o.reservationId}`}
          onDone={onDone}
          icon={o.room ?? '—'}
          title={o.guestName ?? o.room ?? ''}
          sub={t('ask.leaves', { date: date(o.departure, locale) })}
          end={<span className="font-semibold tabular-nums">{money(o.balance, n.currency, locale)}</span>}
        />
      ))}
    </div>
  );
}

function ArrivalsAnswer({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { property, can } = useSession();
  const house = useQuery({
    queryKey: ['house', property?.id],
    queryFn: () => api.get<House>('/dashboard/house', { propertyId: property!.id }),
    enabled: Boolean(property),
  });
  if (!can('reservations.read')) return <p className="text-sm text-muted">{t('ask.noAccess')}</p>;
  if (house.isLoading) return <Spinner />;
  if (house.error || !house.data) return <ErrorText error={house.error} />;
  return (
    <div className="flex flex-col gap-1">
      <p className="mb-2 text-sm text-muted">{house.data.arrivals.length ? t('ask.arrivals') : t('ask.noArrivals')}</p>
      {house.data.arrivals.map((a) => (
        <Row
          key={a.reservationId}
          href={`/reservations/${a.reservationId}`}
          onDone={onDone}
          icon={a.time}
          title={a.guestName}
          sub={`${a.roomNumber ?? t('day.noRoom')} · ${a.roomType} · ${a.ratePlan}`}
        />
      ))}
    </div>
  );
}

interface Found {
  reservations: { id: string; code: string; guestName: string; arrival: string; departure: string; roomNumber: string | null; status: string }[];
  guests: { id: string; firstName: string; lastName: string; email: string | null }[];
  rooms: House['rooms'];
}

function SearchAnswer({ q, onDone }: { q: string; onDone: () => void }) {
  const { t, locale } = useI18n();
  const { property, can } = useSession();
  const found = useQuery({
    queryKey: ['ask-search', property?.id, q],
    queryFn: async (): Promise<Found> => {
      const [reservations, guests, house] = await Promise.all([
        can('reservations.read')
          ? api.get<{ items: Found['reservations'] }>('/reservations', { propertyId: property!.id, q, pageSize: 6 }).then((r) => r.items)
          : [],
        can('guests.read') ? api.get<{ items: Found['guests'] }>('/guests', { q, pageSize: 6 }).then((r) => r.items) : [],
        api.get<House>('/dashboard/house', { propertyId: property!.id }),
      ]);
      const term = q.replace(/[^0-9a-z]/gi, '').toLowerCase();
      return { reservations, guests, rooms: term ? house.rooms.filter((r) => r.number.toLowerCase() === term || r.number.toLowerCase().startsWith(term)).slice(0, 4) : [] };
    },
    enabled: Boolean(property),
  });
  if (found.isLoading) return <Spinner />;
  if (found.error || !found.data) return <ErrorText error={found.error} />;
  const f = found.data;
  if (!f.reservations.length && !f.guests.length && !f.rooms.length) return <p className="text-sm text-muted">{t('ask.noResults', { q })}</p>;
  return (
    <div className="flex flex-col gap-4">
      {f.rooms.length > 0 && (
        <section>
          <h3 className="mb-1 px-3 text-xs font-semibold text-muted">{t('ask.rooms')}</h3>
          {f.rooms.map((r) => (
            <Row
              key={r.id}
              href={r.stay ? `/reservations/${r.stay.reservationId}` : r.arrival ? `/reservations/${r.arrival.reservationId}` : '/housekeeping'}
              onDone={onDone}
              icon={<BedDouble size={18} aria-hidden />}
              title={`${r.number} · ${r.roomType}`}
              sub={`${t(`house.states.${r.state}`)}${r.stay?.guestName ? ` · ${r.stay.guestName}` : r.arrival?.guestName ? ` · ${r.arrival.guestName}` : ''}`}
            />
          ))}
        </section>
      )}
      {f.reservations.length > 0 && (
        <section>
          <h3 className="mb-1 px-3 text-xs font-semibold text-muted">{t('ask.reservations')}</h3>
          {f.reservations.map((r) => (
            <Row
              key={r.id}
              href={`/reservations/${r.id}`}
              onDone={onDone}
              icon={<ClipboardList size={18} aria-hidden />}
              title={r.guestName}
              sub={`${r.code} · ${date(r.arrival, locale)} – ${date(r.departure, locale)}${r.roomNumber ? ` · ${r.roomNumber}` : ''}`}
              end={<span className="text-xs text-muted">{t(`resStatus.${r.status}`)}</span>}
            />
          ))}
        </section>
      )}
      {f.guests.length > 0 && (
        <section>
          <h3 className="mb-1 px-3 text-xs font-semibold text-muted">{t('ask.guests')}</h3>
          {f.guests.map((g) => (
            <Row key={g.id} href={`/guests/${g.id}`} onDone={onDone} icon={<User size={18} aria-hidden />} title={`${g.firstName} ${g.lastName}`} sub={g.email ?? undefined} />
          ))}
        </section>
      )}
    </div>
  );
}
