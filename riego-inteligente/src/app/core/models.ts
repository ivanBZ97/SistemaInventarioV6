/** Fecha calendario local en formato YYYY-MM-DD. */
export type ISODate = string;

export interface Settings {
  /** Umbral de disparo en mm de déficit (6–12). */
  thresholdMm: number;
  /** Tasa de precipitación del aspersor en mm/min. */
  sprinklerRateMmMin: number;
  /** Superficie del pasto en m² (opcional): para expresar los riegos en litros. */
  lawnAreaM2?: number;
  latitude: number;
  longitude: number;
  /** Hora del aviso matutino "HH:MM" (se limita a la ventana 06:30–08:30). */
  morningTime?: string;
  /** true: el aviso de los días en que no hace falta regar llega sin sonido (canal "riego-info"). */
  quietOkAlerts?: boolean;
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

export type OverseedArea = 'full' | 'patches';

export interface WaterState {
  /** Déficit hídrico (mm) al inicio del día `asOf`. */
  deficitMm: number;
  asOf: ISODate;
  /** Día en que el usuario pospuso el riego ("Posponer a mañana"): no se alerta ese día. */
  snoozedDate?: ISODate;
  /** Fecha de término (inclusive) del modo resiembra. */
  overseedUntil?: ISODate;
  /** Dónde se sembró: todo el jardín (riego corto y seguido para todo) o solo parches (se rocían a mano). */
  overseedArea?: OverseedArea;
  /** Última fecha para la que se programó la alerta matutina (anti-duplicados). */
  lastMorningScheduledFor?: ISODate;
  source: 'model' | 'manual' | 'sensor';
  /** Último día en que el déficit se fijó por riego, ajuste manual o sensor: la lluvia anterior ya no influye. */
  resetDate?: ISODate;
  /** Instante (ms) de ese riego/ajuste: de la lluvia medida hoy solo cuenta la caída después. */
  resetAt?: number;
}

/** Lluvia de hoy medida por la estación hasta su última lectura (casi en tiempo real). */
export interface LiveRain {
  /** Día local al que corresponde (hoy). */
  date: ISODate;
  /** mm caídos hoy entre `sinceMs` y `lastAtMs`. */
  mm: number;
  /** Desde cuándo hay lecturas hoy (medianoche si las hay desde entonces); null si aún no hay de hoy. */
  sinceMs: number | null;
  /** Instante de la lectura más reciente de la estación. */
  lastAtMs: number;
  /** mm en la hora previa a la última lectura. */
  lastHourMm: number;
  /** Está lloviendo: lectura reciente con lluvia en la última hora. */
  rainingNow: boolean;
  /** mm por hora local de hoy (24 valores; el 0 es 00:00–01:00). */
  hourly: number[];
  /** [instante, mm] de cada intervalo de hoy (bloques de 10 min): permite contar desde un riego o ajuste. */
  steps: [number, number][];
}

/** Última consulta a la estación: cuándo, si trajo lecturas y, si no, por qué ("HTTP 503", "sin lecturas"…). */
export interface StationStatus {
  attemptAt: number;
  ok: boolean;
  error?: string;
}

export interface DailyWeather {
  date: ISODate;
  et0Mm: number;
  /** Pronóstico de los modelos; en días pasados, lo medido si hay estación. */
  precipitationMm: number;
  precipitationProbMax: number;
  tempMaxC: number;
  windMaxKmh: number;
  /** Solo hoy: lluvia ya medida por la estación (manda si supera al pronóstico, ver `dayRain`). */
  live?: LiveRain;
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
  /** Déficit actual: el del inicio del día menos la lluvia útil ya medida hoy por la estación. */
  deficitMm: number;
  minutes: number;
  etcYesterdayMm: number;
  kc: number;
  tempMaxC: number;
  rainProbPct: number;
  rainForecastMm: number;
  /** Lluvia medida hoy por la estación hasta su última lectura, o null si no hay estación/lecturas. */
  rainMeasuredMm: number | null;
  /** La estación registra lluvia en la última hora. */
  rainingNow: boolean;
  /** Motivo de la pausa: ya llovió lo suficiente, está lloviendo, lo dice el pronóstico de hoy o mañana llueve lo suficiente. */
  rainBlockReason: 'measured' | 'raining' | 'forecast' | 'tomorrow' | null;
  /** Pronóstico de mañana (para explicar "espera la lluvia de mañana"). */
  rainTomorrowMm: number;
  rainTomorrowProbPct: number;
  /** Modo Resiembra activo ese día y dónde se sembró (null si no está activo). */
  overseed: OverseedArea | null;
  /** Umbral de riego usado ese día (más bajo mientras germina una siembra de todo el jardín). */
  thresholdMm: number;
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

/** Lo que informa el worker en segundo plano de su última ejecución (para el panel "Estado del sistema"). */
export interface RunnerStatus {
  /** Instante de la última ejecución (null: nunca se ha ejecutado). */
  lastRunAt: number | null;
  ok?: boolean;
  error?: string;
  /** Estación de respaldo que estaba usando, si la elegida no publicaba. */
  backup?: string | null;
}

export interface PlannedNotification {
  id: number;
  channelId: 'riego-matutino' | 'riego-resiembra' | 'riego-info';
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
