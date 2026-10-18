import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { addDays } from '@pms/shared';
import { Client, startDatabase } from './harness.js';

const ORIGIN = 'http://localhost:3000';
const DEMO_PASSWORD = 'Demo-password-123';
const ADMIN = { email: 'admin@platform.test', password: 'Platform-admin-pass-1' };

let db: Awaited<ReturnType<typeof startDatabase>>;
let app: INestApplication;
let base: string;
let mail: { outbox: { to: string; text: string }[] };
let totpAt: (secret: string, counter: number) => string;

const client = () => new Client(base, ORIGIN).init();
async function login(email: string, password = DEMO_PASSWORD) {
  const c = await client();
  const res = await c.post('/auth/login', { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return c;
}
const tokenFromMail = (to: string) => {
  const msg = [...mail.outbox].reverse().find((m) => m.to === to);
  assert.ok(msg, `no mail for ${to}`);
  return /\/(?:invite|reset-password)\/([\w-]+)/.exec(msg.text)![1]!;
};
/** A TOTP code for a time step not used before (the API rejects replays; ±1 step drift is accepted). */
let lastStep = -Infinity;
function freshCode(secret: string) {
  const step = Math.max(Math.floor(Date.now() / 30_000), lastStep + 1);
  lastStep = step;
  return totpAt(secret, step);
}

before(async () => {
  db = await startDatabase();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(db.ownerUrl, db.appUrl, fileURLToPath(new URL('../../drizzle', import.meta.url)));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: db.appUrl,
    JWT_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WEB_ORIGIN: ORIGIN,
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
    TRUST_PROXY: '0',
  });
  const { createApp } = await import('../src/bootstrap.js');
  const { DbService } = await import('../src/db/db.service.js');
  const { MailService } = await import('../src/mail/mail.service.js');
  const { ensurePlatformAdmin, seedDemo } = await import('../src/db/seed.js');
  ({ totpAt } = await import('../src/common/totp.js'));
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  mail = app.get(MailService);
  const dbs = app.get(DbService);
  await ensurePlatformAdmin(dbs, ADMIN.email, ADMIN.password);
  await seedDemo(dbs, DEMO_PASSWORD);
});

after(async () => {
  await app?.close();
  await db?.stop();
});

describe('database hardening', () => {
  test('every tenant table has forced row-level security', async () => {
    const { TENANT_TABLES } = await import('../src/db/schema.js');
    const rows = await db.superQuery<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = any($1)`,
      [TENANT_TABLES],
    );
    assert.equal(rows.length, TENANT_TABLES.length);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} lacks forced RLS`);
  });

  test('app role sees no tenant rows without a tenant context', async () => {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: db.appUrl });
    await c.connect();
    const { rows } = await c.query('select count(*)::int as n from guests');
    const insert = await c.query(`insert into guests (tenant_id, first_name, last_name) select id, 'x', 'y' from tenants limit 1`).catch((e) => e);
    const audit = await c.query(`delete from audit_logs`).catch((e) => e);
    await c.end();
    assert.equal(rows[0].n, 0);
    assert.match(String(insert.message), /row-level security/);
    assert.match(String(audit.message), /permission denied/);
  });
});

describe('authentication', () => {
  test('health is public', async () => {
    const c = await client();
    assert.equal((await c.get('/health')).status, 200);
  });

  test('protected routes require a session', async () => {
    const c = await client();
    assert.equal((await c.get('/auth/me')).status, 401);
  });

  test('state-changing requests require the CSRF token and same origin', async () => {
    const c = await client();
    const noToken = await c.req('POST', '/auth/login', { email: 'owner@demo.test', password: DEMO_PASSWORD }, { csrf: false });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.error.code, 'CSRF');
    const evil = new Client(base, 'https://evil.example');
    await evil.init();
    assert.equal((await evil.post('/auth/login', { email: 'owner@demo.test', password: DEMO_PASSWORD })).status, 403);
  });

  test('login selects the only organization and exposes permissions', async () => {
    const c = await login('frontdesk@demo.test');
    const me = await c.get('/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.tenant.slug, 'demo');
    assert.ok(me.body.permissions.includes('frontdesk.checkin'));
    assert.ok(!me.body.permissions.includes('roles.manage'));
    assert.ok(!c.cookies.get('pms_at')!.includes(DEMO_PASSWORD));
  });

  test('wrong passwords are rejected and the account locks after 5 attempts', async () => {
    const c = await client();
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/auth/login', { email: 'revenue@demo.test', password: 'wrong-password-x1' });
      assert.equal(r.status, 401);
    }
    const locked = await c.post('/auth/login', { email: 'revenue@demo.test', password: DEMO_PASSWORD });
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
    await db.superQuery(`update users set locked_until = null where email = 'revenue@demo.test'`);
  });

  test('refresh tokens rotate and reuse revokes the session family', async () => {
    const c = await login('accounting@demo.test');
    const oldRefresh = c.cookies.get('pms_rt')!;
    assert.equal((await c.post('/auth/refresh')).status, 204);
    assert.notEqual(c.cookies.get('pms_rt'), oldRefresh);
    assert.equal((await c.get('/auth/me')).status, 200);
    // Within the grace window a stale token is answered with a retry hint, not a lockout.
    const attacker = await client();
    attacker.cookies.set('pms_rt', oldRefresh);
    assert.equal((await attacker.post('/auth/refresh')).body.error.code, 'REFRESH_RACE');
    // After the grace window, reuse is treated as theft: the whole family is revoked.
    await db.superQuery(`update sessions set revoked_at = now() - interval '5 minutes' where revoked_reason = 'rotated'`);
    assert.equal((await attacker.post('/auth/refresh')).status, 401);
    assert.equal((await c.get('/auth/me')).status, 401);
  });

  test('logout revokes the session immediately', async () => {
    const c = await login('manager@demo.test');
    const access = c.cookies.get('pms_at')!;
    assert.equal((await c.post('/auth/logout')).status, 204);
    const replay = await client();
    replay.cookies.set('pms_at', access);
    assert.equal((await replay.get('/auth/me')).status, 401);
  });

  test('password reset flow', async () => {
    const c = await client();
    assert.equal((await c.post('/auth/password/forgot', { email: 'nobody@demo.test' })).status, 202);
    assert.equal((await c.post('/auth/password/forgot', { email: 'hk-lead@demo.test' })).status, 202);
    const token = tokenFromMail('hk-lead@demo.test');
    assert.equal((await c.post('/auth/password/reset', { token, password: 'short' })).status, 422);
    assert.equal((await c.post('/auth/password/reset', { token, password: 'New-password-2026!' })).status, 204);
    assert.equal((await c.post('/auth/password/reset', { token, password: 'New-password-2026!' })).status, 400);
    await login('hk-lead@demo.test', 'New-password-2026!');
  });
});

let tenantB: { id: string };
let ownerB: Client;

describe('platform administration and tenant isolation', () => {
  let adminSecret: string;
  let admin: Client;

  test('platform routes require MFA', async () => {
    admin = await login(ADMIN.email, ADMIN.password);
    assert.equal((await admin.get('/platform/tenants')).body.error.code, 'MFA_SETUP_REQUIRED');
    const setup = await admin.post('/auth/mfa/setup');
    adminSecret = setup.body.secret;
    assert.match(setup.body.qrDataUrl, /^data:image\/png;base64,/);
    const enabled = await admin.post('/auth/mfa/enable', { code: freshCode(adminSecret) });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.recoveryCodes.length, 10);
    assert.equal((await admin.get('/platform/tenants')).status, 200);
  });

  test('MFA login requires a valid second factor and rejects replays', async () => {
    const c = await client();
    const step1 = await c.post('/auth/login', ADMIN);
    assert.equal(step1.body.mfaRequired, true);
    assert.equal((await c.post('/auth/login/mfa', { mfaToken: step1.body.mfaToken, code: '000000' })).status, 401);
    const code = freshCode(adminSecret);
    assert.equal((await c.post('/auth/login/mfa', { mfaToken: step1.body.mfaToken, code })).status, 200);
    const again = await (await client()).post('/auth/login', ADMIN);
    const replay = await (await client()).post('/auth/login/mfa', { mfaToken: again.body.mfaToken, code });
    assert.equal(replay.status, 401);
    admin = c;
  });

  test('non-admins cannot reach platform routes', async () => {
    const c = await login('owner@demo.test');
    assert.equal((await c.get('/platform/tenants')).status, 403);
  });

  test('creating a tenant invites its owner', async () => {
    const res = await admin.post('/platform/tenants', { name: 'Other Hotel Group', slug: 'other', ownerEmail: 'boss@other.test', ownerName: 'Boss' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    tenantB = res.body;
    const token = tokenFromMail('boss@other.test');
    const anon = await client();
    assert.equal((await anon.get(`/auth/invitations/${token}`)).body.organization, 'Other Hotel Group');
    assert.equal((await anon.post('/auth/invitations/accept', { token, name: 'Boss', password: 'Boss-password-2026' })).status, 200);
    assert.equal((await anon.post('/auth/invitations/accept', { token, name: 'Boss', password: 'Boss-password-2026' })).status, 400);
    ownerB = await login('boss@other.test', 'Boss-password-2026');
    const me = await ownerB.get('/auth/me');
    assert.equal(me.body.tenant.id, tenantB.id);
    assert.equal(me.body.role.key, 'owner');
  });

  test('tenant B cannot see or touch tenant A data', async () => {
    const a = await login('owner@demo.test');
    const guestsA = await a.get('/guests');
    assert.ok(guestsA.body.total >= 5);
    const someGuest = guestsA.body.items[0].id;
    const props = (await a.get('/properties')).body;
    assert.equal((await ownerB.get('/guests')).body.total, 0);
    assert.equal((await ownerB.get(`/guests/${someGuest}`)).status, 404);
    assert.equal((await ownerB.patch(`/guests/${someGuest}`, { notes: 'pwned' })).status, 404);
    assert.equal((await ownerB.get(`/properties/${props[0].id}`)).status, 404);
    assert.equal((await ownerB.get(`/rooms?propertyId=${props[0].id}`)).status, 404);
    // Switching into a tenant you do not belong to is refused.
    const demoTenant = (await a.get('/auth/me')).body.tenant.id;
    assert.equal((await ownerB.post('/auth/switch-tenant', { tenantId: demoTenant })).status, 403);
  });

  test('suspending a tenant blocks its users', async () => {
    assert.equal((await admin.patch(`/platform/tenants/${tenantB.id}/status`, { status: 'suspended' })).status, 200);
    assert.equal((await ownerB.get('/guests')).body.error.code, 'TENANT_SUSPENDED');
    await admin.patch(`/platform/tenants/${tenantB.id}/status`, { status: 'active' });
    assert.equal((await ownerB.get('/guests')).status, 200);
  });
});

describe('roles and permissions', () => {
  test('housekeepers cannot see guests or reservations', async () => {
    const c = await login('housekeeper@demo.test');
    assert.equal((await c.get('/guests')).status, 403);
    assert.equal((await c.post('/reservations', {})).status, 403);
    assert.equal((await c.get('/members')).status, 403);
  });

  test('document numbers are masked without guests.pii', async () => {
    const acc = await login('accounting@demo.test');
    const vip = (await acc.get('/guests?q=Popa')).body.items[0];
    assert.match(vip.documentNumber, /^\*+3456$/);
    const fd = await login('frontdesk@demo.test');
    assert.equal((await fd.get(`/guests/${vip.id}`)).body.documentNumber, 'BV123456');
  });

  test('privilege escalation is blocked', async () => {
    const owner = await login('owner@demo.test');
    const roles = (await owner.get('/roles')).body as { id: string; key: string }[];
    const ownerRole = roles.find((r) => r.key === 'owner')!;
    const manager = await login('manager@demo.test');
    // Managers can invite, but not as owner and not with permissions they lack.
    assert.equal((await manager.post('/invitations', { email: 'x@demo.test', roleId: ownerRole.id })).status, 403);
    assert.equal((await manager.post('/roles', { name: 'Super', permissions: ['roles.manage'] })).status, 403);
    const custom = await owner.post('/roles', { name: 'Night Auditor', permissions: ['property.read', 'property.manage', 'reports.read'] });
    assert.equal(custom.status, 201);
    assert.equal((await owner.put(`/roles/${ownerRole.id}`, { name: 'Owner', permissions: [] })).status, 403);
    // The last owner cannot be demoted.
    const members = (await owner.get('/members')).body as { id: string; email: string }[];
    const self = members.find((m) => m.email === 'owner@demo.test')!;
    assert.equal((await owner.patch(`/members/${self.id}`, { roleId: custom.body.id })).status, 403);
  });

  test('disabling a member revokes their sessions', async () => {
    const owner = await login('owner@demo.test');
    const rev = await login('revenue@demo.test');
    assert.equal((await rev.get('/rate-plans?propertyId=' + (await rev.get('/properties')).body[0].id)).status, 200);
    const members = (await owner.get('/members')).body as { id: string; email: string }[];
    const m = members.find((x) => x.email === 'revenue@demo.test')!;
    assert.equal((await owner.patch(`/members/${m.id}`, { status: 'disabled' })).status, 200);
    assert.equal((await rev.get('/properties')).status, 401);
    await owner.patch(`/members/${m.id}`, { status: 'active' });
  });
});

describe('hotel operations', () => {
  let fd: Client;
  let propertyId: string;
  let businessDate: string;

  before(async () => {
    fd = await login('frontdesk@demo.test');
    const props = (await fd.get('/properties')).body;
    propertyId = props[0].id;
    businessDate = props[0].businessDate;
  });

  test('dashboard hides financials without reports.read', async () => {
    const dash = (await fd.get(`/dashboard?propertyId=${propertyId}`)).body;
    assert.equal(dash.financial, null);
    assert.equal(dash.rooms.total, 17);
    const mgr = await login('manager@demo.test');
    assert.ok((await mgr.get(`/dashboard?propertyId=${propertyId}`)).body.financial);
  });

  test('availability and overbooking protection under concurrency', async () => {
    const avail = (await fd.get(`/availability?propertyId=${propertyId}&arrival=${businessDate}&departure=${addDays(businessDate, 2)}&adults=2`)).body;
    const ste = avail.roomTypes.find((r: any) => r.roomType.code === 'STE');
    assert.equal(ste.available, 2);
    const bar = ste.offers.find((o: any) => o.ratePlanName === 'Best Available Rate');
    const body = {
      propertyId,
      roomTypeId: ste.roomType.id,
      ratePlanId: bar.ratePlanId,
      arrival: businessDate,
      departure: addDays(businessDate, 2),
      adults: 2,
      guest: { firstName: 'Race', lastName: 'Condition' },
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => fd.post('/reservations', body)));
    const ok = results.filter((r) => r.status === 201);
    assert.equal(ok.length, 2, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'NO_AVAILABILITY'));
    assert.equal(ok[0]!.body.totalAmount, 130000);
  });

  test('the same room cannot be assigned to overlapping stays', async () => {
    const res = (await fd.get(`/reservations?propertyId=${propertyId}&q=Condition`)).body.items;
    const rooms = (await fd.get(`/rooms?propertyId=${propertyId}`)).body.filter((r: any) => r.roomTypeCode === 'STE');
    const free = rooms.find((r: any) => r.number === '302');
    assert.equal((await fd.patch(`/reservations/${res[0].id}`, { roomId: free.id })).status, 200);
    const clash = await fd.patch(`/reservations/${res[1].id}`, { roomId: free.id });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'ROOM_CONFLICT');
  });

  test('full stay: check-in, charges, balance, payment, check-out, invoice, credit note', async () => {
    const list = (await fd.get(`/reservations?propertyId=${propertyId}&q=Martin`)).body.items;
    const resv = list[0];
    const freeRooms = (await fd.get(`/reservations/${resv.id}/free-rooms`)).body;
    const dirty = freeRooms.find((r: any) => r.status === 'dirty');
    const clean = freeRooms.find((r: any) => r.status === 'clean');
    assert.equal((await fd.post(`/reservations/${resv.id}/check-in`, { roomId: dirty.id })).body.error.code, 'ROOM_NOT_READY');
    assert.equal((await fd.post(`/reservations/${resv.id}/check-in`, { roomId: clean.id })).status, 200);

    assert.equal((await fd.post(`/reservations/${resv.id}/charges`, { category: 'minibar', description: 'Minibar', quantity: 2, unitPrice: 1500 })).status, 201);
    // Night audit as manager posts tonight's room charge and advances the business date.
    const mgr = await login('manager@demo.test');
    const audit = await mgr.post(`/properties/${propertyId}/night-audit`);
    assert.equal(audit.status, 200, JSON.stringify(audit.body));
    assert.ok(audit.body.roomChargesPosted >= 2);
    assert.equal(audit.body.newBusinessDate, addDays(businessDate, 1));
    assert.ok(audit.body.noShows.length >= 1, 'unarrived guests become no-shows');
    // Running it again for a future date is refused.
    assert.equal((await mgr.post(`/properties/${propertyId}/night-audit`)).status, 409);

    const blocked = await fd.post(`/reservations/${resv.id}/check-out`, {});
    assert.equal(blocked.body.error.code, 'OUTSTANDING_BALANCE');
    const due = blocked.body.error.details.balance;
    // Early departure: only the one audited night is charged, plus the minibar.
    assert.equal(due, 33000 + 3000);
    assert.equal((await fd.post(`/reservations/${resv.id}/payments`, { method: 'card', amount: -100 })).status, 403);
    const paid = await fd.post(`/reservations/${resv.id}/payments`, { method: 'card', amount: due, reference: 'POS-1' });
    assert.equal(paid.body.totals.balance, 0);
    const out = await fd.post(`/reservations/${resv.id}/check-out`, {});
    assert.equal(out.status, 200, JSON.stringify(out.body));

    const hk = (await fd.get(`/rooms?propertyId=${propertyId}`)).body.find((r: any) => r.id === clean.id);
    assert.equal(hk.status, 'dirty');
    assert.equal(hk.occupancy, 'vacant');

    const inv = await fd.post('/invoices', { propertyId, type: 'invoice', reservationId: resv.id });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal(inv.body.fullNumber, 'HC-000001');
    assert.equal(inv.body.total, due);
    assert.equal(inv.body.status, 'paid');
    assert.equal((await fd.post('/invoices', { propertyId, type: 'invoice', reservationId: resv.id })).status, 409);
    const full = (await fd.get(`/invoices/${inv.body.id}`)).body;
    assert.equal(full.lines.length, 2);
    assert.equal(full.vatTotal, full.lines.reduce((s: number, l: any) => s + l.vat, 0));
    // Front desk cannot cancel invoices; accountants can, producing a credit note.
    assert.equal((await fd.post(`/invoices/${inv.body.id}/cancel`, { reason: 'Wrong company' })).status, 403);
    const acc = await login('accounting@demo.test');
    const storno = await acc.post(`/invoices/${inv.body.id}/cancel`, { reason: 'Wrong company' });
    assert.equal(storno.status, 200);
    assert.equal(storno.body.creditNote.total, -due);
    assert.equal(storno.body.creditNote.fullNumber, 'HC-CN-000001');
    // Charges are free to be invoiced again, with the next gapless number.
    assert.equal((await acc.post('/invoices', { propertyId, type: 'invoice', reservationId: resv.id })).body.fullNumber, 'HC-000002');
    const audit_ = await (await login('owner@demo.test')).get('/audit-log?pageSize=200');
    assert.ok(audit_.body.items.some((e: any) => e.action === 'invoice.cancelled'));
  });

  test('housekeeping: supervisors assign, housekeepers only see and finish their own tasks', async () => {
    const lead = await login('hk-lead@demo.test', 'New-password-2026!');
    const board = (await lead.get(`/housekeeping/board?propertyId=${propertyId}`)).body;
    const staff = (await lead.get(`/housekeeping/staff?propertyId=${propertyId}`)).body;
    const maid = staff.find((s: any) => s.name === 'Maria Georgescu');
    assert.ok(maid);
    const gen = await lead.post('/housekeeping/generate', { propertyId, date: board.businessDate });
    assert.equal(gen.status, 201);
    const tasks = (await lead.get(`/housekeeping/tasks?propertyId=${propertyId}`)).body;
    assert.ok(tasks.length >= 1);
    const task = tasks.find((t: any) => t.type === 'checkout_clean') ?? tasks[0];
    assert.equal((await lead.patch(`/housekeeping/tasks/${task.id}`, { assignedToUserId: maid.userId })).status, 200);

    const hk = await login('housekeeper@demo.test');
    const mine = (await hk.get(`/housekeeping/tasks?propertyId=${propertyId}`)).body;
    assert.deepEqual(mine.map((t: any) => t.id), [task.id]);
    const other = tasks.find((t: any) => t.id !== task.id);
    if (other) assert.equal((await hk.patch(`/housekeeping/tasks/${other.id}`, { status: 'done' })).status, 403);
    assert.equal((await hk.patch(`/housekeeping/tasks/${task.id}`, { status: 'inspected' })).status, 409);
    assert.equal((await hk.patch(`/housekeeping/tasks/${task.id}`, { status: 'done' })).status, 200);
    assert.equal((await hk.put(`/rooms/${task.roomId}/status`, { status: 'out_of_order' })).status, 403);
    assert.equal((await lead.patch(`/housekeeping/tasks/${task.id}`, { status: 'inspected' })).status, 200);
    const room = (await lead.get(`/rooms?propertyId=${propertyId}`)).body.find((r: any) => r.id === task.roomId);
    assert.equal(room.status, 'inspected');
  });

  test('GDPR export and anonymization', async () => {
    const owner = await login('owner@demo.test');
    const g = await owner.post('/guests', { firstName: 'Erase', lastName: 'Me', email: 'erase@example.com', documentNumber: 'X999' });
    assert.equal(g.status, 201);
    const exp = await owner.get(`/guests/${g.body.id}/gdpr-export`);
    assert.equal(exp.body.profile.documentNumber, 'X999');
    assert.equal((await fd.get(`/guests/${g.body.id}/gdpr-export`)).status, 403);
    assert.equal((await owner.post(`/guests/${g.body.id}/anonymize`)).status, 204);
    const after = (await owner.get(`/guests/${g.body.id}`)).body;
    assert.equal(after.email, null);
    assert.equal(after.lastName, 'Guest');
    const raw = await db.superQuery<{ document_number_enc: string | null }>(`select document_number_enc from guests where id = $1`, [g.body.id]);
    assert.equal(raw[0]!.document_number_enc, null);
  });

  test('validation errors are reported per field', async () => {
    const r = await fd.post('/reservations', { propertyId, arrival: '2026-01-05', departure: '2026-01-01' });
    assert.equal(r.status, 422);
    assert.ok(r.body.error.details.length > 0);
    assert.equal((await fd.get('/guests/not-a-uuid')).status, 400);
  });
});
