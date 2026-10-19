import 'reflect-metadata';
import type { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { contextMiddleware } from './common/context.middleware.js';
import { config } from './config.js';
import { DbService } from './db/db.service.js';

const LEVELS: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];

export async function createApp() {
  const c = config();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: LEVELS.slice(0, LEVELS.indexOf(c.LOG_LEVEL) + 1),
    bodyParser: false,
    // Keep the raw body for Stripe webhook signature checks (req.rawBody).
    rawBody: true,
  });
  app.set('trust proxy', c.TRUST_PROXY);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });
  app.use(contextMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: c.isProduction ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
    }),
  );
  app.use(cookieParser());
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({ origin: c.WEB_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.get(DbService).assertSafeRole();
  return app;
}

