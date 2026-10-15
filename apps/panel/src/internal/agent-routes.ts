import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentConfigResponse, AgentHeartbeat, MediaFileReport, MetricSample, TranscodeOptions } from '@zuipanel/shared';

/** Lo que el panel recuerda de una subida mientras el navegador envía el fichero al nodo. */
export interface UploadMeta {
  serverId: number;
  kind: 'movie' | 'episode';
  name?: string;
  category_id?: number | null;
  series_id?: number;
  season?: number;
  episode_num?: number;
  info?: Record<string, unknown>;
}

/** Muestras guardadas por nodo (una cada 15 s ≈ 90 minutos) */
export const HISTORY_SAMPLES = 360;
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
        input_type: 'pull' | 'push'; stream_key: string | null; record: number;
      }>(
        ctx.db,
        `SELECT s.id, s.name, s.sources, s.on_demand, s.user_agent, tp.options, s.input_type, s.stream_key, s.record
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
          input: s.input_type,
          streamKey: s.stream_key,
          record: !!s.record,
        })),
      };
    });

    r.post('/internal/agent/heartbeat', async (req) => {
      const serverId = (req as unknown as { serverId: number }).serverId;
      const hb = req.body as AgentHeartbeat;
      await execute(ctx.db, 'UPDATE servers SET last_heartbeat = UTC_TIMESTAMP(), status = ? WHERE id = ?', [
        JSON.stringify({
          load: hb.load,
          clients: hb.clients,
          streams: hb.streams,
          cpu: hb.cpu ?? null,
          mem: hb.mem ?? null,
          memTotalMb: hb.memTotalMb ?? null,
          netInMbps: hb.netInMbps ?? 0,
          netOutMbps: hb.netOutMbps ?? 0,
        }),
        serverId,
      ]);
      const sample: MetricSample = {
        t: Date.now(),
        cpu: hb.cpu ?? 0,
        mem: hb.mem ?? 0,
        in: hb.netInMbps ?? 0,
        out: hb.netOutMbps ?? 0,
        clients: hb.clients ?? 0,
      };
      await ctx.redis
        .multi()
        .set(`zp:srv:${serverId}:clients`, String(hb.clients ?? 0), 'EX', ctx.config.serverTimeoutSec * 2)
        .lpush(`zp:srv:${serverId}:hist`, JSON.stringify(sample))
        .ltrim(`zp:srv:${serverId}:hist`, 0, HISTORY_SAMPLES - 1)
        .exec();
      return { ok: true };
    });

    // El nodo terminó de grabar una emisión: se publica como película
    r.post('/internal/agent/recordings', async (req, reply) => {
      const serverId = (req as unknown as { serverId: number }).serverId;
      const b = req.body as MediaFileReport & { streamId: number };
      const stream = await queryOne<{ id: number; name: string; record_category_id: number | null; category_id: number | null }>(
        ctx.db,
        'SELECT id, name, record_category_id, category_id FROM streams WHERE id = ?',
        [Number(b.streamId)],
      );
      if (!stream) return reply.code(404).send({ error: 'canal desconocido' });
      const when = new Intl.DateTimeFormat('es-ES', {
        timeZone: ctx.config.timezone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      }).format(new Date(b.startedAt ?? Date.now()));
      const res = await execute(
        ctx.db,
        `INSERT INTO movies (name, category_id, source_path, container_extension, info, enabled, origin, source_stream_id)
         VALUES (?, ?, ?, ?, ?, 1, 'recording', ?)`,
        [
          `${stream.name} (${when})`,
          stream.record_category_id,
          b.path,
          b.ext || 'mp4',
          JSON.stringify({
            duration_secs: b.durationSec,
            plot: `Grabación de la emisión de ${stream.name} del ${when}.`,
            releasedate: new Date(b.startedAt ?? Date.now()).toISOString().slice(0, 10),
            size_bytes: b.sizeBytes,
          }),
          stream.id,
        ],
      );
      await execute(ctx.db, 'INSERT INTO movie_servers (movie_id, server_id) VALUES (?, ?)', [res.insertId, serverId]);
      // Visible para quien ya ve el directo: entra en los mismos paquetes que el canal
      await execute(
        ctx.db,
        `INSERT IGNORE INTO bouquet_items (bouquet_id, item_type, item_id, sort)
         SELECT bouquet_id, 'movie', ?, 1000000 FROM bouquet_items WHERE item_type = 'live' AND item_id = ?`,
        [res.insertId, stream.id],
      );
      return reply.code(201).send({ movieId: res.insertId });
    });

    // El nodo recibió un vídeo subido desde el panel: se crea la película o el episodio
    r.post('/internal/agent/uploads/:id/complete', async (req, reply) => {
      const serverId = (req as unknown as { serverId: number }).serverId;
      const id = (req.params as { id: string }).id;
      const raw = await ctx.redis.get(`zp:upload:${id}`);
      if (!raw) return reply.code(404).send({ error: 'subida desconocida o caducada' });
      const meta = JSON.parse(raw) as UploadMeta;
      if (meta.serverId !== serverId) return reply.code(403).send({ error: 'la subida es para otro nodo' });
      const b = req.body as MediaFileReport;
      const info = { duration_secs: b.durationSec, size_bytes: b.sizeBytes, ...(meta.info ?? {}) };
      let created: Record<string, unknown>;
      if (meta.kind === 'movie') {
        const res = await execute(
          ctx.db,
          `INSERT INTO movies (name, category_id, source_path, container_extension, info, enabled, origin)
           VALUES (?, ?, ?, ?, ?, 1, 'upload')`,
          [meta.name, meta.category_id ?? null, b.path, b.ext, JSON.stringify(info)],
        );
        await execute(ctx.db, 'INSERT INTO movie_servers (movie_id, server_id) VALUES (?, ?)', [res.insertId, serverId]);
        // Entra en los paquetes que ya tienen películas de la misma categoría
        if (meta.category_id) {
          await execute(
            ctx.db,
            `INSERT IGNORE INTO bouquet_items (bouquet_id, item_type, item_id, sort)
             SELECT DISTINCT bi.bouquet_id, 'movie', ?, 1000000
               FROM bouquet_items bi JOIN movies m ON m.id = bi.item_id
              WHERE bi.item_type = 'movie' AND m.category_id = ? AND m.id <> ?`,
            [res.insertId, meta.category_id, res.insertId],
          );
        }
        created = { type: 'movie', id: res.insertId };
      } else {
        const res = await execute(
          ctx.db,
          `INSERT INTO episodes (series_id, season, episode_num, title, source_path, container_extension, info)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [meta.series_id, meta.season ?? 1, meta.episode_num ?? 1, meta.name ?? '', b.path, b.ext, JSON.stringify(info)],
        );
        await execute(ctx.db, 'INSERT IGNORE INTO series_servers (series_id, server_id) VALUES (?, ?)', [meta.series_id, serverId]);
        created = { type: 'episode', id: res.insertId };
      }
      await ctx.redis.del(`zp:upload:${id}`);
      return reply.code(201).send(created);
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
