import {
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { Public, SkipCsrf, Perms } from "../auth/decorators.js";
import { ctx, requireTenant } from "../common/context.js";
import { safeEqual } from "../common/crypto.js";
import { IdParam, ZBody, ZodPipe } from "../common/zod.js";
import { config } from "../config.js";
import { DbService, type Tx } from "../db/db.service.js";
import { AuditService } from "../db/audit.service.js";
import { doorkeyAccess, reservations, rooms, tenants } from "../db/schema.js";
import { getAccessibleProperty } from "../properties/properties.module.js";
import { doorWindowActive } from "../doors/doors.service.js";
const scope = z
  .object({
    tenantId: z.uuid(),
    roomId: z.uuid(),
    reservationId: z.uuid(),
    version: z.number().int().positive(),
  })
  .strict();
const reader = z
  .object({
    wireId: z.number().int().min(1).max(0xffffffff),
    publicKey: z.string().regex(/^04[0-9a-f]{128}$/i),
    name: z.string().trim().min(1).max(29),
    enabled: z.boolean(),
  })
  .strict();
/** Convert the property's local checkout to epoch seconds, including DST offsets. */
export function checkoutEpoch(date: string, time: string, timezone: string) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let value = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(value))
        .map((p) => [p.type, p.value]),
    );
    const local = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    const delta = target - local;
    if (!delta) return Math.floor(value / 1000);
    value += delta;
  }
  throw new UnprocessableEntityException("Invalid checkout time");
}
@Injectable()
export class DoorKeyService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}
  async manager(path: string, body?: unknown) {
    const c = config();
    if (!c.DOORKEY_MANAGER_URL || !c.DOORKEY_SERVICE_TOKEN)
      throw new ServiceUnavailableException(
        "DoorKey Manager is not configured",
      );
    let r: Response;
    try {
      r = await fetch(c.DOORKEY_MANAGER_URL.replace(/\/$/, "") + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${c.DOORKEY_SERVICE_TOKEN}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
    } catch {
      throw new ServiceUnavailableException("DoorKey Manager unavailable");
    }
    if (!r.ok) {
      if (r.status === 422 || r.status === 409)
        throw new UnprocessableEntityException(
          "Configure a unique room reader before issuing access",
        );
      throw new ServiceUnavailableException("DoorKey request failed");
    }
    return r.json();
  }
  private async room(tx: Tx, id: string) {
    const [r] = await tx.select().from(rooms).where(eq(rooms.id, id));
    if (!r) throw new UnauthorizedException("Room unavailable");
    await getAccessibleProperty(tx, r.propertyId);
    return r;
  }
  private async reservation(tx: Tx, id: string) {
    const [r] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .for("update");
    if (!r) throw new UnauthorizedException("Reservation unavailable");
    const p = await getAccessibleProperty(tx, r.propertyId);
    return { r, p };
  }
  roomConfig(id: string) {
    return this.db.tenant(async (tx) => {
      await this.room(tx, id);
      return this.manager(`/internal/doors/${requireTenant()}/${id}`);
    });
  }
  saveRoom(id: string, b: z.infer<typeof reader>) {
    return this.db.tenant(async (tx) => {
      await this.room(tx, id);
      const result = await this.manager("/internal/doors", {
        tenantId: requireTenant(),
        roomId: id,
        ...b,
      });
      await this.audit.log(tx, "doorkey.reader_configured", "room", id, {
        wireId: b.wireId,
        enabled: b.enabled,
      });
      return result;
    });
  }
  access(id: string) {
    return this.db.tenant(async (tx) => {
      await this.reservation(tx, id);
      const [a] = await tx
        .select()
        .from(doorkeyAccess)
        .where(eq(doorkeyAccess.reservationId, id));
      const devices = await this.manager(
        `/internal/access/${requireTenant()}/${id}`,
      );
      return {
        enabled: a?.enabled ?? false,
        version: a?.version ?? 0,
        ...devices,
      };
    });
  }
  async invite(id: string) {
    // Commit the access record before the Manager calls back into validation.
    const s = await this.db.tenant(async (tx) => {
      const { r, p } = await this.reservation(tx, id);
      if (!r.roomId || !doorWindowActive(r, p))
        throw new UnprocessableEntityException(
          "Check in and assign a room before issuing a phone key",
        );
      const room = await this.room(tx, r.roomId);
      if (!room.active || room.status === "out_of_order")
        throw new UnprocessableEntityException("Room unavailable");
      const [a] = await tx
        .insert(doorkeyAccess)
        .values({
          tenantId: requireTenant(),
          reservationId: id,
          roomId: r.roomId,
        })
        .onConflictDoUpdate({
          target: doorkeyAccess.reservationId,
          set: {
            enabled: true,
            roomId: r.roomId,
            version: sql`case when ${doorkeyAccess.enabled} then ${doorkeyAccess.version} else ${doorkeyAccess.version}+1 end`,
          },
        })
        .returning();
      await this.audit.log(
        tx,
        "doorkey.invitation_requested",
        "reservation",
        id,
      );
      return {
        tenantId: requireTenant(),
        reservationId: id,
        roomId: r.roomId,
        version: a!.version,
      };
    });
    const invite = await this.manager("/internal/invitations", s);
    return {
      ...invite,
      qr: await QRCode.toDataURL(invite.url, { width: 400, margin: 3 }),
    };
  }
  async revoke(id: string, deviceId?: string) {
    await this.db.tenant(async (tx) => {
      await this.reservation(tx, id);
      if (!deviceId)
        await tx
          .update(doorkeyAccess)
          .set({ enabled: false, version: sql`${doorkeyAccess.version}+1` })
          .where(eq(doorkeyAccess.reservationId, id));
      await this.audit.log(
        tx,
        deviceId ? "doorkey.device_revoked" : "doorkey.stay_revoked",
        "reservation",
        id,
        { deviceId },
      );
    });
    // Whole-stay revocation is already effective at validation, even if Manager is temporarily down.
    return this.manager("/internal/revoke", {
      tenantId: requireTenant(),
      reservationId: id,
      ...(deviceId ? { deviceId } : {}),
    });
  }
  async validate(
    body: z.infer<typeof scope>,
    authorization: string | undefined,
  ) {
    const expected = config().DOORKEY_SERVICE_TOKEN;
    if (!expected || !safeEqual(authorization ?? "", `Bearer ${expected}`))
      throw new UnauthorizedException();
    ctx().tenantId = body.tenantId;
    return this.db.tenant(async (tx) => {
      const [tenant] = await tx
        .select()
        .from(tenants)
        .where(
          and(eq(tenants.id, body.tenantId), eq(tenants.status, "active")),
        );
      if (!tenant) throw new UnauthorizedException();
      const { r, p } = await this.reservation(tx, body.reservationId);
      const [a] = await tx
        .select()
        .from(doorkeyAccess)
        .where(eq(doorkeyAccess.reservationId, r.id));
      if (
        !a ||
        !a.enabled ||
        a.version !== body.version ||
        a.roomId !== body.roomId ||
        r.roomId !== body.roomId ||
        !doorWindowActive(r, p)
      )
        throw new UnauthorizedException();
      const room = await this.room(tx, body.roomId);
      if (
        !room.active ||
        room.status === "out_of_order" ||
        room.propertyId !== r.propertyId
      )
        throw new UnauthorizedException();
      return {
        validUntil: checkoutEpoch(r.departure, p.checkOutTime, p.timezone),
      };
    }, body.tenantId);
  }
}
@Controller()
class DoorKeyController {
  constructor(private readonly svc: DoorKeyService) {}
  @Get("rooms/:id/doorkey") @Perms("rooms.manage") room(@IdParam() id: string) {
    return this.svc.roomConfig(id);
  }
  @Put("rooms/:id/doorkey") @Perms("rooms.manage") save(
    @IdParam() id: string,
    @ZBody(reader) b: z.infer<typeof reader>,
  ) {
    return this.svc.saveRoom(id, b);
  }
  @Get("reservations/:id/doorkey")
  @Perms("frontdesk.checkin", "reservations.read")
  access(@IdParam() id: string) {
    return this.svc.access(id);
  }
  @Post("reservations/:id/doorkey/invitations")
  @HttpCode(200)
  @Perms("frontdesk.checkin", "reservations.read")
  invite(@IdParam() id: string) {
    return this.svc.invite(id);
  }
  @Post("reservations/:id/doorkey/revoke")
  @HttpCode(200)
  @Perms("frontdesk.checkin", "reservations.read")
  revoke(@IdParam() id: string) {
    return this.svc.revoke(id);
  }
  @Post("reservations/:id/doorkey/devices/:deviceId/revoke")
  @HttpCode(200)
  @Perms("frontdesk.checkin", "reservations.read")
  revokeDevice(
    @IdParam() id: string,
    @Param("deviceId", new ZodPipe(z.uuid())) d: string,
  ) {
    return this.svc.revoke(id, d);
  }
  @Public()
  @SkipCsrf()
  @Post("internal/doorkey/validate")
  @HttpCode(200)
  validate(@ZBody(scope) b: z.infer<typeof scope>, @Req() req: Request) {
    return this.svc.validate(b, req.headers.authorization);
  }
}
@Module({ controllers: [DoorKeyController], providers: [DoorKeyService] })
export class DoorKeyModule {}
