// Geometría del gráfico del historial del sensor. Funciones puras (sin Angular ni DOM): reciben las muestras y
// devuelven coordenadas listas para dibujar en un SVG.
import { DAY_MS, HOUR_MS, toISODate, weekdayEs } from '../../core/dates';
import { clock, dayMonth, decimal } from '../../core/format';
import type { SensorSample } from '../../core/sensor-history';

/** Lienzo del gráfico, en unidades del viewBox: tamaño y área de trazado. */
export const CHART_GEOMETRY = { W: 320, H: 176, X0: 30, X1: 312, Y0: 10, Y1: 146 } as const;
const { X0, X1, Y0, Y1 } = CHART_GEOMETRY;

/** Un tramo de más de 24 h sin reportes se dibuja punteado: no se sabe qué pasó en medio. */
const LONG_GAP_MS = DAY_MS;
/** Con pocos reportes, cada uno se marca con un punto. */
const MAX_DOTS = 80;

export interface Point {
  x: number;
  y: number;
}

export interface SensorChart {
  /** Línea de humedad en escalones (atributo `d` de un `<path>`). */
  path: string;
  /** Tramos sin reportes por más de 24 h. */
  gapPath: string;
  /** Un punto por reporte (vacío si son demasiados). */
  dots: Point[];
  /** Líneas horizontales de la escala (% de humedad). */
  grid: { v: number; y: number }[];
  /** Niveles de calibración: «húmedo» y «toca regar». */
  calib: { label: string; y: number }[];
  /** Riegos registrados en el periodo. */
  irrigations: { x: number }[];
  xticks: { x: number; label: string }[];
  focus: Point | null;
}

export interface SensorChartInput {
  /** Todo el historial, en orden (se usa también la última muestra anterior al periodo). */
  samples: SensorSample[];
  /** Periodo visible. */
  t0: number;
  t1: number;
  now: number;
  calibration: { wet?: number; dry?: number };
  /** Instantes (ms) de los riegos registrados. */
  irrigationTimes: number[];
  /** Muestra destacada (bajo el dedo), si la hay. */
  focus: SensorSample | null;
}

/** Instante que corresponde a una posición horizontal del gráfico (para ubicar el dedo). */
export function timeAt(viewX: number, t0: number, t1: number): number {
  const x = Math.min(X1, Math.max(X0, viewX));
  return t0 + ((x - X0) / (X1 - X0)) * (t1 - t0);
}

/** Marcas del eje de tiempo: cada 6 h en periodos de hasta 2 días; por día en los más largos (máximo ~8). */
export function timeTicks(t0: number, t1: number): { t: number; label: string }[] {
  const span = t1 - t0;
  const out: { t: number; label: string }[] = [];
  if (span <= 2 * DAY_MS) {
    const stepH = 6;
    const d = new Date(t0);
    d.setMinutes(0, 0, 0);
    d.setHours(Math.ceil(d.getHours() / stepH) * stepH);
    for (let t = d.getTime(); t <= t1; t += stepH * HOUR_MS) out.push({ t, label: clock(t) });
    return out;
  }
  const days = Math.ceil(span / DAY_MS);
  const stepD = days <= 8 ? 1 : days <= 16 ? 3 : days <= 45 ? 7 : Math.ceil(days / 6);
  const d = new Date(t0);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  while (d.getTime() <= t1) {
    const t = d.getTime();
    out.push({ t, label: stepD === 1 ? weekdayEs(toISODate(d)).slice(0, 3) : dayMonth(t) });
    d.setDate(d.getDate() + stepD); // por calendario: un día con cambio de hora no dura 24 h
  }
  return out;
}

/**
 * Arma el gráfico. El sensor a pilas informa solo cuando algo cambia: entre dos reportes la humedad sigue en el
 * último valor, así que la línea va en escalones y parte del valor que traía antes del periodo.
 */
export function sensorChart(input: SensorChartInput): SensorChart {
  const { samples, t0, t1, now, calibration: cal } = input;
  const visible = samples.filter((s) => s.t >= t0 && s.t <= t1);
  const prior = [...samples].reverse().find((s) => s.t < t0);

  // Escala vertical: de 10 en 10, ajustada a lo que hay que mostrar (al menos 20 puntos de alto).
  const values = [...(prior ? [prior.soil] : []), ...visible.map((s) => s.soil), ...(cal.wet !== undefined ? [cal.wet] : []), ...(cal.dry !== undefined ? [cal.dry] : [])];
  const lo = Math.max(0, values.length ? Math.floor((Math.min(...values) - 3) / 10) * 10 : 0);
  const hi = Math.min(100, Math.max(values.length ? Math.ceil((Math.max(...values) + 3) / 10) * 10 : 100, lo + 20));
  const x = (t: number) => X0 + ((t - t0) / (t1 - t0)) * (X1 - X0);
  const y = (pct: number) => Y1 - ((pct - lo) / (hi - lo)) * (Y1 - Y0);
  const px = (t: number) => x(t).toFixed(1);
  const py = (pct: number) => y(pct).toFixed(1);

  const pts = [...(prior ? [{ t: t0, soil: prior.soil }] : []), ...visible];
  let path = '';
  let gapPath = '';
  pts.forEach((s, i) => {
    if (i === 0) {
      path += `M${px(s.t)},${py(s.soil)}`;
      return;
    }
    const prev = pts[i - 1];
    if (s.t - prev.t > LONG_GAP_MS) {
      gapPath += `M${px(prev.t)},${py(prev.soil)}H${px(s.t)}`;
      path += `M${px(s.t)},${py(prev.soil)}`;
    } else {
      path += `H${px(s.t)}`;
    }
    path += `V${py(s.soil)}`;
  });
  // El último valor sigue vigente hasta ahora.
  const last = pts.at(-1);
  const end = Math.min(now, t1);
  if (last && end > last.t) {
    if (end - last.t > LONG_GAP_MS) gapPath += `M${px(last.t)},${py(last.soil)}H${px(end)}`;
    else path += `H${px(end)}`;
  }

  const step = hi - lo > 40 ? 20 : 10;
  const grid: SensorChart['grid'] = [];
  for (let v = lo; v <= hi; v += step) grid.push({ v, y: y(v) });

  return {
    path,
    gapPath,
    dots: visible.length <= MAX_DOTS ? visible.map((s) => ({ x: x(s.t), y: y(s.soil) })) : [],
    grid,
    calib: [
      ...(cal.wet !== undefined ? [{ label: `húmedo ${decimal(cal.wet)} %`, y: y(cal.wet) }] : []),
      ...(cal.dry !== undefined ? [{ label: `toca regar ${decimal(cal.dry)} %`, y: y(cal.dry) }] : []),
    ],
    irrigations: input.irrigationTimes.filter((t) => t >= t0 && t <= t1).map((t) => ({ x: x(t) })),
    xticks: timeTicks(t0, t1).map((tick) => ({ x: x(tick.t), label: tick.label })),
    focus: input.focus ? { x: x(input.focus.t), y: y(input.focus.soil) } : null,
  };
}
