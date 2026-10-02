import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { IllegalTransitionError } from '@nexora/shared';
import { config } from './config';
import { AppError } from './lib/errors';
import { clearHandlers } from './lib/bus';
import type { NexoraModule } from './modules/types';
import { authModule } from './modules/auth';
import { opsModule } from './modules/ops';
import { venuesModule } from './modules/venues';
import { bookingModule } from './modules/booking';
import { floorModule } from './modules/floor';
import { guestsModule } from './modules/guests';
import { wifiModule } from './modules/wifi';
import { posModule } from './modules/pos';
import { loyaltyModule } from './modules/loyalty';
import { crmModule } from './modules/crm';

export const MODULES: NexoraModule[] = [
  authModule,
  opsModule,
  venuesModule,
  bookingModule,
  floorModule,
  guestsModule,
  wifiModule,
  posModule,
  loyaltyModule,
  crmModule,
];

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? { level: 'info', transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : false,
    bodyLimit: 1_048_576,
  });

  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(cookie);
  await app.register(jwt, { secret: config.jwtSecret, cookie: { cookieName: config.cookieName, signed: false } });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: err.issues[0]?.message ?? 'Invalid input', details: err.issues },
      });
    }
    if (err instanceof IllegalTransitionError) {
      return reply.status(409).send({ error: { code: 'ILLEGAL_TRANSITION', message: err.message, details: { from: err.from, to: err.to } } });
    }
    // Postgres exclusion violation = overlapping reservation (EXCLUDE constraint backstop).
    if (err?.code === '23P01') {
      return reply.status(409).send({ error: { code: 'SLOT_UNAVAILABLE', message: 'That table is no longer available for this time', details: { alternatives: [] } } });
    }
    if (err?.code === '22P02') {
      return reply.status(400).send({ error: { code: 'INVALID_ID', message: 'Malformed identifier' } });
    }
    if (err?.code === '23505') {
      return reply.status(409).send({ error: { code: 'DUPLICATE', message: 'A record with these details already exists', details: { constraint: err.constraint } } });
    }
    if (err?.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } });
    }
    if (err?.validation || err?.statusCode === 400) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  clearHandlers();
  for (const m of MODULES) m.init?.();

  await app.register(
    async (api) => {
      for (const m of MODULES) await api.register(m.routes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
