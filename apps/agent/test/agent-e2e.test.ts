/**
 * Prueba de extremo a extremo del agente con FFmpeg real:
 * - un servidor HTTP local emite una fuente MPEG-TS en directo (generada por FFmpeg)
 * - un panel simulado entrega la configuración de canales
 * - el agente arranca el canal bajo demanda, sirve HLS, .ts continuo y VOD con Range
 * Requiere ffmpeg en el PATH y Redis en REDIS_URL.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { signToken, type AgentConfigResponse, type StreamTokenPayload } from '@zuipanel/shared';
import { buildAgent, type Agent } from '../src/app.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const SECRET = 'e2e-secret';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

let source: Server;
let panel: FastifyInstance;
let agent: Agent;
let agentUrl = '';
let tmp = '';
let heartbeats: unknown[] = [];

function token(p: Partial<StreamTokenPayload>) {
  return signToken(
    { l: 1, t: 'live', s: 1, ip: '127.0.0.1', m: 1, k: 'sess-a', e: Math.floor(Date.now() / 1000) + 600, ...p },
    SECRET,
  );
}

describe('Agente de nodo (FFmpeg real)', { skip: !hasFfmpeg && 'ffmpeg no disponible', timeout: 120_000 }, () => {
  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zp-agent-'));
    const r = new Redis(REDIS_URL);
    await r.flushdb();
    r.disconnect();

    // Fuente en directo: cada petición recibe un MPEG-TS a tiempo real
    source = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-re',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1',
      ]);
      ff.stdout.pipe(res);
      req.on('close', () => ff.kill('SIGKILL'));
    });
    await new Promise<void>((r) => source.listen(0, '127.0.0.1', r));
    const srcUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}/live.ts`;

    // Película de prueba
    await writeFile(join(tmp, 'peli.mp4'), Buffer.alloc(100_000, 7));

    panel = Fastify();
    panel.get('/internal/agent/config', async (): Promise<AgentConfigResponse> => ({
      serverId: 1,
      streams: [
        { id: 1, name: 'Remux', sources: ['http://127.0.0.1:1/caida.ts', srcUrl], onDemand: true, userAgent: null, transcode: null },
        {
          id: 2, name: 'Transcode', sources: [srcUrl], onDemand: true, userAgent: null,
          transcode: { videoCodec: 'libx264', preset: 'ultrafast', height: 120, videoBitrate: '300k', audioCodec: 'aac', hlsTime: 2 },
        },
      ],
    }));
    panel.post('/internal/agent/heartbeat', async (req) => {
      heartbeats.push(req.body);
      return { ok: true };
    });
    panel.get('/internal/agent/vod/:type/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id !== '50') return reply.code(404).send({});
      return { path: join(tmp, 'peli.mp4'), ext: 'mp4' };
    });
    await panel.listen({ port: 0, host: '127.0.0.1' });
    const panelUrl = `http://127.0.0.1:${(panel.server.address() as AddressInfo).port}`;

    agent = await buildAgent(
      {
        port: 0, host: '127.0.0.1', serverId: 1, panelUrl, agentKey: 'k', streamSecret: SECRET, redisUrl: REDIS_URL,
        hlsDir: join(tmp, 'hls'), ffmpegPath: 'ffmpeg', idleTimeoutSec: 60, stallTimeoutSec: 30, syncIntervalSec: 600,
        lockTokenToIp: true, xAccelPrefix: '',
      },
      { logger: false },
    );
    await agent.start();
    agentUrl = `http://127.0.0.1:${(agent.app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await agent?.stop();
    await panel?.close();
    source?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('carga la configuración del panel sin arrancar canales bajo demanda', () => {
    assert.equal(agent.supervisor.streams.size, 2);
    assert.equal(agent.supervisor.streams.get(1)!.running, false);
  });

  it('rechaza tokens falsos, de otro canal o de otra IP', async () => {
    assert.equal((await fetch(`${agentUrl}/live/basura.x/1.m3u8`)).status, 403);
    assert.equal((await fetch(`${agentUrl}/live/${token({ s: 2 })}/1.m3u8`)).status, 403);
    assert.equal((await fetch(`${agentUrl}/live/${token({ ip: '1.2.3.4' })}/1.m3u8`)).status, 403);
    assert.equal((await fetch(`${agentUrl}/live/${token({ e: 1 })}/1.m3u8`)).status, 403);
  });

  it('arranca bajo demanda, salta la fuente caída y sirve HLS', async () => {
    const t = token({});
    const r = await fetch(`${agentUrl}/live/${t}/1.m3u8`);
    assert.equal(r.status, 200, await r.clone().text());
    const pl = await r.text();
    assert.match(pl, /#EXTM3U/);
    const seg = pl.split('\n').find((l) => l.startsWith('/hls/'))!;
    assert.ok(seg, pl);
    const sr = await fetch(`${agentUrl}${seg}`);
    assert.equal(sr.status, 200);
    const data = Buffer.from(await sr.arrayBuffer());
    assert.ok(data.length > 1000);
    assert.equal(data[0], 0x47, 'el segmento debe ser MPEG-TS');
    const sp = agent.supervisor.streams.get(1)!;
    assert.equal(sp.sourceIndex, 1, 'debería haber pasado a la segunda fuente');
    assert.match(sp.info.video ?? '', /h264 320x240/);
  });

  it('sirve .ts continuo durante varios segundos', async () => {
    const ac = new AbortController();
    const r = await fetch(`${agentUrl}/live/${token({})}/1.ts`, { signal: ac.signal });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp2t');
    const reader = r.body!.getReader();
    let total = 0;
    let first: Uint8Array | null = null;
    const end = Date.now() + 9000;
    while (Date.now() < end) {
      const { value, done } = await reader.read();
      if (done) break;
      first ??= value;
      total += value.length;
    }
    ac.abort();
    assert.equal(first![0], 0x47);
    assert.ok(total > 50_000, `recibidos ${total} bytes`);
  });

  it('limita conexiones: otro dispositivo de la misma línea no entra', async () => {
    const r = await fetch(`${agentUrl}/live/${token({ k: 'sess-b' })}/1.m3u8`);
    assert.equal(r.status, 403);
  });

  it('transcodifica con libx264 a 120p', async () => {
    const t = token({ s: 2, l: 2, k: 'sess-c' });
    const r = await fetch(`${agentUrl}/live/${t}/2.m3u8`);
    assert.equal(r.status, 200);
    const seg = (await r.text()).split('\n').find((l) => l.startsWith('/hls/'))!;
    const buf = Buffer.from(await (await fetch(`${agentUrl}${seg}`)).arrayBuffer());
    const f = join(tmp, 'probe.ts');
    await writeFile(f, buf);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,height', '-of', 'csv=p=0', f]);
    assert.equal(probe.stdout.toString().trim().split('\n')[0], 'h264,120');
  });

  it('sirve VOD con soporte de Range', async () => {
    const t = token({ t: 'movie', s: 50, l: 3, k: 'sess-d' });
    const full = await fetch(`${agentUrl}/movie/${t}/50.mp4`);
    assert.equal(full.status, 200);
    assert.equal((await full.arrayBuffer()).byteLength, 100_000);
    const part = await fetch(`${agentUrl}/movie/${t}/50.mp4`, { headers: { range: 'bytes=1000-1999' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 1000-1999/100000');
    assert.equal((await part.arrayBuffer()).byteLength, 1000);
    const missing = await fetch(`${agentUrl}/movie/${token({ t: 'movie', s: 51, l: 3, k: 'sess-d' })}/51.mp4`);
    assert.equal(missing.status, 404);
  });

  it('informa al panel de canales y clientes', async () => {
    heartbeats = [];
    await agent.heartbeat();
    const hb = heartbeats[0] as { clients: number; streams: Array<{ id: number; running: boolean }> };
    assert.ok(hb.clients >= 2);
    assert.equal(hb.streams.find((s) => s.id === 1)!.running, true);
  });

  it('para un canal bajo demanda al quedarse sin espectadores', async () => {
    const sp = agent.supervisor.streams.get(2)!;
    await sp.stop();
    assert.equal(sp.running, false);
  });
});
