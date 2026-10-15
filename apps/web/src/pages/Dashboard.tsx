import { api, listAll, type Session, type Stats, type Stream } from '../api';
import { fmtAgo, fmtDuration, useData } from '../components/ui';
import { categoryName, useRefs } from '../refs';
import { channelState } from '../status';

export function Dashboard({ go }: { go: (route: string) => void }) {
  const refs = useRefs();
  const { data, error } = useData(
    async () => {
      const [stats, streams, sessions] = await Promise.all([
        api<Stats>('GET', '/stats'),
        listAll<Stream>('streams'),
        api<Session[]>('GET', '/connections'),
      ]);
      return { stats, streams, sessions };
    },
    [],
    5000,
  );

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <p className="muted">Cargando…</p>;
  const { stats, streams, sessions } = data;
  const states = streams.map((s) => ({ stream: s, state: channelState(s, stats.servers, sessions) }));
  const onAir = states.filter((x) => x.state.tally === 'air' || x.state.tally === 'wait').length;
  const failing = states.filter((x) => x.state.tally === 'fail').length;
  const nodesOnline = stats.servers.filter((s) => s.online).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Resumen</h1>
          <p>Se actualiza solo cada 5 segundos.</p>
        </div>
      </div>

      <div className="summary">
        <span><b>{stats.connections}</b> conectados ahora</span>
        <span><b>{onAir}</b> de {stats.streams} canales emitiendo</span>
        {failing > 0 && <span><b style={{ color: 'var(--tally-air)' }}>{failing}</b> con fallo</span>}
        <span><b>{nodesOnline}</b> de {stats.servers.length} nodos en línea</span>
        <span><b>{stats.lines_active}</b> líneas activas</span>
      </div>

      <div className="section-head">
        <h2>Canales</h2>
        <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span className="tally air">En emisión</span>
          <span className="tally wait">En respaldo o arrancando</span>
          <span className="tally">En reposo</span>
          <span className="tally fail">Fallo</span>
        </span>
      </div>
      <div className="wall">
        {states.length === 0 && (
          <div className="wall-empty">
            Aún no hay canales. <a href="#/canales" onClick={() => go('canales')}>Añade el primero</a>.
          </div>
        )}
        {states.map(({ stream, state }) => (
          <button
            key={stream.id}
            className={`monitor ${state.tally}`}
            onClick={() => go(`canales`)}
            title={state.detail || state.label}
          >
            <div className="strip" />
            <div className="body">
              <div className="name">{stream.name}</div>
              <div className="meta">
                {categoryName(refs, stream.category_id)}
                {state.detail ? ` · ${state.detail.length > 60 ? state.detail.slice(0, 60) + '…' : state.detail}` : ''}
              </div>
              <div className="foot">
                <span className="state">{state.label}</span>
                <span className="viewers">
                  {state.status?.running && state.status.uptimeSec > 0 ? fmtDuration(state.status.uptimeSec) + ' · ' : ''}
                  {state.viewers} {state.viewers === 1 ? 'espectador' : 'espectadores'}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="section-head">
        <h2>Nodos</h2>
        <a href="#/servidores" onClick={() => go('servidores')}>Gestionar nodos</a>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Estado</th>
              <th>Nodo</th>
              <th className="num">Clientes</th>
              <th className="num">Canales activos</th>
              <th className="num">Carga (1 min)</th>
              <th>Último contacto</th>
            </tr>
          </thead>
          <tbody>
            {stats.servers.map((s) => (
              <tr key={s.id}>
                <td>
                  <span className={`tally ${s.online ? 'ok' : 'fail'}`}>{s.online ? 'En línea' : 'Sin respuesta'}</span>
                </td>
                <td>
                  {s.name} <span className="muted mono">{s.public_url}</span>
                </td>
                <td className="num">{s.status?.clients ?? 0}</td>
                <td className="num">{s.status?.streams?.filter((x) => x.running).length ?? 0}</td>
                <td className="num">{s.status?.load?.[0]?.toFixed(2) ?? '—'}</td>
                <td className="muted">{s.last_heartbeat ? `hace ${fmtAgo(new Date(s.last_heartbeat).getTime())}` : 'nunca'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {stats.servers.length === 0 && <div className="empty">Da de alta tu primer nodo en Servidores.</div>}
      </div>
    </>
  );
}
