// Textos de números, horas y antigüedades en español de Chile. Funciones puras; salvo `fmt` (que usa `Intl`),
// también sirven en el worker en segundo plano.
import { addDays, toISODate, weekdayEs } from './dates';

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** "pasto" → "Pasto" */
export const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Número con coma decimal y separador de miles (1.234,5). Solo para la interfaz. */
export function fmt(v: number, digits = 1): string {
  return v.toLocaleString('es-CL', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Número redondeado con coma decimal, sin ceros de relleno ni separador de miles (12,5 · 8). */
export function decimal(v: number, digits = 1): string {
  const k = 10 ** digits;
  return String(Math.round(v * k) / k).replace('.', ',');
}

/** Distancia con un decimal fijo: 4 → "4,0". */
export const km = (v: number) => v.toFixed(1).replace('.', ',');

/** "18:45" (hora local) */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "24/10 16:00" (con ceros: para diagnósticos alineados) */
export function dayMonthClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${clock(ms)}`;
}

/** "7/11" */
export function dayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

/** "07:35", "ayer 23:00" o "24/10 16:00" (para listas) */
export function shortWhen(ms: number, now = Date.now()): string {
  const day = toISODate(new Date(ms));
  const today = toISODate(new Date(now));
  if (day === today) return clock(ms);
  if (day === addDays(today, -1)) return `ayer ${clock(ms)}`;
  return `${dayMonth(ms)} ${clock(ms)}`;
}

/** "hoy a las 07:35", "mañana a las 06:30", "ayer a las 23:00" o "el sábado 24/10 a las 16:00" */
export function whenOf(ms: number, now = Date.now()): string {
  const day = toISODate(new Date(ms));
  const today = toISODate(new Date(now));
  if (day === today) return `hoy a las ${clock(ms)}`;
  if (day === addDays(today, 1)) return `mañana a las ${clock(ms)}`;
  if (day === addDays(today, -1)) return `ayer a las ${clock(ms)}`;
  return `el ${weekdayEs(day)} ${dayMonth(ms)} a las ${clock(ms)}`;
}

/** "45 min", "5 h", "2 días" */
export function ageText(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 120 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.floor(min / 1440)} días`;
}

/** "hace 12 min", "hace 3 h" o "hace 2 días" */
export const agoText = (ms: number) => `hace ${ageText(Math.max(0, ms))}`;
