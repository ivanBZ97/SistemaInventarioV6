// Lluvia OBSERVADA de las estaciones automáticas (EMA) de la Dirección Meteorológica de Chile.
// Usa los recursos JSON públicos del Portal de Servicios Climáticos (sin clave):
//   https://climatologia.meteochile.gob.cl/application/index/menuTematicoJson
// Formato tomado del paquete agrometR (MIT), que consume el mismo servicio. Funciones sin dependencias
// de Angular: las usan la app y el worker en segundo plano.
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

export interface DailyRain {
  mm: number;
  /** Horas del día cubiertas por muestras (para descartar días con la estación caída). */
  coveredHours: number;
}

/**
 * `aguaCaida24Horas` es un acumulado que se reinicia una vez al día (12:00 UTC). La lluvia de cada
 * intervalo es la diferencia con la lectura anterior; si el acumulado baja, hubo reinicio y la lluvia
 * del intervalo es el valor nuevo. Cada intervalo se asigna al día local en que termina.
 */
export function dailyRainFromAccumulated(samples: DmcSample[], field = 'aguaCaida24Horas'): Map<ISODate, DailyRain> {
  const pts = samples
    .map((s) => ({ t: parseMomento(String(s.momento)), v: unitNumber(s[field]) }))
    .filter((p): p is { t: Date; v: number } => p.t !== null && p.v !== null && p.v >= 0)
    .sort((a, b) => a.t.getTime() - b.t.getTime());

  const out = new Map<ISODate, DailyRain>();
  const span = new Map<ISODate, { first: number; last: number }>();
  for (let i = 0; i < pts.length; i++) {
    const day = toISODate(pts[i].t);
    const s = span.get(day);
    const t = pts[i].t.getTime();
    span.set(day, s ? { first: Math.min(s.first, t), last: Math.max(s.last, t) } : { first: t, last: t });
    if (!out.has(day)) out.set(day, { mm: 0, coveredHours: 0 });
    if (i === 0) continue;
    const prev = pts[i - 1].v;
    const cur = pts[i].v;
    const inc = cur >= prev ? cur - prev : cur;
    out.get(day)!.mm += inc;
  }
  for (const [day, r] of out) {
    const s = span.get(day)!;
    r.mm = Math.round(r.mm * 10) / 10;
    r.coveredHours = (s.last - s.first) / 3_600_000;
  }
  return out;
}

async function fetchMonth(code: string, year: number, month: number): Promise<DmcSample[]> {
  const res = await fetch(`${BASE}/datosRecientesEma/${code}/${year}/${String(month).padStart(2, '0')}`);
  if (!res.ok) throw new Error(`DMC HTTP ${res.status}`);
  return parseDmcSamples(await res.json());
}

/** Días con cobertura suficiente para confiar en el total (la estación pudo estar caída). */
const MIN_COVERED_HOURS = 20;

/** Lluvia diaria medida entre `from` y `to` (días locales completos). */
export async function fetchDmcDailyRain(code: string, from: ISODate, to: ISODate): Promise<Map<ISODate, number>> {
  const months = new Set([from.slice(0, 7), to.slice(0, 7)]);
  const samples: DmcSample[] = [];
  for (const ym of months) {
    const [y, m] = ym.split('-').map(Number);
    samples.push(...(await fetchMonth(code, y, m)));
  }
  const daily = dailyRainFromAccumulated(samples);
  const out = new Map<ISODate, number>();
  for (const [day, r] of daily) {
    if (day >= from && day <= to && r.coveredHours >= MIN_COVERED_HOURS) out.set(day, r.mm);
  }
  return out;
}

/** Pisa la lluvia del modelo con la medida por la estación DMC en los días ya pasados. */
export async function applyDmcRain(
  days: DailyWeather[],
  cfg: DmcConfig | undefined,
  today: ISODate,
): Promise<{ days: DailyWeather[]; source: string | null; observed: Map<ISODate, number> }> {
  const empty = new Map<ISODate, number>();
  if (!cfg?.code) return { days, source: null, observed: empty };
  try {
    const observed = await fetchDmcDailyRain(cfg.code, addDays(today, -3), addDays(today, -1));
    if (!observed.size) return { days, source: null, observed };
    return {
      days: days.map((d) => (d.date < today && observed.has(d.date) ? { ...d, precipitationMm: observed.get(d.date)! } : d)),
      source: `${cfg.name} (${cfg.distanceKm.toFixed(1).replace('.', ',')} km) · DMC`,
      observed,
    };
  } catch {
    return { days, source: null, observed: empty };
  }
}
