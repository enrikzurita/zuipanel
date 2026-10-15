import { useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler, type Stats } from './api';
import { Field, ToastProvider, useData } from './components/ui';
import { Bouquets } from './pages/Bouquets';
import { Connections } from './pages/Connections';
import { Dashboard } from './pages/Dashboard';
import { Lines } from './pages/Lines';
import { Categories, Profiles, Servers } from './pages/Settings';
import { Streams } from './pages/Streams';
import { Movies, SeriesPage } from './pages/Vod';
import { RefsProvider } from './refs';

type Route = 'resumen' | 'conexiones' | 'lineas' | 'paquetes' | 'canales' | 'peliculas' | 'series' | 'categorias' | 'servidores' | 'perfiles';

const NAV: Array<{ group: string; items: Array<[Route, string]> }> = [
  { group: 'Operación', items: [['resumen', 'Resumen'], ['conexiones', 'Conexiones']] },
  { group: 'Clientes', items: [['lineas', 'Líneas'], ['paquetes', 'Paquetes']] },
  { group: 'Contenido', items: [['canales', 'Canales'], ['peliculas', 'Películas'], ['series', 'Series'], ['categorias', 'Categorías']] },
  { group: 'Infraestructura', items: [['servidores', 'Servidores'], ['perfiles', 'Perfiles de transcodificación']] },
];

const readRoute = (): Route => {
  const r = window.location.hash.replace(/^#\/?/, '') as Route;
  return NAV.some((g) => g.items.some(([k]) => k === r)) ? r : 'resumen';
};

export function App() {
  const [token, setTok] = useState(getToken());
  useEffect(() => setUnauthorizedHandler(() => (setToken(''), setTok(''))), []);
  if (!token) return <Login onLogin={(t) => (setToken(t), setTok(t))} />;
  return (
    <ToastProvider>
      <RefsProvider>
        <Shell onLogout={() => (setToken(''), setTok(''))} />
      </RefsProvider>
    </ToastProvider>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [route, setRoute] = useState<Route>(readRoute());
  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (r: string) => {
    window.location.hash = `/${r}`;
  };
  const { data: stats } = useData(() => api<Stats>('GET', '/stats'), [], 15000);
  const counts: Partial<Record<Route, number>> = stats
    ? { conexiones: stats.connections, lineas: stats.lines_total, canales: stats.streams, peliculas: stats.movies, series: stats.series }
    : {};

  const pages: Record<Route, ReactNode> = {
    resumen: <Dashboard go={go} />,
    conexiones: <Connections />,
    lineas: <Lines />,
    paquetes: <Bouquets />,
    canales: <Streams />,
    peliculas: <Movies />,
    series: <SeriesPage />,
    categorias: <Categories />,
    servidores: <Servers />,
    perfiles: <Profiles />,
  };

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Secciones">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">ZuiPanel</span>
        </div>
        <div className="nav">
          {NAV.map((g) => (
            <div key={g.group} style={{ display: 'contents' }}>
              <div className="nav-group">{g.group}</div>
              {g.items.map(([key, label]) => (
                <a key={key} href={`#/${key}`} aria-current={route === key ? 'page' : undefined}>
                  <span>{label}</span>
                  {counts[key] != null && <span className="nav-count">{counts[key]}</span>}
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <button onClick={onLogout}>Cerrar sesión</button>
        </div>
      </nav>
      <main className="main" key={route}>
        {pages[route]}
      </main>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('GET', '/stats', undefined, value.trim());
      onLogin(value.trim());
    } catch {
      setError('Ese token no es válido. Es el valor de ADMIN_TOKEN en el .env del servidor principal.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="login-box" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark" aria-hidden="true" style={{ background: 'var(--ink)' }} />
        </div>
        <h1>ZuiPanel</h1>
        <p>Entra con tu token de administración.</p>
        {error && <div className="alert">{error}</div>}
        <Field label="Token de administración" htmlFor="token">
          <input
            id="token"
            className="input mono"
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </Field>
        <button className="btn primary" type="submit" disabled={busy || !value.trim()}>
          Entrar
        </button>
      </form>
    </div>
  );
}
