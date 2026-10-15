import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { listAll, type Bouquet, type Category, type Server, type TranscodeProfile } from './api';

/** Datos de referencia que usan casi todas las pantallas (para selectores y nombres). */
export interface Refs {
  categories: Category[];
  bouquets: Bouquet[];
  servers: Server[];
  profiles: TranscodeProfile[];
  reload: () => void;
}

const empty: Refs = { categories: [], bouquets: [], servers: [], profiles: [], reload: () => {} };
const RefsCtx = createContext<Refs>(empty);
export const useRefs = () => useContext(RefsCtx);

export function RefsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Refs, 'reload'>>(empty);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    Promise.all([
      listAll<Category>('categories'),
      listAll<Bouquet>('bouquets'),
      listAll<Server>('servers'),
      listAll<TranscodeProfile>('transcode_profiles'),
    ])
      .then(([categories, bouquets, servers, profiles]) => setState({ categories, bouquets, servers, profiles }))
      .catch(() => {});
  }, [tick]);
  return <RefsCtx.Provider value={{ ...state, reload }}>{children}</RefsCtx.Provider>;
}

export const TYPE_LABEL = { live: 'Directo', movie: 'Películas', series: 'Series' } as const;

export function categoryOptions(refs: Refs, type: Category['type']) {
  return [
    { value: null, label: 'Sin categoría' },
    ...refs.categories.filter((c) => c.type === type).map((c) => ({ value: c.id, label: c.name })),
  ];
}

export function categoryName(refs: Refs, id: number | null) {
  if (id == null) return '—';
  return refs.categories.find((c) => c.id === id)?.name ?? `#${id}`;
}
