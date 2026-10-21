import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ERROR_CODES } from '@pms/shared';

export const notFound = (entity: string) => new NotFoundException({ code: 'NOT_FOUND', message: `${entity} not found` });
export const invalidState = (message: string) => new ConflictException({ code: ERROR_CODES.INVALID_STATE, message });
export const conflict = (code: string, message: string, details?: unknown) => new ConflictException({ code, message, details });
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new ForbiddenException({ code: 'FORBIDDEN', message });
export const unprocessable = (message: string, details?: unknown) =>
  new UnprocessableEntityException({ code: 'VALIDATION', message, details });

/** Maps PostgreSQL constraint errors to clean HTTP errors. */
export function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}
export function pgConstraint(err: unknown): string | undefined {
  const e = err as { constraint?: string; cause?: { constraint?: string } };
  return e?.constraint ?? e?.cause?.constraint;
}
export const PG_UNIQUE = '23505';
export const PG_EXCLUSION = '23P01';
export const PG_FK = '23503';
