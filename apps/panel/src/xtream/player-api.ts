import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  allowedOutputs,
  authenticate,
  categoriesForLine,
  episodesForSeries,
  lineCanAccess,
  liveStreamsForLine,
  moviesForLine,
  seriesForLine,
  type AuthResult,
  type MovieRow,
  type SeriesRow,
} from '../catalog.js';
import { type AppContext, clientIp, ts } from '../context.js';
import { queryOne, parseJson } from '../db.js';
import { epgForStream } from './epg.js';

type Params = Record<string, string | undefined>;

function params(req: FastifyRequest): Params {
  return { ...(req.query as Params), ...((req.body as Params) ?? {}) };
}

const str = (v: unknown, d = ''): string => (v == null ? d : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function userInfo(auth: AuthResult, activeCons: number) {
  const { line, status } = auth;
  return {
    username: line.username,
    password: line.password,
    message: '',
    auth: 1,
    status,
    exp_date: line.exp_date ? ts(line.exp_date) : null,
    is_trial: String(line.is_trial),
    active_cons: String(activeCons),
    created_at: ts(line.created_at),
    max_connections: String(line.max_connections),
    allowed_output_formats: allowedOutputs(line).filter((f) => f !== 'rtmp'),
  };
}

export function serverInfo(ctx: AppContext) {
  const u = new URL(ctx.config.publicUrl);
  const protocol = u.protocol.replace(':', '');
  const now = new Date();
  const timeNow = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ctx.config.timezone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(now);
  return {
    url: u.hostname,
    port: protocol === 'http' ? u.port || '80' : '80',
    https_port: protocol === 'https' ? u.port || '443' : '443',
    server_protocol: protocol,
    rtmp_port: '1935',
    timezone: ctx.config.timezone,
    timestamp_now: Math.floor(now.getTime() / 1000),
    time_now: timeNow,
    process: true,
  };
}

function rating5(r: unknown): number {
  return Math.round((num(r) / 2) * 10) / 10;
}

function movieInfo(m: MovieRow) {
  const i = (m.info ?? {}) as Record<string, unknown>;
  const durationSecs = num(i.duration_secs);
  return {
    kinopoisk_url: '',
    tmdb_id: m.tmdb_id ? String(m.tmdb_id) : '',
    name: m.name,
    o_name: str(i.o_name, m.name),
    cover_big: str(i.cover_big, m.icon),
    movie_image: m.icon,
    releasedate: str(i.releasedate),
    episode_run_time: str(i.episode_run_time),
    youtube_trailer: str(i.youtube_trailer),
    director: str(i.director),
    actors: str(i.actors ?? i.cast),
    cast: str(i.cast ?? i.actors),
    description: str(i.plot ?? i.description),
    plot: str(i.plot ?? i.description),
    age: str(i.age),
    mpaa_rating: str(i.mpaa_rating),
    rating_count_kinopoisk: 0,
    country: str(i.country),
    genre: str(i.genre),
    backdrop_path: Array.isArray(i.backdrop_path) ? i.backdrop_path : [],
    duration_secs: durationSecs,
    duration: str(i.duration, durationSecs ? new Date(durationSecs * 1000).toISOString().slice(11, 19) : ''),
    bitrate: num(i.bitrate),
    rating: String(m.rating ?? '0'),
  };
}

function seriesListItem(s: SeriesRow, n: number) {
  const i = (s.info ?? {}) as Record<string, unknown>;
  return {
    num: n,
    name: s.name,
    series_id: s.id,
    cover: s.cover,
    plot: str(i.plot),
    cast: str(i.cast),
    director: str(i.director),
    genre: str(i.genre),
    releaseDate: str(i.releaseDate ?? i.releasedate),
    release_date: str(i.releaseDate ?? i.releasedate),
    last_modified: ts(s.last_modified),
    rating: String(s.rating ?? '0'),
    rating_5based: rating5(s.rating),
    backdrop_path: Array.isArray(i.backdrop_path) ? i.backdrop_path : [],
    youtube_trailer: str(i.youtube_trailer),
    tmdb: s.tmdb_id ? String(s.tmdb_id) : '',
    episode_run_time: str(i.episode_run_time),
    category_id: s.category_id != null ? String(s.category_id) : '',
    category_ids: s.category_id != null ? [s.category_id] : [],
  };
}

export async function handlePlayerApi(ctx: AppContext, req: FastifyRequest, reply: FastifyReply) {
  const p = params(req);
  const ip = clientIp(req);
  const auth = await authenticate(ctx.db, str(p.username), str(p.password), ip);
  if (!auth) return reply.send({ user_info: { auth: 0 } });

  const action = p.action;
  const active = auth.status === 'Active';
  const lineId = auth.line.id;
  const categoryId = p.category_id ? num(p.category_id) : undefined;

  switch (action) {
    case undefined:
    case '': {
      const cons = await ctx.tracker.activeCount(lineId);
      return reply.send({ user_info: userInfo(auth, cons), server_info: serverInfo(ctx) });
    }

    case 'get_live_categories':
    case 'get_vod_categories':
    case 'get_series_categories': {
      if (!active) return reply.send([]);
      const type = action === 'get_live_categories' ? 'live' : action === 'get_vod_categories' ? 'movie' : 'series';
      const cats = await categoriesForLine(ctx.db, lineId, type);
      return reply.send(cats.map((c) => ({ category_id: String(c.id), category_name: c.name, parent_id: c.parent_id })));
    }

    case 'get_live_streams': {
      if (!active) return reply.send([]);
      const rows = await liveStreamsForLine(ctx.db, lineId, categoryId);
      return reply.send(
        rows.map((s, i) => ({
          num: i + 1,
          name: s.name,
          stream_type: 'live',
          stream_id: s.id,
          stream_icon: s.icon,
          epg_channel_id: s.epg_channel_id || null,
          added: ts(s.added_at),
          is_adult: 0,
          category_id: s.category_id != null ? String(s.category_id) : '',
          category_ids: s.category_id != null ? [s.category_id] : [],
          custom_sid: s.custom_sid,
          tv_archive: 0,
          direct_source: '',
          tv_archive_duration: 0,
        })),
      );
    }

    case 'get_vod_streams': {
      if (!active) return reply.send([]);
      const rows = await moviesForLine(ctx.db, lineId, categoryId);
      return reply.send(
        rows.map((m, i) => ({
          num: i + 1,
          name: m.name,
          stream_type: 'movie',
          stream_id: m.id,
          stream_icon: m.icon,
          rating: String(m.rating ?? '0'),
          rating_5based: rating5(m.rating),
          tmdb: m.tmdb_id ? String(m.tmdb_id) : '',
          added: ts(m.added_at),
          is_adult: 0,
          category_id: m.category_id != null ? String(m.category_id) : '',
          category_ids: m.category_id != null ? [m.category_id] : [],
          container_extension: m.container_extension,
          custom_sid: '',
          direct_source: '',
        })),
      );
    }

    case 'get_vod_info': {
      const vodId = num(p.vod_id);
      if (!active || !vodId || !(await lineCanAccess(ctx.db, lineId, 'movie', vodId))) return reply.send([]);
      const m = await queryOne<MovieRow>(
        ctx.db,
        'SELECT id, name, category_id, icon, container_extension, tmdb_id, rating, info, added_at FROM movies WHERE id = ? AND enabled = 1',
        [vodId],
      );
      if (!m) return reply.send([]);
      m.info = parseJson<Record<string, unknown> | null>(m.info, null);
      return reply.send({
        info: movieInfo(m),
        movie_data: {
          stream_id: m.id,
          name: m.name,
          title: m.name,
          added: ts(m.added_at),
          category_id: m.category_id != null ? String(m.category_id) : '',
          category_ids: m.category_id != null ? [m.category_id] : [],
          container_extension: m.container_extension,
          custom_sid: '',
          direct_source: '',
        },
      });
    }

    case 'get_series': {
      if (!active) return reply.send([]);
      const rows = await seriesForLine(ctx.db, lineId, categoryId);
      return reply.send(rows.map((s, i) => seriesListItem(s, i + 1)));
    }

    case 'get_series_info': {
      const seriesId = num(p.series_id);
      if (!active || !seriesId || !(await lineCanAccess(ctx.db, lineId, 'series', seriesId))) return reply.send([]);
      const s = await queryOne<SeriesRow>(
        ctx.db,
        'SELECT id, name, category_id, cover, tmdb_id, rating, info, last_modified FROM series WHERE id = ? AND enabled = 1',
        [seriesId],
      );
      if (!s) return reply.send([]);
      s.info = parseJson<Record<string, unknown> | null>(s.info, null);
      const eps = await episodesForSeries(ctx.db, seriesId);
      const seasonsInfo = (Array.isArray(s.info?.seasons) ? s.info!.seasons : []) as Array<Record<string, unknown>>;
      const episodes: Record<string, unknown[]> = {};
      for (const e of eps) {
        const key = String(e.season);
        const ei = (e.info ?? {}) as Record<string, unknown>;
        const durationSecs = num(ei.duration_secs);
        (episodes[key] ??= []).push({
          id: String(e.id),
          episode_num: e.episode_num,
          title: e.title || `${s.name} - S${String(e.season).padStart(2, '0')}E${String(e.episode_num).padStart(2, '0')}`,
          container_extension: e.container_extension,
          info: {
            tmdb_id: ei.tmdb_id ?? '',
            releasedate: str(ei.releasedate),
            plot: str(ei.plot),
            duration_secs: durationSecs,
            duration: str(ei.duration, durationSecs ? new Date(durationSecs * 1000).toISOString().slice(11, 19) : ''),
            movie_image: str(ei.movie_image),
            bitrate: num(ei.bitrate),
            rating: str(ei.rating, '0'),
            season: String(e.season),
          },
          custom_sid: '',
          added: ts(e.added_at),
          season: e.season,
          direct_source: '',
        });
      }
      const seasonNums = [...new Set(eps.map((e) => e.season))];
      const seasons = seasonNums.map((n) => {
        const extra = seasonsInfo.find((x) => num(x.season_number) === n) ?? {};
        return {
          air_date: str(extra.air_date),
          episode_count: episodes[String(n)]?.length ?? 0,
          id: num(extra.id) || n,
          name: str(extra.name, `Temporada ${n}`),
          overview: str(extra.overview),
          season_number: n,
          vote_average: num(extra.vote_average),
          cover: str(extra.cover, s.cover),
          cover_big: str(extra.cover_big, s.cover),
        };
      });
      const listItem = seriesListItem(s, 1);
      const { num: _n, series_id: _sid, ...info } = listItem;
      return reply.send({ seasons, info, episodes });
    }

    case 'get_short_epg':
    case 'get_simple_data_table': {
      const streamId = num(p.stream_id);
      if (!active || !streamId || !(await lineCanAccess(ctx.db, lineId, 'live', streamId))) {
        return reply.send({ epg_listings: [] });
      }
      const full = action === 'get_simple_data_table';
      const limit = full ? 1000 : Math.min(num(p.limit) || 4, 100);
      return reply.send({ epg_listings: await epgForStream(ctx.db, streamId, limit, full) });
    }

    case 'get_all_epg':
      return reply.send({ epg_listings: [] });

    default:
      return reply.send({ user_info: userInfo(auth, await ctx.tracker.activeCount(lineId)), server_info: serverInfo(ctx) });
  }
}

export function registerPlayerApi(app: FastifyInstance, ctx: AppContext) {
  const handler = (req: FastifyRequest, reply: FastifyReply) => handlePlayerApi(ctx, req, reply);
  app.get('/player_api.php', handler);
  app.post('/player_api.php', handler);
  // Algunos clientes usan esta ruta para validar el panel
  app.get('/panel_api.php', async (req, reply) => {
    const p = params(req);
    const auth = await authenticate(ctx.db, str(p.username), str(p.password), clientIp(req));
    if (!auth) return reply.send({ user_info: { auth: 0 } });
    return reply.send({
      user_info: userInfo(auth, await ctx.tracker.activeCount(auth.line.id)),
      server_info: serverInfo(ctx),
      categories: {
        live: (await categoriesForLine(ctx.db, auth.line.id, 'live')).map((c) => ({
          category_id: String(c.id),
          category_name: c.name,
          parent_id: c.parent_id,
        })),
      },
      available_channels: {},
    });
  });
}
