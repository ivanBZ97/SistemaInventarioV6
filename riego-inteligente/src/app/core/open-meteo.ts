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
export async function fetchForecast(lat: number, lon: number): Promise<DailyWeather[]> {
  const res = await fetch(forecastUrl(lat, lon));
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return parseForecast((await res.json()) as OpenMeteoResponse);
}
