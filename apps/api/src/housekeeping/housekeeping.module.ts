import { Controller, Get, Injectable, Module, Patch, Post } from '@nestjs/common';
import { aliasedTable, and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hkGenerateSchema, hkTaskSchema, hkTaskSearchSchema, updateHkTaskSchema } from '@pms/shared';
import { ctx, hasPermission, requireTenant } from '../common/context.js';
import { forbidden, invalidState, notFound, unprocessable } from '../common/errors.js';
import { IdParam, ZBody, ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { guests, housekeepingTasks, memberships, reservations, roles, rooms, roomTypes, users } from '../db/schema.js';
import { getAccessibleProperty } from '../properties/properties.module.js';

/** Allowed transitions for staff without housekeeping.manage. */
const STAFF_TRANSITIONS: Record<string, string[]> = { pending: ['in_progress', 'done'], in_progress: ['done', 'pending'] };

@Injectable()
export class HousekeepingService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  board(propertyId: string) {
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, propertyId);
      const day = property.businessDate;
      const assignee = aliasedTable(users, 'assignee');
      const roomList = await tx
        .select({
          id: rooms.id,
          number: rooms.number,
          floor: rooms.floor,
          status: rooms.status,
          occupancy: rooms.occupancy,
          notes: rooms.notes,
          roomTypeCode: roomTypes.code,
        })
        .from(rooms)
        .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
        .where(and(eq(rooms.propertyId, propertyId), eq(rooms.active, true)))
        .orderBy(asc(rooms.floor), asc(rooms.number));
      const stays = await tx
        .select({
          roomId: reservations.roomId,
          status: reservations.status,
          arrival: reservations.arrival,
          departure: reservations.departure,
          guestName: sql<string>`${guests.firstName} || ' ' || ${guests.lastName}`,
          segment: guests.segment,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            sql`${reservations.roomId} is not null`,
            sql`(${reservations.status} = 'checked_in' or (${reservations.status} in ('tentative','confirmed') and ${reservations.arrival} = ${day}))`,
          ),
        );
      const tasks = await tx
        .select({ task: housekeepingTasks, assigneeName: assignee.name })
        .from(housekeepingTasks)
        .leftJoin(assignee, eq(assignee.id, housekeepingTasks.assignedToUserId))
        .where(and(eq(housekeepingTasks.propertyId, propertyId), eq(housekeepingTasks.date, day), ne(housekeepingTasks.status, 'cancelled')));
      return {
        businessDate: day,
        rooms: roomList.map((r) => {
          const inHouse = stays.find((s) => s.roomId === r.id && s.status === 'checked_in');
          const arriving = stays.find((s) => s.roomId === r.id && s.status !== 'checked_in');
          return {
            ...r,
            guest: inHouse ? { name: inHouse.guestName, departure: inHouse.departure, segment: inHouse.segment, departingToday: inHouse.departure <= day } : null,
            arrivalToday: arriving ? { name: arriving.guestName, segment: arriving.segment } : null,
            tasks: tasks.filter((t) => t.task.roomId === r.id).map((t) => ({ ...t.task, assigneeName: t.assigneeName })),
          };
        }),
      };
    });
  }

  listTasks(q: z.infer<typeof hkTaskSearchSchema>) {
    const onlyMine = q.assignedToMe || !hasPermission('housekeeping.manage');
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, q.propertyId);
      const assignee = aliasedTable(users, 'assignee');
      return tx
        .select({
          task: housekeepingTasks,
          roomNumber: rooms.number,
          roomStatus: rooms.status,
          floor: rooms.floor,
          roomTypeCode: roomTypes.code,
          assigneeName: assignee.name,
        })
        .from(housekeepingTasks)
        .innerJoin(rooms, eq(rooms.id, housekeepingTasks.roomId))
        .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
        .leftJoin(assignee, eq(assignee.id, housekeepingTasks.assignedToUserId))
        .where(
          and(
            eq(housekeepingTasks.propertyId, q.propertyId),
            eq(housekeepingTasks.date, q.date ?? property.businessDate),
            q.status ? eq(housekeepingTasks.status, q.status) : ne(housekeepingTasks.status, 'cancelled'),
            onlyMine ? eq(housekeepingTasks.assignedToUserId, ctx().userId!) : undefined,
          ),
        )
        .orderBy(sql`${housekeepingTasks.priority} desc`, asc(rooms.floor), asc(rooms.number))
        .then((rows) => rows.map((r) => ({ ...r.task, roomNumber: r.roomNumber, roomStatus: r.roomStatus, floor: r.floor, roomTypeCode: r.roomTypeCode, assigneeName: r.assigneeName })));
    });
  }

  /** Staff that can receive housekeeping tasks. */
  staff(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      return tx
        .select({ userId: users.id, name: users.name, roleName: roles.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(
          and(
            eq(memberships.status, 'active'),
            sql`'housekeeping.update' = any(${roles.permissions})`,
            sql`(cardinality(${memberships.propertyIds}) = 0 or ${propertyId}::uuid = any(${memberships.propertyIds}))`,
          ),
        )
        .orderBy(asc(users.name));
    });
  }

  private async assertAssignee(tx: Tx, userId: string | null | undefined) {
    if (!userId) return;
    const [m] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')));
    if (!m) throw unprocessable('Assignee is not an active member of this organization');
  }

  createTask(input: z.infer<typeof hkTaskSchema>) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, input.propertyId);
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, input.roomId));
      if (!room || room.propertyId !== input.propertyId) throw unprocessable('Room does not belong to this property');
      await this.assertAssignee(tx, input.assignedToUserId);
      const [task] = await tx
        .insert(housekeepingTasks)
        .values({ ...input, tenantId: requireTenant(), createdById: ctx().userId })
        .returning();
      await this.audit.log(tx, 'housekeeping.task_created', 'housekeeping_task', task!.id, { room: room.number, type: input.type });
      return task;
    });
  }

  updateTask(id: string, input: z.infer<typeof updateHkTaskSchema>) {
    const manager = hasPermission('housekeeping.manage');
    return this.db.tenant(async (tx) => {
      const [task] = await tx.select().from(housekeepingTasks).where(eq(housekeepingTasks.id, id)).for('update');
      if (!task) throw notFound('Task');
      await getAccessibleProperty(tx, task.propertyId);
      if (!manager) {
        if (task.assignedToUserId !== ctx().userId) throw forbidden('This task is not assigned to you');
        if (input.assignedToUserId !== undefined || input.priority !== undefined) throw forbidden('Only supervisors can reassign tasks');
        if (input.status && !STAFF_TRANSITIONS[task.status]?.includes(input.status)) {
          throw invalidState(`Cannot move a ${task.status} task to ${input.status}`);
        }
      }
      if (input.status === 'inspected' && task.status !== 'done') throw invalidState('Only completed tasks can be inspected');
      await this.assertAssignee(tx, input.assignedToUserId);
      const now = new Date();
      const patch: Partial<typeof housekeepingTasks.$inferInsert> = { ...input };
      if (input.status === 'in_progress') patch.startedAt = now;
      if (input.status === 'done') patch.completedAt = now;
      if (input.status === 'inspected') {
        patch.inspectedAt = now;
        patch.inspectedById = ctx().userId;
      }
      const [updated] = await tx.update(housekeepingTasks).set(patch).where(eq(housekeepingTasks.id, id)).returning();
      if (input.status === 'done' || input.status === 'inspected') {
        await tx
          .update(rooms)
          .set({ status: input.status === 'inspected' ? 'inspected' : 'clean' })
          .where(and(eq(rooms.id, task.roomId), ne(rooms.status, 'out_of_order')));
      }
      await this.audit.log(tx, 'housekeeping.task_updated', 'housekeeping_task', id, input);
      return updated;
    });
  }

  generate(propertyId: string, date: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const inHouse = await tx
        .select({ roomId: reservations.roomId, departure: reservations.departure })
        .from(reservations)
        .where(and(eq(reservations.propertyId, propertyId), eq(reservations.status, 'checked_in')));
      const values = inHouse
        .filter((r) => r.roomId)
        .map((r) => ({
          tenantId: requireTenant(),
          propertyId,
          roomId: r.roomId!,
          type: r.departure <= date ? 'checkout_clean' : 'stayover',
          priority: r.departure <= date ? 1 : 0,
          date,
          createdById: ctx().userId,
        }));
      const dirty = await tx
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(eq(rooms.propertyId, propertyId), eq(rooms.status, 'dirty'), eq(rooms.occupancy, 'vacant')));
      for (const r of dirty) {
        if (!values.some((v) => v.roomId === r.id)) {
          values.push({ tenantId: requireTenant(), propertyId, roomId: r.id, type: 'checkout_clean', priority: 1, date, createdById: ctx().userId });
        }
      }
      if (!values.length) return { created: 0 };
      const created = await tx.insert(housekeepingTasks).values(values).onConflictDoNothing().returning({ id: housekeepingTasks.id });
      await this.audit.log(tx, 'housekeeping.generated', 'property', propertyId, { date, created: created.length });
      return { created: created.length };
    });
  }
}

const propertyQuery = z.object({ propertyId: z.uuid() });

@Controller('housekeeping')
export class HousekeepingController {
  constructor(private readonly svc: HousekeepingService) {}

  @Get('board')
  @Perms('housekeeping.read')
  board(@ZQuery(propertyQuery) q: { propertyId: string }) {
    return this.svc.board(q.propertyId);
  }

  @Get('tasks')
  @Perms('housekeeping.read')
  tasks(@ZQuery(hkTaskSearchSchema) q: z.infer<typeof hkTaskSearchSchema>) {
    return this.svc.listTasks(q);
  }

  @Get('staff')
  @Perms('housekeeping.manage')
  staff(@ZQuery(propertyQuery) q: { propertyId: string }) {
    return this.svc.staff(q.propertyId);
  }

  @Post('tasks')
  @Perms('housekeeping.manage')
  create(@ZBody(hkTaskSchema) body: z.infer<typeof hkTaskSchema>) {
    return this.svc.createTask(body);
  }

  @Patch('tasks/:id')
  @Perms('housekeeping.update')
  update(@IdParam() id: string, @ZBody(updateHkTaskSchema) body: z.infer<typeof updateHkTaskSchema>) {
    return this.svc.updateTask(id, body);
  }

  @Post('generate')
  @Perms('housekeeping.manage')
  generate(@ZBody(hkGenerateSchema) body: z.infer<typeof hkGenerateSchema>) {
    return this.svc.generate(body.propertyId, body.date);
  }
}

@Module({ controllers: [HousekeepingController], providers: [HousekeepingService] })
export class HousekeepingModule {}

