// Lluvia de una estación: qué campo la trae, cómo se interpreta (acumulado diario o por intervalo) y cuánto cayó
// cada día local.
import { toISODate } from '../dates';
import type { ISODate } from '../models';
import { type DmcSample, parseMomento, unitNumber } from './api';
import { BUCKET_MS, MAX_GAP_MS } from './constants';

export type RainKind = 'accumulated' | 'increment';

/** Campo de lluvia de la estación y cómo interpretarlo. */
export interface RainField {
  field: string;
  /** accumulated: acumulado que se reinicia a diario (aguaCaida24Horas); increment: lluvia del intervalo. */
  kind: RainKind;
}

export function detectRainField(samples: DmcSample[]): RainField | null {
  const keys = [...new Set(samples.slice(0, 50).flatMap((s) => Object.keys(s)))];
  if (keys.includes('aguaCaida24Horas')) return { field: 'aguaCaida24Horas', kind: 'accumulated' };
  const perInterval = keys.find((k) => /(agua|precip|lluvia).*minuto/i.test(k));
  if (perInterval) return { field: perInterval, kind: 'increment' };
  const accumulated = keys.find((k) => /(agua|precip|lluvia).*(24|dia)/i.test(k));
  return accumulated ? { field: accumulated, kind: 'accumulated' } : null;
}

/** [instante en ms, valor en mm] */
export type RainPoint = [number, number];

export function rainPoints(samples: DmcSample[], rf: RainField): RainPoint[] {
  const byTime = new Map<number, number>();
  for (const s of samples) {
    const t = parseMomento(String(s.momento));
    const v = unitNumber(s[rf.field]);
    if (t && v !== null && v >= 0) byTime.set(t.getTime(), v);
  }
  return [...byTime].sort((a, b) => a[0] - b[0]);
}

export interface DailyRain {
  mm: number;
  /** Horas del día realmente cubiertas por lecturas (sin contar huecos de más de 1 h). */
  coveredHours: number;
}

/**
 * Lluvia por día local. Con un acumulado (se reinicia a las 12:00 UTC), la lluvia de cada intervalo es la
 * diferencia con la lectura anterior; si el acumulado baja, hubo reinicio y la lluvia es el valor nuevo.
 * Cada intervalo se asigna al día local en que termina.
 */
export function dailyRainFromPoints(points: RainPoint[], kind: RainKind): Map<ISODate, DailyRain> {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const out = new Map<ISODate, { mm: number; covered: number }>();
  for (let i = 0; i < pts.length; i++) {
    const [t, v] = pts[i];
    const day = toISODate(new Date(t));
    const acc = out.get(day) ?? { mm: 0, covered: 0 };
    out.set(day, acc);
    if (kind === 'increment') acc.mm += v;
    if (i === 0) continue;
    const [pt, pv] = pts[i - 1];
    if (kind === 'accumulated') acc.mm += v >= pv ? v - pv : v;
    if (t - pt <= MAX_GAP_MS) acc.covered += t - pt;
  }
  const res = new Map<ISODate, DailyRain>();
  for (const [day, a] of out) res.set(day, { mm: Math.round(a.mm * 10) / 10, coveredHours: a.covered / 3_600_000 });
  return res;
}

/** Atajo para lecturas crudas con `aguaCaida24Horas`. */
export function dailyRainFromAccumulated(samples: DmcSample[], field = 'aguaCaida24Horas'): Map<ISODate, DailyRain> {
  return dailyRainFromPoints(rainPoints(samples, { field, kind: 'accumulated' }), 'accumulated');
}

/** Lluvia total de un conjunto de lecturas (p. ej. las ~12 h de una consulta). */
export function totalRain(points: RainPoint[], kind: RainKind): number {
  let mm = 0;
  for (const d of dailyRainFromPoints(points, kind).values()) mm += d.mm;
  return Math.round(mm * 10) / 10;
}

/** Deja la última lectura de cada bloque de 10 min (el acumulado no pierde información; ocupa ~10× menos). */
export function downsampleAccumulated(points: RainPoint[]): RainPoint[] {
  const byBucket = new Map<number, RainPoint>();
  for (const p of [...points].sort((a, b) => a[0] - b[0])) byBucket.set(Math.floor(p[0] / BUCKET_MS), p);
  return [...byBucket.values()];
}
