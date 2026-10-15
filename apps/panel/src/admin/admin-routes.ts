import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { execute, parseJson, query, queryOne } from '../db.js';

interface Resource {
  table: string;
  columns: string[];
  json?: string[];
  dates?: string[];
  search?: string;
  /** Columnas que no se devuelven en listados (p. ej. muy pesadas) */
  hidden?: string[];
}

/** Recursos con CRUD genérico. Las columnas listadas son las únicas editables. */
const RESOURCES: Record<string, Resource> = {
  lines: {
    table: 'user_lines',
    columns: ['username', 'password', 'max_connections', 'exp_date', 'enabled', 'is_trial', 'allowed_outputs', 'allowed_ips', 'notes'],
    json: ['allowed_outputs', 'allowed_ips'],
    dates: ['exp_date'],
    search: 'username',
  },
  categories: { table: 'categories', columns: ['type', 'name', 'parent_id', 'sort'], search: 'name' },
  bouquets: { table: 'bouquets', columns: ['name', 'sort'], search: 'name' },
  servers: { table: 'servers', columns: ['name', 'public_url', 'is_main', 'enabled', 'max_clients'], json: ['status'], search: 'name' },
  transcode_profiles: { table: 'transcode_profiles', columns: ['name', 'options'], json: ['options'], search: 'name' },
  streams: {
    table: 'streams',
    columns: ['name', 'category_id', 'sources', 'icon', 'epg_channel_id', 'on_demand', 'transcode_profile_id', 'user_agent', 'custom_sid', 'enabled', 'sort'],
    json: ['sources'],
    search: 'name',
  },
  movies: {
    table: 'movies',
    columns: ['name', 'category_id', 'source_path', 'container_extension', 'icon', 'tmdb_id', 'rating', 'info', 'enabled', 'sort'],
    json: ['info'],
    search: 'name',
  },
  series: {
    table: 'series',
    columns: ['name', 'category_id', 'cover', 'tmdb_id', 'rating', 'info', 'enabled', 'sort'],
    json: ['info'],
    search: 'name',
  },
  episodes: {
    table: 'episodes',
    columns: ['series_id', 'season', 'episode_num', 'title', 'source_path', 'container_extension', 'info'],
    json: ['info'],
    search: 'title',
  },
};

function toDbValue(res: Resource, col: string, v: unknown): unknown {
  if (v === undefined) return undefined;
  if (res.json?.includes(col)) return v == null ? null : JSON.stringify(v);
  if (res.dates?.includes(col)) {
    if (v == null || v === '') return null;
    const d = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new Error(`Fecha no válida en ${col}`);
    return d;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function fromDb(res: Resource, row: Record<string, unknown>) {
  for (const c of res.json ?? []) if (c in row) row[c] = parseJson(row[c], null);
  return row;
}

function pickBody(res: Resource, body: Record<string, unknown>, allowId: boolean) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (allowId && body.id != null) {
    cols.push('id');
    vals.push(Number(body.id));
  }
  for (const c of res.columns) {
    const v = toDbValue(res, c, body[c]);
    if (v !== undefined) {
      cols.push(c);
      vals.push(v);
    }
  }
  return { cols, vals };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const bad = (reply: FastifyReply, msg: string) => reply.code(400).send({ error: msg });

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.register(
    async (r) => {
      r.addHook('onRequest', async (req, reply) => {
        const h = String(req.headers.authorization ?? '');
        const token = h.startsWith('Bearer ') ? h.slice(7) : '';
        if (!token || !safeEqual(token, ctx.config.adminToken)) return reply.code(401).send({ error: 'unauthorized' });
      });

      r.setErrorHandler((err: Error & { code?: string; statusCode?: number }, _req, reply) => {
        if (err.code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'Ya existe un registro con ese valor' });
        if (err.code?.startsWith('ER_')) return reply.code(400).send({ error: err.message });
        reply.code(err.statusCode ?? 500).send({ error: err.message });
      });

      // ---- CRUD genérico ----
      r.get('/:resource', async (req, reply) => {
        const res = RESOURCES[(req.params as { resource: string }).resource];
        if (!res) return reply.code(404).send({ error: 'recurso desconocido' });
        const q = req.query as Record<string, string>;
        const limit = Math.min(Number(q.limit ?? 100), 1000);
        const offset = Number(q.offset ?? 0);
        const where: string[] = [];
        const params: unknown[] = [];
        if (q.search && res.search) {
          where.push(`${res.search} LIKE ?`);
          params.push(`%${q.search}%`);
        }
        for (const f of ['category_id', 'series_id', 'type']) {
          if (q[f] && (res.columns.includes(f))) {
            where.push(`${f} = ?`);
            params.push(q[f]);
          }
        }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rows = await query<Record<string, unknown>>(
          ctx.db,
          `SELECT * FROM ${res.table} ${w} ORDER BY id LIMIT ? OFFSET ?`,
          [...params, limit, offset],
        );
        const total = await queryOne<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM ${res.table} ${w}`, params);
        return { total: Number(total?.n ?? 0), items: rows.map((row) => fromDb(res, row)) };
      });

      r.get('/:resource/:id', async (req, reply) => {
        const { resource, id } = req.params as { resource: string; id: string };
        const res = RESOURCES[resource];
        if (!res) return reply.code(404).send({ error: 'recurso desconocido' });
        const row = await queryOne<Record<string, unknown>>(ctx.db, `SELECT * FROM ${res.table} WHERE id = ?`, [Number(id)]);
        if (!row) return reply.code(404).send({ error: 'no encontrado' });
        return fromDb(res, row);
      });

      r.post('/:resource', async (req, reply) => {
        const res = RESOURCES[(req.params as { resource: string }).resource];
        if (!res) return reply.code(404).send({ error: 'recurso desconocido' });
        const { cols, vals } = pickBody(res, (req.body ?? {}) as Record<string, unknown>, true);
        if (!cols.length) return bad(reply, 'Cuerpo vacío');
        const result = await execute(
          ctx.db,
          `INSERT INTO ${res.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          vals,
        );
        const row = await queryOne<Record<string, unknown>>(ctx.db, `SELECT * FROM ${res.table} WHERE id = ?`, [result.insertId]);
        return reply.code(201).send(fromDb(res, row!));
      });

      r.patch('/:resource/:id', async (req, reply) => {
        const { resource, id } = req.params as { resource: string; id: string };
        const res = RESOURCES[resource];
        if (!res) return reply.code(404).send({ error: 'recurso desconocido' });
        const { cols, vals } = pickBody(res, (req.body ?? {}) as Record<string, unknown>, false);
        if (!cols.length) return bad(reply, 'Nada que actualizar');
        const result = await execute(
          ctx.db,
          `UPDATE ${res.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
          [...vals, Number(id)],
        );
        if (!result.affectedRows) return reply.code(404).send({ error: 'no encontrado' });
        const row = await queryOne<Record<string, unknown>>(ctx.db, `SELECT * FROM ${res.table} WHERE id = ?`, [Number(id)]);
        return fromDb(res, row!);
      });

      r.delete('/:resource/:id', async (req, reply) => {
        const { resource, id } = req.params as { resource: string; id: string };
        const res = RESOURCES[resource];
        if (!res) return reply.code(404).send({ error: 'recurso desconocido' });
        const result = await execute(ctx.db, `DELETE FROM ${res.table} WHERE id = ?`, [Number(id)]);
        if (!result.affectedRows) return reply.code(404).send({ error: 'no encontrado' });
        return reply.code(204).send();
      });

      // ---- Relaciones ----
      const setRelation = async (table: string, ownerCol: string, ownerId: number, otherCol: string, ids: number[], withSort = false) => {
        const conn = await ctx.db.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(`DELETE FROM ${table} WHERE ${ownerCol} = ?`, [ownerId]);
          if (ids.length) {
            const rows = ids.map((id, i) => (withSort ? [ownerId, id, i] : [ownerId, id]));
            const cols = withSort ? `(${ownerCol}, ${otherCol}, sort)` : `(${ownerCol}, ${otherCol})`;
            await conn.query(`INSERT INTO ${table} ${cols} VALUES ?`, [rows]);
          }
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          throw e;
        } finally {
          conn.release();
        }
      };

      const relations: Array<[string, string, string, string, boolean]> = [
        // ruta, tabla, columna dueño, columna relacionada, guarda orden
        ['streams/:id/servers', 'stream_servers', 'stream_id', 'server_id', false],
        ['movies/:id/servers', 'movie_servers', 'movie_id', 'server_id', false],
        ['series/:id/servers', 'series_servers', 'series_id', 'server_id', false],
        ['lines/:id/bouquets', 'line_bouquets', 'line_id', 'bouquet_id', true],
      ];
      for (const [path, table, ownerCol, otherCol, withSort] of relations) {
        r.get(`/${path}`, async (req) => {
          const id = Number((req.params as { id: string }).id);
          const rows = await query<Record<string, number>>(
            ctx.db,
            `SELECT ${otherCol} AS id FROM ${table} WHERE ${ownerCol} = ? ${withSort ? 'ORDER BY sort' : ''}`,
            [id],
          );
          return rows.map((x) => x.id);
        });
        r.put(`/${path}`, async (req, reply) => {
          const id = Number((req.params as { id: string }).id);
          const ids = (req.body as { ids?: unknown })?.ids;
          if (!Array.isArray(ids)) return bad(reply, 'Se espera { "ids": [..] }');
          await setRelation(table, ownerCol, id, otherCol, ids.map(Number), withSort);
          return { ok: true };
        });
      }

      // Contenido de un paquete: { items: [{ type: "live", id: 1 }, ...] } en orden
      r.get('/bouquets/:id/items', async (req) => {
        const id = Number((req.params as { id: string }).id);
        return query(ctx.db, 'SELECT item_type AS type, item_id AS id FROM bouquet_items WHERE bouquet_id = ? ORDER BY sort', [id]);
      });
      r.put('/bouquets/:id/items', async (req, reply) => {
        const id = Number((req.params as { id: string }).id);
        const items = (req.body as { items?: Array<{ type: string; id: number }> })?.items;
        if (!Array.isArray(items)) return bad(reply, 'Se espera { "items": [{ "type": "live", "id": 1 }] }');
        if (items.some((i) => !['live', 'movie', 'series'].includes(i.type))) return bad(reply, 'type debe ser live, movie o series');
        const conn = await ctx.db.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query('DELETE FROM bouquet_items WHERE bouquet_id = ?', [id]);
          if (items.length) {
            await conn.query('INSERT IGNORE INTO bouquet_items (bouquet_id, item_type, item_id, sort) VALUES ?', [
              items.map((it, i) => [id, it.type, Number(it.id), i]),
            ]);
          }
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          throw e;
        } finally {
          conn.release();
        }
        return { ok: true };
      });

      // ---- Conexiones activas ----
      r.get('/connections', async () => ctx.tracker.listActive());
      r.delete('/connections/:lineId', async (req) => {
        await ctx.tracker.kick(Number((req.params as { lineId: string }).lineId));
        return { ok: true };
      });
      r.delete('/connections/:lineId/:sid', async (req) => {
        const { lineId, sid } = req.params as { lineId: string; sid: string };
        await ctx.tracker.kick(Number(lineId), sid);
        return { ok: true };
      });

      // ---- Resumen ----
      r.get('/stats', async () => {
        const counts = await queryOne<Record<string, number>>(
          ctx.db,
          `SELECT (SELECT COUNT(*) FROM user_lines) AS lines_total,
                  (SELECT COUNT(*) FROM user_lines WHERE enabled = 1 AND (exp_date IS NULL OR exp_date > UTC_TIMESTAMP())) AS lines_active,
                  (SELECT COUNT(*) FROM streams) AS streams,
                  (SELECT COUNT(*) FROM movies) AS movies,
                  (SELECT COUNT(*) FROM series) AS series,
                  (SELECT COUNT(*) FROM episodes) AS episodes`,
        );
        const servers = await query<Record<string, unknown>>(
          ctx.db,
          `SELECT id, name, enabled, last_heartbeat,
                  last_heartbeat > (UTC_TIMESTAMP() - INTERVAL ? SECOND) AS online, status
             FROM servers ORDER BY id`,
          [ctx.config.serverTimeoutSec],
        );
        const connections = (await ctx.tracker.listActive()).length;
        return {
          ...Object.fromEntries(Object.entries(counts ?? {}).map(([k, v]) => [k, Number(v)])),
          connections,
          servers: servers.map((s) => ({ ...s, online: !!s.online, status: parseJson(s.status, null) })),
        };
      });
    },
    { prefix: '/admin/api' },
  );
}
