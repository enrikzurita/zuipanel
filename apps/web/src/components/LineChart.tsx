import { useEffect, useMemo, useRef, useState } from 'react';

export interface ChartSeries {
  key: string;
  label: string;
  /** Clase de color: 1 = azul, 3 = verde agua (paleta validada) */
  slot: 1 | 3;
}

interface Props {
  data: Array<{ t: number } & Record<string, number>>;
  series: ChartSeries[];
  /** Máximo fijo del eje Y (p. ej. 100 para porcentajes). Si no, se calcula. */
  yMax?: number;
  format: (v: number) => string;
  emptyText?: string;
  ariaLabel: string;
}

const H = 230;
const M = { top: 10, right: 14, bottom: 26, left: 46 };
const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

/** Escala "bonita" para el eje Y. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

export function LineChart({ data, series, yMax, format, emptyText, ariaLabel }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (data.length < 2) return null;
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t;
    const maxV = yMax ?? niceMax(Math.max(...data.flatMap((d) => series.map((s) => d[s.key] ?? 0))) * 1.1);
    const iw = width - M.left - M.right;
    const ih = H - M.top - M.bottom;
    const x = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (v: number) => M.top + ih - (Math.min(v, maxV) / maxV) * ih;
    const paths = series.map((s) => {
      const pts = data.map((d) => `${x(d.t).toFixed(1)},${y(d[s.key] ?? 0).toFixed(1)}`);
      const line = `M${pts.join('L')}`;
      const area = `${line}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
      return { s, line, area };
    });
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);
    const nX = Math.max(2, Math.min(6, Math.floor(iw / 110)));
    const xTicks = Array.from({ length: nX }, (_, i) => t0 + ((t1 - t0) * i) / (nX - 1));
    return { x, y, paths, yTicks, xTicks, iw };
  }, [data, series, width, yMax]);

  if (!geo) {
    return (
      <div ref={wrap} className="chart-empty">
        {emptyText ?? 'Todavía no hay datos. Aparecerán en cuanto los nodos envíen sus primeras métricas.'}
      </div>
    );
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestD = Infinity;
    data.forEach((d, i) => {
      const dist = Math.abs(geo.x(d.t) - px);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    setHover(best);
  };

  const hd = hover != null ? data[hover] : null;
  const hx = hd ? geo.x(hd.t) : 0;

  return (
    <div ref={wrap} className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <g className="grid">
          {geo.yTicks.map((v) => (
            <line key={v} x1={M.left} x2={width - M.right} y1={geo.y(v)} y2={geo.y(v)} />
          ))}
        </g>
        <g className="axis">
          {geo.yTicks.map((v) => (
            <text key={v} x={M.left - 8} y={geo.y(v) + 4} textAnchor="end">
              {format(v)}
            </text>
          ))}
          {geo.xTicks.map((t, i) => (
            <text key={t} x={geo.x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === geo.xTicks.length - 1 ? 'end' : 'middle'}>
              {timeFmt.format(t)}
            </text>
          ))}
        </g>
        {geo.paths.map(({ s, area }) => (
          <path key={`a-${s.key}`} className={`area-${s.slot}`} d={area} />
        ))}
        {geo.paths.map(({ s, line }) => (
          <path key={`l-${s.key}`} className={`line series-${s.slot}`} d={line} />
        ))}
        {hd && (
          <g>
            <line className="cross" x1={hx} x2={hx} y1={M.top} y2={H - M.bottom} />
            {series.map((s) => (
              <circle
                key={s.key}
                className="dot"
                cx={hx}
                cy={geo.y(hd[s.key] ?? 0)}
                r={4.5}
                fill={`var(--series-${s.slot})`}
              />
            ))}
          </g>
        )}
      </svg>
      {hd && (
        <div className="chart-tip" style={{ left: `${(hx / width) * 100}%`, top: 4 }}>
          <div className="muted">{timeFmt.format(hd.t)}</div>
          {series.map((s) => (
            <div key={s.key} className="row">
              <span className="swatch" style={{ background: `var(--series-${s.slot})` }} />
              {s.label}: <b>{format(hd[s.key] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
      <div className="legend">
        {series.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="swatch" style={{ background: `var(--series-${s.slot})` }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
