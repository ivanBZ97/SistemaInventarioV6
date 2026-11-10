// Sensor de humedad de suelo en el balance hídrico: calibración de dos puntos (% del sensor → mm de déficit) y
// cuándo una lectura reemplaza al cálculo teórico. Funciones puras, independientes del fabricante del sensor: las
// usan la app y el worker en segundo plano.
import { clamp } from './irrigation-core';
import type { ISODate, SoilSensorConfig, WaterState } from './models';

/**
 * Lectura del sensor (% de humedad del suelo) → déficit (mm) con la calibración de tu jardín: el % con el suelo
 * recién regado a fondo es déficit 0 y el % cuando toca regar es el umbral; en medio, proporcional.
 * null si falta calibrar (o los dos puntos están demasiado juntos para distinguir).
 */
export function deficitFromSensor(soilPct: number, cfg: Pick<SoilSensorConfig, 'wetPct' | 'dryPct'>, thresholdMm: number): number | null {
  const cal = calibrationPoints(cfg);
  if (!cal) return null;
  return Math.round(clamp((thresholdMm * (cal.wet - soilPct)) / (cal.wet - cal.dry), 0, 25) * 10) / 10;
}

/** Distancia típica (puntos de %) entre "recién regado" y "toca regar", para la calibración provisional. */
export const PROVISIONAL_SPAN_PCT = 30;

/**
 * Puntos de calibración en uso. Con uno solo marcado, el otro se estima a {@link PROVISIONAL_SPAN_PCT} puntos
 * (provisional: así el sensor se puede usar desde ya y se afina al marcar el segundo). null si no hay ninguno o
 * los dos están demasiado juntos para distinguir.
 */
export function calibrationPoints(
  cfg: Pick<SoilSensorConfig, 'wetPct' | 'dryPct'>,
): { wet: number; dry: number; provisional: boolean } | null {
  const { wetPct: w, dryPct: d } = cfg;
  if (w !== undefined && d !== undefined) return w - d >= 3 ? { wet: w, dry: d, provisional: false } : null;
  if (w !== undefined) return { wet: w, dry: Math.max(0, w - PROVISIONAL_SPAN_PCT), provisional: true };
  if (d !== undefined) return { wet: Math.min(100, d + PROVISIONAL_SPAN_PCT), dry: d, provisional: true };
  return null;
}

/** Un reporte del sensor de más de 6 h ya no describe el suelo de ahora. */
export const SENSOR_MAX_AGE_MS = 6 * 3_600_000;

/** Lo que informó el sensor: humedad del suelo (%) y cuándo (ms). */
export interface SensorReport {
  soilPct: number;
  at: number;
}

/**
 * Balance con la lectura del sensor aplicada. La lectura reemplaza al déficit teórico solo si el sensor está
 * activado y calibrado, la lectura es reciente (< 6 h) y es posterior al último riego o ajuste manual (si no,
 * describiría el suelo de antes de regar). En cualquier otro caso devuelve el mismo estado.
 */
export function applySensorReading(
  state: WaterState,
  cfg: SoilSensorConfig | undefined,
  report: SensorReport | null,
  thresholdMm: number,
  today: ISODate,
  now: number,
): WaterState {
  if (!cfg?.enabled || !report) return state;
  const deficit = deficitFromSensor(report.soilPct, cfg, thresholdMm);
  if (deficit === null || now - report.at > SENSOR_MAX_AGE_MS || report.at <= (state.resetAt ?? 0)) return state;
  return { ...state, deficitMm: deficit, asOf: today, source: 'sensor', resetDate: today, resetAt: report.at };
}
