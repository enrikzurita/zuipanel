/**
 * Emisión propia de extremo a extremo:
 *   FFmpeg (como OBS/XbotGo) → nginx-rtmp → agente → HLS, grabación → panel
 * y subida de vídeos al nodo. Requiere nginx con el módulo RTMP, ffmpeg y Redis.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { signPayload, signToken, type AgentConfigResponse, type MediaFileReport } from '@zuipanel/shared';
import { buildAgent, type Agent } from '../src/app.js';
import { parseRtmpStat } from '../src/ingest.js';

const RTMP_MODULE = '/usr/lib/nginx/modules/ngx_rtmp_module.so';
const canRun = existsSync(RTMP_MODULE) && spawnSync('nginx', ['-v']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
const SECRET = 'ingest-secret';
const KEY = 'clave-partido-123';
const RTMP_PORT = 19350;
const STAT_PORT = 18088;

let tmp = '';
let panel: FastifyInstance;
let agent: Agent;
let agentUrl = '';
let nginx: ChildProcess;
const recordings: Array<MediaFileReport & { streamId: number }> = [];
const uploads: Array<{ id: string; body: MediaFileReport }> = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(300);
  }
  throw new Error(`Tiempo agotado esperando: ${what}`);
}

function publish(key: string, seconds: number) {
  return spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac',
    '-f', 'flv', `rtmp://127.0.0.1:${RTMP_PORT}/live/${key}`,
  ]);
}

const token = (p: object = {}) =>
  signToken({ l: 1, t: 'live', s: 10, ip: '127.0.0.1', m: 2, k: 'sess-ingest', e: Math.floor(Date.now() / 1000) + 600, ...p }, SECRET);

describe('Emisión propia por RTMP y subidas', { skip: !canRun && 'falta nginx con RTMP o ffmpeg', timeout: 180_000 }, () => {
  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zp-ingest-'));

    panel = Fastify();
    panel.get('/internal/agent/config', async (): Promise<AgentConfigResponse> => ({
      serverId: 1,
      streams: [
        { id: 10, name: 'Partido', sources: [], onDemand: true, userAgent: null, transcode: null, input: 'push', streamKey: KEY, record: true },
      ],
    }));
    panel.post('/internal/agent/heartbeat', async () => ({ ok: true }));
    panel.post('/internal/agent/recordings', async (req) => {
      recordings.push(req.body as MediaFileReport & { streamId: number });
      return { movieId: 1 };
    });
    panel.post('/internal/agent/uploads/:id/complete', async (req, reply) => {
      uploads.push({ id: (req.params as { id: string }).id, body: req.body as MediaFileReport });
      return reply.code(201).send({ type: 'movie', id: 99 });
    });
    await panel.listen({ port: 0, host: '127.0.0.1' });
    const panelUrl = `http://127.0.0.1:${(panel.server.address() as AddressInfo).port}`;

    agent = await buildAgent(
      {
        port: 0, host: '127.0.0.1', serverId: 1, panelUrl, agentKey: 'k', streamSecret: SECRET,
        redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
        hlsDir: join(tmp, 'hls'), ffmpegPath: 'ffmpeg', idleTimeoutSec: 60, stallTimeoutSec: 30, syncIntervalSec: 600,
        lockTokenToIp: true, xAccelPrefix: '',
        ingestRtmp: `rtmp://127.0.0.1:${RTMP_PORT}/live`,
        ingestStatUrl: `http://127.0.0.1:${STAT_PORT}/stat`,
        recordDir: join(tmp, 'grabaciones'), uploadDir: join(tmp, 'subidas'), minRecordSec: 5,
      },
      { logger: false },
    );
    await agent.start();
    agentUrl = `http://127.0.0.1:${(agent.app.server.address() as AddressInfo).port}`;

    // nginx-rtmp con la misma configuración que en producción, apuntando a este agente
    const tpl = await readFile(new URL('../../../deploy/ingest/nginx.conf.tpl', import.meta.url), 'utf8');
    const conf = tpl
      .replace('__LOAD_MODULE__', `load_module ${RTMP_MODULE};`)
      .replace('__AGENT_URL__', agentUrl)
      .replace('listen 1935;', `listen ${RTMP_PORT};`)
      .replace('listen 8088;', `listen ${STAT_PORT};`)
      .replace('user www-data;', '')
      .replace('error_log /dev/stderr warn;', `error_log ${join(tmp, 'nginx-error.log')} warn;`);
    await mkdir(join(tmp, 'nginx', 'logs'), { recursive: true });
    await writeFile(join(tmp, 'nginx', 'nginx.conf'), conf);
    nginx = spawn('nginx', ['-p', join(tmp, 'nginx'), '-c', 'nginx.conf', '-g', `daemon off; pid ${join(tmp, 'nginx.pid')};`], {
      stdio: 'inherit',
    });
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${STAT_PORT}/stat`)).ok;
      } catch {
        return false;
      }
    }, 10_000, 'nginx-rtmp arrancado');
  });

  after(async () => {
    await agent?.stop();
    await panel?.close();
    nginx?.kill('SIGTERM');
    await sleep(500);
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('entiende las estadísticas de nginx-rtmp', () => {
    const xml = `<rtmp><server><application><name>live</name><live>
      <stream><name>abc</name><publishing/><active/></stream>
      <stream><name>solo-lector</name><active/></stream>
    </live></application><application><name>otra</name><live><stream><name>zzz</name><publishing/></stream></live></application></server></rtmp>`;
    assert.deepEqual([...parseRtmpStat(xml)], ['abc']);
  });

  it('sin señal el canal responde "no disponible" y está apagado', async () => {
    const r = await fetch(`${agentUrl}/live/${token()}/10.m3u8`);
    assert.equal(r.status, 503);
    const sp = agent.supervisor.streams.get(10)!;
    assert.equal(sp.running, false);
    assert.equal(sp.status().signal, false);
  });

  it('rechaza publicar con una clave que no existe', async () => {
    const p = publish('clave-falsa', 5);
    const code = await new Promise<number | null>((res) => p.on('exit', res));
    assert.notEqual(code, 0);
  });

  it('al emitir, el canal arranca solo, se ve en HLS y se graba; al parar, la grabación llega al panel', async () => {
    const pub = publish(KEY, 16);
    const sp = agent.supervisor.streams.get(10)!;
    await waitFor(() => sp.signal && sp.running, 15_000, 'señal detectada y canal arrancado');
    assert.equal(sp.status().recording, true);

    const r = await fetch(`${agentUrl}/live/${token()}/10.m3u8`);
    assert.equal(r.status, 200);
    const seg = (await r.text()).split('\n').find((l) => l.startsWith('/hls/'));
    assert.ok(seg);
    const data = Buffer.from(await (await fetch(`${agentUrl}${seg}`)).arrayBuffer());
    assert.equal(data[0], 0x47);

    await new Promise((res) => pub.on('exit', res));
    await waitFor(() => recordings.length > 0, 25_000, 'grabación registrada en el panel');
    const rec = recordings[0];
    assert.equal(rec.streamId, 10);
    assert.match(rec.path, /\.mp4$/);
    assert.ok(!rec.path.includes('.part'), 'debe quedar el MP4 final, no el temporal');
    assert.ok(rec.durationSec >= 8, `duración ${rec.durationSec}`);
    assert.ok(existsSync(rec.path));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', rec.path]).stdout.toString();
    assert.match(probe, /video/);
    assert.match(probe, /audio/);

    await waitFor(() => !sp.signal && !sp.running, 10_000, 'canal apagado al perder la señal');
  });

  it('acepta subidas con permiso firmado, con CORS, y avisa al panel', async () => {
    const src = join(tmp, 'subir.mp4');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', src]);
    const grant = signPayload({ u: 'subida0001', x: 'mp4', e: Math.floor(Date.now() / 1000) + 600 }, SECRET);

    const pre = await fetch(`${agentUrl}/upload/${grant}`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');

    const bad = await fetch(`${agentUrl}/upload/x.y`, { method: 'PUT', body: 'hola' });
    assert.equal(bad.status, 403);

    const res = await fetch(`${agentUrl}/upload/${grant}`, {
      method: 'PUT',
      body: await readFile(src),
      headers: { 'content-type': 'video/mp4' },
    });
    assert.equal(res.status, 201, await res.clone().text());
    assert.deepEqual(await res.json(), { type: 'movie', id: 99 });
    assert.equal(uploads[0].id, 'subida0001');
    assert.equal(uploads[0].body.durationSec, 3);
    assert.ok(existsSync(uploads[0].body.path));

    const again = await fetch(`${agentUrl}/upload/${grant}`, { method: 'PUT', body: 'x' });
    assert.equal(again.status, 409);
  });
});
