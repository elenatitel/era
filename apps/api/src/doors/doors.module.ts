import { Controller, Get, HttpCode, Module, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Perms, Public } from '../auth/decorators.js';
import { IdParam, ZBody, ZodPipe } from '../common/zod.js';
import { DoorsService } from './doors.service.js';
import { entitySchema, haUrlSchema, HomeAssistantService } from './homeassistant.service.js';

const integrationSchema = z
  .object({
    url: haUrlSchema.transform((v) => new URL(v).origin),
    enabled: z.boolean(),
    token: z.string().trim().min(10).max(4096).optional(),
  })
  .strict();
const roomSchema = z.object({ entityId: entitySchema, enabled: z.boolean() }).strict();
const PublicId = () => Param('publicId', new ZodPipe(z.string().regex(/^[\w-]{43}$/)));

@Controller()
class DoorSettingsController {
  constructor(private readonly svc: DoorsService) {}
  @Get('properties/:id/home-assistant')
  @Perms('property.manage')
  integration(@IdParam() id: string) {
    return this.svc.integration(id);
  }
  @Put('properties/:id/home-assistant')
  @Perms('property.manage')
  saveIntegration(@IdParam() id: string, @ZBody(integrationSchema) body: z.infer<typeof integrationSchema>) {
    return this.svc.saveIntegration(id, body);
  }
  @Post('properties/:id/home-assistant/test')
  @HttpCode(200)
  @Perms('property.manage')
  test(@IdParam() id: string) {
    return this.svc.testIntegration(id);
  }
  @Get('rooms/:id/door')
  @Perms('rooms.manage')
  room(@IdParam() id: string) {
    return this.svc.roomConfig(id);
  }
  @Put('rooms/:id/door')
  @Perms('rooms.manage')
  saveRoom(@IdParam() id: string, @ZBody(roomSchema) body: z.infer<typeof roomSchema>) {
    return this.svc.saveRoom(id, body);
  }
  @Get('reservations/:id/door-access')
  @Perms('frontdesk.checkin', 'reservations.read')
  access(@IdParam() id: string) {
    return this.svc.access(id);
  }
  @Post('reservations/:id/door-access/pin')
  @HttpCode(200)
  @Perms('frontdesk.checkin', 'reservations.read')
  issue(@IdParam() id: string) {
    return this.svc.issue(id);
  }
  @Post('reservations/:id/door-access/revoke')
  @HttpCode(200)
  @Perms('frontdesk.checkin', 'reservations.read')
  revoke(@IdParam() id: string) {
    return this.svc.revoke(id);
  }
  @Post('reservations/:id/door-access/devices/:deviceId/revoke')
  @HttpCode(200)
  @Perms('frontdesk.checkin', 'reservations.read')
  revokeDevice(@IdParam() id: string, @Param('deviceId', new ZodPipe(z.uuid())) deviceId: string) {
    return this.svc.revoke(id, deviceId);
  }
}

/** No staff login. Every action authenticates a stay-scoped PIN or device capability.
 * Keep the global same-origin + double-submit CSRF guard on ALL mutations. */
@Public()
@Controller('public/doors')
class GuestDoorsController {
  constructor(private readonly svc: DoorsService) {}
  private noStore(res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  @Post(':publicId/session')
  @HttpCode(200)
  activate(
    @PublicId() id: string,
    @ZBody(z.object({ pin: z.string().regex(/^\d{6}$/) }).strict())
    body: { pin: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.noStore(res);
    return this.svc.activate(id, body.pin, req, res);
  }
  @Get(':publicId/session')
  session(@PublicId() id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.noStore(res);
    return this.svc.session(id, req);
  }
  @Post(':publicId/unlock')
  @HttpCode(200)
  unlock(@PublicId() id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.noStore(res);
    return this.svc.unlock(id, req);
  }
  @Post(':publicId/forget')
  @HttpCode(200)
  forget(@PublicId() id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.noStore(res);
    return this.svc.forget(id, req, res);
  }
}
@Module({
  controllers: [DoorSettingsController, GuestDoorsController],
  providers: [DoorsService, HomeAssistantService],
})
export class DoorsModule {}
