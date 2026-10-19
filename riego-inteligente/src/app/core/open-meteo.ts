import type { DailyWeather } from './models';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

export function forecastUrl(lat: number, lon: number): string {
  return (
    `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lon}` +
    '&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,' +
    'temperature_2m_max,wind_speed_10m_max' +
    '&hourly=soil_moisture_0_to_7cm&timezone=auto&past_days=2'
  );
}

interface OpenMeteoResponse {
  elevation?: number;
  daily: {
    time: string[];
    et0_fao_evapotranspiration: (number | null)[];
    precipitation_sum: (number | null)[];
    precipitation_probability_max: (number | null)[];
    temperature_2m_max: (number | null)[];
    wind_speed_10m_max: (number | null)[];
  };
}

/** Convierte la respuesta cruda de Open-Meteo en filas diarias (nulls → 0). */
export function parseForecast(json: OpenMeteoResponse): DailyWeather[] {
  const d = json.daily;
  if (!d?.time) throw new Error('Respuesta de Open-Meteo sin datos diarios');
  return d.time.map((date, i) => ({
    date,
    et0Mm: d.et0_fao_evapotranspiration[i] ?? 0,
    precipitationMm: d.precipitation_sum[i] ?? 0,
    precipitationProbMax: d.precipitation_probability_max[i] ?? 0,
    tempMaxC: d.temperature_2m_max[i] ?? 0,
    windMaxKmh: d.wind_speed_10m_max[i] ?? 0,
  }));
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
