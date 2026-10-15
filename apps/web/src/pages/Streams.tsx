import { useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';
import { api, type Stream } from '../api';
import { CrudPage } from '../components/CrudPage';
import { fmtDuration, useData, useToast } from '../components/ui';
import { useLive } from '../live';
import { categoryName, categoryOptions, useRefs } from '../refs';
import { channelState } from '../status';

const isPush = (f: Record<string, unknown>) => f.input_type === 'push';

export function Streams() {
  const refs = useRefs();
  const live = useLive();
  const [cat, setCat] = useState('');
  const stateOf = (s: Stream) => (live.stats ? channelState(s, live.stats.servers, live.sessions) : null);
  const profileName = (id: number | null) =>
    id == null ? 'Remux' : refs.profiles.find((p) => p.id === id)?.name ?? `Perfil #${id}`;

  return (
    <CrudPage<Stream>
      resource="streams"
      title="Canales"
      intro="Canales en directo. Pueden leer una URL de origen o recibir tu propia emisión desde OBS o la app de la cámara."
      singular="canal"
      newLabel="Nuevo canal"
      emptyText="Añade tu primer canal."
      query={cat ? `category_id=${cat}` : ''}
      refreshMs={5000}
      toolbarExtra={
        <select className="select" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Filtrar por categoría">
          <option value="">Todas las categorías</option>
          {refs.categories
            .filter((c) => c.type === 'live')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      }
      columns={[
        {
          label: 'Estado',
          render: (s) => {
            const st = stateOf(s);
            return st ? <span className={`tally ${st.tally}`} title={st.detail}>{st.label}</span> : null;
          },
        },
        { label: 'Canal', render: (s) => <b>{s.name}</b> },
        { label: 'Categoría', render: (s) => categoryName(refs, s.category_id) },
        {
          label: 'Entrada',
          render: (s) => (s.input_type === 'push' ? `Emisión propia${s.record ? ', se graba' : ''}` : 'URL de origen'),
        },
        { label: 'Procesado', render: (s) => profileName(s.transcode_profile_id) },
        {
          label: 'Actividad',
          render: (s) => {
            const st = stateOf(s);
            if (!st?.status?.running) return <span className="muted">—</span>;
            return (
              <span className="muted">
                {fmtDuration(st.status.uptimeSec)}, {st.viewers} viendo
              </span>
            );
          },
        },
      ]}
      fields={[
        { name: 'name', label: 'Nombre', type: 'text', required: true, placeholder: 'Ciudad de Málaga en directo' },
        {
          name: 'input_type',
          label: 'Entrada',
          type: 'select',
          options: [
            { value: 'push', label: 'Emisión propia: la envío desde OBS o la app de la cámara' },
            { value: 'pull', label: 'URL de origen: el servidor la lee de otra dirección' },
          ],
        },
        { name: 'category_id', label: 'Categoría', type: 'select', options: categoryOptions(refs, 'live'), half: true },
        {
          name: 'transcode_profile_id',
          label: 'Procesado',
          type: 'select',
          options: [{ value: null, label: 'Remux (sin recodificar)' }, ...refs.profiles.map((p) => ({ value: p.id, label: p.name }))],
        },
        {
          name: 'sources',
          label: 'Fuentes',
          type: 'lines',
          placeholder: 'http://origen/canal.ts\nhttp://respaldo/canal.ts',
          help: 'Una URL por línea, en orden de preferencia.',
          show: (f) => !isPush(f),
          validate: (v) => (Array.isArray(v) && v.length ? null : 'Añade al menos una fuente'),
        },
        {
          name: 'on_demand',
          label: 'Bajo demanda',
          type: 'bool',
          help: 'Solo se emite mientras alguien lo ve.',
          show: (f) => !isPush(f),
        },
        {
          name: 'record',
          label: 'Grabar cada emisión',
          type: 'bool',
          help: 'Al terminar, la emisión aparece en Películas para verla en diferido.',
          show: isPush,
        },
        {
          name: 'record_category_id',
          label: 'Categoría de las grabaciones',
          type: 'select',
          options: categoryOptions(refs, 'movie'),
          show: (f) => isPush(f) && !!f.record,
        },
        { name: 'enabled', label: 'Canal activo', type: 'bool' },
        { name: 'icon', label: 'Logo (URL)', type: 'text', placeholder: 'https://…/escudo.png' },
        { name: 'epg_channel_id', label: 'ID de guía (EPG)', type: 'text', half: true },
        { name: 'sort', label: 'Orden', type: 'number' },
        { name: 'user_agent', label: 'User-Agent para la fuente', type: 'text', help: 'Solo si el origen lo exige.', show: (f) => !isPush(f) },
      ]}
      defaults={() => ({
        name: '',
        input_type: 'push',
        sources: [],
        on_demand: 1,
        enabled: 1,
        sort: 0,
        record: 1,
        transcode_profile_id: null,
        category_id: null,
        record_category_id: null,
      })}
      relations={[
        {
          key: 'servers',
          label: 'Servidores que lo emiten',
          help: 'Para la emisión propia, elige el servidor al que enviarás la señal.',
          path: (id) => `/streams/${id}/servers`,
          options: refs.servers.map((s) => ({ id: s.id, label: `${s.name} (${s.public_url})` })),
        },
      ]}
      editExtra={(s) => (s.input_type === 'push' ? <PushInfo stream={s} /> : null)}
    />
  );
}

/** Datos para configurar OBS o la app de la cámara. */
function PushInfo({ stream }: { stream: Stream }) {
  const refs = useRefs();
  const toast = useToast();
  const [key, setKey] = useState(stream.stream_key ?? '');
  const { data: serverIds } = useData(() => api<number[]>('GET', `/streams/${stream.id}/servers`), [stream.id]);
  const servers = refs.servers.filter((s) => serverIds?.includes(s.id));

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copiada`);
    } catch {
      window.prompt(`Copia la ${what.toLowerCase()}:`, text);
    }
  };
  const regenerate = async () => {
    if (!window.confirm('La clave actual dejará de funcionar. Tendrás que poner la nueva en OBS o en la cámara. ¿Continuar?')) return;
    const r = await api<{ stream_key: string }>('POST', `/streams/${stream.id}/regenerate-key`);
    setKey(r.stream_key);
    toast('Clave nueva generada');
  };
  const rtmpFor = (publicUrl: string) => {
    try {
      return `rtmp://${new URL(publicUrl).hostname}:1935/live`;
    } catch {
      return 'rtmp://SERVIDOR:1935/live';
    }
  };

  return (
    <div className="subsection">
      <h3>Cómo emitir</h3>
      {servers.length === 0 && (
        <span className="muted">Marca arriba el servidor al que vas a enviar la señal y guarda para ver los datos de conexión.</span>
      )}
      {servers.map((srv) => {
        const url = rtmpFor(srv.public_url);
        return (
          <div key={srv.id} className="ingest-box">
            <b>{srv.name}</b>
            <div className="copy-row">
              <span className="k">Servidor</span>
              <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} />
              <button className="btn small" onClick={() => copy(url, 'Dirección')} aria-label="Copiar servidor">
                <Copy size={14} />
              </button>
            </div>
            <div className="copy-row">
              <span className="k">Clave</span>
              <input className="input" readOnly value={key} onFocus={(e) => e.target.select()} />
              <button className="btn small" onClick={() => copy(key, 'Clave')} aria-label="Copiar clave">
                <Copy size={14} />
              </button>
            </div>
            <div className="copy-row">
              <span className="k">URL completa</span>
              <input className="input" readOnly value={`${url}/${key}`} onFocus={(e) => e.target.select()} />
              <button className="btn small" onClick={() => copy(`${url}/${key}`, 'URL')} aria-label="Copiar URL completa">
                <Copy size={14} />
              </button>
            </div>
          </div>
        );
      })}
      <span className="help">
        En OBS: Ajustes, Emisión, Servicio "Personalizado", y pega Servidor y Clave. En apps que piden una sola dirección RTMP, usa la URL
        completa. El canal se enciende solo al empezar a emitir y se apaga al parar.
      </span>
      <div>
        <button className="btn small ghost" onClick={regenerate}>
          <KeyRound size={14} /> Generar clave nueva
        </button>
      </div>
    </div>
  );
}
