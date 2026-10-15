import type { Server, Session, Stream, StreamStatus } from './api';

export type Tally = 'air' | 'wait' | 'off' | 'fail';

export interface ChannelState {
  tally: Tally;
  label: string;
  detail: string;
  viewers: number;
  status?: StreamStatus;
  serverName?: string;
}

/**
 * Estado de un canal combinando lo que informan los nodos (heartbeat)
 * y las sesiones activas.
 */
export function channelState(
  stream: Stream,
  servers: Array<Server & { online?: boolean }>,
  sessions: Session[],
): ChannelState {
  const viewers = sessions.filter((s) => s.type === 'live' && Number(s.itemId) === stream.id).length;
  if (!stream.enabled) return { tally: 'off', label: 'Desactivado', detail: '', viewers };

  let status: StreamStatus | undefined;
  let serverName: string | undefined;
  let anyOnline = false;
  for (const srv of servers) {
    if (srv.online === false) continue;
    anyOnline = true;
    const st = srv.status?.streams?.find((x) => x.id === stream.id);
    if (st && (!status || st.running)) {
      status = st;
      serverName = srv.name;
    }
  }

  if (!anyOnline) return { tally: 'off', label: 'Sin nodo', detail: 'Ningún nodo en línea', viewers };
  if (!status) {
    return { tally: 'off', label: 'Sin asignar', detail: 'No está en ningún nodo en línea', viewers };
  }
  if (status.running) {
    const backup = status.sourceIndex > 0 ? ` · fuente ${status.sourceIndex + 1}` : '';
    if (status.sourceIndex > 0) {
      return { tally: 'wait', label: 'En respaldo', detail: `${status.video ?? ''}${backup}`, viewers, status, serverName };
    }
    return { tally: 'air', label: 'En emisión', detail: status.video ?? '', viewers, status, serverName };
  }
  if (status.lastError && (!stream.on_demand || viewers > 0)) {
    return { tally: 'fail', label: 'Fallo', detail: status.lastError, viewers, status, serverName };
  }
  if (!stream.on_demand) return { tally: 'wait', label: 'Arrancando', detail: '', viewers, status, serverName };
  return { tally: 'off', label: 'En reposo', detail: 'Arranca cuando alguien lo abre', viewers, status, serverName };
}
