'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { PropertyGate } from '@/components/property-gate';
import { Badge, Card, ErrorText, PageHeader, Pager, Select, Spinner, Table, Td, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Invoice, Paged, Property } from '@/lib/types';

function Invoices({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['invoices', property.id, type, page],
    queryFn: () => api.get<Paged<Invoice>>('/invoices', { propertyId: property.id, type, page, pageSize: 25 }),
    placeholderData: (p) => p,
  });
  return (
    <>
      <PageHeader title={t('invoices.title')} subtitle={property.name} />
      <Card padded={false}>
        <div className="border-b border-line p-3">
          <Select className="w-48" value={type} onChange={(e) => (setType(e.target.value), setPage(1))}>
            <option value="">{t('common.all')}</option>
            {(['invoice', 'proforma', 'credit_note'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`invoices.${x}`)}
              </option>
            ))}
          </Select>
        </div>
        {list.isLoading ? (
          <Spinner />
        ) : (
          <>
            <ErrorText error={list.error} />
            <Table head={[t('invoices.number'), t('common.type'), t('invoices.billTo'), t('invoices.issueDate'), t('common.status'), t('invoices.total')]} empty={!list.data?.items.length}>
              {list.data?.items.map((i) => (
                <tr key={i.id} className="hover:bg-subtle">
                  <Td>
                    <Link href={`/invoices/${i.id}`} className="font-mono text-xs font-semibold text-accent hover:underline">
                      {i.fullNumber}
                    </Link>
                  </Td>
                  <Td>{t(`invoices.${i.type}`)}</Td>
                  <Td>{i.billTo.name}</Td>
                  <Td>{date(i.issueDate, locale)}</Td>
                  <Td>
                    <Badge tone={statusTone[i.status]}>{t(`invoices.${i.status}`)}</Badge>
                  </Td>
                  <Td className="text-right font-medium whitespace-nowrap">{money(i.total, i.currency, locale)}</Td>
                </tr>
              ))}
            </Table>
            <Pager page={page} pageSize={25} total={list.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export default function InvoicesPage() {
  return <PropertyGate perms={['invoices.read']}>{(p) => <Invoices property={p} />}</PropertyGate>;
}
