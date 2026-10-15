/**
 * Tests de integración del panel contra MariaDB y Redis reales.
 * Requiere: TEST_DATABASE_URL (BD vacía que se puede borrar) y Redis en REDIS_URL.
 *   TEST_DATABASE_URL=mysql://zp:zp@127.0.0.1:3306/zuipanel_test npm test -w @zuipanel/panel
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import type { FastifyInstance } from 'fastify';
import { verifyPayload, verifyToken } from '@zuipanel/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import type { AppContext } from '../src/context.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'test-stream-secret';
const ADMIN = 'test-admin-token';
const AGENT_KEY = 'test-agent-key';

let app: FastifyInstance;
let ctx: AppContext;

async function resetDb(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  const conn = await mysql.createConnection({ uri: url });
  await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  await conn.end();
}

async function seed() {
  const conn = await mysql.createConnection({ uri: DB_URL!, multipleStatements: true });
  await conn.query(`
    INSERT INTO servers (id, name, public_url, is_main, last_heartbeat) VALUES
      (1, 'main', 'http://s1.example.com:8081', 1, UTC_TIMESTAMP()),
      (2, 'caido', 'http://s2.example.com:8081', 0, UTC_TIMESTAMP() - INTERVAL 1 HOUR);
    INSERT INTO categories (id, type, name, sort) VALUES
      (1, 'live', 'Deportes', 1), (2, 'live', 'Noticias', 2), (3, 'movie', 'Acción', 1), (4, 'series', 'Drama', 1);
    INSERT INTO streams (id, name, category_id, sources, icon, epg_channel_id) VALUES
      (101, 'Canal Deportes', 1, '["http://origen/1.ts"]', 'http://logo/1.png', 'deportes.es'),
      (102, 'Canal Noticias', 2, '["http://origen/2.ts"]', '', ''),
      (103, 'Canal Oculto', 1, '["http://origen/3.ts"]', '', '');
    INSERT INTO stream_servers VALUES (101, 2), (101, 1), (102, 1), (103, 1);
    INSERT INTO movies (id, name, category_id, source_path, container_extension, rating, info) VALUES
      (201, 'Peli Uno', 3, '/media/peli1.mkv', 'mkv', 7.4, '{"plot":"Una peli","duration_secs":5400,"genre":"Acción"}');
    INSERT INTO movie_servers VALUES (201, 1);
    INSERT INTO series (id, name, category_id, cover, rating, info) VALUES
      (301, 'Serie Uno', 4, 'http://cover/s1.jpg', 8.0, '{"plot":"Una serie","genre":"Drama"}');
    INSERT INTO series_servers VALUES (301, 1);
    INSERT INTO episodes (id, series_id, season, episode_num, title, source_path, container_extension) VALUES
      (401, 301, 1, 1, 'Piloto', '/media/s1e1.mp4', 'mp4'),
      (402, 301, 1, 2, '', '/media/s1e2.mp4', 'mp4'),
      (403, 301, 2, 1, 'Vuelta', '/media/s2e1.mp4', 'mp4');
    INSERT INTO bouquets (id, name) VALUES (1, 'Completo');
    INSERT INTO bouquet_items (bouquet_id, item_type, item_id, sort) VALUES
      (1, 'live', 102, 1), (1, 'live', 101, 2), (1, 'movie', 201, 1), (1, 'series', 301, 1);
    INSERT INTO user_lines (id, username, password, max_connections, exp_date) VALUES
      (1, 'pepe', 'secreto', 1, UTC_TIMESTAMP() + INTERVAL 30 DAY),
      (2, 'caducado', 'x', 1, UTC_TIMESTAMP() - INTERVAL 1 DAY),
      (3, 'soloTs', 'y', 2, NULL);
    UPDATE user_lines SET allowed_outputs = '["ts"]' WHERE id = 3;
    INSERT INTO line_bouquets (line_id, bouquet_id) VALUES (1, 1), (2, 1), (3, 1);
    INSERT INTO epg_programmes (channel_id, start, stop, title, description) VALUES
      ('deportes.es', UTC_TIMESTAMP() - INTERVAL 10 MINUTE, UTC_TIMESTAMP() + INTERVAL 50 MINUTE, 'Fútbol: Málaga - Cádiz', 'Directo'),
      ('deportes.es', UTC_TIMESTAMP() + INTERVAL 50 MINUTE, UTC_TIMESTAMP() + INTERVAL 110 MINUTE, 'Resumen', NULL);
  `);
  await conn.end();
}

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

describe('Panel ZuiPanel (API Xtream)', { skip: !DB_URL && 'TEST_DATABASE_URL no definida' }, () => {
  before(async () => {
    await resetDb(DB_URL!);
    await migrate(DB_URL!, undefined, () => {});
    await seed();
    const config = loadConfig({
      DATABASE_URL: DB_URL,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      STREAM_SECRET: SECRET,
      ADMIN_TOKEN: ADMIN,
      AGENT_KEY,
      PUBLIC_URL: 'http://panel.example.com',
    });
    ({ app, ctx } = await buildApp(config, { logger: false }));
    await ctx.redis.flushdb();
  });

  after(async () => {
    await app?.close();
  });

  it('rechaza credenciales incorrectas con auth 0', async () => {
    const r = await get('/player_api.php?username=pepe&password=mal');
    assert.deepEqual(r.json(), { user_info: { auth: 0 } });
  });

  it('autentica y devuelve user_info y server_info', async () => {
    const r = await get('/player_api.php?username=pepe&password=secreto');
    const body = r.json();
    assert.equal(body.user_info.auth, 1);
    assert.equal(body.user_info.status, 'Active');
    assert.equal(body.user_info.max_connections, '1');
    assert.match(body.user_info.exp_date, /^\d+$/);
    assert.deepEqual(body.user_info.allowed_output_formats, ['m3u8', 'ts']);
    assert.equal(body.server_info.url, 'panel.example.com');
    assert.equal(body.server_info.port, '80');
    assert.equal(body.server_info.server_protocol, 'http');
  });

  it('acepta también POST con formulario', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/player_api.php',
      payload: 'username=pepe&password=secreto&action=get_live_categories',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(r.json().length, 2);
  });

  it('marca la línea caducada y no le da contenido', async () => {
    const r = await get('/player_api.php?username=caducado&password=x');
    assert.equal(r.json().user_info.status, 'Expired');
    const s = await get('/player_api.php?username=caducado&password=x&action=get_live_streams');
    assert.deepEqual(s.json(), []);
  });

  it('lista categorías y canales del paquete, en el orden del paquete', async () => {
    const cats = (await get('/player_api.php?username=pepe&password=secreto&action=get_live_categories')).json();
    assert.deepEqual(cats.map((c: { category_name: string }) => c.category_name), ['Deportes', 'Noticias']);
    assert.equal(typeof cats[0].category_id, 'string');

    const streams = (await get('/player_api.php?username=pepe&password=secreto&action=get_live_streams')).json();
    assert.deepEqual(streams.map((s: { stream_id: number }) => s.stream_id), [102, 101]); // 103 no está en el paquete
    const s = streams[1];
    assert.equal(s.stream_type, 'live');
    assert.equal(s.epg_channel_id, 'deportes.es');
    assert.equal(s.category_id, '1');
    assert.equal(s.num, 2);

    const filtered = (await get('/player_api.php?username=pepe&password=secreto&action=get_live_streams&category_id=2')).json();
    assert.deepEqual(filtered.map((x: { stream_id: number }) => x.stream_id), [102]);
  });

  it('devuelve VOD con su info', async () => {
    const vods = (await get('/player_api.php?username=pepe&password=secreto&action=get_vod_streams')).json();
    assert.equal(vods[0].stream_id, 201);
    assert.equal(vods[0].container_extension, 'mkv');
    assert.equal(vods[0].rating_5based, 3.7);
    const info = (await get('/player_api.php?username=pepe&password=secreto&action=get_vod_info&vod_id=201')).json();
    assert.equal(info.info.plot, 'Una peli');
    assert.equal(info.info.duration, '01:30:00');
    assert.equal(info.movie_data.stream_id, 201);
  });

  it('devuelve series con temporadas y episodios', async () => {
    const list = (await get('/player_api.php?username=pepe&password=secreto&action=get_series')).json();
    assert.equal(list[0].series_id, 301);
    const info = (await get('/player_api.php?username=pepe&password=secreto&action=get_series_info&series_id=301')).json();
    assert.deepEqual(info.seasons.map((s: { season_number: number }) => s.season_number), [1, 2]);
    assert.equal(info.episodes['1'].length, 2);
    assert.equal(info.episodes['1'][0].id, '401');
    assert.equal(info.episodes['1'][1].title, 'Serie Uno - S01E02');
    assert.equal(info.info.name, 'Serie Uno');
  });

  it('devuelve EPG corta con textos en base64', async () => {
    const r = (await get('/player_api.php?username=pepe&password=secreto&action=get_short_epg&stream_id=101')).json();
    assert.equal(r.epg_listings.length, 2);
    assert.equal(Buffer.from(r.epg_listings[0].title, 'base64').toString(), 'Fútbol: Málaga - Cádiz');
    const full = (await get('/player_api.php?username=pepe&password=secreto&action=get_simple_data_table&stream_id=101')).json();
    assert.equal(full.epg_listings[0].now_playing, 1);
  });

  it('genera la lista M3U con directos, películas y episodios', async () => {
    const r = await get('/get.php?username=pepe&password=secreto&type=m3u_plus&output=m3u8');
    assert.equal(r.statusCode, 200);
    const text = r.body;
    assert.match(text, /^#EXTM3U url-tvg="http:\/\/panel\.example\.com\/xmltv\.php/);
    assert.match(text, /tvg-id="deportes.es".*group-title="Deportes",Canal Deportes\nhttp:\/\/panel\.example\.com\/live\/pepe\/secreto\/101\.m3u8/);
    assert.match(text, /http:\/\/panel\.example\.com\/movie\/pepe\/secreto\/201\.mkv/);
    assert.match(text, /Serie Uno S02 E01\nhttp:\/\/panel\.example\.com\/series\/pepe\/secreto\/403\.mp4/);
    assert.doesNotMatch(text, /\/103\./);
  });

  it('genera XMLTV', async () => {
    const r = await get('/xmltv.php?username=pepe&password=secreto');
    assert.match(r.body, /<channel id="deportes.es">/);
    assert.match(r.body, /<title>Fútbol: Málaga - Cádiz<\/title>/);
  });

  it('redirige un directo al nodo sano con un token válido', async () => {
    await ctx.redis.flushdb();
    const r = await get('/live/pepe/secreto/101.ts', { 'user-agent': 'TiviMate' });
    assert.equal(r.statusCode, 302);
    const loc = r.headers.location as string;
    const m = /^http:\/\/s1\.example\.com:8081\/live\/([^/]+)\/101\.ts$/.exec(loc);
    assert.ok(m, `redirección inesperada: ${loc}`); // s2 está caído, debe elegir s1
    const v = verifyToken(m[1], SECRET);
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.payload.l, 1);
      assert.equal(v.payload.s, 101);
      assert.equal(v.payload.m, 1);
    }
  });

  it('el mismo dispositivo puede cambiar de canal, otro no entra si no hay conexiones libres', async () => {
    await ctx.redis.flushdb();
    assert.equal((await get('/live/pepe/secreto/101.ts', { 'user-agent': 'TiviMate' })).statusCode, 302);
    assert.equal((await get('/live/pepe/secreto/102.ts', { 'user-agent': 'TiviMate' })).statusCode, 302);
    const other = await get('/live/pepe/secreto/101.ts', { 'user-agent': 'OtraApp' });
    assert.equal(other.statusCode, 403);
    assert.equal(other.body, 'Max connections reached');
    const info = (await get('/player_api.php?username=pepe&password=secreto')).json();
    assert.equal(info.user_info.active_cons, '1');
  });

  it('expulsar una línea libera la conexión', async () => {
    await ctx.redis.flushdb();
    await get('/live/pepe/secreto/101.ts', { 'user-agent': 'TiviMate' });
    const kick = await app.inject({ method: 'DELETE', url: '/admin/api/connections/1', headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(kick.statusCode, 200);
    assert.equal((await get('/live/pepe/secreto/101.ts', { 'user-agent': 'OtraApp' })).statusCode, 302);
    // el dispositivo expulsado queda bloqueado durante la ventana
    assert.equal((await get('/live/pepe/secreto/101.ts', { 'user-agent': 'TiviMate' })).statusCode, 403);
  });

  it('acepta el formato antiguo /usuario/contraseña/id', async () => {
    await ctx.redis.flushdb();
    const r = await get('/pepe/secreto/101', { 'user-agent': 'Vieja' });
    assert.equal(r.statusCode, 302);
    assert.match(r.headers.location as string, /\/live\/[^/]+\/101\.ts$/);
  });

  it('bloquea contenido fuera del paquete, salidas no permitidas y líneas caducadas', async () => {
    await ctx.redis.flushdb();
    assert.equal((await get('/live/pepe/secreto/103.ts')).statusCode, 404);
    assert.equal((await get('/live/soloTs/y/101.m3u8')).statusCode, 403);
    assert.equal((await get('/live/caducado/x/101.ts')).statusCode, 403);
    assert.equal((await get('/live/pepe/mal/101.ts')).statusCode, 401);
  });

  it('redirige películas y episodios', async () => {
    await ctx.redis.flushdb();
    const mv = await get('/movie/pepe/secreto/201.mkv');
    assert.equal(mv.statusCode, 302);
    assert.match(mv.headers.location as string, /^http:\/\/s1\.example\.com:8081\/movie\/[^/]+\/201\.mkv$/);
    const ep = await get('/series/pepe/secreto/402.mp4');
    assert.equal(ep.statusCode, 302);
    assert.match(ep.headers.location as string, /\/series\/[^/]+\/402\.mp4$/);
  });

  describe('API de administración', () => {
    const auth = { authorization: `Bearer ${ADMIN}` };

    it('exige token', async () => {
      assert.equal((await get('/admin/api/lines')).statusCode, 401);
    });

    it('crea, edita y borra una línea y le asigna paquetes', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/admin/api/lines',
        headers: auth,
        payload: { username: 'nuevo', password: 'abc', max_connections: 2, exp_date: '2030-01-01T00:00:00Z', allowed_outputs: ['ts'] },
      });
      assert.equal(created.statusCode, 201);
      const line = created.json();
      assert.deepEqual(line.allowed_outputs, ['ts']);

      const dup = await app.inject({ method: 'POST', url: '/admin/api/lines', headers: auth, payload: { username: 'nuevo', password: 'z' } });
      assert.equal(dup.statusCode, 409);

      const bq = await app.inject({ method: 'PUT', url: `/admin/api/lines/${line.id}/bouquets`, headers: auth, payload: { ids: [1] } });
      assert.equal(bq.statusCode, 200);
      const streams = (await get('/player_api.php?username=nuevo&password=abc&action=get_live_streams')).json();
      assert.equal(streams.length, 2);

      const upd = await app.inject({ method: 'PATCH', url: `/admin/api/lines/${line.id}`, headers: auth, payload: { enabled: false } });
      assert.equal(upd.json().enabled, 0);
      assert.equal((await get('/player_api.php?username=nuevo&password=abc')).json().user_info.status, 'Disabled');

      const del = await app.inject({ method: 'DELETE', url: `/admin/api/lines/${line.id}`, headers: auth });
      assert.equal(del.statusCode, 204);
    });

    it('gestiona el contenido de un paquete', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/admin/api/bouquets/1/items',
        headers: auth,
        payload: { items: [{ type: 'live', id: 101 }, { type: 'live', id: 103 }, { type: 'live', id: 102 }, { type: 'movie', id: 201 }, { type: 'series', id: 301 }] },
      });
      assert.equal(put.statusCode, 200);
      const streams = (await get('/player_api.php?username=pepe&password=secreto&action=get_live_streams')).json();
      assert.deepEqual(streams.map((s: { stream_id: number }) => s.stream_id), [101, 103, 102]);
    });

    it('devuelve estadísticas con estado de servidores', async () => {
      const st = (await get('/admin/api/stats', auth)).json();
      assert.equal(st.streams, 3);
      assert.equal(st.servers.find((s: { id: number }) => s.id === 1).online, true);
      assert.equal(st.servers.find((s: { id: number }) => s.id === 2).online, false);
    });
  });

  describe('Emisión propia, grabaciones y subidas', () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const agent = { 'x-agent-key': AGENT_KEY, 'x-server-id': '1' };
    let pushId = 0;
    let key = '';

    it('un canal de emisión propia recibe clave automáticamente y se puede regenerar', async () => {
      const r = await app.inject({
        method: 'POST', url: '/admin/api/streams', headers: auth,
        payload: { name: 'Partido Cadete', input_type: 'push', sources: [], record: 1, record_category_id: 3, on_demand: 0 },
      });
      assert.equal(r.statusCode, 201, r.body);
      const s = r.json();
      pushId = s.id;
      assert.match(s.stream_key, /^[0-9a-f]{24}$/);
      const regen = await app.inject({ method: 'POST', url: `/admin/api/streams/${pushId}/regenerate-key`, headers: auth });
      key = regen.json().stream_key;
      assert.notEqual(key, s.stream_key);
      const pull = await app.inject({ method: 'POST', url: '/admin/api/streams/101/regenerate-key', headers: auth });
      assert.equal(pull.statusCode, 404);
      await app.inject({ method: 'PUT', url: `/admin/api/streams/${pushId}/servers`, headers: auth, payload: { ids: [1] } });
    });

    it('el nodo recibe el canal como push con su clave', async () => {
      const cfg = (await get('/internal/agent/config', agent)).json();
      const s = cfg.streams.find((x: { id: number }) => x.id === pushId);
      assert.equal(s.input, 'push');
      assert.equal(s.streamKey, key);
      assert.equal(s.record, true);
    });

    it('una grabación terminada se publica como película en su categoría y nodo', async () => {
      const r = await app.inject({
        method: 'POST', url: '/internal/agent/recordings', headers: agent,
        payload: { streamId: pushId, path: '/media/grabaciones/x/20261018-100000.mp4', ext: 'mp4', sizeBytes: 123, durationSec: 5400, startedAt: Date.parse('2026-10-18T08:00:00Z') },
      });
      assert.equal(r.statusCode, 201, r.body);
      const movieId = r.json().movieId;
      const m = (await get(`/admin/api/movies/${movieId}`, auth)).json();
      assert.equal(m.origin, 'recording');
      assert.equal(m.category_id, 3);
      assert.match(m.name, /^Partido Cadete \(18 oct 2026/);
      assert.equal(m.info.duration_secs, 5400);
      assert.deepEqual((await get(`/admin/api/movies/${movieId}/servers`, auth)).json(), [1]);
      const recs = (await get('/admin/api/movies?origin=recording', auth)).json();
      assert.equal(recs.total, 1);
      // el canal no está en ningún paquete todavía: la grabación tampoco
      const before = (await get('/player_api.php?username=pepe&password=secreto&action=get_vod_streams')).json();
      assert.ok(!before.some((x: { stream_id: number }) => x.stream_id === movieId));
      // con el canal en el paquete, la siguiente grabación entra sola
      const items = (await get('/admin/api/bouquets/1/items', auth)).json();
      await app.inject({ method: 'PUT', url: '/admin/api/bouquets/1/items', headers: auth, payload: { items: [...items, { type: 'live', id: pushId }] } });
      const r2 = await app.inject({
        method: 'POST', url: '/internal/agent/recordings', headers: agent,
        payload: { streamId: pushId, path: '/media/grabaciones/x/2.mp4', ext: 'mp4', sizeBytes: 1, durationSec: 60, startedAt: Date.now() },
      });
      const vods = (await get('/player_api.php?username=pepe&password=secreto&action=get_vod_streams')).json();
      assert.ok(vods.some((x: { stream_id: number }) => x.stream_id === r2.json().movieId));
    });

    it('una subida pide permiso al panel, va al nodo y crea la película o el episodio', async () => {
      const bad = await app.inject({ method: 'POST', url: '/admin/api/uploads', headers: auth, payload: { kind: 'movie', name: 'x', filename: 'a.exe', serverId: 1 } });
      assert.equal(bad.statusCode, 400);
      const g = await app.inject({
        method: 'POST', url: '/admin/api/uploads', headers: auth,
        payload: { kind: 'movie', name: 'Final de copa', category_id: 3, filename: 'final.MKV', serverId: 1 },
      });
      assert.equal(g.statusCode, 200, g.body);
      const { uploadId, url } = g.json();
      assert.match(url, /^http:\/\/s1\.example\.com:8081\/upload\/[^/]+$/);
      const grant = verifyPayload<{ u: string; x: string }>(url.split('/upload/')[1], SECRET);
      assert.deepEqual([grant?.u, grant?.x], [uploadId, 'mkv']);

      const wrongNode = await app.inject({
        method: 'POST', url: `/internal/agent/uploads/${uploadId}/complete`, headers: { ...agent, 'x-server-id': '2' },
        payload: { path: '/m/x.mkv', ext: 'mkv', sizeBytes: 1, durationSec: 60 },
      });
      assert.equal(wrongNode.statusCode, 403);
      const done = await app.inject({
        method: 'POST', url: `/internal/agent/uploads/${uploadId}/complete`, headers: agent,
        payload: { path: '/media/subidas/abc.mkv', ext: 'mkv', sizeBytes: 1, durationSec: 60 },
      });
      assert.equal(done.statusCode, 201, done.body);
      const m = (await get(`/admin/api/movies/${done.json().id}`, auth)).json();
      assert.equal(m.name, 'Final de copa');
      const vods = (await get('/player_api.php?username=pepe&password=secreto&action=get_vod_streams')).json();
      assert.ok(vods.some((x: { stream_id: number }) => x.stream_id === done.json().id), 'la subida entra en el paquete de su categoría');
      assert.equal(m.origin, 'upload');
      assert.equal(m.container_extension, 'mkv');
      const again = await app.inject({
        method: 'POST', url: `/internal/agent/uploads/${uploadId}/complete`, headers: agent,
        payload: { path: '/m/x.mkv', ext: 'mkv', sizeBytes: 1, durationSec: 60 },
      });
      assert.equal(again.statusCode, 404);

      const ge = await app.inject({
        method: 'POST', url: '/admin/api/uploads', headers: auth,
        payload: { kind: 'episode', series_id: 301, season: 3, episode_num: 7, name: 'Jornada 7', filename: 'j7.mp4', serverId: 1 },
      });
      const de = await app.inject({
        method: 'POST', url: `/internal/agent/uploads/${ge.json().uploadId}/complete`, headers: agent,
        payload: { path: '/media/subidas/j7.mp4', ext: 'mp4', sizeBytes: 1, durationSec: 90 },
      });
      assert.equal(de.json().type, 'episode');
      const info = (await get('/player_api.php?username=pepe&password=secreto&action=get_series_info&series_id=301')).json();
      assert.equal(info.episodes['3'][0].title, 'Jornada 7');
    });
  });

  describe('API interna de agentes', () => {
    const agent = { 'x-agent-key': AGENT_KEY, 'x-server-id': '1' };

    it('rechaza claves incorrectas', async () => {
      assert.equal((await get('/internal/agent/config', { 'x-agent-key': 'mal', 'x-server-id': '1' })).statusCode, 401);
    });

    it('entrega la configuración de canales del nodo con su perfil', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/admin/api/transcode_profiles',
        headers: { authorization: `Bearer ${ADMIN}` },
        payload: { name: '720p GPU', options: { videoCodec: 'h264_nvenc', height: 720, videoBitrate: '3000k' } },
      });
      await app.inject({
        method: 'PATCH',
        url: '/admin/api/streams/102',
        headers: { authorization: `Bearer ${ADMIN}` },
        payload: { transcode_profile_id: r.json().id, on_demand: false },
      });
      const cfg = (await get('/internal/agent/config', agent)).json();
      assert.deepEqual(cfg.streams.map((s: { id: number }) => s.id).slice(0, 3), [101, 102, 103]);
      const s102 = cfg.streams.find((s: { id: number }) => s.id === 102);
      assert.equal(s102.onDemand, false);
      assert.equal(s102.transcode.videoCodec, 'h264_nvenc');
      assert.deepEqual(s102.sources, ['http://origen/2.ts']);
    });

    it('registra heartbeats y resuelve rutas VOD', async () => {
      const hb = await app.inject({
        method: 'POST',
        url: '/internal/agent/heartbeat',
        headers: agent,
        payload: { serverId: 1, clients: 7, load: [0.5, 0.4, 0.3], streams: [] },
      });
      assert.equal(hb.statusCode, 200);
      assert.equal(await ctx.redis.get('zp:srv:1:clients'), '7');
      const hb2 = await app.inject({
        method: 'POST',
        url: '/internal/agent/heartbeat',
        headers: agent,
        payload: { serverId: 1, clients: 3, load: [0.1], streams: [], cpu: 42.5, mem: 61, netInMbps: 80, netOutMbps: 950 },
      });
      assert.equal(hb2.statusCode, 200);
      const hist = (await get('/admin/api/history', { authorization: `Bearer ${ADMIN}` })).json();
      const last = hist[hist.length - 1];
      assert.equal(last.cpu, 42.5);
      assert.equal(last.out, 950);
      const st = (await get('/admin/api/stats', { authorization: `Bearer ${ADMIN}` })).json();
      assert.equal(st.servers.find((s: { id: number }) => s.id === 1).status.netOutMbps, 950);
      const vod = (await get('/internal/agent/vod/series/401', agent)).json();
      assert.deepEqual(vod, { path: '/media/s1e1.mp4', ext: 'mp4' });
      assert.equal((await get('/internal/agent/vod/movie/999', agent)).statusCode, 404);
    });
  });
});
