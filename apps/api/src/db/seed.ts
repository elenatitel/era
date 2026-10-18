/**
 * Seeding:
 *   npm run db:seed                 -> ensures the platform admin from PLATFORM_ADMIN_EMAIL/PASSWORD exists
 *   npm run db:seed -- --demo       -> also creates a demo organization (refused in production)
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { addDays, todayIn } from '@pms/shared';
import { config } from '../config.js';
import { hashPassword } from '../auth/auth.service.js';
import { seedTenantRoles } from '../platform/platform.module.js';
import { quote } from '../properties/pricing.js';
import { encrypt } from '../common/crypto.js';
import { DbService } from './db.service.js';
import {
  documentSeries,
  guests,
  memberships,
  properties,
  ratePlans,
  reservations,
  rooms,
  roomTypes,
  tenants,
  users,
} from './schema.js';

export async function ensurePlatformAdmin(db: DbService, email: string, password: string) {
  const [existing] = await db.db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  if (existing) {
    if (!existing.isPlatformAdmin) await db.db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, existing.id));
    return existing.id;
  }
  const [u] = await db.db
    .insert(users)
    .values({ email: email.toLowerCase(), name: 'Platform Admin', passwordHash: await hashPassword(password), isPlatformAdmin: true, locale: 'en' })
    .returning();
  return u!.id;
}

export async function seedDemo(db: DbService, password: string) {
  const [exists] = await db.db.select().from(tenants).where(eq(tenants.slug, 'demo'));
  if (exists) return { skipped: true as const };
  const [tenant] = await db.db.insert(tenants).values({ name: 'Demo Hotels SRL', slug: 'demo' }).returning();
  const passwordHash = await hashPassword(password);
  const people = [
    ['owner', 'owner@demo.test', 'Ana Popescu'],
    ['manager', 'manager@demo.test', 'Mihai Ionescu'],
    ['front_desk', 'frontdesk@demo.test', 'Elena Dumitru'],
    ['housekeeping_supervisor', 'hk-lead@demo.test', 'Ioana Stan'],
    ['housekeeper', 'housekeeper@demo.test', 'Maria Georgescu'],
    ['accountant', 'accounting@demo.test', 'Radu Marin'],
    ['revenue_manager', 'revenue@demo.test', 'Andrei Vasile'],
  ] as const;

  await db.tenant(async (tx) => {
    const tenantId = tenant!.id;
    const roleRows = await seedTenantRoles(tx, tenantId);
    for (const [key, email, name] of people) {
      const [found] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      const userId = found?.id ?? (await tx.insert(users).values({ email, name, passwordHash }).returning())[0]!.id;
      await tx.insert(memberships).values({ tenantId, userId, roleId: roleRows.find((r) => r.key === key)!.id });
    }

    const [property] = await tx
      .insert(properties)
      .values({
        tenantId,
        name: 'Hotel Carpați',
        legalName: 'Demo Hotels SRL',
        taxId: 'RO12345678',
        registrationNumber: 'J08/1234/2020',
        address: 'Str. Republicii 10',
        city: 'Brașov',
        country: 'RO',
        email: 'reception@demo.test',
        phone: '+40 268 000 000',
        businessDate: todayIn('Europe/Bucharest'),
      })
      .returning();
    const p = property!;
    await tx.insert(documentSeries).values([
      { tenantId, propertyId: p.id, type: 'invoice', prefix: 'HC' },
      { tenantId, propertyId: p.id, type: 'proforma', prefix: 'HCP' },
      { tenantId, propertyId: p.id, type: 'credit_note', prefix: 'HC-CN' },
    ]);

    const types = await tx
      .insert(roomTypes)
      .values([
        { tenantId, propertyId: p.id, name: 'Double Room', code: 'DBL', baseOccupancy: 2, maxOccupancy: 3, baseRate: 35000 },
        { tenantId, propertyId: p.id, name: 'Twin Room', code: 'TWN', baseOccupancy: 2, maxOccupancy: 2, baseRate: 33000 },
        { tenantId, propertyId: p.id, name: 'Junior Suite', code: 'STE', baseOccupancy: 2, maxOccupancy: 4, baseRate: 65000 },
      ])
      .returning();
    const [dbl, twn, ste] = types as [(typeof types)[0], (typeof types)[0], (typeof types)[0]];
    const roomRows = await tx
      .insert(rooms)
      .values([
        ...Array.from({ length: 8 }, (_, i) => ({ tenantId, propertyId: p.id, roomTypeId: dbl.id, number: `10${i + 1}`, floor: '1' })),
        ...Array.from({ length: 6 }, (_, i) => ({ tenantId, propertyId: p.id, roomTypeId: twn.id, number: `20${i + 1}`, floor: '2' })),
        ...Array.from({ length: 3 }, (_, i) => ({ tenantId, propertyId: p.id, roomTypeId: ste.id, number: `30${i + 1}`, floor: '3' })),
      ])
      .returning();
    const plans = await tx
      .insert(ratePlans)
      .values([
        { tenantId, propertyId: p.id, name: 'Best Available Rate', code: 'BAR' },
        { tenantId, propertyId: p.id, name: 'Bed & Breakfast', code: 'BB', includesBreakfast: true, adjustmentPercent: 12 },
        { tenantId, propertyId: p.id, name: 'Non-refundable', code: 'NR', adjustmentPercent: -10, minNights: 2 },
      ])
      .returning();

    const guestRows = await tx
      .insert(guests)
      .values([
        { tenantId, firstName: 'Andrei', lastName: 'Popa', email: 'andrei.popa@example.com', phone: '+40 721 000 001', nationality: 'RO', segment: 'vip', documentType: 'id_card', documentNumberEnc: encrypt('BV123456') },
        { tenantId, firstName: 'Sophie', lastName: 'Martin', email: 'sophie.martin@example.com', nationality: 'FR', segment: 'standard' },
        { tenantId, firstName: 'Lukas', lastName: 'Weber', email: 'l.weber@example.com', nationality: 'DE', segment: 'business' },
        { tenantId, firstName: 'Cristina', lastName: 'Enache', phone: '+40 744 000 002', nationality: 'RO', segment: 'standard' },
        { tenantId, firstName: 'James', lastName: 'Taylor', email: 'jtaylor@example.com', nationality: 'GB', segment: 'agent' },
      ])
      .returning();

    const today = p.businessDate;
    const bookings = [
      { guest: 0, type: dbl, plan: plans[1]!, arrival: addDays(today, -2), nights: 4, status: 'checked_in', room: '101' },
      { guest: 1, type: twn, plan: plans[0]!, arrival: today, nights: 2, status: 'confirmed', room: null },
      { guest: 2, type: ste, plan: plans[0]!, arrival: today, nights: 3, status: 'confirmed', room: '301' },
      { guest: 3, type: dbl, plan: plans[2]!, arrival: addDays(today, 3), nights: 2, status: 'confirmed', room: null },
      { guest: 4, type: dbl, plan: plans[0]!, arrival: addDays(today, 7), nights: 5, status: 'tentative', room: null },
    ];
    let n = 0;
    for (const b of bookings) {
      const departure = addDays(b.arrival, b.nights);
      const q = await quote(tx, b.type, b.plan, b.arrival, departure);
      const room = b.room ? roomRows.find((r) => r.number === b.room) : undefined;
      await tx.insert(reservations).values({
        tenantId,
        propertyId: p.id,
        code: `DEMO${String(++n).padStart(4, '0')}`,
        guestId: guestRows[b.guest]!.id,
        roomTypeId: b.type.id,
        roomId: room?.id ?? null,
        ratePlanId: b.plan.id,
        status: b.status,
        source: 'direct',
        arrival: b.arrival,
        departure,
        adults: 2,
        currency: 'RON',
        totalAmount: q.total,
        nightlyRates: q.nightlyRates,
        checkedInAt: b.status === 'checked_in' ? new Date() : null,
      });
      if (b.status === 'checked_in' && room) await tx.update(rooms).set({ occupancy: 'occupied' }).where(eq(rooms.id, room.id));
    }
    await tx.update(rooms).set({ status: 'dirty' }).where(sql`${rooms.number} in ('102', '205')`);
  }, tenant!.id);
  return { skipped: false as const, users: people.map((p) => p[1]) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DbService();
  try {
    const c = config();
    if (c.PLATFORM_ADMIN_EMAIL && c.PLATFORM_ADMIN_PASSWORD) {
      if (c.PLATFORM_ADMIN_PASSWORD.length < 12) throw new Error('PLATFORM_ADMIN_PASSWORD must have at least 12 characters');
      await ensurePlatformAdmin(db, c.PLATFORM_ADMIN_EMAIL, c.PLATFORM_ADMIN_PASSWORD);
      console.log(`Platform admin ready: ${c.PLATFORM_ADMIN_EMAIL} (enable 2FA at first sign-in)`);
    }
    if (process.argv.includes('--demo')) {
      if (c.isProduction && !process.argv.includes('--force')) throw new Error('Refusing to seed demo data in production');
      const password = process.env.DEMO_PASSWORD ?? `Demo-${randomBytes(6).toString('base64url')}`;
      const result = await seedDemo(db, password);
      if (result.skipped) console.log('Demo organization already exists');
      else console.log(`Demo organization created. Users: ${result.users.join(', ')}\nPassword for all demo users: ${password}`);
    }
  } finally {
    await db.onModuleDestroy();
  }
}
