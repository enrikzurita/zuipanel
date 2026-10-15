import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, listAll, type Session, type Stats, type Stream } from './api';
import { channelState, type ChannelState } from './status';

/** Estado en vivo compartido por la cabecera y el resumen (se refresca cada 5 s). */
export interface Live {
  stats: Stats | null;
  sessions: Session[];
  streams: Stream[];
  channels: Array<{ stream: Stream; state: ChannelState }>;
  onAir: number;
  down: number;
  netIn: number;
  netOut: number;
}

const emptyLive: Live = { stats: null, sessions: [], streams: [], channels: [], onAir: 0, down: 0, netIn: 0, netOut: 0 };
const LiveCtx = createContext<Live>(emptyLive);
export const useLive = () => useContext(LiveCtx);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Live>(emptyLive);
  useEffect(() => {
    let alive = true;
    let streams: Stream[] = [];
    let lastStreams = 0;
    const tick = async () => {
      try {
        if (Date.now() - lastStreams > 15_000) {
          streams = await listAll<Stream>('streams');
          lastStreams = Date.now();
        }
        const [stats, sessions] = await Promise.all([api<Stats>('GET', '/stats'), api<Session[]>('GET', '/connections')]);
        if (!alive) return;
        const channels = streams.map((s) => ({ stream: s, state: channelState(s, stats.servers, sessions) }));
        const online = stats.servers.filter((s) => s.online);
        setLive({
          stats,
          sessions,
          streams,
          channels,
          onAir: channels.filter((c) => c.state.tally === 'air' || c.state.tally === 'wait').length,
          down: channels.filter((c) => c.state.tally === 'fail').length,
          netIn: Math.round(online.reduce((a, s) => a + (s.status?.netInMbps ?? 0), 0) * 10) / 10,
          netOut: Math.round(online.reduce((a, s) => a + (s.status?.netOutMbps ?? 0), 0) * 10) / 10,
        });
      } catch {
        // la cabecera simplemente no se actualiza en este ciclo
      }
    };
    tick();
    const iv = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, []);
  return <LiveCtx.Provider value={live}>{children}</LiveCtx.Provider>;
}

export const fmtMbps = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} Gbps` : `${Math.round(v)} Mbps`);
