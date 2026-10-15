import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentConfigResponse, AgentHeartbeat, TranscodeOptions } from '@zuipanel/shared';
import type { AppContext } from '../context.js';
import { execute, parseJson, query, queryOne } from '../db.js';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Endpoints que usan los agentes de nodo. Autenticados con AGENT_KEY. */
export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext) {
  app.register(async (r) => {
    r.addHook('onRequest', async (req, reply) => {
      const key = String(req.headers['x-agent-key'] ?? '');
      if (!key || !safeEqual(key, ctx.config.agentKey)) return reply.code(401).send({ error: 'unauthorized' });
      const sid = Number(req.headers['x-server-id']);
      if (!sid) return reply.code(400).send({ error: 'x-server-id requerido' });
      const srv = await queryOne(ctx.db, 'SELECT id FROM servers WHERE id = ?', [sid]);
      if (!srv) return reply.code(404).send({ error: 'servidor desconocido' });
      (req as unknown as { serverId: number }).serverId = sid;
    });

    r.get('/internal/agent/config', async (req): Promise<AgentConfigResponse> => {
      const serverId = (req as unknown as { serverId: number }).serverId;
      const rows = await query<{
        id: number; name: string; sources: unknown; on_demand: number; user_agent: string | null; options: unknown;
      }>(
        ctx.db,
        `SELECT s.id, s.name, s.sources, s.on_demand, s.user_agent, tp.options
           FROM streams s
           JOIN stream_servers ss ON ss.stream_id = s.id AND ss.server_id = ?
           LEFT JOIN transcode_profiles tp ON tp.id = s.transcode_profile_id
          WHERE s.enabled = 1
          ORDER BY s.id`,
        [serverId],
      );
      return {
        serverId,
        streams: rows.map((s) => ({
          id: s.id,
          name: s.name,
          sources: parseJson<string[]>(s.sources, []),
          onDemand: !!s.on_demand,
          userAgent: s.user_agent,
          transcode: parseJson<TranscodeOptions | null>(s.options, null),
        })),
      };
    });

    r.post('/internal/agent/heartbeat', async (req) => {
      const serverId = (req as unknown as { serverId: number }).serverId;
      const hb = req.body as AgentHeartbeat;
      await execute(ctx.db, 'UPDATE servers SET last_heartbeat = UTC_TIMESTAMP(), status = ? WHERE id = ?', [
        JSON.stringify({ load: hb.load, clients: hb.clients, streams: hb.streams }),
        serverId,
      ]);
      await ctx.redis.set(`zp:srv:${serverId}:clients`, String(hb.clients ?? 0), 'EX', ctx.config.serverTimeoutSec * 2);
      return { ok: true };
    });

    r.get('/internal/agent/vod/:type/:id', async (req, reply) => {
      const serverId = (req as unknown as { serverId: number }).serverId;
      const { type, id } = req.params as { type: string; id: string };
      let row: { source_path: string; container_extension: string } | null = null;
      if (type === 'movie') {
        row = await queryOne(
          ctx.db,
          `SELECT m.source_path, m.container_extension FROM movies m
             JOIN movie_servers ms ON ms.movie_id = m.id AND ms.server_id = ?
            WHERE m.id = ? AND m.enabled = 1`,
          [serverId, Number(id)],
        );
      } else if (type === 'series') {
        row = await queryOne(
          ctx.db,
          `SELECT e.source_path, e.container_extension FROM episodes e
             JOIN series_servers ss ON ss.series_id = e.series_id AND ss.server_id = ?
            WHERE e.id = ?`,
          [serverId, Number(id)],
        );
      }
      if (!row) return reply.code(404).send({ error: 'not found' });
      return { path: row.source_path, ext: row.container_extension };
    });
  });
}
