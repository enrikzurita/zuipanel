import { useState } from 'react';
import { api, listAll, type Episode, type Movie, type Series } from '../api';
import { CrudPage, type FieldDef } from '../components/CrudPage';
import { useData, useToast } from '../components/ui';
import { categoryName, categoryOptions, useRefs } from '../refs';

const EXT_OPTIONS = ['mp4', 'mkv', 'avi', 'ts', 'mov', 'webm'].map((e) => ({ value: e, label: e }));
const INFO_HELP = 'Opcional. Ejemplo: {"plot":"Sinopsis","genre":"Acción","cast":"…","director":"…","duration_secs":5400}';

export function Movies() {
  const refs = useRefs();
  const [cat, setCat] = useState('');
  const fields: FieldDef[] = [
    { name: 'name', label: 'Título', type: 'text', required: true },
    { name: 'category_id', label: 'Categoría', type: 'select', options: categoryOptions(refs, 'movie'), half: true },
    { name: 'rating', label: 'Nota (0–10)', type: 'number' },
    { name: 'source_path', label: 'Fichero en el nodo', type: 'text', required: true, placeholder: '/mnt/media/peliculas/titulo.mkv', half: true },
    { name: 'container_extension', label: 'Formato', type: 'select', options: EXT_OPTIONS },
    { name: 'icon', label: 'Carátula (URL)', type: 'text' },
    { name: 'info', label: 'Ficha', type: 'json', help: INFO_HELP },
    { name: 'enabled', label: 'Visible para los clientes', type: 'bool' },
  ];
  return (
    <CrudPage<Movie>
      resource="movies"
      title="Películas"
      intro="Cada película apunta a un fichero que debe existir en los nodos donde la asignes (por ejemplo, tu montaje rclone)."
      singular="película"
      newLabel="Nueva película"
      query={cat ? `category_id=${cat}` : ''}
      toolbarExtra={<CategoryFilter type="movie" value={cat} onChange={setCat} />}
      columns={[
        { label: 'Título', render: (m) => <b>{m.name}</b> },
        { label: 'Categoría', render: (m) => categoryName(refs, m.category_id) },
        { label: 'Nota', className: 'num', render: (m) => Number(m.rating).toFixed(1) },
        { label: 'Fichero', render: (m) => <span className="mono muted">{m.source_path}</span> },
        { label: 'Visible', render: (m) => (m.enabled ? 'Sí' : <span className="muted">No</span>) },
      ]}
      fields={fields}
      defaults={() => ({ name: '', container_extension: 'mp4', enabled: 1, rating: 0, category_id: null })}
      relations={[serverRelation(refs, 'movies')]}
    />
  );
}

export function SeriesPage() {
  const refs = useRefs();
  const [cat, setCat] = useState('');
  return (
    <CrudPage<Series>
      resource="series"
      title="Series"
      intro="Crea la serie y después añade sus episodios desde su ficha."
      singular="serie"
      newLabel="Nueva serie"
      query={cat ? `category_id=${cat}` : ''}
      toolbarExtra={<CategoryFilter type="series" value={cat} onChange={setCat} />}
      columns={[
        { label: 'Serie', render: (s) => <b>{s.name}</b> },
        { label: 'Categoría', render: (s) => categoryName(refs, s.category_id) },
        { label: 'Nota', className: 'num', render: (s) => Number(s.rating).toFixed(1) },
        { label: 'Visible', render: (s) => (s.enabled ? 'Sí' : <span className="muted">No</span>) },
      ]}
      fields={[
        { name: 'name', label: 'Título', type: 'text', required: true },
        { name: 'category_id', label: 'Categoría', type: 'select', options: categoryOptions(refs, 'series'), half: true },
        { name: 'rating', label: 'Nota (0–10)', type: 'number' },
        { name: 'cover', label: 'Portada (URL)', type: 'text' },
        { name: 'info', label: 'Ficha', type: 'json', help: INFO_HELP },
        { name: 'enabled', label: 'Visible para los clientes', type: 'bool' },
      ]}
      defaults={() => ({ name: '', enabled: 1, rating: 0, category_id: null })}
      relations={[serverRelation(refs, 'series')]}
      editExtra={(s) => <EpisodeManager series={s} />}
    />
  );
}

function serverRelation(refs: ReturnType<typeof useRefs>, resource: string) {
  return {
    key: 'servers',
    label: 'Nodos que tienen los ficheros',
    path: (id: number) => `/${resource}/${id}/servers`,
    options: refs.servers.map((s) => ({ id: s.id, label: `${s.name} (${s.public_url})` })),
  };
}

function CategoryFilter({ type, value, onChange }: { type: 'movie' | 'series'; value: string; onChange: (v: string) => void }) {
  const refs = useRefs();
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Filtrar por categoría">
      <option value="">Todas las categorías</option>
      {refs.categories
        .filter((c) => c.type === type)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </select>
  );
}

function EpisodeManager({ series }: { series: Series }) {
  const toast = useToast();
  const { data: eps, reload } = useData(() => listAll<Episode>('episodes', `series_id=${series.id}`), [series.id]);
  const next = (() => {
    if (!eps?.length) return { season: 1, episode_num: 1 };
    const last = eps.reduce((a, b) => (b.season > a.season || (b.season === a.season && b.episode_num > a.episode_num) ? b : a));
    return { season: last.season, episode_num: last.episode_num + 1 };
  })();
  const [form, setForm] = useState({ title: '', source_path: '', container_extension: 'mp4' });
  const [num, setNum] = useState<{ season: number; episode_num: number } | null>(null);
  const cur = num ?? next;

  const add = async () => {
    if (!form.source_path.trim()) return toast('Indica el fichero del episodio', true);
    try {
      await api('POST', '/episodes', { series_id: series.id, ...cur, ...form });
      toast(`T${cur.season} E${cur.episode_num} añadido`);
      setForm({ ...form, title: '', source_path: '' });
      setNum(null);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const remove = async (e: Episode) => {
    if (!window.confirm(`¿Eliminar T${e.season} E${e.episode_num}?`)) return;
    await api('DELETE', `/episodes/${e.id}`);
    reload();
  };

  const sorted = [...(eps ?? [])].sort((a, b) => a.season - b.season || a.episode_num - b.episode_num);
  return (
    <div className="subsection">
      <h3>Episodios</h3>
      {sorted.length === 0 && <span className="muted">Sin episodios todavía.</span>}
      {sorted.length > 0 && (
        <div className="table-wrap">
          <table>
            <tbody>
              {sorted.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    T{e.season} E{e.episode_num}
                  </td>
                  <td>
                    {e.title || <span className="muted">Sin título</span>}
                    <div className="mono muted">{e.source_path}</div>
                  </td>
                  <td className="actions">
                    <button className="btn small ghost danger" onClick={() => remove(e)}>
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="field-row">
        <div className="field">
          <label>Temporada</label>
          <input className="input" type="number" min={0} value={cur.season} onChange={(e) => setNum({ ...cur, season: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>Episodio</label>
          <input className="input" type="number" min={0} value={cur.episode_num} onChange={(e) => setNum({ ...cur, episode_num: Number(e.target.value) })} />
        </div>
      </div>
      <div className="field">
        <label>Título</label>
        <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label>Fichero en el nodo</label>
        <input
          className="input"
          value={form.source_path}
          placeholder="/mnt/media/series/serie/s01e01.mkv"
          onChange={(e) => {
            const v = e.target.value;
            const ext = /\.([a-z0-9]{2,4})$/i.exec(v)?.[1]?.toLowerCase();
            setForm({ ...form, source_path: v, container_extension: ext ?? form.container_extension });
          }}
        />
      </div>
      <div>
        <button className="btn" onClick={add}>
          Añadir episodio
        </button>
      </div>
    </div>
  );
}
