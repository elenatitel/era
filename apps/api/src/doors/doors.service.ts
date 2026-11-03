import {
  Injectable,
  NotFoundException,
  HttpException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHmac, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { ctx, requireTenant } from '../common/context.js';
import { decrypt, encrypt, randomToken, sha256 } from '../common/crypto.js';
import { DbService, type Tx } from '../db/db.service.js';
import { AuditService } from '../db/audit.service.js';
import {
  doorDevices,
  doorGrants,
  doorIntegrations,
  doorRateLimits,
  doorRooms,
  doorRoutes,
  properties,
  reservations,
  rooms,
  tenants,
} from '../db/schema.js';
import { getAccessibleProperty } from '../properties/properties.module.js';
import { HomeAssistantService } from './homeassistant.service.js';

const COOKIE = 'pms_door';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const denied = () =>
  new UnauthorizedException('Guest key invalid, expired or revoked. Enter your stay PIN or contact reception.');
function cookieOptions(publicId: string) {
  return {
    httpOnly: true,
    secure: config().cookieSecure,
    sameSite: 'strict' as const,
    path: `/api/public/doors/${publicId}`,
    maxAge: MAX_AGE,
  };
}
function localNow(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function doorWindowActive(
  r: { status: string; arrival: string; departure: string },
  p: { timezone: string; checkOutTime: string },
  now = new Date(),
) {
  const local = localNow(p.timezone, now);
  return r.status === 'checked_in' && local >= r.arrival + 'T00:00' && local < r.departure + 'T' + p.checkOutTime;
}

@Injectable()
export class DoorsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly ha: HomeAssistantService,
  ) {}
  private pinMac(roomId: string, pin: string) {
    return createHmac('sha256', Buffer.from(config().ENCRYPTION_KEY, 'base64'))
      .update(`era:door-pin:v1:${roomId}:${pin}`)
      .digest('hex');
  }
  private async room(tx: Tx, id: string) {
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, id));
    if (!room) throw new NotFoundException('Room');
    await getAccessibleProperty(tx, room.propertyId);
    return room;
  }
  private async reservation(tx: Tx, id: string) {
    const [r] = await tx.select().from(reservations).where(eq(reservations.id, id)).for('update');
    if (!r) throw new NotFoundException('Reservation');
    const p = await getAccessibleProperty(tx, r.propertyId);
    return { r, p };
  }
  private async routeFor(tx: Tx, roomId: string) {
    await tx
      .insert(doorRoutes)
      .values({ roomId, tenantId: requireTenant(), publicId: randomToken() })
      .onConflictDoNothing();
    const [route] = await tx
      .select()
      .from(doorRoutes)
      .where(and(eq(doorRoutes.roomId, roomId), eq(doorRoutes.tenantId, requireTenant())));
    if (!route) throw new NotFoundException('Room');
    return route;
  }
  private url(id: string) {
    return config().WEB_ORIGIN + '/door/' + id;
  }
  integration(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const [row] = await tx.select().from(doorIntegrations).where(eq(doorIntegrations.propertyId, propertyId));
      return {
        url: row?.url ?? '',
        enabled: row?.enabled ?? false,
        tokenConfigured: !!row?.tokenEnc,
      };
    });
  }
  saveIntegration(propertyId: string, input: { url: string; enabled: boolean; token?: string }) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const [old] = await tx.select().from(doorIntegrations).where(eq(doorIntegrations.propertyId, propertyId));
      if (!input.token && (!old || old.url !== input.url))
        throw new UnprocessableEntityException('Supply a token when setting or changing the Home Assistant URL');
      const tokenEnc = input.token ? encrypt(input.token) : old!.tokenEnc;
      await tx
        .insert(doorIntegrations)
        .values({
          propertyId,
          tenantId: requireTenant(),
          url: input.url,
          enabled: input.enabled,
          tokenEnc,
        })
        .onConflictDoUpdate({
          target: doorIntegrations.propertyId,
          set: { url: input.url, enabled: input.enabled, tokenEnc },
        });
      if (old && old.url !== input.url)
        await tx
          .update(doorGrants)
          .set({ revokedAt: new Date(), version: sql`${doorGrants.version}+1` })
          .where(sql`${doorGrants.roomId} in (select id from rooms where property_id = ${propertyId})`);
      await this.audit.log(tx, 'door.integration_updated', 'property', propertyId, {
        enabled: input.enabled,
        url: input.url,
      });
      return { url: input.url, enabled: input.enabled, tokenConfigured: true };
    });
  }
  async testIntegration(propertyId: string) {
    const row = await this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const [row] = await tx.select().from(doorIntegrations).where(eq(doorIntegrations.propertyId, propertyId));
      if (!row) throw new UnprocessableEntityException('Save the integration first');
      return row;
    });
    await this.ha.call(row.url, decrypt(row.tokenEnc));
    return { message: 'Connection successful. No door command was sent.' };
  }
  roomConfig(roomId: string) {
    return this.db.tenant(async (tx) => {
      await this.room(tx, roomId);
      const [cfg] = await tx.select().from(doorRooms).where(eq(doorRooms.roomId, roomId));
      const route = await this.routeFor(tx, roomId);
      return {
        entityId: cfg?.entityId ?? '',
        enabled: cfg?.enabled ?? false,
        url: this.url(route.publicId),
        qr: await QRCode.toDataURL(this.url(route.publicId), {
          width: 512,
          margin: 3,
        }),
      };
    });
  }
  saveRoom(roomId: string, input: { entityId: string; enabled: boolean }) {
    return this.db.tenant(async (tx) => {
      await this.room(tx, roomId);
      const [old] = await tx.select().from(doorRooms).where(eq(doorRooms.roomId, roomId)).for('update');
      await tx
        .insert(doorRooms)
        .values({ roomId, tenantId: requireTenant(), ...input })
        .onConflictDoUpdate({ target: doorRooms.roomId, set: input });
      // Actuator changes must not silently give old devices access to new hardware.
      if (old && old.entityId !== input.entityId)
        await tx
          .update(doorGrants)
          .set({ revokedAt: new Date(), version: sql`${doorGrants.version}+1` })
          .where(eq(doorGrants.roomId, roomId));
      await this.routeFor(tx, roomId);
      await this.audit.log(tx, 'door.room_configured', 'room', roomId, {
        entityId: input.entityId,
        enabled: input.enabled,
      });
      return { saved: true };
    });
  }
  access(reservationId: string) {
    return this.db.tenant(async (tx) => {
      const { r } = await this.reservation(tx, reservationId);
      const [grant] = await tx.select().from(doorGrants).where(eq(doorGrants.reservationId, r.id));
      const devices = grant
        ? await tx
            .select({
              id: doorDevices.id,
              name: doorDevices.name,
              createdAt: doorDevices.createdAt,
              lastUsedAt: doorDevices.lastUsedAt,
              expiresAt: doorDevices.expiresAt,
              revokedAt: doorDevices.revokedAt,
              version: doorDevices.version,
            })
            .from(doorDevices)
            .where(eq(doorDevices.grantId, grant.id))
        : [];
      return {
        configured: !!grant,
        revoked: !!grant?.revokedAt,
        roomId: grant?.roomId ?? r.roomId,
        version: grant?.version,
        devices: devices.map((d) => ({
          ...d,
          active: !d.revokedAt && !grant?.revokedAt && d.version === grant?.version && d.expiresAt > new Date(),
        })),
      };
    });
  }
  issue(reservationId: string) {
    return this.db.tenant(async (tx) => {
      const { r } = await this.reservation(tx, reservationId);
      if (!r.roomId || !['confirmed', 'checked_in'].includes(r.status))
        throw new UnprocessableEntityException('Assign a room to an active reservation first');
      const room = await this.room(tx, r.roomId);
      const [integration] = await tx
        .select()
        .from(doorIntegrations)
        .where(eq(doorIntegrations.propertyId, r.propertyId));
      const [cfg] = await tx.select().from(doorRooms).where(eq(doorRooms.roomId, room.id));
      if (!integration?.enabled || !cfg?.enabled || !room.active)
        throw new UnprocessableEntityException('Enable Home Assistant and door access for this room first');
      const route = await this.routeFor(tx, room.id);
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      // Avoid PIN reuse even across historical reservations in the same room.
      const pinMac = this.pinMac(room.id, pin);
      const [collision] = await tx
        .select({ id: doorGrants.id })
        .from(doorGrants)
        .where(and(eq(doorGrants.roomId, room.id), eq(doorGrants.pinMac, pinMac)));
      if (collision) throw new UnprocessableEntityException('Please generate the PIN again');
      await tx
        .insert(doorGrants)
        .values({
          tenantId: requireTenant(),
          reservationId: r.id,
          roomId: room.id,
          pinMac,
        })
        .onConflictDoUpdate({
          target: doorGrants.reservationId,
          set: {
            roomId: room.id,
            pinMac,
            revokedAt: null,
            version: sql`${doorGrants.version}+1`,
          },
        });
      await this.audit.log(tx, 'door.pin_rotated', 'reservation', r.id, {
        roomId: room.id,
      });
      return {
        pin,
        url: this.url(route.publicId),
        message: 'Shown once. Share this PIN with the guests. Access starts after check-in.',
      };
    });
  }
  revoke(reservationId: string, deviceId?: string) {
    return this.db.tenant(async (tx) => {
      const { r } = await this.reservation(tx, reservationId);
      const [g] = await tx.select().from(doorGrants).where(eq(doorGrants.reservationId, r.id));
      if (g) {
        if (deviceId)
          await tx
            .update(doorDevices)
            .set({ revokedAt: new Date() })
            .where(and(eq(doorDevices.id, deviceId), eq(doorDevices.grantId, g.id)));
        else
          await tx
            .update(doorGrants)
            .set({
              revokedAt: new Date(),
              version: sql`${doorGrants.version}+1`,
            })
            .where(eq(doorGrants.id, g.id));
      }
      await this.audit.log(tx, deviceId ? 'door.device_revoked' : 'door.stay_revoked', 'reservation', r.id, {
        deviceId,
      });
      return { revoked: true };
    });
  }
  private async rate(key: string, limit: number, windowMs = 60_000) {
    const bucket = Math.floor(Date.now() / windowMs);
    const [r] = await this.db.db
      .insert(doorRateLimits)
      .values({ key: sha256(key), bucket, attempts: 1 })
      .onConflictDoUpdate({
        target: doorRateLimits.key,
        set: {
          bucket,
          attempts: sql`case when ${doorRateLimits.bucket} = ${bucket} then ${doorRateLimits.attempts}+1 else 1 end`,
        },
      })
      .returning();
    if (r!.attempts > limit) throw new HttpException('Too many attempts. Please wait before trying again.', 429);
    // Bound retention without storing raw IP addresses or PINs.
    if (randomInt(100) === 0)
      await this.db.db
        .delete(doorRateLimits)
        .where(sql`${doorRateLimits.bucket} < ${Math.floor(Date.now() / 60_000) - 2}`);
  }
  private async publicRoute(publicId: string, req: Request) {
    await this.rate('door:ip:' + (req.ip ?? 'unknown'), 60);
    const [row] = await this.db.db
      .select({ tenantId: doorRoutes.tenantId, roomId: doorRoutes.roomId })
      .from(doorRoutes)
      .innerJoin(tenants, eq(tenants.id, doorRoutes.tenantId))
      .where(and(eq(doorRoutes.publicId, publicId), eq(tenants.status, 'active')));
    if (!row) throw denied();
    ctx().tenantId = row.tenantId;
    return row;
  }
  private async active(tx: Tx, grant: typeof doorGrants.$inferSelect, roomId: string) {
    if (grant.revokedAt || grant.roomId !== roomId) throw denied();
    const { r, p } = await this.reservation(tx, grant.reservationId);
    const [live] = await tx.select().from(doorGrants).where(eq(doorGrants.id, grant.id)).for('update');
    if (!live || live.revokedAt || live.version !== grant.version || live.roomId !== roomId) throw denied();
    const room = await this.room(tx, roomId);
    const [cfg] = await tx.select().from(doorRooms).where(eq(doorRooms.roomId, roomId));
    const [integration] = await tx
      .select()
      .from(doorIntegrations)
      .where(eq(doorIntegrations.propertyId, room.propertyId));
    if (
      r.roomId !== roomId ||
      r.propertyId !== room.propertyId ||
      !doorWindowActive(r, p) ||
      !room.active ||
      room.status === 'out_of_order' ||
      !cfg?.enabled ||
      !integration?.enabled
    )
      throw denied();
    return { r, p, room, cfg, integration };
  }
  async activate(publicId: string, pin: string, req: Request, res: Response) {
    const route = await this.publicRoute(publicId, req);
    await this.rate('door:pin:room:' + route.roomId, 10);
    await this.rate('door:pin:ip:' + (req.ip ?? 'unknown'), 20);
    const token = randomToken();
    const result = await this.db.tenant(async (tx) => {
      const [g] = await tx
        .select()
        .from(doorGrants)
        .where(and(eq(doorGrants.roomId, route.roomId), eq(doorGrants.pinMac, this.pinMac(route.roomId, pin))));
      if (!g) throw denied();
      const { room, r, p } = await this.active(tx, g, route.roomId);
      const current = await tx
        .select({ id: doorDevices.id })
        .from(doorDevices)
        .where(
          and(
            eq(doorDevices.grantId, g.id),
            eq(doorDevices.version, g.version),
            isNull(doorDevices.revokedAt),
            gt(doorDevices.expiresAt, new Date()),
          ),
        );
      if (current.length >= 20)
        throw new UnprocessableEntityException('Device limit reached. Please contact reception.');
      const [d] = await tx
        .insert(doorDevices)
        .values({
          tenantId: route.tenantId,
          grantId: g.id,
          tokenHash: sha256(token),
          version: g.version,
          name: (req.headers['user-agent'] ?? 'Guest browser').slice(0, 200),
          expiresAt: new Date(Date.now() + MAX_AGE),
        })
        .returning();
      await this.audit.log(tx, 'door.device_activated', 'reservation', r.id, {
        deviceId: d!.id,
        roomId: room.id,
      });
      return {
        room: room.number,
        property: p.name,
        validUntil: r.departure + ' ' + p.checkOutTime,
        timezone: p.timezone,
      };
    }, route.tenantId);
    res.cookie(COOKIE, token, cookieOptions(publicId));
    return result;
  }
  private async device(tx: Tx, roomId: string, req: Request) {
    const token = req.cookies?.[COOKIE];
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw denied();
    const [d] = await tx
      .select()
      .from(doorDevices)
      .where(eq(doorDevices.tokenHash, sha256(token)));
    if (!d || d.revokedAt || d.expiresAt <= new Date()) throw denied();
    const [g] = await tx.select().from(doorGrants).where(eq(doorGrants.id, d.grantId));
    if (!g || d.version !== g.version) throw denied();
    const active = await this.active(tx, g, roomId);
    const [liveDevice] = await tx.select().from(doorDevices).where(eq(doorDevices.id, d.id)).for('update');
    if (!liveDevice || liveDevice.revokedAt || liveDevice.expiresAt <= new Date() || liveDevice.version !== g.version)
      throw denied();
    return { d: liveDevice, g, ...active };
  }
  async session(publicId: string, req: Request) {
    const route = await this.publicRoute(publicId, req);
    return this.db.tenant(async (tx) => {
      const { room, p, r } = await this.device(tx, route.roomId, req);
      return {
        room: room.number,
        property: p.name,
        validUntil: r.departure + ' ' + p.checkOutTime,
        timezone: p.timezone,
      };
    }, route.tenantId);
  }
  async unlock(publicId: string, req: Request) {
    const route = await this.publicRoute(publicId, req);
    // Separate committed counters prevent repeated hardware calls after a timeout.
    // At most one room command in each five-second bucket, across all devices/replicas.
    await this.db.tenant((tx) => this.device(tx, route.roomId, req), route.tenantId);
    await this.rate('door:unlock:room:' + route.roomId, 1, 5_000);
    await this.rate('door:unlock:minute:' + route.roomId, 10);
    try {
      return await this.db.tenant(async (tx) => {
        const { d, r, room, cfg, integration } = await this.device(tx, route.roomId, req);
        // active() locks the reservation until completion; checkout/room moves serialize.
        await this.ha.call(integration.url, decrypt(integration.tokenEnc), cfg.entityId);
        await tx.update(doorDevices).set({ lastUsedAt: new Date() }).where(eq(doorDevices.id, d.id));
        await this.audit.log(tx, 'door.command_accepted', 'reservation', r.id, {
          roomId: room.id,
          deviceId: d.id,
        });
        return {
          message: 'Unlock command accepted. This does not confirm the physical door position.',
        };
      }, route.tenantId);
    } catch (e) {
      await this.audit.security('door.command_failed', {
        tenantId: route.tenantId,
        metadata: { roomId: route.roomId },
      });
      throw e;
    }
  }
  async forget(publicId: string, req: Request, res: Response) {
    const route = await this.publicRoute(publicId, req);
    const token = req.cookies?.[COOKIE];
    if (typeof token === 'string')
      await this.db.tenant(async (tx) => {
        const [d] = await tx
          .select({ id: doorDevices.id })
          .from(doorDevices)
          .innerJoin(doorGrants, eq(doorGrants.id, doorDevices.grantId))
          .where(and(eq(doorDevices.tokenHash, sha256(token)), eq(doorGrants.roomId, route.roomId)));
        if (d) await tx.update(doorDevices).set({ revokedAt: new Date() }).where(eq(doorDevices.id, d.id));
      }, route.tenantId);
    res.clearCookie(COOKIE, cookieOptions(publicId));
    return { forgotten: true };
  }
}
