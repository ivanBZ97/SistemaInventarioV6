// Historial de mediciones del sensor de suelo: una muestra por reporte del sensor (no por consulta), guardada en
// el teléfono. Funciones puras: las usan la app, el worker en segundo plano y las pruebas.
import { toISODate } from './irrigation-core';

export interface SensorSample {
  /** Instante en que el sensor informó (ms). */
  t: number;
  /** Humedad del suelo que marca el sensor (%). */
  soil: number;
  tempC: number | null;
  battery: number | null;
}

/** La app guarda un año; el worker, lo de las últimas dos semanas hasta que la app lo recoja. */
export const HISTORY_KEEP_DAYS = 366;
export const RUNNER_HISTORY_KEEP_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Une muestras nuevas al historial: una por instante (la misma lectura consultada dos veces no se duplica;
 * si una trae temperatura o batería y la otra no, se completa), ordenadas y sin lo más viejo que `keepDays`.
 */
export function mergeSamples(history: SensorSample[], incoming: SensorSample[], now: number, keepDays = HISTORY_KEEP_DAYS): SensorSample[] {
  const cutoff = now - keepDays * DAY_MS;
  const byT = new Map<number, SensorSample>();
  for (const s of [...history, ...incoming]) {
    if (!(s && Number.isFinite(s.t) && Number.isFinite(s.soil)) || s.t < cutoff || s.t > now + 3_600_000) continue;
    const prev = byT.get(s.t);
    byT.set(s.t, prev ? { ...s, tempC: s.tempC ?? prev.tempC, battery: s.battery ?? prev.battery } : s);
  }
  // El mismo reporte puede llegar con horas apenas distintas (lectura en vivo y registro de la nube): uno solo.
  const out: SensorSample[] = [];
  for (const s of [...byT.values()].sort((a, b) => a.t - b.t)) {
    const prev = out[out.length - 1];
    if (prev && s.t - prev.t < SAME_REPORT_MS && s.soil === prev.soil) {
      out[out.length - 1] = { ...prev, tempC: prev.tempC ?? s.tempC, battery: prev.battery ?? s.battery };
    } else {
      out.push(s);
    }
  }
  return out;
}

const SAME_REPORT_MS = 2 * 60_000;

export interface SensorDay {
  date: string;
  min: number;
  max: number;
  avg: number;
  /** Humedad del último reporte del día. */
  last: number;
  tempMax: number | null;
  count: number;
}

/** Resumen por día local (lo más nuevo primero), para la tabla del historial. */
export function dailySensorSummary(samples: SensorSample[]): SensorDay[] {
  const days = new Map<string, SensorSample[]>();
  for (const s of samples) {
    const d = toISODate(new Date(s.t));
    days.set(d, [...(days.get(d) ?? []), s]);
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return [...days.entries()]
    .map(([date, list]) => {
      const soils = list.map((s) => s.soil);
      const temps = list.map((s) => s.tempC).filter((v): v is number => v !== null);
      return {
        date,
        min: r1(Math.min(...soils)),
        max: r1(Math.max(...soils)),
        avg: r1(soils.reduce((a, b) => a + b, 0) / soils.length),
        last: r1(list[list.length - 1].soil),
        tempMax: temps.length ? r1(Math.max(...temps)) : null,
        count: list.length,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** CSV con hora local (para pegar en una planilla). */
export function sensorCsv(samples: SensorSample[]): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = (t: number) => {
    const d = new Date(t);
    return `${toISODate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const v = (x: number | null) => (x === null ? '' : String(x));
  return ['fecha_hora;humedad_suelo_pct;temperatura_c;bateria_pct', ...samples.map((s) => `${local(s.t)};${s.soil};${v(s.tempC)};${v(s.battery)}`)].join('\n');
}

/**
 * Registros de datos del sensor en la nube de Tuya ({code, value, event_time}) → muestras: cada humedad con la
 * temperatura informada en el mismo despertar (±5 min).
 */
export function samplesFromLogs(
  logs: { code?: string; value?: unknown; event_time?: unknown }[],
  soilCode: string,
  tempCode: string | null,
  norm: { soil: (v: number) => number; temp: (v: number) => number },
): SensorSample[] {
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const at = (l: { event_time?: unknown }) => num(l.event_time);
  const temps = tempCode
    ? logs.filter((l) => l.code === tempCode && Number.isFinite(num(l.value)) && Number.isFinite(at(l))).map((l) => [at(l), norm.temp(num(l.value))] as const)
    : [];
  return logs
    .filter((l) => l.code === soilCode && Number.isFinite(num(l.value)) && Number.isFinite(at(l)))
    .map((l) => {
      const t = at(l);
      let best: number | null = null;
      let bestGap = 5 * 60_000;
      for (const [tt, v] of temps) {
        const gap = Math.abs(tt - t);
        if (gap <= bestGap) {
          bestGap = gap;
          best = v;
        }
      }
      return { t, soil: norm.soil(num(l.value)), tempC: best, battery: null };
    });
}
