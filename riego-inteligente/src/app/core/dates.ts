// Fechas de calendario local (YYYY-MM-DD) y sus nombres en español. Funciones puras, sin `Intl`: también corren
// en el worker en segundo plano.
import type { ISODate } from './models';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export interface TimeOfDay {
  hour: number;
  minute: number;
}

const parts = (iso: ISODate): [number, number, number] => {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m, d];
};

export function toISODate(d: Date): ISODate {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function addDays(iso: ISODate, n: number): ISODate {
  const [y, m, d] = parts(iso);
  return toISODate(new Date(y, m - 1, d + n));
}

/** Días de calendario de `b` a `a` (positivo si `a` es posterior). */
export function diffDays(a: ISODate, b: ISODate): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(ya, ma - 1, da) - Date.UTC(yb, mb - 1, db)) / DAY_MS);
}

/** Instante local de una fecha a una hora dada. */
export function atTime(iso: ISODate, t: TimeOfDay): Date {
  const [y, m, d] = parts(iso);
  return new Date(y, m - 1, d, t.hour, t.minute, 0, 0);
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "jueves" */
export function weekdayEs(date: ISODate): string {
  const [y, m, d] = parts(date);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

/** "jueves 23 de octubre" */
export function longDateEs(date: ISODate): string {
  const [, m, d] = parts(date);
  return `${weekdayEs(date)} ${d} de ${MONTHS[m - 1]}`;
}
