// Meteorología de la estación (temperatura, humedad, radiación y viento) → ET0 diaria FAO-56, y corrección del
// pronóstico de ET0 según lo medido.
import { addDays, toISODate } from '../dates';
import { type DailyMet, WIND_10M_TO_2M, et0PenmanMonteith, satVapourPressure } from '../fao56';
import type { DailyWeather, ISODate } from '../models';
import { type DmcSample, parseMomento, unitNumber } from './api';
import { BUCKET_MS, KEEP_MS } from './constants';
import type { StationMeta } from './stations';

export type WindUnit = 'kt' | 'km/h' | 'm/s';

export const WIND_TO_MS: Record<WindUnit, number> = { kt: 0.514444, 'km/h': 1 / 3.6, 'm/s': 1 };

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
  const wind =
    pick('fuerzaDelVientoPromedio10Minutos', /(fuerza|velocidad).*viento.*promedio/i) ??
    keys.find((k) => /^(fuerza|velocidad)DelViento$/i.test(k));
  const missing = [!temp && 'temperatura', !rh && 'humedad relativa', !rad && 'radiación global', !wind && 'viento'].filter(
    (x): x is string => !!x,
  );
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

/** Corrección del pronóstico de ET0: estación ÷ modelo en los últimos 7 días (≥ 2 días), limitada a ±20 %. */
export function et0Correction(
  pairs: Record<ISODate, [number, number]> | undefined,
  today: ISODate,
): { ratio: number; days: number } | null {
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
