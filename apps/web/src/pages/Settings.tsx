import { useState } from 'react';
import { api, type Category, type Stats, type Server, type TranscodeProfile } from '../api';
import { CrudPage } from '../components/CrudPage';
import { fmtAgo, useData } from '../components/ui';
import { TYPE_LABEL, useRefs } from '../refs';

export function Categories() {
  const refs = useRefs();
  const [type, setType] = useState('');
  return (
    <CrudPage<Category>
      resource="categories"
      title="Categorías"
      intro="Agrupan el contenido en los reproductores. Cada categoría es de un tipo: directo, películas o series."
      singular="categoría"
      newLabel="Nueva categoría"
      onChanged={refs.reload}
      query={type ? `type=${type}` : ''}
      toolbarExtra={
        <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filtrar por tipo">
          <option value="">Todos los tipos</option>
          <option value="live">Directo</option>
          <option value="movie">Películas</option>
          <option value="series">Series</option>
        </select>
      }
      columns={[
        { label: 'Categoría', render: (c) => <b>{c.name}</b> },
        { label: 'Tipo', render: (c) => TYPE_LABEL[c.type] },
        { label: 'Orden', className: 'num', render: (c) => c.sort },
      ]}
      fields={[
        { name: 'name', label: 'Nombre', type: 'text', required: true },
        {
          name: 'type',
          label: 'Tipo',
          type: 'select',
          half: true,
          options: [
            { value: 'live', label: 'Directo' },
            { value: 'movie', label: 'Películas' },
            { value: 'series', label: 'Series' },
          ],
        },
        { name: 'sort', label: 'Orden', type: 'number' },
      ]}
      defaults={() => ({ name: '', type: type || 'live', sort: 0 })}
    />
  );
}

export function Servers() {
  const refs = useRefs();
  const { data: stats } = useData(() => api<Stats>('GET', '/stats'), [], 5000);
  const live = (id: number) => stats?.servers.find((s) => s.id === id);
  return (
    <CrudPage<Server>
      resource="servers"
      title="Servidores"
      intro="Los nodos que emiten los canales y sirven el VOD. Tras darlo de alta aquí, arranca el agente en ese servidor con su número de nodo."
      singular="servidor"
      newLabel="Nuevo servidor"
      onChanged={refs.reload}
      refreshMs={5000}
      columns={[
        {
          label: 'Estado',
          render: (s) => {
            const l = live(s.id);
            if (!s.enabled) return <span className="tally">Desactivado</span>;
            return <span className={`tally ${l?.online ? 'ok' : 'fail'}`}>{l?.online ? 'En línea' : 'Sin respuesta'}</span>;
          },
        },
        { label: 'Nº de nodo', className: 'num', render: (s) => s.id },
        { label: 'Nombre', render: (s) => <b>{s.name}</b> },
        { label: 'URL pública', render: (s) => <span className="mono">{s.public_url}</span> },
        { label: 'Clientes', className: 'num', render: (s) => live(s.id)?.status?.clients ?? 0 },
        {
          label: 'Último contacto',
          render: (s) => {
            const hb = live(s.id)?.last_heartbeat;
            return <span className="muted">{hb ? `hace ${fmtAgo(new Date(hb).getTime())}` : 'nunca'}</span>;
          },
        },
      ]}
      fields={[
        { name: 'name', label: 'Nombre', type: 'text', required: true, placeholder: 'vps-madrid-1' },
        {
          name: 'public_url',
          label: 'URL pública',
          type: 'text',
          required: true,
          placeholder: 'http://s1.tudominio.com:8081',
          help: 'A esta dirección se envía a los espectadores.',
        },
        { name: 'max_clients', label: 'Máximo de clientes', type: 'number', help: '0 = sin límite' },
        { name: 'enabled', label: 'Recibe espectadores', type: 'bool' },
        { name: 'is_main', label: 'Servidor principal', type: 'bool' },
      ]}
      defaults={() => ({ name: '', public_url: 'http://', max_clients: 0, enabled: 1, is_main: 0 })}
    />
  );
}

const PROFILE_HELP =
  'videoCodec: copy, libx264, libx265, h264_nvenc o hevc_nvenc. Opcionales: preset, videoBitrate ("3000k"), height (720), fps, audioCodec (copy o aac), audioBitrate, hlsTime.';

export function Profiles() {
  const refs = useRefs();
  return (
    <CrudPage<TranscodeProfile>
      resource="transcode_profiles"
      title="Perfiles de transcodificación"
      intro="Cómo se procesa un canal. Sin perfil, el canal se emite tal cual llega (remux), sin gastar apenas CPU."
      singular="perfil"
      newLabel="Nuevo perfil"
      onChanged={refs.reload}
      columns={[
        { label: 'Perfil', render: (p) => <b>{p.name}</b> },
        {
          label: 'Ajustes',
          render: (p) => {
            const o = p.options as Record<string, string | number>;
            const parts = [o.videoCodec, o.height ? `${o.height}p` : null, o.videoBitrate, o.audioCodec ? `audio ${o.audioCodec}` : null];
            return <span className="muted">{parts.filter(Boolean).join(', ')}</span>;
          },
        },
      ]}
      fields={[
        { name: 'name', label: 'Nombre', type: 'text', required: true, placeholder: '720p GPU' },
        { name: 'options', label: 'Ajustes', type: 'json', required: true, help: PROFILE_HELP },
      ]}
      defaults={() => ({
        name: '',
        options: { videoCodec: 'libx264', preset: 'veryfast', height: 720, videoBitrate: '3000k', audioCodec: 'aac' },
      })}
    />
  );
}
