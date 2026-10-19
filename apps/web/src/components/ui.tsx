'use client';

import clsx from 'clsx';
import { X } from 'lucide-react';
import Link from 'next/link';
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useEffect,
  useId,
  useRef,
} from 'react';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        variant === 'primary' && 'bg-brand text-on-brand shadow-sm hover:bg-brand-hover',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-subtle',
        variant === 'ghost' && 'text-muted hover:bg-subtle hover:text-ink',
        variant === 'danger' && 'bg-danger-fill text-on-danger hover:opacity-90',
        className,
      )}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function ButtonLink({ href, children, variant = 'primary', className }: { href: string; children: ReactNode; variant?: Variant; className?: string }) {
  return (
    <Link
      href={href}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition',
        variant === 'primary' && 'bg-brand text-on-brand shadow-sm hover:bg-brand-hover',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-subtle',
        variant === 'ghost' && 'text-muted hover:bg-subtle hover:text-ink',
        className,
      )}
    >
      {children}
    </Link>
  );
}

const fieldBase =
  'w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/25 disabled:bg-subtle';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} {...props} className={clsx(fieldBase, className)} />;
});

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={clsx(fieldBase, 'pr-8', className)}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(fieldBase, 'min-h-20', className)} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={clsx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-line accent-brand"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={clsx('rounded-2xl border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, eyebrow, subtitle, actions }: { title: string; eyebrow?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="text-2xl leading-8 font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <div className="text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const tones: Record<string, string> = {
  gray: 'bg-subtle text-muted',
  green: 'bg-success-soft text-success',
  red: 'bg-danger-soft text-danger',
  amber: 'bg-warning-soft text-warning',
  blue: 'bg-info-soft text-info',
  brand: 'bg-brand-soft text-on-brand-soft',
  violet: 'bg-brand-soft text-on-brand-soft',
};

export function Badge({ tone = 'gray', dot, children }: { tone?: keyof typeof tones; dot?: boolean; children: ReactNode }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone])}>
      {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export const statusTone: Record<string, keyof typeof tones> = {
  tentative: 'amber',
  confirmed: 'blue',
  checked_in: 'green',
  checked_out: 'gray',
  cancelled: 'red',
  no_show: 'red',
  clean: 'green',
  dirty: 'amber',
  inspected: 'blue',
  out_of_order: 'red',
  pending: 'amber',
  in_progress: 'blue',
  done: 'green',
  issued: 'blue',
  paid: 'green',
  active: 'green',
  suspended: 'red',
  disabled: 'gray',
  vip: 'brand',
  business: 'blue',
  agent: 'amber',
  standard: 'gray',
};

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] leading-4 font-semibold tracking-[0.08em] uppercase text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2.5 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {empty && <p className="px-4 py-12 text-center font-display text-xl text-muted italic">{t('common.none')}</p>}
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={clsx('px-4 py-2.5 align-middle', className)}>{children}</td>;
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className={clsx(
        'm-auto w-[calc(100%-2rem)] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[2px]',
        wide ? 'max-w-3xl' : 'max-w-lg',
      )}
    >
      {open && (
        <div>
          <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-subtle" aria-label="Close">
              <X size={18} />
            </button>
          </header>
          <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Alert({ tone = 'red', children }: { tone?: 'red' | 'green' | 'amber' | 'blue'; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={clsx(
        'rounded-lg px-3 py-2.5 text-sm',
        tone === 'red' && 'bg-danger-soft text-danger',
        tone === 'green' && 'bg-success-soft text-success',
        tone === 'amber' && 'bg-warning-soft text-warning',
        tone === 'blue' && 'bg-info-soft text-info',
      )}
    >
      {children}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : t('errors.generic');
  const details = error instanceof ApiError && Array.isArray(error.details) ? (error.details as { path: string; message: string }[]) : null;
  return (
    <Alert>
      {msg}
      {details && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {details.slice(0, 6).map((d, i) => (
            <li key={i}>
              {d.path && <strong>{d.path}: </strong>}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-focus border-t-transparent" />
    </div>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{label}</p>
        {icon && <div className="rounded-xl border border-line bg-subtle p-2 text-accent">{icon}</div>}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {items.map((i) => (
        <button
          key={i.value}
          role="tab"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={clsx(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap',
            value === i.value ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3 text-sm text-muted">
      <span>
        {t('common.page')} {page} / {pages}
      </span>
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t('common.previous')}
      </Button>
      <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t('common.next')}
      </Button>
    </div>
  );
}

export function Forbidden() {
  const { t } = useI18n();
  return <Alert tone="amber">{t('errors.forbidden')}</Alert>;
}
