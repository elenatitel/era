import { Controller, Get, HttpCode, Module, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  availabilitySchema,
  calendarSchema,
  cancelReservationSchema,
  checkInSchema,
  checkOutSchema,
  createReservationSchema,
  isoDate,
  reservationSearchSchema,
  updateReservationSchema,
} from '@pms/shared';
import { IdParam, ZBody, ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { ReservationsService } from './reservations.service.js';

const frontDeskQuery = z.object({ propertyId: z.uuid(), date: isoDate.optional() });

@Controller()
export class ReservationsController {
  constructor(private readonly svc: ReservationsService) {}

  @Get('availability')
  @Perms('reservations.read')
  availability(@ZQuery(availabilitySchema) q: z.infer<typeof availabilitySchema>) {
    return this.svc.searchAvailability(q);
  }

  @Get('reservations')
  @Perms('reservations.read')
  search(@ZQuery(reservationSearchSchema) q: z.infer<typeof reservationSearchSchema>) {
    return this.svc.search(q);
  }

  @Get('reservations/calendar')
  @Perms('reservations.read')
  calendar(@ZQuery(calendarSchema) q: z.infer<typeof calendarSchema>) {
    return this.svc.calendar(q.propertyId, q.from, q.to);
  }

  @Get('reservations/:id')
  @Perms('reservations.read')
  get(@IdParam() id: string) {
    return this.svc.get(id);
  }

  @Get('reservations/:id/free-rooms')
  @Perms('reservations.read')
  freeRooms(@IdParam() id: string) {
    return this.svc.freeRooms(id);
  }

  @Post('reservations')
  @Perms('reservations.create')
  create(@ZBody(createReservationSchema) body: z.infer<typeof createReservationSchema>) {
    return this.svc.create(body);
  }

  @Patch('reservations/:id')
  @Perms('reservations.update')
  update(@IdParam() id: string, @ZBody(updateReservationSchema) body: z.infer<typeof updateReservationSchema>) {
    return this.svc.update(id, body);
  }

  @Post('reservations/:id/cancel')
  @Perms('reservations.cancel')
  @HttpCode(200)
  cancel(@IdParam() id: string, @ZBody(cancelReservationSchema) body: { reason: string | null }) {
    return this.svc.cancel(id, body.reason);
  }

  @Post('reservations/:id/no-show')
  @Perms('reservations.cancel')
  @HttpCode(200)
  noShow(@IdParam() id: string, @ZBody(cancelReservationSchema) body: { reason: string | null }) {
    return this.svc.cancel(id, body.reason, true);
  }

  @Post('reservations/:id/check-in')
  @Perms('frontdesk.checkin')
  @HttpCode(200)
  checkIn(@IdParam() id: string, @ZBody(checkInSchema) body: z.infer<typeof checkInSchema>) {
    return this.svc.checkIn(id, body.roomId, body.allowDirtyRoom);
  }

  @Post('reservations/:id/check-out')
  @Perms('frontdesk.checkout')
  @HttpCode(200)
  checkOut(@IdParam() id: string, @ZBody(checkOutSchema) body: z.infer<typeof checkOutSchema>) {
    return this.svc.checkOut(id, body.allowOpenBalance);
  }

  @Get('front-desk')
  @Perms('reservations.read')
  frontDesk(@ZQuery(frontDeskQuery) q: z.infer<typeof frontDeskQuery>) {
    return this.svc.frontDesk(q.propertyId, q.date);
  }

  @Post('properties/:id/night-audit')
  @Perms('property.manage')
  @HttpCode(200)
  nightAudit(@IdParam() id: string) {
    return this.svc.nightAudit(id);
  }
}

@Module({ controllers: [ReservationsController], providers: [ReservationsService], exports: [ReservationsService] })
export class ReservationsModule {}
