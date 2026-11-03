import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicHomeAssistantAddress } from '../src/doors/homeassistant.service.js';

test('public IPv4 resolves through the HA filter, including the deployed HA address', () => {
  for (const address of ['154.43.62.82', '1.1.1.1', '8.8.8.8'])
    assert.equal(isPublicHomeAssistantAddress(address, 4), true, address);
});
test('private, loopback, metadata, shared, multicast and reserved IPv4 stay blocked', () => {
  for (const address of [
    '0.0.0.0',
    '10.10.0.103',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.10.102',
    '100.64.0.1',
    '192.0.2.10',
    '198.18.0.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
  ])
    assert.equal(isPublicHomeAssistantAddress(address, 4), false, address);
});
test('IPv6 public addresses pass; mapped IPv4 and translation ranges cannot bypass checks', () => {
  assert.equal(isPublicHomeAssistantAddress('2606:4700:4700::1111', 6), true);
  for (const address of [
    '::',
    '::1',
    '::ffff:10.0.0.1',
    '::ffff:154.43.62.82',
    '64:ff9b::a00:1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '2001:db8::1',
    '2002:a00:1::1',
  ])
    assert.equal(isPublicHomeAssistantAddress(address, 6), false, address);
});
test('invalid addresses or mismatched address families fail closed', () => {
  for (const [address, family] of [
    ['localhost', 4],
    ['invalid', 6],
    ['154.43.62.82', 6],
    ['::1', 4],
    ['1.1.1.1', 0],
  ] as const)
    assert.equal(isPublicHomeAssistantAddress(address, family), false);
});
