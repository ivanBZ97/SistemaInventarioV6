/** Fecha calendario local en formato YYYY-MM-DD. */
export type ISODate = string;

export interface Settings {
  /** Umbral de disparo en mm de déficit (6–12). */
  thresholdMm: number;
  /** Tasa de precipitación del aspersor en mm/min. */
  sprinklerRateMmMin: number;
  latitude: number;
  longitude: number;
  /** Hora del aviso matutino "HH:MM" (se limita a la ventana 06:30–08:30). */
  morningTime?: string;
  /** true = la app actualiza sola la ubicación si te mueves (> 10 km). */
  useGps: boolean;
  /** Nombre legible del lugar (p. ej. "Pudahuel, Región Metropolitana"). */
  placeName?: string;
  /** Estación automática de la Dirección Meteorológica de Chile (lluvia observada, sin clave). */
  dmc?: DmcConfig;
  /** Credenciales del servicio oficial de la DMC (opcional; sin ellas se intenta el acceso público). */
  dmcAuth?: DmcAuth;
  /** Estación agroclimática INIA (lluvia observada). Opcional. */
  agromet?: AgrometConfig;
  /** false hasta que el usuario elige ubicación (GPS o búsqueda): dispara el aviso de primer arranque. */
  locationSet: boolean;
}

export interface DmcConfig {
  /** Código nacional de la estación (p. ej. 330160 = El Milagro, Buin). */
  code: string;
  name: string;
  distanceKm: number;
  /** Ubicación y altura de la estación (para la ET0 FAO-56). */
  latitude?: number;
  longitude?: number;
  elevationM?: number;
}

export interface DmcAuth {
  /** Correo con el que te registraste en el portal de servicios climáticos de la DMC. */
  user: string;
  /** Token personal que envía la DMC al confirmar la cuenta. Solo se guarda en el teléfono. */
  token: string;
}

export interface AgrometConfig {
  /** Clave personal de la API de INIA Agromet. */
  apiKey: string;
  stationId: string;
  stationName: string;
  distanceKm: number;
  /** Identificador de la variable de precipitación de esa estación (se busca por nombre). */
  rainVariableId: string;
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
  /** Último día en que el déficit se fijó por riego, ajuste manual o sensor: la lluvia anterior ya no influye. */
  resetDate?: ISODate;
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
  /** Lluvia efectiva prevista hoy (80 % si > 2 mm); se descuenta del balance mañana. */
  effectiveRainTodayMm: number;
  etcTodayMm: number;
  /** Déficit esperado mañana: hoy + ETc de hoy − lluvia efectiva de hoy. */
  projectedDeficitMm: number;
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
