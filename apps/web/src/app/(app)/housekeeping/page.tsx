'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Crown, LogIn, LogOut, User } from 'lucide-react';
import { useState } from 'react';
import { PropertyGate } from '@/components/property-gate';
import { Badge, Button, Card, ErrorText, PageHeader, Select, Spinner, Tabs, statusTone } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Property } from '@/lib/types';

interface Task {
  id: string;
  roomId: string;
  type: string;
  status: string;
  priority: number;
  notes: string | null;
  assignedToUserId: string | null;
  assigneeName: string | null;
  roomNumber?: string;
  floor?: string | null;
  roomTypeCode?: string;
}
interface BoardRoom {
  id: string;
  number: string;
  floor: string | null;
  status: string;
  occupancy: string;
  roomTypeCode: string;
  guest: { name: string; departure: string; segment: string; departingToday: boolean } | null;
  arrivalToday: { name: string; segment: string } | null;
  tasks: Task[];
}

const tile: Record<string, string> = {
  clean: 'border-success bg-success-soft',
  inspected: 'border-info bg-info-soft',
  dirty: 'border-warning bg-warning-soft',
  out_of_order: 'border-danger bg-danger-soft',
};

function Housekeeping({ property }: { property: Property }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const manager = can('housekeeping.manage');
  const [tab, setTab] = useState<'board' | 'tasks'>(manager ? 'board' : 'tasks');
  const board = useQuery({ queryKey: ['hk-board', property.id], queryFn: () => api.get<{ businessDate: string; rooms: BoardRoom[] }>('/housekeeping/board', { propertyId: property.id }), refetchInterval: 30_000 });
  const tasks = useQuery({ queryKey: ['hk-tasks', property.id], queryFn: () => api.get<Task[]>('/housekeeping/tasks', { propertyId: property.id }), refetchInterval: 30_000 });
  const staff = useQuery({
    queryKey: ['hk-staff', property.id],
    queryFn: () => api.get<{ userId: string; name: string }[]>('/housekeeping/staff', { propertyId: property.id }),
    enabled: manager,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['hk-board'] });
    void qc.invalidateQueries({ queryKey: ['hk-tasks'] });
  };
  const roomStatus = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api.put(`/rooms/${id}/status`, { status }), onSuccess: invalidate });
  const updateTask = useMutation({ mutationFn: ({ id, ...body }: { id: string; status?: string; assignedToUserId?: string | null }) => api.patch(`/housekeeping/tasks/${id}`, body), onSuccess: invalidate });
  const generate = useMutation({ mutationFn: () => api.post('/housekeeping/generate', { propertyId: property.id, date: board.data!.businessDate }), onSuccess: invalidate });

  const error = board.error ?? tasks.error ?? roomStatus.error ?? updateTask.error ?? generate.error;

  return (
    <>
      <PageHeader
        title={t('housekeeping.title')}
        subtitle={board.data && `${property.name} · ${date(board.data.businessDate, locale)}`}
        actions={
          manager && (
            <Button variant="secondary" loading={generate.isPending} disabled={!board.data} onClick={() => generate.mutate()}>
              {t('housekeeping.generate')}
            </Button>
          )
        }
      />
      <ErrorText error={error} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ...(manager || can('rooms.read') ? [{ value: 'board' as const, label: t('housekeeping.board') }] : []),
          { value: 'tasks' as const, label: manager ? t('housekeeping.tasks') : t('housekeeping.myTasks') },
        ]}
      />
      {tab === 'board' &&
        (board.isLoading ? (
          <Spinner />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {board.data?.rooms.map((r) => (
              <div key={r.id} className={clsx('flex flex-col gap-2 rounded-xl border p-3', tile[r.status])}>
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-lg leading-none font-semibold">{r.number}</p>
                    <p className="text-[11px] text-muted">{r.roomTypeCode}</p>
                  </div>
                  <Badge tone={statusTone[r.status]}>{t(`roomStatus.${r.status}`)}</Badge>
                </div>
                <div className="min-h-8 space-y-0.5 text-xs">
                  {r.guest && (
                    <p className="flex items-center gap-1 truncate">
                      {r.guest.segment === 'vip' ? <Crown size={12} className="text-accent" /> : <User size={12} />}
                      {r.guest.name}
                      {r.guest.departingToday && <LogOut size={12} className="ml-auto text-warning" aria-label={t('housekeeping.departing')} />}
                    </p>
                  )}
                  {r.arrivalToday && (
                    <p className="flex items-center gap-1 truncate text-info">
                      <LogIn size={12} /> {r.arrivalToday.name}
                    </p>
                  )}
                  {r.tasks.map((tk) => (
                    <p key={tk.id} className="truncate text-muted">
                      {t(`hkType.${tk.type}`)} · {tk.assigneeName ?? t('housekeeping.unassigned')}
                    </p>
                  ))}
                </div>
                {can('housekeeping.update') && (
                  <div className="mt-auto flex flex-wrap gap-1">
                    {r.status === 'dirty' && (
                      <Button size="sm" variant="secondary" onClick={() => roomStatus.mutate({ id: r.id, status: 'clean' })}>
                        {t('housekeeping.markClean')}
                      </Button>
                    )}
                    {r.status === 'clean' && manager && (
                      <Button size="sm" variant="secondary" onClick={() => roomStatus.mutate({ id: r.id, status: 'inspected' })}>
                        {t('housekeeping.inspect')}
                      </Button>
                    )}
                    {(r.status === 'clean' || r.status === 'inspected') && (
                      <Button size="sm" variant="ghost" onClick={() => roomStatus.mutate({ id: r.id, status: 'dirty' })}>
                        {t('housekeeping.markDirty')}
                      </Button>
                    )}
                    {manager &&
                      (r.status === 'out_of_order' ? (
                        <Button size="sm" variant="secondary" onClick={() => roomStatus.mutate({ id: r.id, status: 'dirty' })}>
                          {t('housekeeping.backInService')}
                        </Button>
                      ) : (
                        r.occupancy === 'vacant' && (
                          <Button size="sm" variant="ghost" onClick={() => confirm(`${r.number}: ${t('housekeeping.outOfOrder')}?`) && roomStatus.mutate({ id: r.id, status: 'out_of_order' })}>
                            {t('housekeeping.outOfOrder')}
                          </Button>
                        )
                      ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      {tab === 'tasks' &&
        (tasks.isLoading ? (
          <Spinner />
        ) : !tasks.data?.length ? (
          <Card>
            <p className="py-6 text-center text-sm text-muted">{t('housekeeping.noTasks')}</p>
          </Card>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {tasks.data.map((tk) => (
              <li key={tk.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-2xl leading-none font-semibold">{tk.roomNumber}</p>
                    <p className="mt-1 text-sm">
                      {t(`hkType.${tk.type}`)} {tk.priority > 0 && <Badge tone="red">!</Badge>}
                    </p>
                  </div>
                  <Badge tone={statusTone[tk.status]}>{t(`hkStatus.${tk.status}`)}</Badge>
                </div>
                {manager && (
                  <Select
                    className="mt-3"
                    aria-label={t('housekeeping.assignTo')}
                    value={tk.assignedToUserId ?? ''}
                    onChange={(e) => updateTask.mutate({ id: tk.id, assignedToUserId: e.target.value || null })}
                  >
                    <option value="">{t('housekeeping.unassigned')}</option>
                    {staff.data?.map((s) => (
                      <option key={s.userId} value={s.userId}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
                <div className="mt-3 flex gap-2">
                  {tk.status === 'pending' && (
                    <Button className="flex-1" variant="secondary" onClick={() => updateTask.mutate({ id: tk.id, status: 'in_progress' })}>
                      {t('housekeeping.start')}
                    </Button>
                  )}
                  {(tk.status === 'pending' || tk.status === 'in_progress') && (
                    <Button className="flex-1" onClick={() => updateTask.mutate({ id: tk.id, status: 'done' })}>
                      {t('housekeeping.done')}
                    </Button>
                  )}
                  {tk.status === 'done' && manager && (
                    <Button className="flex-1" onClick={() => updateTask.mutate({ id: tk.id, status: 'inspected' })}>
                      {t('housekeeping.inspect')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}

export default function HousekeepingPage() {
  return <PropertyGate perms={['housekeeping.read']}>{(p) => <Housekeeping property={p} />}</PropertyGate>;
}
