// Almacén local de lecturas de una estación. Cada consulta a la DMC trae solo las últimas ~12 h, así que las
// lecturas se acumulan aquí (la app y el worker tienen cada uno el suyo) y con ellas se arman los días completos.
import { addDays, toISODate } from '../dates';
import type { DailyWeather, DmcAuth, DmcConfig, ISODate } from '../models';
import { type RecentFetch, type SummaryFetch, fetchDailySummary, fetchRecent, hasAuth } from './api';
import { KEEP_MS, STALE_STATION_MS } from './constants';
import { type MetBucket, type MetFields, detectMetFields, mergeMetBuckets, metBuckets } from './met';
import {
  type RainField,
  type RainKind,
  type RainPoint,
  dailyRainFromPoints,
  detectRainField,
  downsampleAccumulated,
  rainPoints,
} from './rain';

export interface DmcStore {
  code: string;
  field?: string;
  kind?: RainKind;
  /** Última consulta (exitosa o no) y si resultó bien: evita reintentar cada 15 min si el servicio falla. */
  attemptAt: number;
  ok: boolean;
  pts: RainPoint[];
  /** Lluvia diaria según el resumen diario oficial (con token): completa los días que las lecturas no cubren. */
  daily?: Record<ISODate, number>;
  /** Bloques de 10 min de temperatura, humedad, radiación y viento (para la ET0). */
  met?: MetBucket[];
  metFields?: MetFields;
  /** Pares (ET0 estación, ET0 modelo) por día: miden el sesgo del modelo. */
  et0Pairs?: Record<ISODate, [number, number]>;
  /** Última consulta del resumen diario (cambia una vez al día: no hace falta pedirlo en cada consulta). */
  summaryAt?: number;
  /** Por qué la última consulta no trajo lecturas (sin credenciales): se muestra en el panel. */
  error?: string;
}

const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

const SUMMARY_EVERY_MS = 3 * 3_600_000;

export function mergeStore(prev: DmcStore | null, code: string, rf: RainField, pts: RainPoint[], now: number): DmcStore {
  const same = prev && prev.code === code && prev.field === rf.field;
  const map = new Map<number, number>(same ? prev.pts : []);
  pts.forEach(([t, v]) => map.set(t, v));
  let merged: RainPoint[] = [...map].filter(([t]) => t >= now - KEEP_MS).sort((a, b) => a[0] - b[0]);
  if (rf.kind === 'accumulated') merged = downsampleAccumulated(merged);
  const keep =
    prev?.code === code
      ? { daily: prev.daily, met: prev.met, metFields: prev.metFields, et0Pairs: prev.et0Pairs, summaryAt: prev.summaryAt }
      : {};
  return { ...keep, code, field: rf.field, kind: rf.kind, attemptAt: now, ok: true, pts: merged };
}

function mergeDaily(store: DmcStore, daily: Map<ISODate, number>, today: ISODate): DmcStore {
  if (!daily.size) return store;
  const keep = addDays(today, -10);
  const merged = { ...(store.daily ?? {}), ...Object.fromEntries(daily) };
  return { ...store, daily: Object.fromEntries(Object.entries(merged).filter(([d]) => d >= keep)) };
}

/**
 * Consulta la estación si el almacén está viejo (o si `force`) y agrega las lecturas nuevas. Nunca lanza.
 * Tras un fallo espera 1 h antes de reintentar (o `maxAgeMs`, si es menor: con la app abierta), salvo que se
 * fuerce (botón "Probar").
 */
export async function refreshDmcStore(
  store: DmcStore | null,
  code: string,
  now: number,
  maxAgeMs: number,
  force = false,
  auth?: DmcAuth,
): Promise<{ store: DmcStore; fetched?: RecentFetch; rain?: RainField | null; summary?: SummaryFetch }> {
  const current = store && store.code === code ? store : null;
  const wait = current?.ok ? maxAgeMs : Math.min(maxAgeMs, RETRY_AFTER_FAILURE_MS);
  if (!force && current && now - current.attemptAt < wait) return { store: current };
  const fetched = await fetchRecent(code, auth);
  const rain = fetched.ok ? detectRainField(fetched.samples) : null;
  const error = !fetched.ok
    ? fetched.status
      ? `HTTP ${fetched.status}`
      : 'sin conexión'
    : !fetched.samples.length
      ? 'sin lecturas'
      : 'sin campo de lluvia';
  let next: DmcStore =
    fetched.ok && rain
      ? mergeStore(current, code, rain, rainPoints(fetched.samples, rain), now)
      : { ...(current ?? { code, pts: [] }), attemptAt: now, ok: false, error };
  // Temperatura, humedad, radiación y viento para la ET0 (bloques de 10 min).
  if (fetched.ok) {
    const { fields } = detectMetFields(fetched.samples);
    if (fields) next = { ...next, metFields: fields, met: mergeMetBuckets(next.met ?? [], metBuckets(fetched.samples, fields), now) };
  }
  // Con token, el resumen diario oficial aporta el total de ayer aunque falten lecturas (cada 3 h basta).
  const summaryDue = force || !current?.summaryAt || now - current.summaryAt >= SUMMARY_EVERY_MS;
  const summary = hasAuth(auth) && summaryDue ? await fetchDailySummary(code, auth) : undefined;
  if (summary) next = { ...mergeDaily(next, summary.daily, toISODate(new Date(now))), summaryAt: now };
  return { store: next, fetched, rain, summary };
}

/** Días ya cerrados (antes de hoy, últimos 4): con ≥ 20 h de lecturas o, si no, según el resumen diario. */
export function observedFromStore(store: DmcStore | null, code: string, today: ISODate, minHours = 20): Map<ISODate, number> {
  const out = new Map<ISODate, number>();
  if (!store || store.code !== code) return out;
  const from = addDays(today, -4);
  // 1) Días calendario armados con lecturas minuto a minuto (definición exacta del día).
  if (store.kind && store.pts.length) {
    for (const [day, r] of dailyRainFromPoints(store.pts, store.kind)) {
      if (day < today && day >= from && r.coveredHours >= minHours) out.set(day, r.mm);
    }
  }
  // 2) Lo que falte, desde el resumen diario oficial.
  for (const [day, mm] of Object.entries(store.daily ?? {})) {
    if (day < today && day >= from && !out.has(day)) out.set(day, mm);
  }
  return out;
}

/** Pisa la lluvia del modelo con la medida en los días pasados que tienen dato. */
export function withDmcRain(
  days: DailyWeather[],
  observed: Map<ISODate, number>,
  cfg: DmcConfig | undefined,
  today: ISODate,
): { days: DailyWeather[]; source: string | null; observed: Map<ISODate, number> } {
  if (!cfg || !observed.size) return { days, source: null, observed: new Map() };
  return {
    days: days.map((d) => (d.date < today && observed.has(d.date) ? { ...d, precipitationMm: observed.get(d.date)! } : d)),
    source: `${cfg.name} (${cfg.distanceKm.toFixed(1).replace('.', ',')} km) · DMC`,
    observed,
  };
}

/** La estación no está publicando: su lectura de lluvia más nueva tiene más de 3 h (o no hay ninguna). */
export function storeIsStale(store: DmcStore | null, now: number): boolean {
  const last = store?.pts.length ? store.pts[store.pts.length - 1][0] : null;
  return last === null || now - last > STALE_STATION_MS;
}

/** ¿Hay que guardar el almacén? Solo si hubo consulta nueva o cambiaron los pares de ET0 (evita escribir cada 5 min). */
export function storeChanged(next: DmcStore | null, prev: DmcStore | null): boolean {
  if (!next) return false;
  return (
    !prev || next.attemptAt !== prev.attemptAt || next.code !== prev.code || JSON.stringify(next.et0Pairs) !== JSON.stringify(prev.et0Pairs)
  );
}

/** Guarda pares (ET0 estación, ET0 modelo) por día para medir el sesgo del modelo. */
export function recordEt0Pairs(store: DmcStore, station: Map<ISODate, number>, modelDays: DailyWeather[], today: ISODate): DmcStore {
  if (!station.size) return store;
  const pairs: Record<ISODate, [number, number]> = { ...(store.et0Pairs ?? {}) };
  for (const [day, et0] of station) {
    const model = modelDays.find((d) => d.date === day)?.et0Mm;
    if (model !== undefined && model > 0) pairs[day] = [et0, Math.round(model * 100) / 100];
  }
  const keep = addDays(today, -14);
  return { ...store, et0Pairs: Object.fromEntries(Object.entries(pairs).filter(([d]) => d >= keep)) };
}
