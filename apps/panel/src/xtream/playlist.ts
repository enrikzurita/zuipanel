import type { FastifyInstance } from 'fastify';
import { allowedOutputs, authenticate, liveStreamsForLine, moviesForLine } from '../catalog.js';
import { type AppContext, clientIp } from '../context.js';
import { query } from '../db.js';

const attr = (s: string | null | undefined) => (s ?? '').replace(/"/g, "'");

export function registerPlaylist(app: FastifyInstance, ctx: AppContext) {
  app.get('/get.php', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const auth = await authenticate(ctx.db, q.username ?? '', q.password ?? '', clientIp(req));
    if (!auth || auth.status !== 'Active') return reply.code(403).send('Forbidden');

    const { line } = auth;
    const plus = (q.type ?? 'm3u_plus') === 'm3u_plus';
    let output = q.output === 'hls' ? 'm3u8' : q.output || 'ts';
    const outputs = allowedOutputs(line);
    if (!outputs.includes(output)) output = outputs.includes('ts') ? 'ts' : outputs[0];

    const base = ctx.config.publicUrl;
    const u = encodeURIComponent(line.username);
    const p = encodeURIComponent(line.password);
    const cats = new Map(
      (await query<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM categories')).map((c) => [c.id, c.name]),
    );
    const group = (id: number | null) => (id != null ? cats.get(id) ?? '' : '');

    const out: string[] = [
      plus ? `#EXTM3U url-tvg="${base}/xmltv.php?username=${u}&password=${p}" x-tvg-url="${base}/xmltv.php?username=${u}&password=${p}"` : '#EXTM3U',
    ];

    for (const s of await liveStreamsForLine(ctx.db, line.id)) {
      out.push(
        plus
          ? `#EXTINF:-1 tvg-id="${attr(s.epg_channel_id)}" tvg-name="${attr(s.name)}" tvg-logo="${attr(s.icon)}" group-title="${attr(group(s.category_id))}",${s.name}`
          : `#EXTINF:-1,${s.name}`,
        `${base}/live/${u}/${p}/${s.id}.${output}`,
      );
    }

    if (plus) {
      for (const m of await moviesForLine(ctx.db, line.id)) {
        out.push(
          `#EXTINF:-1 tvg-id="" tvg-name="${attr(m.name)}" tvg-logo="${attr(m.icon)}" group-title="${attr(group(m.category_id))}",${m.name}`,
          `${base}/movie/${u}/${p}/${m.id}.${m.container_extension}`,
        );
      }
      const eps = await query<{
        id: number; season: number; episode_num: number; title: string; container_extension: string;
        series_name: string; cover: string; category_id: number | null;
      }>(
        ctx.db,
        `SELECT e.id, e.season, e.episode_num, e.title, e.container_extension,
                sr.name AS series_name, sr.cover, sr.category_id
           FROM episodes e
           JOIN series sr ON sr.id = e.series_id AND sr.enabled = 1
           JOIN (SELECT bi.item_id, MIN(lb.sort * 1000000 + bi.sort) AS ord
                   FROM line_bouquets lb JOIN bouquet_items bi ON bi.bouquet_id = lb.bouquet_id
                  WHERE lb.line_id = ? AND bi.item_type = 'series' GROUP BY bi.item_id) a ON a.item_id = sr.id
          ORDER BY a.ord, sr.id, e.season, e.episode_num`,
        [line.id],
      );
      for (const e of eps) {
        const name = `${e.series_name} S${String(e.season).padStart(2, '0')} E${String(e.episode_num).padStart(2, '0')}`;
        out.push(
          `#EXTINF:-1 tvg-id="" tvg-name="${attr(name)}" tvg-logo="${attr(e.cover)}" group-title="${attr(group(e.category_id))}",${name}`,
          `${base}/series/${u}/${p}/${e.id}.${e.container_extension}`,
        );
      }
    }

    reply
      .header('Content-Type', 'audio/x-mpegurl; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="playlist_${line.username}.m3u"`);
    return reply.send(out.join('\n') + '\n');
  });
}
