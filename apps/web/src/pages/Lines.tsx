import { api, type Line, type Session } from '../api';
import { CrudPage, type FieldDef } from '../components/CrudPage';
import { fmtDate, randomPassword, useData, useToast } from '../components/ui';
import { useRefs } from '../refs';

function lineState(l: Line): { cls: string; label: string } {
  if (!l.enabled) return { cls: 'fail', label: 'Desactivada' };
  if (l.exp_date && new Date(l.exp_date).getTime() < Date.now()) return { cls: 'wait', label: 'Caducada' };
  return { cls: 'ok', label: l.is_trial ? 'Prueba' : 'Activa' };
}

const OUTPUTS = [
  { value: 'all', label: 'Todos (TS y HLS)' },
  { value: 'ts', label: 'Solo TS' },
  { value: 'm3u8', label: 'Solo HLS (m3u8)' },
];

export function Lines({ initialSearch }: { initialSearch?: string }) {
  const refs = useRefs();
  const toast = useToast();
  const { data: sessions } = useData(() => api<Session[]>('GET', '/connections'), [], 10000);
  const activeFor = (id: number) => sessions?.filter((s) => Number(s.lineId) === id).length ?? 0;

  const fields: FieldDef[] = [
    { name: 'username', label: 'Usuario', type: 'text', required: true, half: true },
    { name: 'password', label: 'Contraseña', type: 'password', required: true },
    { name: 'max_connections', label: 'Conexiones simultáneas', type: 'number', half: true, help: 'Dispositivos a la vez' },
    { name: 'exp_date', label: 'Caduca', type: 'datetime', help: 'Vacío = no caduca' },
    { name: 'enabled', label: 'Línea activa', type: 'bool' },
    { name: 'is_trial', label: 'Es una prueba', type: 'bool' },
    {
      name: 'allowed_outputs',
      label: 'Formatos permitidos',
      type: 'select',
      options: OUTPUTS,
      encode: (v) => (Array.isArray(v) && v.length === 1 ? v[0] : 'all'),
      decode: (v) => (v === 'all' || !v ? null : [v]),
    },
    {
      name: 'allowed_ips',
      label: 'IPs permitidas',
      type: 'lines',
      placeholder: 'Una IP por línea',
      help: 'Vacío = desde cualquier IP',
      decode: (v) => (Array.isArray(v) && v.length ? v : null),
    },
    { name: 'notes', label: 'Notas', type: 'textarea', placeholder: 'Cliente, forma de pago, etc.' },
  ];

  const copyAccess = async (l: Line) => {
    const server = window.location.origin;
    const text = `Servidor: ${server}\nUsuario: ${l.username}\nContraseña: ${l.password}\nLista M3U: ${server}/get.php?username=${encodeURIComponent(l.username)}&password=${encodeURIComponent(l.password)}&type=m3u_plus&output=m3u8`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Datos de acceso copiados');
    } catch {
      window.prompt('Copia los datos de acceso:', text);
    }
  };

  return (
    <CrudPage<Line>
      resource="lines"
      title="Líneas"
      intro="Cada línea es un cliente: usuario y contraseña para su reproductor, cuántos dispositivos a la vez y hasta cuándo."
      singular="línea"
      newLabel="Nueva línea"
      searchPlaceholder="Buscar por usuario"
      emptyText="Crea la primera línea para dar acceso a un cliente."
      refreshMs={10000}
      initialSearch={initialSearch}
      columns={[
        { label: 'Usuario', render: (l) => <b>{l.username}</b> },
        { label: 'Estado', render: (l) => <span className={`tally ${lineState(l).cls}`}>{lineState(l).label}</span> },
        { label: 'Conectados', className: 'num', render: (l) => `${activeFor(l.id)} / ${l.max_connections}` },
        { label: 'Caduca', render: (l) => (l.exp_date ? fmtDate(l.exp_date) : <span className="muted">Nunca</span>) },
        { label: 'Notas', render: (l) => <span className="muted">{l.notes ?? ''}</span> },
      ]}
      fields={fields}
      defaults={() => {
        const exp = new Date();
        exp.setMonth(exp.getMonth() + 1);
        return { username: '', password: randomPassword(), max_connections: 1, exp_date: exp.toISOString(), enabled: 1, is_trial: 0 };
      }}
      relations={[
        {
          key: 'bouquets',
          label: 'Paquetes',
          help: 'Lo que verá el cliente. El orden de los paquetes es el de la lista.',
          path: (id) => `/lines/${id}/bouquets`,
          options: refs.bouquets.map((b) => ({ id: b.id, label: b.name })),
        },
      ]}
      rowActions={(l, reload) => (
        <>
          <button className="btn small ghost" onClick={() => copyAccess(l)}>
            Copiar acceso
          </button>
          {activeFor(l.id) > 0 && (
            <button
              className="btn small"
              onClick={async () => {
                await api('DELETE', `/connections/${l.id}`);
                toast(`${l.username} desconectado`);
                reload();
              }}
            >
              Desconectar
            </button>
          )}
        </>
      )}
    />
  );
}
