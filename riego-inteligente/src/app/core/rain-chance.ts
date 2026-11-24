// Probabilidad de lluvia útil con los pronósticos por ensambles de Open-Meteo: ~200 escenarios de cuatro sistemas
// (ECMWF IFS ENS, Google WeatherNext 2, ECMWF AIFS ENS y NOAA GEFS) para los próximos 10 días.
//
// La "probabilidad de lluvia" de los modelos (precipitation_probability_max) es la de que caiga algo (> 0,1 mm) en
// alguna hora del día: con ella el riego se pausaba por lloviznas que no reponen nada. Aquí se cuenta qué parte de
// los escenarios da la lluvia que de verdad importa (p. ej. 4 mm o más). Funciones puras más el cliente HTTP (sin
// dependencias): las usan la app y el worker en segundo plano.
import type { DailyWeather, ISODate } from './models';
import { fetchWithTimeout } from './http';

export const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';

/** Sistemas que se combinan; cada escenario (miembro) cuenta lo mismo. */
export const ENSEMBLE_MODELS = ['ecmwf_ifs025_ensemble', 'google_weathernext2_ensemble', 'ecmwf_aifs025_ensemble', 'ncep_gefs025'] as const;

/** Con menos escenarios que estos en un día, su probabilidad no se usa (se decide con la regla de los modelos). */
export const MIN_MEMBERS = 20;

/** Lluvia (mm) de cada escenario por día, de menor a mayor y con un decimal. */
export type EnsembleRain = Record<ISODate, number[]>;

/**
 * Consulta de los ensambles. Sus celdas miden ~25 km: con la ubicación redondeada a dos decimales (~1 km) basta, y
 * así no se envía la posición exacta del jardín.
 */
export function ensembleUrl(lat: number, lon: number): string {
  return (
    `${ENSEMBLE_URL}?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
    `&daily=precipitation_sum&timezone=auto&forecast_days=10&models=${ENSEMBLE_MODELS.join(',')}`
  );
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Escenarios de lluvia por día. Cada sistema llega como varias series `precipitation_sum_<modelo>` (control) y
 * `precipitation_sum_memberNN_<modelo>`: se toman todas. Los días con muy pocos escenarios se omiten.
 */
export function parseEnsemble(json: unknown): EnsembleRain {
  const daily = (json as { daily?: Record<string, unknown> } | null)?.daily;
  const time = daily?.time;
  if (!daily || !Array.isArray(time)) throw new Error('Respuesta de ensambles sin datos diarios');
  const series = Object.entries(daily)
    .filter(([key, values]) => key.startsWith('precipitation_sum') && Array.isArray(values))
    .map(([, values]) => values as unknown[]);
  const out: EnsembleRain = {};
  time.forEach((date, i) => {
    if (typeof date !== 'string') return;
    const members = series
      .map((s) => s[i])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
      .map(round1)
      .sort((a, b) => a - b);
    if (members.length >= MIN_MEMBERS) out[date] = members;
  });
  return out;
}

/** Cliente sin dependencias: sirve en la app (fetch del WebView) y en el worker (fetch del runner). */
export async function fetchEnsemble(lat: number, lon: number): Promise<EnsembleRain> {
  const res = await fetchWithTimeout(ensembleUrl(lat, lon));
  if (!res.ok) throw new Error(`Ensambles HTTP ${res.status}`);
  return parseEnsemble(await res.json());
}

/** Agrega los escenarios a los días de hoy en adelante (los días pasados ya tienen lo medido). */
export function withEnsemble(days: DailyWeather[], rain: EnsembleRain | null | undefined, today: ISODate): DailyWeather[] {
  if (!rain) return days;
  return days.map((d) => (d.date >= today && rain[d.date]?.length ? { ...d, rainMembers: rain[d.date] } : d));
}

/** Probabilidad (%, entera) de que llueva al menos `mm` ese día según los escenarios; null si no los hay. */
export function rainChancePct(w: Pick<DailyWeather, 'rainMembers'> | undefined, mm: number): number | null {
  const members = w?.rainMembers;
  if (!members?.length) return null;
  const hits = members.filter((v) => v >= mm - 1e-9).length;
  return Math.round((100 * hits) / members.length);
}

/** Escenarios reducidos a una parte del día (p. ej. las horas que faltan de hoy): cada uno por `fraction` (0–1). */
export function scaleMembers(members: number[], fraction: number): number[] {
  const f = Math.min(1, Math.max(0, fraction));
  return members.map((v) => round1(v * f));
}

/** Los escenarios se vuelven a pedir cada 3 h, como el pronóstico de los modelos… */
export const ENSEMBLE_MAX_AGE_MS = 3 * 3_600_000;
/** …y, si no se pueden pedir (sin red), los guardados sirven hasta un día después. */
export const ENSEMBLE_MAX_STALE_MS = 24 * 3_600_000;
