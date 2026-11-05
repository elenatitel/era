import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { addDays } from '@pms/shared';
import { Client, startDatabase } from './harness.js';

const ORIGIN = 'http://localhost:3000';
const DEMO_PASSWORD = 'Demo-password-123';
const LIMIT = 40;

let db: Awaited<ReturnType<typeof startDatabase>>;
let app: INestApplication;
let base: string;
let fake: Server;
let script: (any[] | ((body: any) => any[]))[] = [];
let broken = false;
const seen: any[] = [];

const text = (t: string) => [{ type: 'text', text: t }];
const call = (name: string, input: unknown = {}) => [{ type: 'tool_use', id: `toolu_${randomUUID().replaceAll('-', '')}`, name, input }];

before(async () => {
  // Plays the model: each request gets the next scripted reply, and everything sent is kept.
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      if (broken) {
        res.statusCode = 400;
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }));
        return;
      }
      const next = script.shift() ?? text('Done.');
      const content = typeof next === 'function' ? next(seen.at(-1)) : next;
      const stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'test', content, stop_reason, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
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
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_API_BASE: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
    AI_DAILY_QUESTIONS: String(LIMIT),
  });
  const { createApp } = await import('../src/bootstrap.js');
  const { DbService } = await import('../src/db/db.service.js');
  const { seedDemo } = await import('../src/db/seed.js');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  await seedDemo(app.get(DbService), DEMO_PASSWORD);
});

after(async () => {
  await app?.close();
  await db?.stop();
  fake?.close();
});

beforeEach(() => {
  script = [];
  broken = false;
  seen.length = 0;
});

async function login(email: string) {
  const c = await new Client(base, ORIGIN).init();
  assert.equal((await c.post('/auth/login', { email, password: DEMO_PASSWORD })).status, 200);
  return c;
}

/** Books a stay for today with a note full of what must not leave the system. */
async function stayToday(mgr: Client) {
  const [property] = (await mgr.get('/properties')).body as { id: string; businessDate: string }[];
  const today = property!.businessDate;
  const q = `propertyId=${property!.id}`;
  const search = (await mgr.get(`/availability?${q}&arrival=${today}&departure=${addDays(today, 2)}&adults=1`)).body;
  const offer = search.roomTypes.find((t: any) => t.available >= 1 && t.offers.some((o: any) => o.sellable));
  const res = await mgr.post('/reservations', {
    propertyId: property!.id,
    roomTypeId: offer.roomType.id,
    ratePlanId: offer.offers.find((o: any) => o.sellable).ratePlanId,
    arrival: today,
    departure: addDays(today, 2),
    adults: 1,
    guest: { firstName: 'Ioana', lastName: 'Zamfirescu', email: 'ioana@zamfir.test', phone: '0722111333' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // Written by the guest on the booking page, which staff reservations do not offer.
  await db.superQuery(`UPDATE reservations SET guest_requests = $1 WHERE id = $2`, ['Ioana Zamfirescu vrea pernă. Sunați la 0722 111 333 sau ioana@zamfir.test.', res.body.id]);
  return { propertyId: property!.id, reservationId: res.body.id as string };
}

test('the agent answers with names it never saw', async () => {
  const mgr = await login('manager@demo.test');
  const { propertyId, reservationId } = await stayToday(mgr);
  // The last reply names the guest with the reference the tool handed out.
  script = [
    call('arrivals_today'),
    (body) => {
      const result = JSON.stringify(body.messages.at(-1).content);
      return text(`Sosește ${result.match(/(\[\[R\d+\]\])(?:(?!\[\[R).)*pernă/)![1]}.`);
    },
  ];
  const res = await mgr.post('/ask', { propertyId, question: 'Cine sosește azi și ce a cerut?', locale: 'ro' });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const sent = JSON.stringify(seen);
  for (const secret of ['Zamfirescu', 'Ioana', 'Sophie Martin', 'ioana@zamfir.test', '0722', reservationId]) assert.ok(!sent.includes(secret), `${secret} reached the model`);
  assert.ok(sent.includes('[[R'), 'guests are sent as references');
  assert.ok(sent.includes('Answer in Romanian'));
  assert.ok(seen.every((body) => body.thread === undefined), 'the conversation is not stored on the provider side');
  assert.ok(seen[1].tools.length > 0, 'every turn carries the whole request');
  assert.ok(sent.includes('[email]') && sent.includes('[phone]'), 'requests reach the model scrubbed');
  assert.equal(res.body.answer, 'Sosește Ioana Zamfirescu.');
  assert.equal(res.body.stays[0].id, reservationId);

  const written = await db.superQuery<{ metadata: any }>(`SELECT metadata FROM audit_logs WHERE action = 'ask.question' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(written[0]!.metadata.outcome, 'answered');
  assert.deepEqual(written[0]!.metadata.tools, ['arrivals_today']);
  assert.ok(!JSON.stringify(written[0]).includes('sosește'), 'the question text is not kept');
});

test('references become names and links, invented ones disappear', async () => {
  const { Refs } = await import('../src/ask/ask-tools.js');
  const refs = new Refs();
  const r1 = refs.add('id-1', { guestName: 'Ana Pop', code: 'ABC', room: '204' });
  assert.equal(r1, '[[R1]]');
  assert.equal(refs.add('id-1', {}), '[[R1]]');
  const { answer, mentioned } = refs.restore('[[R1]] are sold, iar [[R7]] nu. Tot [[R1]].', 'oaspetele');
  assert.equal(answer, 'Ana Pop are sold, iar nu. Tot Ana Pop.');
  assert.deepEqual(mentioned.map((m) => m.id), ['id-1']);
});

test('contact details in a question stay here and still find the stay', async () => {
  const mgr = await login('manager@demo.test');
  const { propertyId } = await stayToday(mgr);
  script = [call('find_stays', { search: '[contact1]' }), text('Am găsit [[R1]].')];
  const res = await mgr.post('/ask', { propertyId, question: 'Ce rezervare are 0722111333 pe 12.11.2026?', locale: 'ro' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(!JSON.stringify(seen).includes('0722111333'));
  assert.ok(JSON.stringify(seen[0].messages).includes('12.11.2026'), 'dates are not mistaken for phone numbers');
  assert.equal(res.body.answer, 'Am găsit Ioana Zamfirescu.');
  assert.equal(res.body.stays.length, 1);
  assert.equal(res.body.stays[0].guestName, 'Ioana Zamfirescu');
  assert.deepEqual(res.body.tools, ['find_stays']);
});

test('the agent gets no tool that writes, and only what the role can see', async () => {
  const mgr = await login('manager@demo.test');
  const { propertyId } = await stayToday(mgr);
  script = [text('Gata.')];
  assert.equal((await mgr.post('/ask', { propertyId, question: 'Anulează toate rezervările de azi', locale: 'ro' })).status, 200);
  assert.deepEqual(seen[0].tools.map((t: any) => t.name).sort(), ['arrivals_today', 'availability', 'close_of_day', 'find_stays', 'hotel_overview', 'rooms_today', 'stay_details']);

  seen.length = 0;
  const hk = await login('housekeeper@demo.test');
  script = [call('find_stays', { search: 'Zamfirescu' }), text('Rolul tău nu poate vedea asta.')];
  const res = await hk.post('/ask', { propertyId, question: 'Ce rezervare are Zamfirescu?', locale: 'ro' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const offered = seen[0].tools.map((t: any) => t.name);
  assert.ok(!offered.includes('find_stays') && !offered.includes('stay_details') && !offered.includes('availability'), offered.join());
  assert.deepEqual(res.body.tools, [], 'a tool the role lacks never ran');
  assert.ok(!JSON.stringify(seen[1].messages).includes('"guest"'));
});

test('the stay tool only opens references handed out in the same question', async () => {
  const mgr = await login('manager@demo.test');
  const { propertyId, reservationId } = await stayToday(mgr);
  script = [call('stay_details', { ref: 'R1' }), text('Nu am găsit.')];
  const res = await mgr.post('/ask', { propertyId, question: 'Ce știm despre rezervarea asta?', locale: 'ro' });
  assert.equal(res.status, 200);
  const result = seen[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.ok(!JSON.stringify(seen[1]).includes(reservationId));
});

test('a failure of the model is reported and still counted', async () => {
  const mgr = await login('manager@demo.test');
  const [property] = (await mgr.get('/properties')).body as { id: string }[];
  broken = true;
  const res = await mgr.post('/ask', { propertyId: property!.id, question: 'Cine sosește azi?', locale: 'ro' });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'AI_UNAVAILABLE');
  const [row] = await db.superQuery<{ outcome: string }>(`SELECT metadata->>'outcome' AS outcome FROM audit_logs WHERE action = 'ask.question' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(row!.outcome, 'failed');

  assert.deepEqual((await mgr.get('/ask/status')).body, { enabled: true });
});

test('a question costs nothing unless the property is reachable and the day has room', async () => {
  const mgr = await login('manager@demo.test');
  const [property] = (await mgr.get('/properties')).body as { id: string }[];
  assert.equal((await mgr.post('/ask', { propertyId: randomUUID(), question: 'Cine sosește azi?', locale: 'ro' })).status, 404);
  assert.equal(seen.length, 0);

  const [tenant] = await db.superQuery<{ tenant_id: string }>(`SELECT tenant_id FROM properties WHERE id = $1`, [property!.id]);
  await db.superQuery(`INSERT INTO audit_logs (tenant_id, action, entity_type) SELECT $1, 'ask.question', 'property' FROM generate_series(1, $2::int)`, [tenant!.tenant_id, LIMIT]);
  const res = await mgr.post('/ask', { propertyId: property!.id, question: 'Cine sosește azi?', locale: 'ro' });
  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'AI_LIMIT');
  assert.equal(seen.length, 0);
});
