import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sessionId, signToken, type ContentType } from '@zuipanel/shared';
import { allowedOutputs, authenticate, lineCanAccess } from '../catalog.js';
import { type AppContext, clientIp } from '../context.js';
import { query, queryOne } from '../db.js';

type Kind = 'live' | 'movie' | 'episode';

interface ServerRow {
  id: number;
  public_url: string;
  max_clients: number;
}

/** Elige el nodo sano con menos clientes entre los asignados a ese contenido. */
export async function pickServer(ctx: AppContext, kind: Kind, itemId: number): Promise<ServerRow | null> {
  let join: string;
  let id = itemId;
  if (kind === 'live') join = 'JOIN stream_servers x ON x.server_id = s.id AND x.stream_id = ?';
  else if (kind === 'movie') join = 'JOIN movie_servers x ON x.server_id = s.id AND x.movie_id = ?';
  else {
    const ep = await queryOne<{ series_id: number }>(ctx.db, 'SELECT series_id FROM episodes WHERE id = ?', [itemId]);
    if (!ep) return null;
    id = ep.series_id;
    join = 'JOIN series_servers x ON x.server_id = s.id AND x.series_id = ?';
  }
  const servers = await query<ServerRow>(
    ctx.db,
    `SELECT s.id, s.public_url, s.max_clients FROM servers s ${join}
      WHERE s.enabled = 1 AND s.last_heartbeat > (UTC_TIMESTAMP() - INTERVAL ? SECOND)`,
    [id, ctx.config.serverTimeoutSec],
  );
  if (!servers.length) return null;
  const loads = await Promise.all(servers.map((s) => ctx.redis.get(`zp:srv:${s.id}:clients`)));
  let best: ServerRow | null = null;
  let bestLoad = Infinity;
  servers.forEach((s, i) => {
    const load = Number(loads[i] ?? 0);
    if (s.max_clients > 0 && load >= s.max_clients) return;
    if (load < bestLoad) {
      best = s;
      bestLoad = load;
    }
  });
  return best;
}

function parseFile(file: string): { id: number; ext: string } | null {
  const m = /^(\d+)(?:\.([a-z0-9]{1,5}))?$/i.exec(file);
  if (!m) return null;
  return { id: Number(m[1]), ext: (m[2] ?? '').toLowerCase() };
}

async function handle(ctx: AppContext, kind: Kind, req: FastifyRequest, reply: FastifyReply) {
  const { u, p, file } = req.params as { u: string; p: string; file: string };
  const parsed = parseFile(file);
  if (!parsed) return reply.code(404).send('Not found');

  const ip = clientIp(req);
  const auth = await authenticate(ctx.db, u, p, ip);
  if (!auth) return reply.code(401).send('Unauthorized');
  if (auth.status !== 'Active') return reply.code(403).send(auth.status);
  const { line } = auth;

  let ext = parsed.ext;
  if (kind === 'live') {
    if (!ext) ext = 'ts';
    if (ext === 'hls') ext = 'm3u8';
    if (!['ts', 'm3u8'].includes(ext) || !allowedOutputs(line).includes(ext)) {
      return reply.code(403).send('Output not allowed');
    }
  }

  if (!(await lineCanAccess(ctx.db, line.id, kind, parsed.id))) return reply.code(404).send('Not found');

  const ua = String(req.headers['user-agent'] ?? '');
  const sid = sessionId(line.id, ip, ua);
  if (await ctx.tracker.isKicked(sid)) return reply.code(403).send('Kicked');

  const server = await pickServer(ctx, kind, parsed.id);
  if (!server) return reply.code(503).send('No server available');

  const type: ContentType = kind === 'episode' ? 'series' : kind;
  const ok = await ctx.tracker.acquire(sid, line.max_connections, {
    lineId: line.id,
    username: line.username,
    type,
    itemId: parsed.id,
    ip,
    userAgent: ua,
    serverId: server.id,
  });
  if (!ok) return reply.code(403).send('Max connections reached');

  const token = signToken(
    {
      l: line.id,
      t: type,
      s: parsed.id,
      ip,
      m: line.max_connections,
      k: sid,
      e: Math.floor(Date.now() / 1000) + ctx.config.tokenTtl,
    },
    ctx.config.streamSecret,
  );
  const prefix = kind === 'episode' ? 'series' : kind;
  const target = `${server.public_url.replace(/\/$/, '')}/${prefix}/${token}/${parsed.id}${ext ? '.' + ext : ''}`;
  return reply.redirect(target, 302);
}

export function registerStreamRoutes(app: FastifyInstance, ctx: AppContext) {
  const route = (path: string, kind: Kind) => {
    app.route({
      method: ['GET', 'HEAD'],
      url: path,
      handler: (req, reply) => handle(ctx, kind, req, reply),
    });
  };
  route('/live/:u/:p/:file', 'live');
  route('/movie/:u/:p/:file', 'movie');
  route('/series/:u/:p/:file', 'episode');
  // Formato antiguo de Xtream: http://host/usuario/contraseña/123
  route('/:u/:p/:file', 'live');
}
