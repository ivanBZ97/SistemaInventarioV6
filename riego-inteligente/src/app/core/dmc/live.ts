// Lluvia de hoy casi en tiempo real, a partir de las lecturas guardadas de la estación.
import { type TimeOfDay, atTime, toISODate } from '../dates';
import { RAINING_NOW_MM } from '../irrigation-core';
import type { DailyWeather, ISODate, LiveRain } from '../models';
import { LIVE_FRESH_MS, MAX_GAP_MS } from './constants';
import type { DmcStore } from './store';

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
    sinceMs ??= fromYesterday && linked ? atTime(today, { hour: 0, minute: 0 }).getTime() : t;
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
 * Cada cuánto consultar la estación en segundo plano (cada consulta trae ~12 h y pesa ~0,5 MB): cada 30 min si
 * llueve, si se pronostica lluvia o en la hora y media antes del aviso de la mañana; si no, cada 3 h.
 */
export function backgroundStationMaxAgeMs(now: number, live: LiveRain | null, today: DailyWeather | undefined, morning: TimeOfDay): number {
  const wet = !!live && (live.lastHourMm > 0 || live.steps.some(([t]) => t >= live.lastAtMs - 3 * 3_600_000));
  const likely = !!today && (today.precipitationMm >= 1 || today.precipitationProbMax >= 30);
  const alertAt = atTime(toISODate(new Date(now)), morning).getTime();
  const beforeAlert = now >= alertAt - 90 * 60_000 && now < alertAt;
  return wet || likely || beforeAlert ? 30 * 60_000 : 3 * 3_600_000;
}
