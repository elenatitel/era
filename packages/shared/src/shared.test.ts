import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vatFromGross, parseMoney, applyPercent } from './money.js';
import { stayDates, nightsBetween, addDays } from './dates.js';
import { ROLE_TEMPLATES, ALL_PERMISSIONS, isPermission } from './permissions.js';
import { createReservationSchema, password } from './schemas.js';

test('vat from gross', () => {
  assert.equal(vatFromGross(12100, 2100), 2100);
  assert.equal(vatFromGross(11100, 1100), 1100);
  assert.equal(vatFromGross(5000, 0), 0);
});

test('parse money', () => {
  assert.equal(parseMoney('12,50'), 1250);
  assert.equal(parseMoney('7'), 700);
  assert.equal(parseMoney('-3.1'), -310);
  assert.equal(parseMoney('1.234'), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(applyPercent(10000, -10), 9000);
});

test('stay dates', () => {
  assert.equal(nightsBetween('2026-02-27', '2026-03-02'), 3);
  assert.deepEqual(stayDates('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01']);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('role templates only reference known permissions', () => {
  for (const role of ROLE_TEMPLATES) for (const p of role.permissions) assert.ok(isPermission(p), p);
  assert.equal(ROLE_TEMPLATES.find((r) => r.key === 'owner')!.permissions.length, ALL_PERMISSIONS.length);
});

test('reservation schema validation', () => {
  const base = {
    propertyId: crypto.randomUUID(),
    roomTypeId: crypto.randomUUID(),
    ratePlanId: crypto.randomUUID(),
    arrival: '2026-05-01',
    departure: '2026-05-03',
    adults: 2,
    guestId: crypto.randomUUID(),
  };
  assert.ok(createReservationSchema.safeParse(base).success);
  assert.ok(!createReservationSchema.safeParse({ ...base, departure: '2026-05-01' }).success);
  assert.ok(!createReservationSchema.safeParse({ ...base, guest: { firstName: 'A', lastName: 'B' } }).success);
});

test('password policy', () => {
  assert.ok(!password.safeParse('short1').success);
  assert.ok(!password.safeParse('onlylettersherexx').success);
  assert.ok(password.safeParse('correct horse 42 battery').success);
});
