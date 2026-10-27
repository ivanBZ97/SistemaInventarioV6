import type { DailyWeather } from './models';
import { addDays } from './irrigation-core';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** Modelos que se promedian (mejor que depender de uno solo). */
export const MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'] as const;

export function forecastUrl(lat: number, lon: number): string {
  return (
    `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lon}` +
    '&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,' +
    'temperature_2m_max,wind_speed_10m_max' +
    '&hourly=precipitation&timezone=auto&past_days=2' +
    `&models=${MODELS.join(',')}`
  );
}

interface OpenMeteoResponse {
  elevation?: number;
  /** Con `models=` cada variable llega como `<variable>_<modelo>`; sin él, con su nombre simple. */
  daily: { time: string[]; [key: string]: unknown };
  /** Horas locales ("2026-10-26T13:00", con timezone=auto). */
  hourly?: { time: string[]; [key: string]: unknown };
}

type Series = (number | null)[];

/** Series de una variable: una por modelo disponible, o la serie simple si no hay sufijos. */
function seriesOf(daily: OpenMeteoResponse['daily'], name: string): Series[] {
  const perModel = MODELS.map((m) => daily[`${name}_${m}`]).filter(Array.isArray) as Series[];
  if (perModel.length) return perModel;
  return Array.isArray(daily[name]) ? [daily[name] as Series] : [];
}

/** Mediana: con 3 modelos, un modelo que exagera la lluvia no arrastra al resto. */
export function median(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mean(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Convierte la respuesta en filas diarias combinando los modelos disponibles (los nulls no cuentan):
 * promedio para ET0, temperatura y viento; MEDIANA para la lluvia, porque el promedio "reparte" la
 * lluvia de un solo modelo e inventa lloviznas que no ocurrieron.
 * La probabilidad de lluvia no existe en todos los modelos: si ninguno la entrega, se estima como el
 * porcentaje de modelos que pronostican ≥ 1 mm.
 */
export function parseForecast(json: OpenMeteoResponse): DailyWeather[] {
  const d = json.daily;
  if (!d?.time) throw new Error('Respuesta de Open-Meteo sin datos diarios');
  const hourly = hourlyRainByDay(json.hourly);
  const et0 = seriesOf(d, 'et0_fao_evapotranspiration');
  const rain = seriesOf(d, 'precipitation_sum');
  const prob = seriesOf(d, 'precipitation_probability_max');
  const tmax = seriesOf(d, 'temperature_2m_max');
  const wind = seriesOf(d, 'wind_speed_10m_max');
  return d.time.map((date, i) => {
    const rains = rain.map((s) => s[i]).filter((x): x is number => typeof x === 'number');
    const proxy = rains.length ? (100 * rains.filter((x) => x >= 1).length) / rains.length : 0;
    return {
      date,
      et0Mm: mean(et0.map((s) => s[i])) ?? 0,
      precipitationMm: median(rains) ?? 0,
      precipitationProbMax: mean(prob.map((s) => s[i])) ?? proxy,
      tempMaxC: mean(tmax.map((s) => s[i])) ?? 0,
      windMaxKmh: mean(wind.map((s) => s[i])) ?? 0,
      ...(hourly.has(date) ? { hourlyRainMm: hourly.get(date) } : {}),
    };
  });
}

/**
 * Lluvia por hora local de cada día (mediana de los modelos), 24 valores por día: el índice h es la lluvia entre
 * las h y las h+1. Open-Meteo informa en cada hora lo caído en la hora ANTERIOR (13:00 = de 12:00 a 13:00).
 */
function hourlyRainByDay(h: OpenMeteoResponse['hourly']): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!h?.time) return out;
  const rain = seriesOf(h as OpenMeteoResponse['daily'], 'precipitation');
  if (!rain.length) return out;
  h.time.forEach((t, i) => {
    let date = t.slice(0, 10);
    let hour = Number(t.slice(11, 13)) - 1;
    if (hour === -1) {
      date = addDays(date, -1);
      hour = 23;
    }
    if (!(hour >= 0 && hour < 24)) return;
    const day = out.get(date) ?? new Array<number>(24).fill(0);
    day[hour] += median(rain.map((s) => s[i])) ?? 0;
    out.set(date, day);
  });
  return out;
}

/** Cliente sin dependencias: sirve en la app (fetch del WebView) y en el worker (fetch del runner). */
export async function fetchForecastWithMeta(
  lat: number,
  lon: number,
): Promise<{ days: DailyWeather[]; elevationM: number | null }> {
  const res = await fetch(forecastUrl(lat, lon));
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const json = (await res.json()) as OpenMeteoResponse;
  return { days: parseForecast(json), elevationM: typeof json.elevation === 'number' ? json.elevation : null };
}

export async function fetchForecast(lat: number, lon: number): Promise<DailyWeather[]> {
  return (await fetchForecastWithMeta(lat, lon)).days;
}

// ───────────── Geocodificación (gratis, sin API key) ─────────────

export interface Place {
  label: string;
  latitude: number;
  longitude: number;
}

/** Busca ciudades/comunas por nombre (Open-Meteo Geocoding). */
export async function searchPlaces(query: string): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=es&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[];
  };
  return (json.results ?? []).map((r) => ({
    label: [r.name, r.admin1 ?? r.country].filter(Boolean).join(', '),
    latitude: Math.round(r.latitude * 100) / 100,
    longitude: Math.round(r.longitude * 100) / 100,
  }));
}

/** Nombre del lugar para unas coordenadas (BigDataCloud, endpoint gratuito de cliente). */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=es`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as { locality?: string; city?: string; principalSubdivision?: string };
    const parts = [j.locality || j.city, j.principalSubdivision].filter(Boolean);
    return parts.length ? [...new Set(parts)].join(', ') : null;
  } catch {
    return null;
  }
}
