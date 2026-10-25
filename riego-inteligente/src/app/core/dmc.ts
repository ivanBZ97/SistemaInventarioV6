// Lluvia OBSERVADA de las estaciones automáticas (EMA) de la Dirección Meteorológica de Chile.
// Usa el recurso JSON público de datos recientes del Portal de Servicios Climáticos (sin clave):
//   https://climatologia.meteochile.gob.cl/application/productos/datosRecientesEma/<código>
// que entrega ~24 h de lecturas. Como cada consulta cubre solo un día, las lecturas se guardan en un
// almacén local (la app y el worker tienen el suyo) y con él se arman los días completos.
// La variante mensual (…/<código>/<año>/<mes>) hoy exige usuario y token, por eso no se usa.
// Funciones sin dependencias de Angular: las usan la app y el worker en segundo plano.
import { addDays, distanceKm, toISODate } from './irrigation-core';
import { DMC_STATIONS_FALLBACK } from './dmc-stations';
import type { DailyWeather, DmcConfig, ISODate } from './models';

const BASE = 'https://climatologia.meteochile.gob.cl/application/productos';

export interface DmcStation {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
}

export interface DmcSample {
  momento: string;
  [field: string]: unknown;
}

/** "0.2 mm", "12,5 °C", 3 → número (la DMC entrega los valores con su unidad). */
export function unitNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v);
  return m ? parseFloat(m[0].replace(',', '.')) : null;
}

/** Los `momento` de la DMC vienen en UTC; se devuelve el instante como Date. */
export function parseMomento(momento: string): Date | null {
  const s = momento.trim().replace(' ', 'T');
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ───────────── Estaciones ─────────────

export async function listDmcStations(): Promise<DmcStation[]> {
  try {
    const res = await fetch(`${BASE}/estacionesRedEma`);
    if (res.ok) {
      const json = (await res.json()) as { datosEstacion?: Record<string, unknown>[] };
      const live = (json.datosEstacion ?? []).flatMap((r) => {
        const latitude = unitNumber(r['latitud']);
        const longitude = unitNumber(r['longitud']);
        if (latitude === null || longitude === null || !r['codigoNacional']) return [];
        return [{
          code: String(r['codigoNacional']).trim(),
          name: String(r['nombreEstacion'] ?? '').trim(),
          latitude,
          longitude,
          elevationM: unitNumber(r['altura']),
        }];
      });
      if (live.length) return live;
    }
  } catch {
    /* sin servicio: se usa el catastro incluido en la app */
  }
  return DMC_STATIONS_FALLBACK.map(([code, name, latitude, longitude, elevationM]) => ({ code, name, latitude, longitude, elevationM }));
}

export function nearestDmcStation(stations: DmcStation[], lat: number, lon: number): (DmcStation & { distanceKm: number }) | null {
  let best: (DmcStation & { distanceKm: number }) | null = null;
  for (const s of stations) {
    const d = distanceKm(lat, lon, s.latitude, s.longitude);
    if (!best || d < best.distanceKm) best = { ...s, distanceKm: d };
  }
  return best;
}

// ───────────── Datos de la estación ─────────────

/** Extrae las muestras de la respuesta (`datosEstaciones.datos`, tolerando variantes del formato). */
export function parseDmcSamples(json: unknown): DmcSample[] {
  const out: DmcSample[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length && node.every((x) => x && typeof x === 'object' && 'momento' in x)) {
        out.push(...(node as DmcSample[]));
        return;
      }
      node.forEach((x) => visit(x, depth + 1));
      return;
    }
    Object.values(node as Record<string, unknown>).forEach((v) => visit(v, depth + 1));
  };
  visit(json, 0);
  return out;
}

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

const MAX_GAP_MS = 60 * 60_000;

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

/** Lluvia total de un conjunto de lecturas (p. ej. las últimas 24 h de una consulta). */
export function totalRain(points: RainPoint[], kind: RainKind): number {
  let mm = 0;
  for (const d of dailyRainFromPoints(points, kind).values()) mm += d.mm;
  return Math.round(mm * 10) / 10;
}

// ───────────── Almacén local de lecturas ─────────────

export interface DmcStore {
  code: string;
  field?: string;
  kind?: RainKind;
  /** Última consulta (exitosa o no) y si resultó bien: evita reintentar cada 15 min si el servicio falla. */
  attemptAt: number;
  ok: boolean;
  pts: RainPoint[];
}

const KEEP_MS = 5 * 86_400_000;
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

export function mergeStore(prev: DmcStore | null, code: string, rf: RainField, pts: RainPoint[], now: number): DmcStore {
  const same = prev && prev.code === code && prev.field === rf.field;
  const map = new Map<number, number>(same ? prev!.pts : []);
  pts.forEach(([t, v]) => map.set(t, v));
  const merged = [...map].filter(([t]) => t >= now - KEEP_MS).sort((a, b) => a[0] - b[0]);
  return { code, field: rf.field, kind: rf.kind, attemptAt: now, ok: true, pts: merged };
}

export interface RecentFetch {
  ok: boolean;
  status: number;
  samples: DmcSample[];
  error?: string;
}

export async function fetchRecent(code: string): Promise<RecentFetch> {
  try {
    const res = await fetch(`${BASE}/datosRecientesEma/${code}`);
    if (!res.ok) return { ok: false, status: res.status, samples: [] };
    return { ok: true, status: res.status, samples: parseDmcSamples(await res.json()) };
  } catch (e) {
    return { ok: false, status: 0, samples: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Consulta la estación si el almacén está viejo (o si `force`) y agrega las lecturas nuevas. Nunca lanza.
 * Tras un fallo espera 1 h antes de reintentar, salvo que se fuerce (botón "Probar").
 */
export async function refreshDmcStore(
  store: DmcStore | null,
  code: string,
  now: number,
  maxAgeMs: number,
  force = false,
): Promise<{ store: DmcStore; fetched?: RecentFetch; rain?: RainField | null }> {
  const current = store && store.code === code ? store : null;
  const wait = current?.ok ? maxAgeMs : RETRY_AFTER_FAILURE_MS;
  if (!force && current && now - current.attemptAt < wait) return { store: current };
  const fetched = await fetchRecent(code);
  const rain = fetched.ok ? detectRainField(fetched.samples) : null;
  if (!fetched.ok || !rain) {
    const failed: DmcStore = { ...(current ?? { code, pts: [] }), attemptAt: now, ok: false };
    return { store: failed, fetched, rain };
  }
  return { store: mergeStore(current, code, rain, rainPoints(fetched.samples, rain), now), fetched, rain };
}

/** Días ya cerrados (antes de hoy, últimos 4) con al menos 20 h de lecturas → lluvia medida. */
export function observedFromStore(store: DmcStore | null, code: string, today: ISODate, minHours = 20): Map<ISODate, number> {
  const out = new Map<ISODate, number>();
  if (!store || store.code !== code || !store.kind || !store.pts.length) return out;
  for (const [day, r] of dailyRainFromPoints(store.pts, store.kind)) {
    if (day < today && day >= addDays(today, -4) && r.coveredHours >= minHours) out.set(day, r.mm);
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

// ───────────── Diagnóstico ("Probar") ─────────────

const fmtMm = (v: number) => `${String(Math.round(v * 10) / 10).replace('.', ',')} mm`;
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function probe(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return `HTTP ${res.status}`;
    const json = (await res.json()) as unknown;
    const keys = json && typeof json === 'object' ? Object.keys(json as object).slice(0, 6).join(', ') : typeof json;
    return `OK (${keys})`;
  } catch (e) {
    return `sin respuesta (${e instanceof Error ? e.message : e})`;
  }
}

/**
 * Prueba la estación y explica qué entregó: sirve para verificar contra agrometeorologia.cl y, si algo
 * cambió en la DMC, para saber qué ajustar. También agrega las lecturas al almacén.
 */
export async function diagnoseDmc(
  code: string,
  store: DmcStore | null,
  today: ISODate,
  now = Date.now(),
): Promise<{ ok: boolean; lines: string[]; store: DmcStore }> {
  const lines: string[] = [];
  const { store: next, fetched, rain } = await refreshDmcStore(store, code, now, 0, true);
  const f: RecentFetch = fetched ?? { ok: false, status: 0, samples: [], error: 'sin consulta' };
  if (!f.ok) {
    lines.push(`Datos recientes (${code}): ${f.status ? `HTTP ${f.status}` : `sin respuesta${f.error ? ` (${f.error})` : ''}`}.`);
  } else if (!f.samples.length) {
    lines.push(`Datos recientes (${code}): la respuesta no trae lecturas con "momento".`);
  } else if (!rain) {
    const keys = [...new Set(f.samples.slice(0, 5).flatMap((s) => Object.keys(s)))].slice(0, 14).join(', ');
    lines.push(`Datos recientes: ${f.samples.length} lecturas, pero sin campo de lluvia reconocible. Campos: ${keys}.`);
  } else {
    const pts = rainPoints(f.samples, rain);
    if (pts.length) {
      lines.push(`✓ Datos recientes: ${pts.length} lecturas, de ${hhmm(pts[0][0])} a ${hhmm(pts[pts.length - 1][0])} · campo ${rain.field}.`);
      lines.push(`Lluvia en ese periodo: ${fmtMm(totalRain(pts, rain.kind))} (compárala con "Últimas 24 Horas" en agrometeorologia.cl).`);
    } else {
      lines.push(`Datos recientes: ${f.samples.length} lecturas, pero ninguna con valor de ${rain.field}.`);
    }
  }
  const days = observedFromStore(next, code, today);
  lines.push(
    days.size
      ? `Días completos guardados: ${[...days].sort().map(([d, mm]) => `${d.slice(8)}/${d.slice(5, 7)} ${fmtMm(mm)}`).join(' · ')}.`
      : 'Aún no hay días completos guardados: se completan solos con el uso (cada consulta trae ~24 h).',
  );
  lines.push(`Catastro de estaciones: ${await probe(`${BASE}/estacionesRedEma`)} · Resumen diario: ${await probe(`${BASE}/emaResumenDiario/${code}`)}.`);
  return { ok: f.ok && !!rain, lines, store: next };
}
