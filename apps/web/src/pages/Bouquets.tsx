import { useEffect, useMemo, useState } from 'react';
import { api, listAll, type Bouquet, type Movie, type Series, type Stream } from '../api';
import { CrudPage } from '../components/CrudPage';
import { useData, useToast } from '../components/ui';
import { categoryName, useRefs } from '../refs';

type ItemType = 'live' | 'movie' | 'series';
interface Item {
  type: ItemType;
  id: number;
}

export function Bouquets() {
  const refs = useRefs();
  return (
    <CrudPage<Bouquet>
      resource="bouquets"
      title="Paquetes"
      intro="Un paquete agrupa canales, películas y series. A cada línea le asignas uno o varios paquetes."
      singular="paquete"
      newLabel="Nuevo paquete"
      emptyText="Crea un paquete y elige qué contenido incluye."
      onChanged={refs.reload}
      columns={[
        { label: 'Paquete', render: (b) => <b>{b.name}</b> },
        { label: 'Orden', className: 'num', render: (b) => b.sort },
      ]}
      fields={[
        { name: 'name', label: 'Nombre', type: 'text', required: true, half: true },
        { name: 'sort', label: 'Orden', type: 'number' },
      ]}
      defaults={() => ({ name: '', sort: 0 })}
      editExtra={(b) => <BouquetContent bouquet={b} />}
    />
  );
}

function BouquetContent({ bouquet }: { bouquet: Bouquet }) {
  const refs = useRefs();
  const toast = useToast();
  const { data: catalog } = useData(async () => {
    const [streams, movies, series] = await Promise.all([
      listAll<Stream>('streams'),
      listAll<Movie>('movies'),
      listAll<Series>('series'),
    ]);
    return { streams, movies, series };
  }, []);
  const [selected, setSelected] = useState<Item[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<ItemType>('live');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api<Item[]>('GET', `/bouquets/${bouquet.id}/items`).then(setSelected);
  }, [bouquet.id]);

  const has = (t: ItemType, id: number) => !!selected?.some((x) => x.type === t && x.id === id);
  const toggle = (t: ItemType, id: number) => {
    setSelected((cur) => (has(t, id) ? cur!.filter((x) => !(x.type === t && x.id === id)) : [...(cur ?? []), { type: t, id }]));
    setDirty(true);
  };

  const lists = useMemo(() => {
    if (!catalog) return null;
    const f = filter.toLowerCase();
    const map = (arr: Array<{ id: number; name: string; category_id: number | null }>) =>
      arr
        .filter((x) => !f || x.name.toLowerCase().includes(f))
        .map((x) => ({ id: x.id, name: x.name, cat: categoryName(refs, x.category_id) }))
        .sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
    return { live: map(catalog.streams), movie: map(catalog.movies), series: map(catalog.series) };
  }, [catalog, filter, refs]);

  const setAll = (t: ItemType, on: boolean) => {
    if (!lists) return;
    const ids = lists[t].map((x) => x.id);
    setSelected((cur) => {
      const rest = (cur ?? []).filter((x) => !(x.type === t && ids.includes(x.id)));
      return on ? [...rest, ...ids.map((id) => ({ type: t, id }))] : rest;
    });
    setDirty(true);
  };

  const save = async () => {
    try {
      await api('PUT', `/bouquets/${bouquet.id}/items`, { items: selected });
      setDirty(false);
      toast('Contenido del paquete guardado');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const count = (t: ItemType) => selected?.filter((x) => x.type === t).length ?? 0;
  const tabs: Array<[ItemType, string]> = [
    ['live', 'Canales'],
    ['movie', 'Películas'],
    ['series', 'Series'],
  ];

  return (
    <div className="subsection">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <h3>Contenido</h3>
        <button className="btn primary small" disabled={!dirty} onClick={save}>
          Guardar contenido
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="tablist">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`btn small${tab === t ? ' primary' : ''}`}
            onClick={() => setTab(t)}
          >
            {label} ({count(t)})
          </button>
        ))}
      </div>
      <input className="input" type="search" placeholder="Filtrar" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {!lists || !selected ? (
        <span className="muted">Cargando…</span>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn small ghost" onClick={() => setAll(tab, true)}>
              Marcar todos
            </button>
            <button className="btn small ghost" onClick={() => setAll(tab, false)}>
              Desmarcar todos
            </button>
          </div>
          <div className="checklist" style={{ maxHeight: 360 }}>
            {lists[tab].length === 0 && <span className="muted">Nada que mostrar.</span>}
            {lists[tab].map((x, i) => (
              <div key={x.id}>
                {(i === 0 || lists[tab][i - 1].cat !== x.cat) && <div className="bq-cat">{x.cat}</div>}
                <label className="check">
                  <input type="checkbox" checked={has(tab, x.id)} onChange={() => toggle(tab, x.id)} />
                  {x.name}
                </label>
              </div>
            ))}
          </div>
          {dirty && <span className="help">Tienes cambios sin guardar en el contenido.</span>}
        </>
      )}
    </div>
  );
}
