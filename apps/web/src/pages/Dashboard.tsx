import { useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Play, TrendingDown, TrendingUp, Users, XCircle, Zap } from 'lucide-react';
import { api, type MetricSample } from '../api';
import { LineChart } from '../components/LineChart';
import { fmtDuration, useData } from '../components/ui';
import { fmtMbps, useLive } from '../live';
import { categoryName, useRefs } from '../refs';

interface Issue {
  sev: 'crit' | 'warn';
  text: string;
}

export function Dashboard({ go }: { go: (route: string) => void }) {
  const refs = useRefs();
  const live = useLive();
  const [server, setServer] = useState('');
  const { data: history } = useData(
    () => api<MetricSample[]>('GET', `/history${server ? `?server=${server}` : ''}`),
    [server],
    15000,
  );

  const stats = live.stats;
  if (!stats) return <p className="muted">Cargando…</p>;

  const sid = server ? Number(server) : null;
  const servers = sid ? stats.servers.filter((s) => s.id === sid) : stats.servers;
  const online = servers.filter((s) => s.online);
  const sessions = sid ? live.sessions.filter((s) => Number(s.serverId) === sid) : live.sessions;
  const channels = sid
    ? live.channels.filter((c) => c.state.serverName === servers[0]?.name)
    : live.channels;
  const onAir = channels.filter((c) => c.state.tally === 'air' || c.state.tally === 'wait').length;
  const down = channels.filter((c) => c.state.tally === 'fail');
  const netOut = online.reduce((a, s) => a + (s.status?.netOutMbps ?? 0), 0);
  const netIn = online.reduce((a, s) => a + (s.status?.netInMbps ?? 0), 0);

  // Problemas detectados, de más a menos grave
  const issues: Issue[] = [];
  for (const s of servers) {
    if (!s.enabled) continue;
    if (!s.online) issues.push({ sev: 'crit', text: `El nodo ${s.name} no responde.` });
    else {
      if ((s.status?.cpu ?? 0) >= 90) issues.push({ sev: 'warn', text: `CPU al ${s.status?.cpu}% en ${s.name}.` });
      if ((s.status?.mem ?? 0) >= 90) issues.push({ sev: 'warn', text: `Memoria al ${s.status?.mem}% en ${s.name}.` });
    }
  }
  for (const c of down) issues.push({ sev: 'crit', text: `${c.stream.name}: ${c.state.detail || 'no arranca'}` });
  for (const c of channels.filter((x) => x.state.tally === 'wait' && x.state.label === 'En respaldo')) {
    issues.push({ sev: 'warn', text: `${c.stream.name} está tirando de una fuente de respaldo.` });
  }
  if (stats.servers.length === 0) issues.push({ sev: 'warn', text: 'No hay ningún nodo dado de alta.' });

  const tiles = [
    { icon: <Zap size={20} />, value: String(sessions.length), label: 'Conexiones en línea' },
    { icon: <Users size={20} />, value: String(stats.lines_active), label: 'Líneas activas' },
    { icon: <Play size={20} />, value: String(onAir), label: 'Canales en emisión' },
    { icon: <AlertTriangle size={20} />, value: String(down.length), label: 'Canales caídos', alert: down.length > 0 },
    { icon: <TrendingUp size={20} />, value: fmtMbps(netOut), label: 'Salida de red' },
    { icon: <TrendingDown size={20} />, value: fmtMbps(netIn), label: 'Entrada de red' },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Resumen</h1>
        <select className="select" style={{ width: 260 }} value={server} onChange={(e) => setServer(e.target.value)} aria-label="Servidor">
          <option value="">Todos los servidores</option>
          {stats.servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="tiles">
        {tiles.map((t) => {
          const [num, unit] = t.value.split(' ');
          return (
            <div key={t.label} className={`tile${t.alert ? ' alert' : ''}`}>
              <div className="tile-icon">{t.icon}</div>
              <div className="tile-text">
                <div className="tile-val">
                  {num}
                  {unit && <small>{unit}</small>}
                </div>
                <div className="tile-label">{t.label}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Estado del servicio</h2>
            <Activity size={18} className="muted" />
          </div>
          <ul className="issues">
            {issues.length === 0 && (
              <li className="sev-ok">
                <CheckCircle2 size={16} /> No se ha detectado ningún problema.
              </li>
            )}
            {issues.map((i, n) => (
              <li key={n} className={`sev-${i.sev}`}>
                {i.sev === 'crit' ? <XCircle size={16} /> : <AlertTriangle size={16} />}
                <span>{i.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>CPU y memoria</h2>
          </div>
          <LineChart
            ariaLabel="Uso de CPU y memoria en el tiempo"
            data={(history ?? []).map((h) => ({ t: h.t, cpu: h.cpu, mem: h.mem }))}
            series={[
              { key: 'cpu', label: 'CPU', slot: 1 },
              { key: 'mem', label: 'Memoria', slot: 3 },
            ]}
            yMax={100}
            format={(v) => `${Math.round(v)}%`}
          />
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Tráfico de red</h2>
          </div>
          <LineChart
            ariaLabel="Tráfico de red de salida y de entrada en el tiempo"
            data={(history ?? []).map((h) => ({ t: h.t, out: h.out, in: h.in }))}
            series={[
              { key: 'out', label: 'Salida', slot: 1 },
              { key: 'in', label: 'Entrada', slot: 3 },
            ]}
            format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}G` : `${v % 1 ? v.toFixed(1) : v}M`)}
          />
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Servidores</h2>
            <a href="#/servidores" onClick={() => go('servidores')} style={{ fontSize: 'var(--step--1)' }}>
              Gestionar
            </a>
          </div>
          <div className="table-wrap" style={{ background: 'transparent' }}>
            <table>
              <thead>
                <tr>
                  <th>Servidor</th>
                  <th className="num">Clientes</th>
                  <th className="num">CPU</th>
                  <th className="num">Memoria</th>
                  <th className="num">Salida</th>
                </tr>
              </thead>
              <tbody>
                {stats.servers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className={`tally ${s.online ? 'ok' : 'fail'}`}>{s.name}</span>
                    </td>
                    <td className="num">{s.status?.clients ?? 0}</td>
                    <td className="num">{s.online && s.status?.cpu != null ? `${s.status.cpu}%` : '—'}</td>
                    <td className="num">{s.online && s.status?.mem != null ? `${s.status.mem}%` : '—'}</td>
                    <td className="num">{s.online ? fmtMbps(s.status?.netOutMbps ?? 0) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Canales</h2>
          <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span className="tally air">En emisión</span>
            <span className="tally wait">Respaldo o arrancando</span>
            <span className="tally">En reposo</span>
            <span className="tally fail">Fallo</span>
          </span>
        </div>
        <div className="wall">
          {channels.length === 0 && (
            <div className="wall-empty">
              Aún no hay canales.{' '}
              <a href="#/canales" onClick={() => go('canales')}>
                Añade el primero
              </a>
            </div>
          )}
          {channels.map(({ stream, state }) => (
            <button key={stream.id} className={`monitor ${state.tally}`} onClick={() => go('canales')} title={state.detail || state.label}>
              <div className="strip" />
              <div className="body">
                <div className="name">{stream.name}</div>
                <div className="meta">{categoryName(refs, stream.category_id)}</div>
                {state.detail && <div className="meta">{state.detail.length > 60 ? state.detail.slice(0, 60) + '…' : state.detail}</div>}
                <div className="foot">
                  <span className="state">{state.label}</span>
                  <span>
                    {state.status?.running && state.status.uptimeSec > 0 ? `${fmtDuration(state.status.uptimeSec)}, ` : ''}
                    {state.viewers} viendo
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
