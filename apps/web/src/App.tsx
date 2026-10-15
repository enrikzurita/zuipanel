import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clapperboard,
  Cpu,
  Film,
  FolderTree,
  Layers,
  ListVideo,
  Monitor,
  Play,
  PlugZap,
  Search,
  Server,
  TrendingUp,
  Tv,
  Users,
  Zap,
} from 'lucide-react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { Field, ToastProvider } from './components/ui';
import { fmtMbps, LiveProvider, useLive } from './live';
import { Bouquets } from './pages/Bouquets';
import { Connections } from './pages/Connections';
import { Dashboard } from './pages/Dashboard';
import { Lines } from './pages/Lines';
import { Categories, Profiles, Servers } from './pages/Settings';
import { Streams } from './pages/Streams';
import { Movies, SeriesPage } from './pages/Vod';
import { RefsProvider } from './refs';

type Route = 'resumen' | 'conexiones' | 'lineas' | 'paquetes' | 'canales' | 'peliculas' | 'series' | 'categorias' | 'servidores' | 'perfiles';

interface NavLeaf {
  route: Route;
  label: string;
  icon: ReactNode;
}
interface NavEntry {
  label: string;
  icon: ReactNode;
  route?: Route;
  children?: NavLeaf[];
}

const NAV: NavEntry[] = [
  { label: 'Resumen', icon: <Activity size={17} />, route: 'resumen' },
  {
    label: 'Servidores',
    icon: <Server size={17} />,
    children: [
      { route: 'servidores', label: 'Servidores', icon: <Server size={16} /> },
      { route: 'perfiles', label: 'Perfiles de transcodificación', icon: <Cpu size={16} /> },
    ],
  },
  {
    label: 'Líneas',
    icon: <Monitor size={17} />,
    children: [
      { route: 'lineas', label: 'Líneas', icon: <Users size={16} /> },
      { route: 'conexiones', label: 'Conexiones en directo', icon: <PlugZap size={16} /> },
    ],
  },
  {
    label: 'Contenido',
    icon: <Play size={17} />,
    children: [
      { route: 'canales', label: 'Canales', icon: <Tv size={16} /> },
      { route: 'peliculas', label: 'Películas', icon: <Film size={16} /> },
      { route: 'series', label: 'Series', icon: <Clapperboard size={16} /> },
      { route: 'categorias', label: 'Categorías', icon: <FolderTree size={16} /> },
    ],
  },
  { label: 'Paquetes', icon: <Layers size={17} />, route: 'paquetes' },
];

const ALL_ROUTES = NAV.flatMap((n) => (n.children ? n.children.map((c) => c.route) : [n.route!]));

function readRoute(): { route: Route; q: string } {
  const [path, qs] = window.location.hash.replace(/^#\/?/, '').split('?');
  const route = (ALL_ROUTES.includes(path as Route) ? path : 'resumen') as Route;
  return { route, q: new URLSearchParams(qs ?? '').get('q') ?? '' };
}

export function App() {
  const [token, setTok] = useState(getToken());
  useEffect(() => setUnauthorizedHandler(() => (setToken(''), setTok(''))), []);
  if (!token) return <Login onLogin={(t) => (setToken(t), setTok(t))} />;
  return (
    <ToastProvider>
      <RefsProvider>
        <LiveProvider>
          <Shell onLogout={() => (setToken(''), setTok(''))} />
        </LiveProvider>
      </RefsProvider>
    </ToastProvider>
  );
}

function Logo() {
  return (
    <div className="logo">
      <span className="logo-mark" aria-hidden="true" />
      Zui<b>Panel</b>
    </div>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [{ route, q }, setLoc] = useState(readRoute());
  const [open, setOpen] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const on = () => {
      setLoc(readRoute());
      setOpen(null);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.nav-item, .user-menu')) setOpen(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const go = (r: string) => {
    window.location.hash = `/${r}`;
  };

  const pages: Record<Route, ReactNode> = {
    resumen: <Dashboard go={go} />,
    conexiones: <Connections />,
    lineas: <Lines initialSearch={q} />,
    paquetes: <Bouquets />,
    canales: <Streams />,
    peliculas: <Movies />,
    series: <SeriesPage />,
    categorias: <Categories />,
    servidores: <Servers />,
    perfiles: <Profiles />,
  };

  return (
    <>
      <header className="topbar">
        <Logo />
        <LivePills />
        <div className="top-right">
          <form
            className="top-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get('q');
              go(`lineas?q=${encodeURIComponent(String(v ?? ''))}`);
            }}
          >
            <Search size={14} />
            <input name="q" placeholder="Buscar línea…" aria-label="Buscar línea por usuario" />
          </form>
          <div className="user-menu nav-item">
            <button className="user-btn" onClick={() => setOpen(open === 'user' ? null : 'user')} aria-expanded={open === 'user'}>
              Administrador <ChevronDown size={15} />
            </button>
            {open === 'user' && (
              <div className="menu" style={{ left: 'auto', right: 0, minWidth: 180 }}>
                <a href="#" onClick={(e) => (e.preventDefault(), onLogout())}>
                  Cerrar sesión
                </a>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="navbar" ref={navRef} aria-label="Secciones">
        {NAV.map((n) => {
          const active = n.route === route || n.children?.some((c) => c.route === route);
          if (!n.children) {
            return (
              <div key={n.label} className="nav-item">
                <a className={`nav-btn${active ? ' active' : ''}`} href={`#/${n.route}`} aria-current={active ? 'page' : undefined}>
                  {n.icon} {n.label}
                </a>
              </div>
            );
          }
          const isOpen = open === n.label;
          return (
            <div key={n.label} className={`nav-item${isOpen ? ' open' : ''}`}>
              <button
                className={`nav-btn${active ? ' active' : ''}`}
                onClick={() => setOpen(isOpen ? null : n.label)}
                aria-expanded={isOpen}
                aria-haspopup="true"
              >
                {n.icon} {n.label} <ChevronDown size={15} className="chev" />
              </button>
              {isOpen && (
                <div className="menu">
                  {n.children.map((c) => (
                    <a key={c.route} href={`#/${c.route}`} aria-current={c.route === route ? 'page' : undefined}>
                      {c.icon} {c.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <main className="main" key={`${route}?${q}`}>
        {pages[route]}
      </main>
    </>
  );
}

function LivePills() {
  const live = useLive();
  const s = live.stats;
  return (
    <div className="live-pills" aria-label="Estado en directo">
      <span className="pill" title="Conexiones en línea">
        <Zap size={15} /> <span className="val">{live.sessions.length}</span>
      </span>
      <span className="pill" title="Líneas activas">
        <Users size={15} /> <span className="val">{s?.lines_active ?? '—'}</span>
      </span>
      <span className="pill" title="Canales en emisión y caídos">
        <ListVideo size={15} />
        <span className="val">
          <span>
            {live.onAir} <ArrowUp size={11} />
          </span>
          <span>
            {live.down} <ArrowDown size={11} />
          </span>
        </span>
      </span>
      <span className="pill" title="Tráfico de red: salida y entrada">
        <TrendingUp size={15} />
        <span className="val">
          <span>
            {fmtMbps(live.netOut)} <ArrowUp size={11} />
          </span>
          <span>
            {fmtMbps(live.netIn)} <ArrowDown size={11} />
          </span>
        </span>
      </span>
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
      <header className="topbar">
        <Logo />
      </header>
      <div className="login-center">
        <form className="login-box" onSubmit={submit}>
          <h1>Acceso al panel</h1>
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
    </div>
  );
}
