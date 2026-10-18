import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from './context.js';

export function contextMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  runWithContext(
    { requestId, ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined) ?? null },
    () => next(),
  );
}
