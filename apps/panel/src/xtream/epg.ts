import type { FastifyInstance } from 'fastify';
import { authenticate, liveStreamsForLine } from '../catalog.js';
import { type AppContext, clientIp } from '../context.js';
import { type Db, query, queryOne } from '../db.js';

interface ProgrammeRow {
  id: number;
  channel_id: string;
  start: Date;
  stop: Date;
  title: string;
  description: string | null;
  lang: string;
}

const b64 = (s: string) => Buffer.from(s ?? '', 'utf8').toString('base64');
const sqlDate = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

export async function epgForStream(db: Db, streamId: number, limit: number, full: boolean) {
  const s = await queryOne<{ epg_channel_id: string }>(db, 'SELECT epg_channel_id FROM streams WHERE id = ?', [streamId]);
  if (!s?.epg_channel_id) return [];
  const now = new Date();
  const rows = await query<ProgrammeRow>(
    db,
    `SELECT * FROM epg_programmes WHERE channel_id = ? AND stop > ? ORDER BY start LIMIT ?`,
    [s.epg_channel_id, full ? sqlDate(new Date(now.getTime() - 24 * 3600_000)) : sqlDate(now), limit],
  );
  return rows.map((r) => {
    const start = Math.floor(r.start.getTime() / 1000);
    const stop = Math.floor(r.stop.getTime() / 1000);
    const base = {
      id: String(r.id),
      epg_id: '0',
      title: b64(r.title),
      lang: r.lang,
      start: sqlDate(r.start),
      end: sqlDate(r.stop),
      description: b64(r.description ?? ''),
      channel_id: r.channel_id,
      start_timestamp: String(start),
      stop_timestamp: String(stop),
    };
    if (!full) return base;
    const nowSec = Math.floor(now.getTime() / 1000);
    return { ...base, now_playing: start <= nowSec && stop > nowSec ? 1 : 0, has_archive: 0 };
  });
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Fecha en formato XMLTV: 20261015090000 +0000 */
const xmltvDate = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

export function registerXmltv(app: FastifyInstance, ctx: AppContext) {
  app.get('/xmltv.php', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const auth = await authenticate(ctx.db, q.username ?? '', q.password ?? '', clientIp(req));
    if (!auth || auth.status !== 'Active') return reply.code(403).send('Forbidden');

    const streams = await liveStreamsForLine(ctx.db, auth.line.id);
    const withEpg = streams.filter((s) => s.epg_channel_id);
    const channelIds = [...new Set(withEpg.map((s) => s.epg_channel_id))];

    reply.header('Content-Type', 'application/xml; charset=utf-8');
    const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="ZuiPanel">\n'];
    const seen = new Set<string>();
    for (const s of withEpg) {
      if (seen.has(s.epg_channel_id)) continue;
      seen.add(s.epg_channel_id);
      parts.push(
        `  <channel id="${xmlEscape(s.epg_channel_id)}">\n    <display-name>${xmlEscape(s.name)}</display-name>\n` +
          (s.icon ? `    <icon src="${xmlEscape(s.icon)}" />\n` : '') +
          '  </channel>\n',
      );
    }
    if (channelIds.length) {
      const from = sqlDate(new Date(Date.now() - 24 * 3600_000));
      const to = sqlDate(new Date(Date.now() + 7 * 24 * 3600_000));
      const rows = await query<ProgrammeRow>(
        ctx.db,
        `SELECT * FROM epg_programmes WHERE channel_id IN (?) AND stop > ? AND start < ? ORDER BY channel_id, start`,
        [channelIds, from, to],
      );
      for (const r of rows) {
        parts.push(
          `  <programme start="${xmltvDate(r.start)}" stop="${xmltvDate(r.stop)}" channel="${xmlEscape(r.channel_id)}">\n` +
            `    <title${r.lang ? ` lang="${xmlEscape(r.lang)}"` : ''}>${xmlEscape(r.title)}</title>\n` +
            (r.description ? `    <desc>${xmlEscape(r.description)}</desc>\n` : '') +
            '  </programme>\n',
        );
      }
    }
    parts.push('</tv>\n');
    return reply.send(parts.join(''));
  });
}
