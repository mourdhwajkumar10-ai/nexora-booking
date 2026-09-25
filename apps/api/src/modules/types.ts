import type { FastifyPluginAsync } from 'fastify';

/**
 * A feature module. `routes` is registered under /api/v1. `init` runs once per app build and is
 * where a module subscribes to bus events (lib/bus `on`) and registers background jobs (lib/jobs).
 */
export interface NexoraModule {
  name: string;
  routes: FastifyPluginAsync;
  init?: () => void;
}
