'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ChevronRight, Moon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Alert, Button, ErrorText, Modal } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Night } from '@/lib/live-types';
import { useSession } from '@/lib/session';

/** Renders "<em>…</em>" in a translated string as the serif italic accent; everything stays plain text. */
export function Emph({ text }: { text: string }) {
  const parts = text.split(/<em>|<\/em>/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-display font-normal italic">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function useNight(propertyId: string | undefined) {
  return useQuery({
    queryKey: ['night', propertyId],
    queryFn: () => api.get<Night>('/dashboard/night', { propertyId: propertyId! }),
    enabled: Boolean(propertyId),
    refetchInterval: 60_000,
  });
}

/** The checklist before closing the day; runs the audit when the user confirms. */
export function NightAuditDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { property } = useSession();
  const qc = useQueryClient();
  const night = useNight(property?.id);
  const [done, setDone] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api.post<{ newBusinessDate: string }>(`/properties/${property!.id}/night-audit`),
    onSuccess: (r) => {
      setDone(t('dashboard.nightAuditDone', { date: date(r.newBusinessDate, locale) }));
      void qc.invalidateQueries();
    },
  });
  const n = night.data;
  return (
    <Modal
      open={open}
      onClose={() => {
        setDone(null);
        run.reset();
        onClose();
      }}
      title={t('audit.title')}
    >
      {done ? (
        <Alert tone="green">{done}</Alert>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{n && t('audit.confirm', { date: date(n.businessDate, locale) })}</p>
          <ul className="flex flex-col gap-2.5">
            {n?.checks.map((c) => (
              <li key={c.key} className="flex items-center gap-3">
                <span
                  className={clsx(
                    'grid h-6 w-6 shrink-0 place-items-center rounded-full',
                    c.done ? 'bg-success-soft text-success' : 'border-2 border-sun',
                  )}
                >
                  {c.done && <Check size={13} strokeWidth={3} aria-hidden />}
                </span>
                <span className={clsx('flex-1 text-sm', c.done && 'text-muted line-through')}>{t(`night.checks.${c.key}`)}</span>
                {!c.done && <span className="text-xs font-semibold text-warning">{t('night.left', { n: c.count })}</span>}
              </li>
            ))}
          </ul>
          <ErrorText error={run.error ?? night.error} />
          <div className="flex justify-end">
            <Button loading={run.isPending} disabled={!n} onClick={() => run.mutate()} variant={n?.ready ? 'primary' : 'secondary'}>
              {n?.ready ? t('audit.run') : t('audit.runAnyway')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Sidebar card: the business date to close and how many checks remain. Only for property managers. */
export function NightAuditCard() {
  const { t, locale } = useI18n();
  const { can, property } = useSession();
  const night = useNight(can('property.manage') ? property?.id : undefined);
  const [open, setOpen] = useState(false);
  if (!can('property.manage') || !night.data) return null;
  const left = night.data.checks.filter((c) => !c.done).length;
  return (
    <div className="flex flex-col gap-3 rounded-[22px] bg-sun p-4 text-on-sun">
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#15171c] text-sun">
          <Moon size={17} aria-hidden />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-semibold">{t('audit.title')}</span>
          <span className="text-xs">{t('audit.readyToClose', { date: date(night.data.businessDate, locale) })}</span>
        </span>
      </div>
      <AuditButton onClick={() => setOpen(true)}>{left ? t('audit.checksLeft', { n: left }) : t('audit.allClear')}</AuditButton>
      <NightAuditDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function AuditButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 items-center justify-between rounded-full bg-white px-4 text-sm font-semibold text-[#15171c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#15171c]"
    >
      {children}
      <ChevronRight size={16} aria-hidden />
    </button>
  );
}
