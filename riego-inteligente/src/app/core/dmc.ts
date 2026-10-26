// Lluvia OBSERVADA de las estaciones automáticas (EMA) de la Dirección Meteorológica de Chile.
// Servicio oficial documentado (usuario + token gratuitos del Portal de Servicios Climáticos):
//   https://climatologia.meteochile.gob.cl/application/servicios/getDatosRecientesEma/<código>?usuario=…&token=…
// Sin credenciales se intenta el antiguo acceso público (…/productos/datosRecientesEma/<código>), que en
// octubre de 2026 responde 404. Cada consulta trae solo las últimas horas, así que las lecturas se guardan
// en un almacén local (la app y el worker tienen el suyo) y con él se arman los días completos.
// Funciones sin dependencias de Angular: las usan la app y el worker en segundo plano.
import { RAINING_NOW_MM, addDays, atTime, distanceKm, toISODate } from './irrigation-core';
import { DMC_STATIONS_FALLBACK } from './dmc-stations';
import { type DailyMet, WIND_10M_TO_2M, et0PenmanMonteith, satVapourPressure } from './fao56';
import type { DailyWeather, DmcAuth, DmcConfig, ISODate, LiveRain } from './models';

const BASE = 'https://climatologia.meteochile.gob.cl/application/productos';
const SERVICES = 'https://climatologia.meteochile.gob.cl/application/servicios';
const WIS2 = 'https://wischile.meteochile.gob.cl/oapi';

const hasAuth = (auth?: DmcAuth): auth is DmcAuth => !!auth?.user?.trim() && !!auth?.token?.trim();

function authQuery(auth: DmcAuth): string {
  return `usuario=${encodeURIComponent(auth.user.trim())}&token=${encodeURIComponent(auth.token.trim())}`;
}

/** URL de los datos recientes de una estación: servicio con token si hay credenciales, si no el público. */
export function recentUrl(code: string, auth?: DmcAuth): string {
  return hasAuth(auth) ? `${SERVICES}/getDatosRecientesEma/${code}?${authQuery(auth)}` : `${BASE}/datosRecientesEma/${code}`;
}

/** Quita usuario y token de un texto (para mostrar o copiar diagnósticos sin filtrar credenciales). */
export function redact(text: string, auth?: DmcAuth): string {
  let out = text;
  for (const secret of [auth?.user, auth?.token]) {
    const v = secret?.trim();
    if (!v) continue;
    for (const form of new Set([v, encodeURIComponent(v)])) out = out.split(form).join('***');
  }
  return out;
}

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

/** Las `n` estaciones más cercanas a un punto, de la más cercana a la más lejana. */
export function nearbyDmcStations(stations: DmcStation[], lat: number, lon: number, n: number): (DmcStation & { distanceKm: number })[] {
  return stations
    .map((s) => ({ ...s, distanceKm: distanceKm(lat, lon, s.latitude, s.longitude) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n);
}

/** Estaciones a revisar al conectar: las `n` más cercanas dentro de `maxKm` (la más cercana siempre). */
export function stationsToCheck(stations: DmcStation[], lat: number, lon: number, n = 6, maxKm = 40): (DmcStation & { distanceKm: number })[] {
  return nearbyDmcStations(stations, lat, lon, n).filter((s, i) => i === 0 || s.distanceKm <= maxKm);
}

/** live: lectura de hace ≤ 90 min · late: de hace ≤ 24 h · stale: más vieja o sin lecturas · error: no respondió. */
export type StationHealth = 'live' | 'late' | 'stale' | 'error';

export interface StationCheck extends DmcStation {
  distanceKm: number;
  health: StationHealth;
  /** Instante de la lectura más nueva que entrega la DMC (cualquier dato). */
  newest: number | null;
  readings: number;
  /** Por qué no respondió ("HTTP 500", "sin conexión"). */
  error?: string;
  /** Inicio de la respuesta cuando no trae lecturas (sin credenciales): p. ej. un aviso de token inválido. */
  snippet?: string;
}

/** Revisa si una estación está enviando datos: consulta sus lecturas recientes y mira la más nueva. */
export async function checkStation(st: DmcStation & { distanceKm: number }, auth: DmcAuth | undefined, now: number): Promise<StationCheck> {
  const { f, newest } = await newestReading(st.code, auth);
  const base = { ...st, newest, readings: f.samples.length, snippet: f.snippet };
  if (!f.ok) return { ...base, health: 'error', error: f.status ? `HTTP ${f.status}` : 'sin conexión' };
  if (newest === null) return { ...base, health: 'stale' };
  const age = now - newest;
  return { ...base, health: age <= LIVE_FRESH_MS ? 'live' : age <= 24 * 3_600_000 ? 'late' : 'stale' };
}

/** Revisa varias estaciones, de a 3 a la vez, avisando cada resultado (para ir llenando la lista). */
export async function checkStations(
  stations: (DmcStation & { distanceKm: number })[],
  auth: DmcAuth | undefined,
  now: number,
  onResult?: (c: StationCheck) => void,
): Promise<StationCheck[]> {
  const out: StationCheck[] = [];
  let next = 0;
  const worker = async () => {
    while (next < stations.length) {
      const c = await checkStation(stations[next++], auth, now);
      out.push(c);
      onResult?.(c);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

/** La estación que conviene usar: la más cercana al día; si ninguna, la más cercana con datos de las últimas 24 h. */
export function bestStation(checks: StationCheck[]): StationCheck | null {
  const byDistance = [...checks].sort((a, b) => a.distanceKm - b.distanceKm);
  return byDistance.find((c) => c.health === 'live') ?? byDistance.find((c) => c.health === 'late') ?? null;
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

/** Lluvia total de un conjunto de lecturas (p. ej. las ~12 h de una consulta). */
export function totalRain(points: RainPoint[], kind: RainKind): number {
  let mm = 0;
  for (const d of dailyRainFromPoints(points, kind).values()) mm += d.mm;
  return Math.round(mm * 10) / 10;
}

const BUCKET_MS = 10 * 60_000;

/** Deja la última lectura de cada bloque de 10 min (el acumulado no pierde información; ocupa ~10× menos). */
export function downsampleAccumulated(points: RainPoint[]): RainPoint[] {
  const byBucket = new Map<number, RainPoint>();
  for (const p of [...points].sort((a, b) => a[0] - b[0])) byBucket.set(Math.floor(p[0] / BUCKET_MS), p);
  return [...byBucket.values()];
}

// ───────────── Meteorología de la estación → ET0 (FAO-56) ─────────────

export type WindUnit = 'kt' | 'km/h' | 'm/s';
const WIND_TO_MS: Record<WindUnit, number> = { kt: 0.514444, 'km/h': 1 / 3.6, 'm/s': 1 };

/** Campos de la estación necesarios para la ET0. */
export interface MetFields {
  temp: string;
  rh: string;
  rad: string;
  wind: string;
  windUnit: WindUnit;
  /** true si la unidad del viento no venía en el dato y se supuso (nudos, estándar aeronáutico de la DMC). */
  windUnitAssumed: boolean;
}

export function detectMetFields(samples: DmcSample[]): { fields: MetFields | null; missing: string[]; keys: string[] } {
  const keys = [...new Set(samples.slice(0, 50).flatMap((s) => Object.keys(s)))];
  const pick = (exact: string, re: RegExp) => (keys.includes(exact) ? exact : keys.find((k) => re.test(k)));
  const temp = pick('temperatura', /^temperatura(Aire|DelAire)?$/i);
  const rh = pick('humedadRelativa', /^humedad.*relativa$/i);
  const rad = pick('radiacionGlobalInst', /radiacion.*global/i);
  const wind = pick('fuerzaDelVientoPromedio10Minutos', /(fuerza|velocidad).*viento.*promedio/i) ?? keys.find((k) => /^(fuerza|velocidad)DelViento$/i.test(k));
  const missing = [
    !temp && 'temperatura',
    !rh && 'humedad relativa',
    !rad && 'radiación global',
    !wind && 'viento',
  ].filter((x): x is string => !!x);
  if (!temp || !rh || !rad || !wind) return { fields: null, missing, keys };
  const raw = samples.map((s) => s[wind]).find((v) => typeof v === 'string' && /[a-z]/i.test(v)) as string | undefined;
  const windUnit: WindUnit = raw && /km/i.test(raw) ? 'km/h' : raw && /m\/s/i.test(raw) ? 'm/s' : 'kt';
  return { fields: { temp, rh, rad, wind, windUnit, windUnitAssumed: !raw }, missing, keys };
}

/** [inicio del bloque (ms), n.º de lecturas, Tmín, Tmáx, ea media (kPa), radiación media (W/m²), viento medio (m/s, a 10 m)] */
export type MetBucket = [number, number, number, number, number, number, number];

export function metBuckets(samples: DmcSample[], f: MetFields): MetBucket[] {
  const acc = new Map<number, { n: number; tmin: number; tmax: number; ea: number; rad: number; wind: number }>();
  for (const s of samples) {
    const t = parseMomento(String(s.momento));
    const temp = unitNumber(s[f.temp]);
    const rh = unitNumber(s[f.rh]);
    const rad = unitNumber(s[f.rad]);
    const wind = unitNumber(s[f.wind]);
    if (!t || temp === null || rh === null || rad === null || wind === null) continue;
    if (rh < 0 || rh > 100 || temp < -30 || temp > 50 || rad < 0 || rad > 1500 || wind < 0) continue;
    const key = Math.floor(t.getTime() / BUCKET_MS) * BUCKET_MS;
    const a = acc.get(key) ?? { n: 0, tmin: Infinity, tmax: -Infinity, ea: 0, rad: 0, wind: 0 };
    a.n++;
    a.tmin = Math.min(a.tmin, temp);
    a.tmax = Math.max(a.tmax, temp);
    a.ea += (satVapourPressure(temp) * rh) / 100;
    a.rad += rad;
    a.wind += wind * WIND_TO_MS[f.windUnit];
    acc.set(key, a);
  }
  const r = (v: number, k: number) => Math.round(v * k) / k;
  return [...acc]
    .sort((a, b) => a[0] - b[0])
    .map(([start, a]) => [start, a.n, r(a.tmin, 10), r(a.tmax, 10), r(a.ea / a.n, 1000), r(a.rad / a.n, 1), r(a.wind / a.n, 100)]);
}

/** Junta bloques de varias consultas: si un bloque viene en ambas, gana el que tiene más lecturas. */
export function mergeMetBuckets(prev: MetBucket[], next: MetBucket[], now: number): MetBucket[] {
  const map = new Map<number, MetBucket>(prev.map((b) => [b[0], b]));
  for (const b of next) {
    const old = map.get(b[0]);
    if (!old || b[1] >= old[1]) map.set(b[0], b);
  }
  return [...map.values()].filter((b) => b[0] >= now - KEEP_MS).sort((a, b) => a[0] - b[0]);
}

/** Variables diarias (día local) a partir de los bloques; solo cuentan los bloques con ≥ 3 lecturas. */
export function dailyMetFromBuckets(buckets: MetBucket[]): Map<ISODate, DailyMet & { coveredHours: number }> {
  const days = new Map<ISODate, { n: number; tmin: number; tmax: number; ea: number; rad: number; wind: number }>();
  for (const [start, n, tmin, tmax, ea, rad, wind] of buckets) {
    if (n < 3) continue;
    const day = toISODate(new Date(start + BUCKET_MS / 2));
    const d = days.get(day) ?? { n: 0, tmin: Infinity, tmax: -Infinity, ea: 0, rad: 0, wind: 0 };
    d.n++;
    d.tmin = Math.min(d.tmin, tmin);
    d.tmax = Math.max(d.tmax, tmax);
    d.ea += ea;
    d.rad += rad;
    d.wind += wind;
    days.set(day, d);
  }
  const out = new Map<ISODate, DailyMet & { coveredHours: number }>();
  for (const [day, d] of days) {
    out.set(day, {
      tmaxC: d.tmax,
      tminC: d.tmin,
      eaKpa: d.ea / d.n,
      rsMJ: (d.rad / d.n) * 0.0864, // W/m² medio del día → MJ/m²/día
      u2: (d.wind / d.n) * WIND_10M_TO_2M, // anemómetro a 10 m (estándar de las EMA)
      coveredHours: (d.n * BUCKET_MS) / 3_600_000,
    });
  }
  return out;
}

export interface StationMeta {
  latitude: number;
  elevationM: number;
}

/** Latitud y altura de la estación (de la configuración o del catastro incluido). */
export function stationMeta(cfg: DmcConfig, fallbackLat: number, fallbackElevation: number | null): StationMeta {
  const known = DMC_STATIONS_FALLBACK.find(([code]) => code === cfg.code);
  return {
    latitude: cfg.latitude ?? known?.[2] ?? fallbackLat,
    elevationM: cfg.elevationM ?? known?.[4] ?? fallbackElevation ?? 0,
  };
}

/** ET0 medida (mm/día) de los días ya cerrados con ≥ 21 h de lecturas y valores plausibles. */
export function stationEt0(buckets: MetBucket[], meta: StationMeta, today: ISODate, minHours = 21): Map<ISODate, number> {
  const out = new Map<ISODate, number>();
  for (const [day, m] of dailyMetFromBuckets(buckets)) {
    if (day >= today || day < addDays(today, -4) || m.coveredHours < minHours) continue;
    const plausible = m.tmaxC <= 48 && m.tminC >= -15 && m.tminC <= m.tmaxC && m.u2 <= 20 && m.eaKpa <= satVapourPressure(m.tmaxC) + 0.2;
    if (!plausible) continue;
    const et0 = et0PenmanMonteith(m, meta.latitude, meta.elevationM, day);
    if (et0 >= 0 && et0 <= 12) out.set(day, Math.round(et0 * 10) / 10);
  }
  return out;
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

/** Corrección del pronóstico de ET0: estación ÷ modelo en los últimos 7 días (≥ 2 días), limitada a ±20 %. */
export function et0Correction(pairs: Record<ISODate, [number, number]> | undefined, today: ISODate): { ratio: number; days: number } | null {
  const recent = Object.entries(pairs ?? {}).filter(([d]) => d < today && d >= addDays(today, -7));
  if (recent.length < 2) return null;
  const st = recent.reduce((s, [, p]) => s + p[0], 0);
  const mo = recent.reduce((s, [, p]) => s + p[1], 0);
  if (mo <= 0) return null;
  const ratio = Math.min(1.2, Math.max(0.8, st / mo));
  return { ratio: Math.round(ratio * 100) / 100, days: recent.length };
}

/** Días pasados: ET0 medida. Hoy y días futuros: ET0 del modelo corregida por su sesgo reciente. */
export function withStationEt0(
  days: DailyWeather[],
  station: Map<ISODate, number>,
  correction: { ratio: number } | null,
  today: ISODate,
): DailyWeather[] {
  return days.map((d) => {
    if (d.date < today && station.has(d.date)) return { ...d, et0Mm: station.get(d.date)! };
    if (d.date >= today && correction) return { ...d, et0Mm: Math.round(d.et0Mm * correction.ratio * 100) / 100 };
    return d;
  });
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

const KEEP_MS = 5 * 86_400_000;
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
const SUMMARY_EVERY_MS = 3 * 3_600_000;

export function mergeStore(prev: DmcStore | null, code: string, rf: RainField, pts: RainPoint[], now: number): DmcStore {
  const same = prev && prev.code === code && prev.field === rf.field;
  const map = new Map<number, number>(same ? prev!.pts : []);
  pts.forEach(([t, v]) => map.set(t, v));
  let merged: RainPoint[] = [...map].filter(([t]) => t >= now - KEEP_MS).sort((a, b) => a[0] - b[0]);
  if (rf.kind === 'accumulated') merged = downsampleAccumulated(merged);
  const keep =
    prev?.code === code ? { daily: prev.daily, met: prev.met, metFields: prev.metFields, et0Pairs: prev.et0Pairs, summaryAt: prev.summaryAt } : {};
  return { ...keep, code, field: rf.field, kind: rf.kind, attemptAt: now, ok: true, pts: merged };
}

// ───────────── Resumen diario oficial (con token) ─────────────

/** "24-10-2026", "24/10/2026" o "2026-10-24" → fecha ISO. */
export function parseDmcDate(s: unknown): ISODate | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  let m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Lluvia diaria del resumen diario de la DMC: bloque `aguaCaidaDiaria` (fecha dd-mm-aaaa + valor en mm).
 * Tolera variantes (arreglo, objeto por fecha, hoy/ayer anidados). No usa `aguaCaidaDiariaEstacion`.
 */
export function parseDailySummary(json: unknown): Map<ISODate, number> {
  const out = new Map<ISODate, number>();
  const take = (fecha: unknown, valor: unknown) => {
    const d = parseDmcDate(fecha);
    const v = unitNumber(valor);
    if (d && v !== null && v >= 0) out.set(d, v);
  };
  const read = (block: unknown, depth: number): void => {
    if (depth > 3 || block === null || typeof block !== 'object') return;
    if (Array.isArray(block)) return block.forEach((b) => read(b, depth + 1));
    const o = block as Record<string, unknown>;
    if ('fecha' in o && ('valor' in o || 'value' in o)) return take(o['fecha'], o['valor'] ?? o['value']);
    for (const [k, v] of Object.entries(o)) {
      if (parseDmcDate(k)) take(k, v && typeof v === 'object' ? ((v as Record<string, unknown>)['valor'] ?? (v as Record<string, unknown>)['value']) : v);
      else read(v, depth + 1);
    }
  };
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'aguaCaidaDiaria') read(v, 0);
      else visit(v, depth + 1);
    }
  };
  visit(json, 0);
  return out;
}

/** Fragmento del resumen donde están los datos de lluvia (para el diagnóstico si no se pudo leer). */
function summarySnippet(json: unknown, auth?: DmcAuth): string {
  let found: unknown = null;
  const visit = (node: unknown, depth: number): void => {
    if (found || depth > 6 || node === null || typeof node !== 'object') return;
    if (!Array.isArray(node) && Object.keys(node as object).some((k) => k.startsWith('aguaCaida'))) {
      found = node;
      return;
    }
    Object.values(node as object).forEach((v) => visit(v, depth + 1));
  };
  visit(json, 0);
  return redact(JSON.stringify(found ?? json).slice(0, 420), auth);
}

export interface SummaryFetch {
  status: number;
  daily: Map<ISODate, number>;
  snippet?: string;
}

export async function fetchDailySummary(code: string, auth: DmcAuth): Promise<SummaryFetch> {
  try {
    const res = await fetch(`${SERVICES}/getEmaResumenDiario/${code}?${authQuery(auth)}`);
    if (!res.ok) return { status: res.status, daily: new Map() };
    const json = (await res.json()) as unknown;
    const daily = parseDailySummary(json);
    return { status: res.status, daily, snippet: daily.size ? undefined : summarySnippet(json, auth) };
  } catch {
    return { status: 0, daily: new Map() };
  }
}

function mergeDaily(store: DmcStore, daily: Map<ISODate, number>, today: ISODate): DmcStore {
  if (!daily.size) return store;
  const keep = addDays(today, -10);
  const merged = { ...(store.daily ?? {}), ...Object.fromEntries(daily) };
  return { ...store, daily: Object.fromEntries(Object.entries(merged).filter(([d]) => d >= keep)) };
}

export interface RecentFetch {
  ok: boolean;
  status: number;
  samples: DmcSample[];
  error?: string;
  /** Inicio de la respuesta (sin credenciales) cuando no trae lecturas: ayuda a diagnosticar. */
  snippet?: string;
}

async function bodySnippet(res: { text?: () => Promise<string> }, auth?: DmcAuth): Promise<string | undefined> {
  try {
    const t = res.text ? await res.text() : '';
    return t ? redact(t.replace(/\s+/g, ' ').slice(0, 180), auth) : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchRecent(code: string, auth?: DmcAuth): Promise<RecentFetch> {
  try {
    const res = await fetch(recentUrl(code, auth));
    if (!res.ok) return { ok: false, status: res.status, samples: [], snippet: await bodySnippet(res, auth) };
    const json = (await res.json()) as unknown;
    const samples = parseDmcSamples(json);
    const snippet = samples.length ? undefined : redact(JSON.stringify(json).slice(0, 180), auth);
    return { ok: true, status: res.status, samples, snippet };
  } catch (e) {
    return { ok: false, status: 0, samples: [], error: redact(e instanceof Error ? e.message : String(e), auth) };
  }
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
  const error = !fetched.ok ? (fetched.status ? `HTTP ${fetched.status}` : 'sin conexión') : !fetched.samples.length ? 'sin lecturas' : 'sin campo de lluvia';
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

// ───────────── Lluvia de hoy, casi en tiempo real ─────────────

/** Una lectura más vieja que esto (la DMC publica con ~25 min de atraso) ya no dice si está lloviendo. */
export const LIVE_FRESH_MS = 90 * 60_000;

/**
 * Lluvia de hoy hasta la última lectura guardada, por hora y por bloque de 10 min. Un acumulado necesita la
 * lectura anterior: sin ella (o con un hueco largo desde ayer) se cuenta desde la primera lectura de hoy.
 */
export function liveRainFromStore(store: DmcStore | null, code: string, today: ISODate, now: number): LiveRain | null {
  if (!store || store.code !== code || !store.kind || !store.pts.length) return null;
  const pts = [...store.pts].sort((a, b) => a[0] - b[0]);
  const lastAtMs = pts[pts.length - 1][0];
  const hourly = new Array<number>(24).fill(0);
  const steps: [number, number][] = [];
  let sinceMs: number | null = null;
  let lastHour = 0;
  for (let i = 0; i < pts.length; i++) {
    const [t, v] = pts[i];
    const prev = pts[i - 1];
    const linked = !!prev && t - prev[0] <= MAX_GAP_MS;
    // Lluvia del intervalo que termina en esta lectura (si el acumulado baja, hubo reinicio).
    const mm = store.kind === 'increment' ? v : !prev ? null : v >= prev[1] ? v - prev[1] : v;
    if (mm !== null && (linked || store.kind === 'increment') && t > lastAtMs - 3_600_000) lastHour += mm;
    if (toISODate(new Date(t)) !== today) continue;
    const fromYesterday = !!prev && toISODate(new Date(prev[0])) !== today;
    if (sinceMs === null) sinceMs = fromYesterday && linked ? atTime(today, { hour: 0, minute: 0 }).getTime() : t;
    // Un intervalo que empezó ayer con un hueco largo no se puede repartir entre los dos días.
    if (mm === null || mm <= 0 || (store.kind === 'accumulated' && fromYesterday && !linked)) continue;
    steps.push([t, Math.round(mm * 100) / 100]);
    hourly[new Date(t).getHours()] += mm;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const lastHourMm = r1(lastHour);
  return {
    date: today,
    mm: r1(steps.reduce((s, [, x]) => s + x, 0)),
    sinceMs,
    lastAtMs,
    lastHourMm,
    rainingNow: now - lastAtMs <= LIVE_FRESH_MS && lastHourMm >= RAINING_NOW_MM,
    hourly: hourly.map(r1),
    steps,
  };
}

/** Agrega a hoy la lluvia ya medida (ver `dayRain`): el balance de hoy y el aviso de la mañana la consideran. */
export function withLiveRain(days: DailyWeather[], live: LiveRain | null, today: ISODate): DailyWeather[] {
  if (!live || live.date !== today) return days;
  return days.map((d) => (d.date === today ? { ...d, live } : d));
}

/**
 * Cada cuánto consultar la estación en segundo plano (cada consulta trae ~12 h): cada 30 min si llueve, si se
 * pronostica lluvia o en la hora y media antes del aviso de la mañana; si no, cada 2 h.
 */
export function backgroundStationMaxAgeMs(
  now: number,
  live: LiveRain | null,
  today: DailyWeather | undefined,
  morning: { hour: number; minute: number },
): number {
  const wet = !!live && (live.lastHourMm > 0 || live.steps.some(([t]) => t >= live.lastAtMs - 3 * 3_600_000));
  const likely = !!today && (today.precipitationMm >= 1 || today.precipitationProbMax >= 30);
  const alertAt = atTime(toISODate(new Date(now)), morning).getTime();
  const beforeAlert = now >= alertAt - 90 * 60_000 && now < alertAt;
  return wet || likely || beforeAlert ? 30 * 60_000 : 2 * 3_600_000;
}

// ───────────── Diagnóstico ("Probar") ─────────────

const fmtMm = (v: number) => `${String(Math.round(v * 10) / 10).replace('.', ',')} mm`;
const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${clock(t)}`;
};

/** Prueba un recurso y resume qué devolvió (estado, claves y el inicio del contenido, sin credenciales). */
async function probe(url: string, auth?: DmcAuth, describe?: (json: unknown) => string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return `HTTP ${res.status}`;
    const json = (await res.json()) as unknown;
    if (describe) return redact(`OK · ${describe(json)}`, auth);
    const keys = json && typeof json === 'object' ? Object.keys(json as object).slice(0, 8).join(', ') : typeof json;
    return redact(`OK · claves: ${keys} · ${JSON.stringify(json).slice(0, 160)}`, auth);
  } catch (e) {
    return `sin respuesta (${redact(e instanceof Error ? e.message : String(e), auth)})`;
  }
}

/** "45 min", "5 h", "2 días" */
const ageText = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min < 120 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.floor(min / 1440)} días`;
};

/** Una lectura de más de 3 h indica que la DMC no está recibiendo datos de la estación. */
const STALE_STATION_MS = 3 * 3_600_000;

/** Lectura más nueva (cualquier dato) que entrega la DMC para una estación. */
async function newestReading(code: string, auth?: DmcAuth): Promise<{ f: RecentFetch; newest: number | null }> {
  const f = await fetchRecent(code, auth);
  const ts = f.samples.map((s) => parseMomento(String(s.momento))?.getTime() ?? 0).filter((t) => t > 0);
  return { f, newest: ts.length ? Math.max(...ts) : null };
}

const wis2Collections = (json: unknown): string => {
  const cols = (json as { collections?: { id?: string }[] })?.collections ?? [];
  return `${cols.length} colecciones: ${cols.slice(0, 8).map((c) => c.id).join(', ')}`;
};

/**
 * Prueba la estación y explica qué entregó: sirve para verificar contra agrometeorologia.cl y, si algo
 * cambió en la DMC, para saber qué ajustar. También agrega las lecturas al almacén.
 */
export async function diagnoseDmc(
  code: string,
  store: DmcStore | null,
  today: ISODate,
  now = Date.now(),
  auth?: DmcAuth,
  meta?: StationMeta,
  alternatives: { code: string; name: string; distanceKm: number }[] = [],
): Promise<{ ok: boolean; lines: string[]; store: DmcStore }> {
  const lines: string[] = [hasAuth(auth) ? 'Modo: servicio oficial con usuario y token.' : 'Modo: acceso público (sin token).'];
  const { store: next, fetched, rain, summary } = await refreshDmcStore(store, code, now, 0, true, auth);
  const f: RecentFetch = fetched ?? { ok: false, status: 0, samples: [], error: 'sin consulta' };
  if (!f.ok) {
    lines.push(`Datos recientes (${code}): ${f.status ? `HTTP ${f.status}` : `sin respuesta${f.error ? ` (${f.error})` : ''}`}.`);
    if (f.snippet) lines.push(`Respuesta: ${f.snippet}`);
  } else if (!f.samples.length) {
    lines.push(`Datos recientes (${code}): la respuesta no trae lecturas con "momento".`);
    if (f.snippet) lines.push(`Respuesta: ${f.snippet}`);
  } else if (!rain) {
    const keys = [...new Set(f.samples.slice(0, 5).flatMap((s) => Object.keys(s)))].slice(0, 14).join(', ');
    lines.push(`Datos recientes: ${f.samples.length} lecturas, pero sin campo de lluvia reconocible. Campos: ${keys}.`);
  } else {
    const pts = rainPoints(f.samples, rain);
    if (pts.length) {
      const kb = Math.round(JSON.stringify(f.samples).length / 1024);
      lines.push(`✓ Datos recientes: ${pts.length} lecturas (≈ ${kb} KB), de ${hhmm(pts[0][0])} a ${hhmm(pts[pts.length - 1][0])} · campo ${rain.field}.`);
      lines.push(`Lluvia en ese periodo: ${fmtMm(totalRain(pts, rain.kind))}.`);
      const live = liveRainFromStore(next, code, today, now);
      if (live?.sinceMs != null) {
        lines.push(
          `Lluvia de hoy: ${fmtMm(live.mm)} desde las ${clock(live.sinceMs)} hasta las ${clock(live.lastAtMs)} ` +
            `(${Math.round((now - live.lastAtMs) / 60_000)} min de atraso)${live.rainingNow ? ' · está lloviendo' : ''}.`,
        );
      }
    } else {
      lines.push(`Datos recientes: ${f.samples.length} lecturas, pero ninguna con valor de ${rain.field}.`);
    }
  }
  // ¿La DMC no recibe datos de esta estación? Se prueban las más cercanas para saber si el problema es solo de esta.
  const times = f.samples.map((s) => parseMomento(String(s.momento))?.getTime() ?? 0).filter((t) => t > 0);
  const newest = times.length ? Math.max(...times) : null;
  if (f.ok && (newest === null || now - newest > STALE_STATION_MS)) {
    lines.push(
      newest === null
        ? '⚠ La DMC no está entregando lecturas de esta estación.'
        : `⚠ La lectura más nueva es del ${hhmm(newest)} (hace ${ageText(now - newest)}): la DMC no está recibiendo datos de esta estación.`,
    );
    if (alternatives.length) {
      const parts = await Promise.all(
        alternatives.map(async (s) => {
          const r = await newestReading(s.code, auth);
          const label = `${s.name} (${Math.round(s.distanceKm)} km)`;
          if (!r.f.ok) return `${label}: ${r.f.status ? `HTTP ${r.f.status}` : 'sin respuesta'}`;
          return r.newest === null ? `${label}: sin lecturas` : `${label}: última lectura ${hhmm(r.newest)} (hace ${ageText(now - r.newest)})`;
        }),
      );
      lines.push(`Otras estaciones DMC cercanas · ${parts.join(' · ')}.`);
    }
  }
  const days = observedFromStore(next, code, today);
  lines.push(
    days.size
      ? `Lluvia medida que usará la app: ${[...days].sort().map(([d, mm]) => `${d.slice(8)}/${d.slice(5, 7)} ${fmtMm(mm)}`).join(' · ')}.`
      : 'Aún no hay días completos guardados: se completan solos con el uso (cada consulta trae ~12 h).',
  );
  // ET0 con los datos de la estación
  if (f.ok && f.samples.length) {
    const met = detectMetFields(f.samples);
    if (met.fields) {
      const mf = met.fields;
      const last = [...f.samples].reverse().find((s) => unitNumber(s[mf.temp]) !== null);
      const lastAt = last ? parseMomento(String(last.momento)) : null;
      const n = (k: string) => (last ? unitNumber(last[k]) : null);
      const c = (v: number | null) => (v === null ? '?' : String(v).replace('.', ','));
      const wind = n(mf.wind);
      lines.push(
        `ET0 · campos: ${mf.temp}, ${mf.rh}, ${mf.rad}, ${mf.wind} (${mf.windUnit}${mf.windUnitAssumed ? ', supuesto' : ''}).` +
          (last
            ? ` Última lectura${lastAt ? ` (${hhmm(lastAt.getTime())})` : ''}: ${c(n(mf.temp))} °C · ${c(n(mf.rh))} % HR · ${c(n(mf.rad))} W/m² · viento ${wind === null ? '?' : c(Math.round(wind * WIND_TO_MS[mf.windUnit] * 10) / 10)} m/s.`
            : ''),
      );
    } else {
      lines.push(`ET0 · faltan campos: ${met.missing.join(', ')}. Disponibles: ${met.keys.slice(0, 16).join(', ')}.`);
    }
  }
  if (meta && next.met?.length) {
    const st = stationEt0(next.met, meta, today);
    const pairs = next.et0Pairs ?? {};
    lines.push(
      st.size
        ? `✓ ET0 medida: ${[...st].sort().map(([d, v]) => `${d.slice(8)}/${d.slice(5, 7)} ${fmtMm(v)}${pairs[d] ? ` (modelo ${fmtMm(pairs[d][1])})` : ''}`).join(' · ')}.`
        : 'ET0 medida: aún no hay días completos (se necesitan ≥ 21 h de lecturas; se completan solos con el uso).',
    );
    const corr = et0Correction(pairs, today);
    if (corr) lines.push(`Pronóstico de ET0 corregido ×${String(corr.ratio).replace('.', ',')} según ${corr.days} días medidos.`);
  }
  if (summary) {
    lines.push(
      summary.daily.size
        ? `✓ Resumen diario oficial: ${[...summary.daily].sort().map(([d, mm]) => `${d.slice(8)}/${d.slice(5, 7)} ${fmtMm(mm)}`).join(' · ')}.`
        : `Resumen diario: ${summary.status ? `HTTP ${summary.status}` : 'sin respuesta'}${summary.snippet ? ` · no reconocí la lluvia en: ${summary.snippet}` : ''}`,
    );
  } else {
    lines.push(`Detalles técnicos · Resumen diario (público): ${await probe(`${BASE}/emaResumenDiario/${code}`, auth)}`);
  }
  lines.push(`Detalles técnicos · WIS2 DMC (público): ${await probe(`${WIS2}/collections?f=json`, auth, wis2Collections)}`);
  return { ok: f.ok && !!rain, lines: lines.map((l) => redact(l, auth)), store: next };
}
