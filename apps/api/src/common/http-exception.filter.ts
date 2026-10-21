import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { maybeCtx } from './context.js';
import { PG_EXCLUSION, PG_FK, PG_UNIQUE, pgErrorCode } from './errors.js';

/** Uniform error envelope. Never leaks stack traces or SQL to clients. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId = maybeCtx()?.requestId;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { code: string; message: string; details?: unknown } = { code: 'INTERNAL', message: 'Internal server error' };

    if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      body = { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response && 'code' in response) {
        const r = response as { code: string; message?: string; details?: unknown };
        body = { code: r.code, message: r.message ?? exception.message, details: r.details };
      } else {
        const message = typeof response === 'string' ? response : ((response as { message?: string }).message ?? exception.message);
        body = { code: HttpStatus[status] ?? 'ERROR', message: Array.isArray(message) ? message.join(', ') : String(message) };
      }
    } else {
      const code = pgErrorCode(exception);
      if (code === PG_UNIQUE) {
        status = HttpStatus.CONFLICT;
        body = { code: 'DUPLICATE', message: 'A record with these values already exists' };
      } else if (code === PG_EXCLUSION) {
        status = HttpStatus.CONFLICT;
        body = { code: 'ROOM_CONFLICT', message: 'The room is already booked for these dates' };
      } else if (code === PG_FK) {
        status = HttpStatus.CONFLICT;
        body = { code: 'IN_USE', message: 'The record is referenced by other data' };
      } else {
        this.logger.error(
          `${req.method} ${req.originalUrl} [${requestId}] ${exception instanceof Error ? exception.stack : String(exception)}`,
        );
      }
    }
    if (status >= 500 && exception instanceof HttpException) this.logger.error(`${req.method} ${req.originalUrl} ${exception.message}`);
    res.status(status).json({ error: body, requestId });
  }
}
