import { useState } from 'react';
import { api, type Session, type Stats, type Stream } from '../api';
import { CrudPage } from '../components/CrudPage';
import { fmtDuration, useData } from '../components/ui';
import { categoryName, categoryOptions, useRefs } from '../refs';
import { channelState } from '../status';

export function Streams() {
  const refs = useRefs();
  const [cat, setCat] = useState('');
  const { data: live } = useData(
    async () => {
      const [stats, sessions] = await Promise.all([api<Stats>('GET', '/stats'), api<Session[]>('GET', '/connections')]);
      return { stats, sessions };
    },
    [],
    5000,
  );
  const stateOf = (s: Stream) => (live ? channelState(s, live.stats.servers, live.sessions) : null);
  const profileName = (id: number | null) =>
    id == null ? 'Remux' : refs.profiles.find((p) => p.id === id)?.name ?? `Perfil #${id}`;

  return (
    <CrudPage<Stream>
      resource="streams"
      title="Canales"
      intro="Canales en directo. Cada uno tiene una o varias fuentes; si la primera falla, el nodo pasa a la siguiente."
      singular="canal"
      newLabel="Nuevo canal"
      emptyText="Añade tu primer canal con la URL de su fuente."
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
        { label: 'Procesado', render: (s) => profileName(s.transcode_profile_id) },
        { label: 'Arranque', render: (s) => (s.on_demand ? 'Bajo demanda' : 'Siempre encendido') },
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
        { name: 'name', label: 'Nombre', type: 'text', required: true },
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
          required: true,
          placeholder: 'http://origen/canal.ts\nhttp://respaldo/canal.ts',
          help: 'Una URL por línea, en orden de preferencia.',
          decode: (v) => {
            if (!Array.isArray(v) || v.length === 0) throw new Error('Añade al menos una fuente');
            return v;
          },
        },
        { name: 'on_demand', label: 'Bajo demanda', type: 'bool', help: 'Solo se emite mientras alguien lo ve. Desactívalo para canales muy vistos.' },
        { name: 'enabled', label: 'Canal activo', type: 'bool' },
        { name: 'icon', label: 'Logo (URL)', type: 'text', placeholder: 'https://…/logo.png' },
        { name: 'epg_channel_id', label: 'ID de guía (EPG)', type: 'text', half: true },
        { name: 'sort', label: 'Orden', type: 'number' },
        { name: 'user_agent', label: 'User-Agent para la fuente', type: 'text', help: 'Solo si el origen lo exige.' },
      ]}
      defaults={() => ({ name: '', sources: [], on_demand: 1, enabled: 1, sort: 0, transcode_profile_id: null, category_id: null })}
      relations={[
        {
          key: 'servers',
          label: 'Nodos que lo emiten',
          help: 'El panel envía a cada espectador al nodo en línea con menos carga.',
          path: (id) => `/streams/${id}/servers`,
          options: refs.servers.map((s) => ({ id: s.id, label: `${s.name} (${s.public_url})` })),
        },
      ]}
    />
  );
}
