import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type ListResult } from '../api';
import { Drawer, Field, fromLocalInput, randomPassword, toLocalInput, useData, useToast } from './ui';

export type FieldType = 'text' | 'number' | 'bool' | 'select' | 'lines' | 'datetime' | 'json' | 'password' | 'textarea';

export interface Option {
  value: string | number | null;
  label: string;
}

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  options?: Option[];
  help?: string;
  required?: boolean;
  placeholder?: string;
  /** Agrupa este campo con el siguiente en una fila de dos columnas */
  half?: boolean;
  /** Conversión opcional valor guardado → valor del formulario y viceversa */
  encode?: (v: unknown) => unknown;
  decode?: (v: unknown) => unknown;
}

export interface Column<T> {
  label: string;
  render: (item: T) => ReactNode;
  className?: string;
}

export interface Relation {
  key: string;
  label: string;
  help?: string;
  path: (id: number) => string;
  options: Array<{ id: number; label: string; group?: string }>;
}

export interface CrudPageProps<T extends { id: number }> {
  resource: string;
  title: string;
  intro?: string;
  singular: string;
  newLabel: string;
  columns: Column<T>[];
  fields: FieldDef[];
  defaults: () => Record<string, unknown>;
  relations?: Relation[];
  /** Filtros extra en la URL de listado (p. ej. "category_id=3") */
  query?: string;
  toolbarExtra?: ReactNode;
  rowActions?: (item: T, reload: () => void) => ReactNode;
  /** Contenido adicional dentro del panel al editar (p. ej. episodios) */
  editExtra?: (item: T) => ReactNode;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Avisa a la página de que los datos cambiaron (para refrescar contadores) */
  onChanged?: () => void;
  refreshMs?: number;
}

const PAGE = 50;

function toForm(fields: FieldDef[], item: Record<string, unknown>) {
  const f: Record<string, unknown> = {};
  for (const d of fields) {
    const v = d.encode ? d.encode(item[d.name]) : item[d.name];
    if (d.type === 'lines') f[d.name] = Array.isArray(v) ? v.join('\n') : '';
    else if (d.type === 'json') f[d.name] = v == null ? '' : JSON.stringify(v, null, 2);
    else if (d.type === 'datetime') f[d.name] = toLocalInput((v as string) ?? null);
    else if (d.type === 'bool') f[d.name] = !!v;
    else f[d.name] = v ?? '';
  }
  return f;
}

function fromForm(fields: FieldDef[], form: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const d of fields) {
    const v = form[d.name];
    switch (d.type) {
      case 'lines':
        out[d.name] = String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
        break;
      case 'json': {
        const s = String(v ?? '').trim();
        if (!s) out[d.name] = null;
        else {
          try {
            out[d.name] = JSON.parse(s);
          } catch {
            throw new Error(`"${d.label}" no es un JSON válido`);
          }
        }
        break;
      }
      case 'datetime':
        out[d.name] = fromLocalInput(String(v ?? ''));
        break;
      case 'bool':
        out[d.name] = v ? 1 : 0;
        break;
      case 'number':
        out[d.name] = v === '' || v == null ? 0 : Number(v);
        break;
      case 'select':
        out[d.name] = v === '' || v == null ? null : isNaN(Number(v)) ? v : Number(v);
        break;
      default:
        out[d.name] = v ?? '';
    }
    if (d.decode) out[d.name] = d.decode(out[d.name]);
    if (d.required && (out[d.name] === '' || out[d.name] == null)) throw new Error(`Falta "${d.label}"`);
  }
  return out;
}

export function CrudPage<T extends { id: number }>(props: CrudPageProps<T>) {
  const { resource, columns, fields, relations = [], query = '' } = props;
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<T | 'new' | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebounced(search);
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(t);
  }, [search]);
  useEffect(() => setOffset(0), [query]);

  const { data, error, reload } = useData(
    () =>
      api<ListResult<T>>(
        'GET',
        `/${resource}?limit=${PAGE}&offset=${offset}${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}${query ? '&' + query : ''}`,
      ),
    [resource, offset, debounced, query],
    props.refreshMs,
  );

  const changed = () => {
    reload();
    props.onChanged?.();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{props.title}</h1>
          {props.intro && <p>{props.intro}</p>}
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          {props.newLabel}
        </button>
      </div>

      <div className="toolbar">
        <input
          className="input"
          type="search"
          placeholder={props.searchPlaceholder ?? 'Buscar por nombre'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar"
        />
        {props.toolbarExtra}
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label} className={c.className}>
                  {c.label}
                </th>
              ))}
              {props.rowActions && <th className="actions" aria-label="Acciones" />}
            </tr>
          </thead>
          <tbody>
            {data?.items.map((item) => (
              <tr key={item.id} className="clickable" onClick={() => setEditing(item)}>
                {columns.map((c) => (
                  <td key={c.label} className={c.className}>
                    {c.render(item)}
                  </td>
                ))}
                {props.rowActions && (
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    {props.rowActions(item, changed)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.items.length === 0 && (
          <div className="empty">{debounced ? `Nada coincide con "${debounced}".` : props.emptyText ?? 'Todavía no hay nada aquí.'}</div>
        )}
        {data && data.total > PAGE && (
          <div className="pager">
            <span>
              {offset + 1}–{Math.min(offset + PAGE, data.total)} de {data.total}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button className="btn small" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
                Anteriores
              </button>
              <button className="btn small" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                Siguientes
              </button>
            </span>
          </div>
        )}
      </div>

      {editing && (
        <EditDrawer
          {...props}
          relations={relations}
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            toast(isNew ? `${cap(props.singular)} creado` : 'Cambios guardados');
            changed();
            if (isNew && props.editExtra) setEditing(saved);
            else setEditing(null);
          }}
          onDeleted={() => {
            toast(`${cap(props.singular)} eliminado`);
            setEditing(null);
            changed();
          }}
        />
      )}
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function EditDrawer<T extends { id: number }>(
  props: CrudPageProps<T> & {
    relations: Relation[];
    item: T | null;
    onClose: () => void;
    onSaved: (item: T, isNew: boolean) => void;
    onDeleted: () => void;
  },
) {
  const { item, fields, relations, resource } = props;
  const toast = useToast();
  const isNew = !item;
  const [form, setForm] = useState<Record<string, unknown>>(() =>
    toForm(fields, (item as unknown as Record<string, unknown>) ?? props.defaults()),
  );
  const [rel, setRel] = useState<Record<string, number[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    Promise.all(relations.map((r) => api<number[]>('GET', r.path(item.id)).then((ids) => [r.key, ids] as const)))
      .then((pairs) => setRel(Object.fromEntries(pairs)))
      .catch((e: Error) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const set = (name: string, v: unknown) => setForm((f) => ({ ...f, [name]: v }));

  async function save() {
    setErr(null);
    let body: Record<string, unknown>;
    try {
      body = fromForm(fields, form);
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    setBusy(true);
    try {
      const saved = isNew
        ? await api<T>('POST', `/${resource}`, body)
        : await api<T>('PATCH', `/${resource}/${item!.id}`, body);
      for (const r of relations) {
        if (rel[r.key]) await api('PUT', r.path(saved.id), { ids: rel[r.key] });
      }
      props.onSaved(saved, isNew);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!item || !window.confirm(`¿Eliminar este ${props.singular}? No se puede deshacer.`)) return;
    setBusy(true);
    try {
      await api('DELETE', `/${resource}/${item.id}`);
      props.onDeleted();
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  }

  // Agrupa los campos marcados como "half" de dos en dos
  const rows = useMemo(() => {
    const out: FieldDef[][] = [];
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].half && fields[i + 1]) {
        out.push([fields[i], fields[i + 1]]);
        i++;
      } else out.push([fields[i]]);
    }
    return out;
  }, [fields]);

  return (
    <Drawer
      title={isNew ? props.newLabel : `Editar ${props.singular}`}
      onClose={props.onClose}
      footer={
        <>
          {!isNew && (
            <button className="btn danger" onClick={remove} disabled={busy}>
              Eliminar
            </button>
          )}
          <div className="right">
            <button className="btn" onClick={props.onClose}>
              Cancelar
            </button>
            <button className="btn primary" onClick={save} disabled={busy}>
              {isNew ? 'Crear' : 'Guardar cambios'}
            </button>
          </div>
        </>
      }
    >
      {err && <div className="alert">{err}</div>}
      {rows.map((row) =>
        row.length === 2 ? (
          <div className="field-row" key={row[0].name}>
            {row.map((d) => (
              <FieldInput key={d.name} def={d} value={form[d.name]} onChange={(v) => set(d.name, v)} />
            ))}
          </div>
        ) : (
          <FieldInput key={row[0].name} def={row[0]} value={form[row[0].name]} onChange={(v) => set(row[0].name, v)} />
        ),
      )}

      {relations.map((r) => (
        <RelationPicker
          key={r.key}
          relation={r}
          value={rel[r.key] ?? []}
          loading={!isNew && !(r.key in rel)}
          onChange={(ids) => setRel((x) => ({ ...x, [r.key]: ids }))}
        />
      ))}

      {!isNew && props.editExtra?.(item!)}
    </Drawer>
  );
}

function FieldInput({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const id = `f-${def.name}`;
  if (def.type === 'bool') {
    return (
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {def.label}
        </label>
        {def.help && <span className="help">{def.help}</span>}
      </div>
    );
  }
  let input: ReactNode;
  switch (def.type) {
    case 'select':
      input = (
        <select id={id} className="select" value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)}>
          {def.options?.map((o) => (
            <option key={String(o.value)} value={o.value == null ? '' : String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'lines':
    case 'json':
    case 'textarea':
      input = (
        <textarea
          id={id}
          className="textarea"
          value={String(value ?? '')}
          placeholder={def.placeholder}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      );
      break;
    case 'datetime':
      input = <input id={id} className="input" type="datetime-local" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'password':
      input = (
        <div className="input-with-btn">
          <input id={id} className="input mono" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
          <button type="button" className="btn" onClick={() => onChange(randomPassword())}>
            Generar
          </button>
        </div>
      );
      break;
    default:
      input = (
        <input
          id={id}
          className="input"
          type={def.type === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          placeholder={def.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <Field label={def.label} help={def.help} htmlFor={id}>
      {input}
    </Field>
  );
}

function RelationPicker({
  relation,
  value,
  loading,
  onChange,
}: {
  relation: Relation;
  value: number[];
  loading: boolean;
  onChange: (ids: number[]) => void;
}) {
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  let lastGroup: string | undefined;
  return (
    <div className="field">
      <span className="label">{relation.label}</span>
      <div className="checklist">
        {loading && <span className="muted">Cargando…</span>}
        {!loading && relation.options.length === 0 && <span className="muted">No hay opciones todavía.</span>}
        {!loading &&
          relation.options.map((o) => {
            const header = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <div key={o.id}>
                {header && <div className="bq-cat">{header}</div>}
                <label className="check">
                  <input type="checkbox" checked={value.includes(o.id)} onChange={() => toggle(o.id)} />
                  {o.label}
                </label>
              </div>
            );
          })}
      </div>
      {relation.help && <span className="help">{relation.help}</span>}
    </div>
  );
}
