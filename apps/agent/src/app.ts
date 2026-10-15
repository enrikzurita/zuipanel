import { readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import {
  ConnectionTracker,
  verifyToken,
  type AgentConfigResponse,
  type AgentHeartbeat,
  type ContentType,
  type MediaFileReport,
  type StreamTokenPayload,
} from '@zuipanel/shared';
import type { AgentConfig } from './config.js';
import { SEGMENT_PATTERN } from './ffmpeg-args.js';
import { parsePlaylist, rewritePlaylist } from './hls.js';
import { Supervisor, type StreamProcess } from './supervisor.js';
import { SystemMetrics } from './metrics.js';
import { sendFileWithRange } from './vod.js';
import { IngestWatcher } from './ingest.js';
import { Recorder } from './recorder.js';
import { registerUploadRoutes } from './upload.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEARTBEAT_EVERY_MS = 10_000;

export interface Agent {
  app: FastifyInstance;
  supervisor: Supervisor;
  sync(): Promise<void>;
  heartbeat(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function buildAgent(config: AgentConfig, opts: { logger?: boolean } = {}): Promise<Agent> {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  const tracker = new ConnectionTracker(redis);
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: true, routerOptions: { ignoreDuplicateSlashes: true, maxParamLength: 1000 } });
  const log = (m: string) => app.log.info(m);
  const supervisor = new Supervisor({
    hlsDir: config.hlsDir,
    ffmpegPath: config.ffmpegPath,
    idleTimeoutSec: config.idleTimeoutSec,
    stallTimeoutSec: config.stallTimeoutSec,
    log,
  });

  /** Sesiones vistas recientemente en este nodo (para informar de la carga). */
  const recentSessions = new Map<string, number>();
  const noteSession = (sid: string) => recentSessions.set(sid, Date.now());

  const panelFetch = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${config.panelUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-agent-key': config.agentKey,
        'x-server-id': String(config.serverId),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Panel respondió ${res.status} en ${path}`);
    return res.json();
  };

  /** Reintenta una llamada al panel (p. ej. registrar una grabación si el panel se reinicia). */
  async function panelPostWithRetry(path: string, body: unknown, tries = 5) {
    for (let i = 1; ; i++) {
      try {
        return await panelFetch(path, { method: 'POST', body: JSON.stringify(body) });
      } catch (e) {
        if (i >= tries) throw e;
        await sleep(2000 * i);
      }
    }
  }

  const recorder = new Recorder({
    dir: config.recordDir ?? '/media/grabaciones',
    ffmpegPath: config.ffmpegPath,
    minSeconds: config.minRecordSec ?? 30,
    log,
    onFinished: async (streamId: number, report: MediaFileReport) => {
      await panelPostWithRetry('/internal/agent/recordings', { streamId, ...report });
    },
  });
  const ingest = new IngestWatcher(supervisor, recorder, {
    statUrl: config.ingestStatUrl ?? 'http://127.0.0.1:8088/stat',
    rtmpBase: config.ingestRtmp ?? 'rtmp://127.0.0.1:1935/live',
    log,
  });

  async function sync() {
    const cfg = (await panelFetch('/internal/agent/config')) as AgentConfigResponse;
    // Los canales push leen de la entrada RTMP local con su clave
    const streams = cfg.streams.map((s) =>
      s.input === 'push' && s.streamKey ? { ...s, sources: [ingest.sourceFor(s.streamKey)], onDemand: false } : s,
    );
    await supervisor.reconcile(streams);
    await ingest.tick();
  }

  const metrics = new SystemMetrics();
  async function heartbeat() {
    const cutoff = Date.now() - 30_000;
    for (const [sid, t] of recentSessions) if (t < cutoff) recentSessions.delete(sid);
    const [mem, net] = await Promise.all([metrics.memPercent(), metrics.netMbps()]);
    const hb: AgentHeartbeat = {
      serverId: config.serverId,
      clients: recentSessions.size,
      load: loadavg(),
      streams: [...supervisor.streams.values()].map((s) => s.status()),
      cpu: metrics.cpuPercent(),
      mem: mem.percent,
      memTotalMb: mem.totalMb,
      netInMbps: net.inMbps,
      netOutMbps: net.outMbps,
    };
    await panelFetch('/internal/agent/heartbeat', { method: 'POST', body: JSON.stringify(hb) });
  }

  // Caché de rutas VOD que nos da el panel
  const vodCache = new Map<string, { path: string; ext: string; at: number }>();
  async function vodPath(type: 'movie' | 'series', id: number) {
    const key = `${type}:${id}`;
    const hit = vodCache.get(key);
    if (hit && Date.now() - hit.at < 300_000) return hit;
    const r = (await panelFetch(`/internal/agent/vod/${type}/${id}`)) as { path: string; ext: string };
    const v = { ...r, at: Date.now() };
    vodCache.set(key, v);
    return v;
  }

  /** Valida token + límite de conexiones. Devuelve el payload o responde con error. */
  async function authorize(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
    type: ContentType,
    itemId: number,
  ): Promise<StreamTokenPayload | null> {
    const v = verifyToken(token, config.streamSecret, { ip: req.ip, checkIp: config.lockTokenToIp });
    if (!v.ok) {
      reply.code(403).send(`Invalid token (${v.reason})`);
      return null;
    }
    const p = v.payload;
    if (p.t !== type || p.s !== itemId) {
      reply.code(403).send('Token mismatch');
      return null;
    }
    if (!(await heartbeatSession(p, req))) {
      reply.code(403).send('Max connections reached');
      return null;
    }
    return p;
  }

  async function heartbeatSession(p: StreamTokenPayload, req: FastifyRequest): Promise<boolean> {
    if (await tracker.isKicked(p.k)) return false;
    const ok = await tracker.acquire(p.k, p.m, {
      lineId: p.l,
      type: p.t,
      itemId: p.s,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      serverId: config.serverId,
    });
    if (ok) noteSession(p.k);
    return ok;
  }

  const parseFile = (file: string) => {
    const m = /^(\d+)(?:\.([a-z0-9]{1,5}))?$/i.exec(file);
    return m ? { id: Number(m[1]), ext: (m[2] ?? '').toLowerCase() } : null;
  };

  app.get('/health', async () => ({ ok: true, serverId: config.serverId, streams: supervisor.streams.size }));

  // ---- Entrada RTMP: nginx-rtmp pregunta aquí si una clave puede publicar ----
  app.register(async (r) => {
    r.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    r.post('/ingest/publish', async (req, reply) => {
      // Solo el servidor de entrada (red interna) puede llamar aquí
      const remote = req.socket.remoteAddress ?? '';
      if (!/^(::ffff:)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)|^::1$/.test(remote)) {
        return reply.code(403).send('forbidden');
      }
      const b = (req.body ?? {}) as Record<string, string>;
      const key = b.name ?? '';
      if (b.app !== 'live' || !ingest.isValidKey(key)) {
        log(`publicación rechazada (clave desconocida) desde ${b.addr ?? '?'}`);
        return reply.code(403).send('invalid key');
      }
      log(`publicación aceptada para la clave …${key.slice(-4)} desde ${b.addr ?? '?'}`);
      // Arranca el canal sin esperar al siguiente sondeo
      setTimeout(() => void ingest.tick(), 1500);
      return reply.code(200).send('ok');
    });
  });

  // ---- Subidas de vídeo desde el panel ----
  registerUploadRoutes(app, {
    secret: config.streamSecret,
    dir: config.uploadDir ?? '/media/subidas',
    log,
    complete: (uploadId, report) => panelPostWithRetry(`/internal/agent/uploads/${encodeURIComponent(uploadId)}/complete`, report, 3),
  });

  // ---- Directo ----
  app.get('/live/:token/:file', async (req, reply) => {
    const { token, file } = req.params as { token: string; file: string };
    const f = parseFile(file);
    if (!f) return reply.code(404).send('Not found');
    const p = await authorize(req, reply, token, 'live', f.id);
    if (!p) return;
    const sp = await supervisor.ensure(f.id);
    if (!sp) return reply.code(503).send('Stream unavailable');

    if (f.ext === 'm3u8') {
      const text = await readFile(sp.playlistPath, 'utf8');
      const enc = encodeURIComponent(token);
      return reply
        .header('Content-Type', 'application/vnd.apple.mpegurl')
        .header('Cache-Control', 'no-cache')
        .send(rewritePlaylist(text, (seg) => `/hls/${enc}/${f.id}/${seg}`));
    }
    return pipeLiveTs(req, reply, sp, p);
  });

  app.get('/hls/:token/:id/:seg', async (req, reply) => {
    const { token, id, seg } = req.params as { token: string; id: string; seg: string };
    if (!SEGMENT_PATTERN.test(seg)) return reply.code(404).send('Not found');
    const p = await authorize(req, reply, token, 'live', Number(id));
    if (!p) return;
    const sp = supervisor.streams.get(Number(id));
    if (!sp) return reply.code(404).send('Not found');
    sp.touch();
    try {
      const data = await readFile(join(sp.dir, seg));
      return reply.header('Content-Type', 'video/mp2t').header('Cache-Control', 'public, max-age=60').send(data);
    } catch {
      return reply.code(404).send('Segment gone');
    }
  });

  /**
   * Salida .ts continua (lo que piden la mayoría de apps IPTV): se van
   * enviando los segmentos HLS uno tras otro por la misma conexión.
   */
  async function pipeLiveTs(req: FastifyRequest, reply: FastifyReply, sp: StreamProcess, p: StreamTokenPayload) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    let lastSeq = -1;
    let lastNew = Date.now();
    let lastBeat = Date.now();
    while (!closed) {
      sp.touch();
      let pl;
      try {
        pl = parsePlaylist(await readFile(sp.playlistPath, 'utf8'));
      } catch {
        pl = { mediaSequence: 0, segments: [] };
      }
      let segs = pl.segments.filter((s) => s.seq > lastSeq);
      // Al empezar, arrancamos cerca del directo (los dos últimos segmentos)
      if (lastSeq === -1 && segs.length > 2) segs = segs.slice(-2);
      for (const s of segs) {
        if (closed) break;
        try {
          const data = await readFile(join(sp.dir, s.uri.split('/').pop()!));
          if (!res.write(data)) await new Promise<void>((r) => res.once('drain', () => r()));
        } catch {
          // el segmento ya se borró; seguimos con el siguiente
        }
        lastSeq = s.seq;
        lastNew = Date.now();
      }
      if (Date.now() - lastNew > 30_000) break; // la fuente dejó de producir
      if (Date.now() - lastBeat > HEARTBEAT_EVERY_MS) {
        lastBeat = Date.now();
        if (!(await heartbeatSession(p, req))) break; // expulsado o sin conexiones
      }
      await sleep(400);
    }
    if (!res.writableEnded) res.end();
  }

  // ---- VOD (películas y episodios) ----
  const vodRoute = (prefix: 'movie' | 'series') => {
    app.route({
      method: ['GET', 'HEAD'],
      url: `/${prefix}/:token/:file`,
      handler: async (req, reply) => {
        const { token, file } = req.params as { token: string; file: string };
        const f = parseFile(file);
        if (!f) return reply.code(404).send('Not found');
        const p = await authorize(req, reply, token, prefix, f.id);
        if (!p) return;
        let v;
        try {
          v = await vodPath(prefix, f.id);
        } catch {
          return reply.code(404).send('Not found');
        }
        if (config.xAccelPrefix) {
          // nginx sirve el fichero; Node solo autoriza
          return reply.header('X-Accel-Redirect', `${config.xAccelPrefix}${encodeURI(v.path)}`).send();
        }
        return sendFileWithRange(req, reply, v.path, v.ext, () => {
          // Mientras se descarga, mantenemos viva la sesión
          const iv = setInterval(() => heartbeatSession(p, req).catch(() => {}), HEARTBEAT_EVERY_MS);
          let done = false;
          return () => {
            if (done) return;
            done = true;
            clearInterval(iv);
          };
        });
      },
    });
  };
  vodRoute('movie');
  vodRoute('series');

  let syncTimer: NodeJS.Timeout | null = null;
  let hbTimer: NodeJS.Timeout | null = null;

  return {
    app,
    supervisor,
    sync,
    heartbeat,
    async start() {
      const safe = (fn: () => Promise<void>, what: string) => () =>
        fn().catch((e) => app.log.warn(`${what}: ${(e as Error).message}`));
      await safe(sync, 'sync')();
      await safe(heartbeat, 'heartbeat')();
      supervisor.startTimers();
      ingest.start();
      syncTimer = setInterval(safe(sync, 'sync'), config.syncIntervalSec * 1000);
      hbTimer = setInterval(safe(heartbeat, 'heartbeat'), 15_000);
      await app.listen({ port: config.port, host: config.host });
    },
    async stop() {
      if (syncTimer) clearInterval(syncTimer);
      if (hbTimer) clearInterval(hbTimer);
      ingest.stop();
      await recorder.stopAll();
      await supervisor.shutdown();
      await app.close();
      redis.disconnect();
    },
  };
}
