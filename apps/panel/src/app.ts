import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { ConnectionTracker } from '@zuipanel/shared';
import { registerAdminRoutes } from './admin/admin-routes.js';
import type { PanelConfig } from './config.js';
import type { AppContext } from './context.js';
import { createDb } from './db.js';
import { registerAgentRoutes } from './internal/agent-routes.js';
import { registerXmltv } from './xtream/epg.js';
import { registerPlayerApi } from './xtream/player-api.js';
import { registerPlaylist } from './xtream/playlist.js';
import { registerStreamRoutes } from './xtream/stream-routes.js';

export async function buildApp(config: PanelConfig, opts: { logger?: boolean } = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const db = createDb(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  const ctx: AppContext = { config, db, redis, tracker: new ConnectionTracker(redis) };

  const app = Fastify({
    logger: opts.logger ?? true,
    // Detrás de nginx/Cloudflare: usa X-Forwarded-For para la IP real
    trustProxy: true,
    // Los clientes IPTV a veces mandan URLs con dobles barras
    routerOptions: { ignoreDuplicateSlashes: true, maxParamLength: 1000 },
  });
  await app.register(formbody);

  app.get('/health', async () => ({ ok: true }));

  // Panel web de gestión (apps/web compilada) en /admin/
  const webDir = process.env.WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/admin/', index: ['index.html'] });
    app.get('/admin', (_req, reply) => reply.redirect('/admin/', 302));
    app.get('/', (_req, reply) => reply.redirect('/admin/', 302));
  } else {
    app.get('/', async () => ({ ok: true, web: 'no compilada: npm run build -w @zuipanel/web' }));
  }
  registerPlayerApi(app, ctx);
  registerPlaylist(app, ctx);
  registerXmltv(app, ctx);
  registerAdminRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  // Al final: incluye la ruta comodín /:usuario/:contraseña/:id
  registerStreamRoutes(app, ctx);

  app.addHook('onClose', async () => {
    await db.end();
    redis.disconnect();
  });
  return { app, ctx };
}
