/** Fecha calendario local en formato YYYY-MM-DD. */
export type ISODate = string;

export interface Settings {
  /** Umbral de disparo en mm de déficit (6–12). */
  thresholdMm: number;
  /** Tasa de precipitación del aspersor en mm/min. */
  sprinklerRateMmMin: number;
  latitude: number;
  longitude: number;
  /** true = la app actualiza sola la ubicación si te mueves (> 10 km). */
  useGps: boolean;
  /** Nombre legible del lugar (p. ej. "Pudahuel, Región Metropolitana"). */
  placeName?: string;
  /** false hasta que el usuario elige ubicación (GPS o búsqueda): dispara el aviso de primer arranque. */
  locationSet: boolean;
}

export interface WaterState {
  /** Déficit hídrico (mm) al inicio del día `asOf`. */
  deficitMm: number;
  asOf: ISODate;
  /** Día en que el usuario pospuso el riego ("Posponer a mañana"): no se alerta ese día. */
  snoozedDate?: ISODate;
  /** Fecha de término (inclusive) del modo resiembra. */
  overseedUntil?: ISODate;
  /** Última fecha para la que se programó la alerta matutina (anti-duplicados). */
  lastMorningScheduledFor?: ISODate;
  source: 'model' | 'manual' | 'sensor';
}

export interface DailyWeather {
  date: ISODate;
  et0Mm: number;
  precipitationMm: number;
  precipitationProbMax: number;
  tempMaxC: number;
  windMaxKmh: number;
}

export interface DayRecord {
  date: ISODate;
  etcMm: number;
  effectiveRainMm: number;
}

export interface IrrigationEvent {
  date: ISODate;
  /** Timestamp ISO del registro. */
  at: string;
  mm: number;
  source: 'manual' | 'notification';
}

export type IrrigationStatus = 'ok' | 'irrigate' | 'paused_rain';

export interface Evaluation {
  date: ISODate;
  status: IrrigationStatus;
  deficitMm: number;
  minutes: number;
  etcYesterdayMm: number;
  kc: number;
  tempMaxC: number;
  rainProbPct: number;
  rainForecastMm: number;
  windMaxKmh: number;
  windWarning: boolean;
  rainBlock: boolean;
  humidityPct: number;
}

export interface PlannedNotification {
  id: number;
  channelId: 'riego-matutino' | 'riego-resiembra';
  title: string;
  body: string;
  at: Date;
  /** Si es true, la notificación lleva los botones "Ya regué" / "Posponer a mañana". */
  actions: boolean;
}

export interface SoilReading {
  /** Humedad útil en la raíz, 0–100 (misma escala que el indicador del Dashboard). */
  moisturePct: number;
  takenAt: string;
  source: string;
}

export interface ChartDay {
  date: ISODate;
  etcMm: number;
  replenishedMm: number;
  irrigationMm: number;
  rainMm: number;
  estimated: boolean;
}
