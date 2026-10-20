// Lluvia OBSERVADA de la red agroclimática INIA (https://agromet.inia.cl/api/v2, requiere clave personal).
// Reemplaza la lluvia del modelo en los días ya transcurridos, que es la que alimenta el balance hídrico.
// Funciones sin dependencias de Angular: las usan la app y el worker en segundo plano.
import { addDays, distanceKm, toISODate } from './irrigation-core';
import type { AgrometConfig, DailyWeather, ISODate } from './models';

const BASE = 'https://agromet.inia.cl/api/v2';

export interface AgrometStation {
  id: string;
  name: string;
  comuna: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
}

export interface NearbyStation extends AgrometStation {
  distanceKm: number;
}

interface Sample {
  tiempo: string;
  valor: number | string | null;
}

async function call<T>(endpoint: string, apiKey: string, params: Record<string, string> = {}): Promise<T[]> {
  const q = new URLSearchParams({ ...params, key: apiKey });
  const res = await fetch(`${BASE}/${endpoint}/?${q}`);
  if (res.status === 401 || res.status === 403) throw new Error('Clave de Agromet inválida');
  if (!res.ok) throw new Error(`Agromet HTTP ${res.status}`);
  const json = (await res.json()) as { response?: T[] } | T[];
  const rows = Array.isArray(json) ? json : json.response;
  return Array.isArray(rows) ? rows : [];
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

export async function listStations(apiKey: string): Promise<AgrometStation[]> {
  const rows = await call<Record<string, unknown>>('estaciones', apiKey);
  return rows.flatMap((r) => {
    const latitude = num(r['latitud']);
    const longitude = num(r['longitud']);
    if (latitude === null || longitude === null) return [];
    return [
      {
        id: String(r['identificador'] ?? ''),
        name: String(r['nombre'] ?? ''),
        comuna: String(r['comuna'] ?? ''),
        latitude,
        longitude,
        elevationM: num(r['elevacion']),
      },
    ];
  });
}

export function nearestStations(stations: AgrometStation[], lat: number, lon: number, n = 5): NearbyStation[] {
  return stations
    .filter((s) => s.id)
    .map((s) => ({ ...s, distanceKm: distanceKm(lat, lon, s.latitude, s.longitude) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n);
}

const normalize = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Los IDs numéricos no son consistentes entre fuentes: la variable de lluvia se busca por nombre. */
export async function findRainVariable(apiKey: string, stationId: string): Promise<string | null> {
  const vars = await call<Record<string, unknown>>('variables', apiKey, { estacion: stationId });
  const hit = vars.find((v) => normalize(String(v['nombre'] ?? '')).includes('precipitacion'));
  return hit ? String(hit['identificador']) : null;
}

/** Fecha local (YYYY-MM-DD) de una muestra; si trae zona horaria se convierte a la del teléfono. */
export function sampleDate(tiempo: string): ISODate | null {
  if (/(Z|[+-]\d\d:?\d\d)$/.test(tiempo)) {
    const d = new Date(tiempo);
    return Number.isNaN(d.getTime()) ? null : toISODate(d);
  }
  return /^\d{4}-\d{2}-\d{2}/.test(tiempo) ? tiempo.slice(0, 10) : null;
}

/** Suma de lluvia por día (las muestras de precipitación son acumulados por intervalo). */
export function sumByDay(samples: Sample[]): Map<ISODate, number> {
  const out = new Map<ISODate, number>();
  for (const s of samples) {
    const day = sampleDate(s.tiempo);
    const v = num(s.valor);
    if (!day || v === null || v < 0) continue;
    out.set(day, (out.get(day) ?? 0) + v);
  }
  return out;
}

export async function fetchObservedRain(cfg: AgrometConfig, from: ISODate, to: ISODate): Promise<Map<ISODate, number>> {
  const rows = await call<Sample>('muestras', cfg.apiKey, {
    estacion: cfg.stationId,
    variable: cfg.rainVariableId,
    desde: from,
    hasta: to,
  });
  return sumByDay(rows);
}

/** Pisa la lluvia del modelo con la observada, solo en días ya pasados y con muestras. */
export function mergeObservedRain(days: DailyWeather[], observed: Map<ISODate, number>, today: ISODate): DailyWeather[] {
  return days.map((d) => (d.date < today && observed.has(d.date) ? { ...d, precipitationMm: observed.get(d.date)! } : d));
}

/** Aplica la lluvia observada si hay estación configurada; ante cualquier error conserva el modelo. */
export async function applyObservedRain(
  days: DailyWeather[],
  cfg: AgrometConfig | undefined,
  today: ISODate,
): Promise<{ days: DailyWeather[]; source: string | null }> {
  if (!cfg?.apiKey || !cfg.stationId || !cfg.rainVariableId) return { days, source: null };
  try {
    const observed = await fetchObservedRain(cfg, addDays(today, -3), today);
    const used = [...observed.keys()].filter((d) => d < today);
    if (!used.length) return { days, source: null };
    return {
      days: mergeObservedRain(days, observed, today),
      source: `${cfg.stationName} (${cfg.distanceKm.toFixed(1)} km)`,
    };
  } catch {
    return { days, source: null };
  }
}
