import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import https from 'node:https';
import { z } from 'zod';

export const entitySchema = z
  .string()
  .max(255)
  .regex(/^(lock|script)\.[a-z0-9_]+$/)
  .refine(
    (v) => !['script.turn_on', 'script.turn_off', 'script.toggle', 'script.reload'].includes(v),
    'Choose an individual lock or script',
  );
export const haUrlSchema = z
  .url()
  .max(500)
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (!u.port || u.port === '443') &&
      u.pathname === '/' &&
      !isIP(u.hostname.replace(/^\[|\]$/g, ''))
    );
  }, 'Use an HTTPS hostname without a path, credentials or custom port');

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['2001::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');

@Injectable()
export class HomeAssistantService {
  async call(base: string, token: string, entityId?: string): Promise<void> {
    const parsed = haUrlSchema.safeParse(base);
    if (!parsed.success || (entityId && !entitySchema.safeParse(entityId).success))
      throw new ServiceUnavailableException('Door integration is not configured correctly');
    const url = new URL(base);
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(() => reject(new Error('DNS timeout')), 2000);
      }),
    ])
      .catch(() => [])
      .finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some((a) => blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')))
      throw new ServiceUnavailableException('Home Assistant must resolve to a public HTTPS address');
    const target = addresses[0]!;
    const service = entityId?.startsWith('lock.') ? 'lock/unlock' : entityId ? `script/${entityId.slice(7)}` : '';
    const payload = entityId?.startsWith('lock.') ? { entity_id: entityId } : {};
    // Pinned DNS lookup prevents rebinding; HTTPS still verifies the original hostname.
    // No redirects or automatic retries: an uncertain response can mean the relay already ran.
    await new Promise<void>((resolve, reject) => {
      const fail = () =>
        reject(new ServiceUnavailableException('Unable to confirm the door command. Please contact reception.'));
      const req = https.request(
        url,
        {
          method: entityId ? 'POST' : 'GET',
          path: entityId ? '/api/services/' + service : '/api/',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          lookup: ((_host: unknown, opts: { all?: boolean }, cb: any) =>
            opts.all
              ? cb(null, [{ address: target.address, family: target.family }])
              : cb(null, target.address, target.family)) as any,
        },
        (res) => {
          res.resume();
          res.on('error', fail);
          res.on('aborted', fail);
          res.on('end', () => (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? resolve() : fail()));
        },
      );
      const deadline = setTimeout(() => req.destroy(new Error('timeout')), 10_000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', fail);
      req.end(entityId ? JSON.stringify(payload) : undefined);
    });
  }
}
