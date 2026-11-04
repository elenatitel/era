'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { Company, Guest, Paged } from '@/lib/types';
import { Badge, Input, statusTone } from './ui';

export function GuestPicker({ value, onChange }: { value: Guest | null; onChange: (g: Guest | null) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['guest-search', q],
    queryFn: () => api.get<Paged<Guest>>('/guests', { q, pageSize: 8 }),
    enabled: q.trim().length >= 2,
  });
  if (value)
    return (
      <div className="flex items-center justify-between rounded-lg border border-line p-3">
        <div>
          <p className="font-medium">
            {value.firstName} {value.lastName}{' '}
            {value.segment !== 'standard' && <Badge tone={statusTone[value.segment]}>{t(`segments.${value.segment}`)}</Badge>}
          </p>
          <p className="text-xs text-muted">{[value.email, value.phone].filter(Boolean).join(' · ')}</p>
        </div>
        <button className="text-sm text-accent hover:underline" onClick={() => onChange(null)}>
          {t('common.edit')}
        </button>
      </div>
    );
  return (
    <div className="relative">
      <Input placeholder={t('common.search') + '…'} value={q} onChange={(e) => setQ(e.target.value)} />
      {results.data && results.data.items.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface shadow-lg">
          {results.data.items.map((g) => (
            <li key={g.id}>
              <button className="w-full px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => onChange(g)}>
                <span className="font-medium">
                  {g.firstName} {g.lastName}
                </span>
                <span className="ml-2 text-xs text-muted">{g.email ?? g.phone ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CompanyPicker({ value, onChange }: { value: Company | null; onChange: (c: Company | null) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['company-search', q],
    queryFn: () => api.get<Paged<Company>>('/companies', { q, pageSize: 8 }),
    enabled: q.trim().length >= 2,
  });
  if (value)
    return (
      <div className="flex items-center justify-between rounded-lg border border-line p-3">
        <div>
          <p className="font-medium">{value.name}</p>
          {value.taxId && <p className="text-xs text-muted">{value.taxId}</p>}
        </div>
        <button type="button" className="text-sm text-accent hover:underline" onClick={() => onChange(null)}>
          {t('settings.remove')}
        </button>
      </div>
    );
  return (
    <div className="relative">
      <Input placeholder={t('common.search') + '…'} value={q} onChange={(e) => setQ(e.target.value)} />
      {results.data && results.data.items.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface shadow-lg">
          {results.data.items.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-subtle" onClick={() => onChange(c)}>
                <span className="font-medium">{c.name}</span>
                <span className="ml-2 text-xs text-muted">{c.taxId ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
