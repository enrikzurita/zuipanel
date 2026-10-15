import { api, listAll, type Movie, type Session, type Stream } from '../api';
import { fmtAgo, fmtDuration, useData, useToast } from '../components/ui';
import { useRefs } from '../refs';

function appName(ua: string): string {
  if (!ua) return 'Desconocida';
  const known = ['TiviMate', 'IPTVSmarters', 'Smarters', 'OTT Navigator', 'VLC', 'Kodi', 'MaxPlayer', 'ExoPlayer', 'AppleCoreMedia', 'Lavf'];
  const hit = known.find((k) => ua.toLowerCase().includes(k.toLowerCase()));
  if (hit === 'AppleCoreMedia') return 'Reproductor de Apple';
  if (hit === 'Lavf') return 'FFmpeg / Lavf';
  return hit ?? ua.split(/[ /]/)[0];
}

export function Connections() {
  const refs = useRefs();
  const toast = useToast();
  const { data, reload } = useData(
    async () => {
      const [sessions, streams, movies] = await Promise.all([
        api<Session[]>('GET', '/connections'),
        listAll<Stream>('streams'),
        listAll<Movie>('movies'),
      ]);
      return { sessions, streams, movies };
    },
    [],
    5000,
  );

  const what = (s: Session) => {
    const id = Number(s.itemId);
    if (s.type === 'live') return data?.streams.find((x) => x.id === id)?.name ?? `Canal #${id}`;
    if (s.type === 'movie') return data?.movies.find((x) => x.id === id)?.name ?? `Película #${id}`;
    return `Episodio #${id}`;
  };
  const server = (id: string) => refs.servers.find((x) => x.id === Number(id))?.name ?? '—';

  const kick = async (s: Session, all: boolean) => {
    await api('DELETE', all ? `/connections/${s.lineId}` : `/connections/${s.lineId}/${s.sid}`);
    toast(all ? `Todos los dispositivos de ${s.username || 'la línea'} desconectados` : 'Dispositivo desconectado');
    reload();
  };

  const sessions = [...(data?.sessions ?? [])].sort((a, b) => Number(a.startedAt) - Number(b.startedAt));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Conexiones</h1>
          <p>Quién está viendo ahora. Un dispositivo deja de contar 30 segundos después de dejar de pedir vídeo.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Línea</th>
              <th>Viendo</th>
              <th>Aplicación</th>
              <th>IP</th>
              <th>Nodo</th>
              <th>Conectado</th>
              <th className="actions" aria-label="Acciones" />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.sid}>
                <td>
                  <b>{s.username || `#${s.lineId}`}</b>
                </td>
                <td>{what(s)}</td>
                <td title={s.userAgent}>{appName(s.userAgent)}</td>
                <td className="mono">{s.ip}</td>
                <td>{server(s.serverId)}</td>
                <td className="muted">{s.startedAt ? fmtDuration(Math.floor((Date.now() - Number(s.startedAt)) / 1000)) : '—'}</td>
                <td className="actions">
                  <button className="btn small" onClick={() => kick(s, false)}>
                    Desconectar
                  </button>{' '}
                  <button className="btn small ghost" onClick={() => kick(s, true)} title="Desconecta todos los dispositivos de esta línea">
                    Toda la línea
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && sessions.length === 0 && <div className="empty">Nadie está viendo nada ahora mismo.</div>}
      </div>
      {data && sessions.length > 0 && (
        <p className="muted" style={{ marginTop: 10, fontSize: 'var(--step--1)' }}>
          Último dato recibido hace {fmtAgo(Math.max(...sessions.map((s) => Number(s.lastSeen))))}.
        </p>
      )}
    </>
  );
}
