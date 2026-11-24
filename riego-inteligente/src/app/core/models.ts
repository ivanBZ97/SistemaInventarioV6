/** Fecha calendario local en formato YYYY-MM-DD. */
export type ISODate = string;

export interface Settings {
  /** Umbral de disparo en mm de déficit (6–12) cuando se fija a mano (ver `thresholdAuto`). */
  thresholdMm: number;
  /**
   * true: el umbral se calcula con el agua útil del suelo, la profundidad de las raíces y el consumo del día (FAO-56);
   * `thresholdMm` queda como valor manual para cuando se desactive.
   */
  thresholdAuto?: boolean;
  /** Suelo del jardín (textura y agua útil), elegido a mano o detectado con SoilGrids. */
  soil?: SoilInfo;
  /** Etapa del pasto: define la profundidad de las raíces que aprovechan el agua del suelo. */
  lawnStage?: LawnStage;
  /** Horas de sol directo sobre el pasto: a la sombra consume menos agua (sin dato: pleno sol). */
  exposure?: Exposure;
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
  /** Sensor de humedad de suelo Tuya / Smart Life, leído desde la nube de Tuya. Opcional. */
  soilSensor?: SoilSensorConfig;
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

/** Sol directo sobre el pasto en verano: pleno sol (≥ 6 h), media sombra (3–6 h) o sombra (< 3 h). */
export type Exposure = 'sun' | 'partial' | 'shade';

/** Textura del suelo, agrupada como en la tabla 19 de FAO-56. */
export type SoilTexture = 'sand' | 'sandyLoam' | 'loam' | 'clay';

/** Pasto nuevo (raíces cortas, ~10 cm) o establecido (~15 cm). */
export type LawnStage = 'young' | 'established';

export interface SoilInfo {
  texture: SoilTexture;
  /** Agua útil del suelo: % del volumen entre capacidad de campo y punto de marchitez. */
  awcPct: number;
  /** Elegido a mano o detectado con el mapa de suelos SoilGrids (ISRIC) para la zona. */
  source: 'manual' | 'soilgrids';
  /** Composición de los primeros 30 cm según SoilGrids (%), para mostrarla. */
  sandPct?: number;
  clayPct?: number;
}

/** Centro de datos de la cuenta de Smart Life (Chile: América oeste). */
export type TuyaRegion = 'us' | 'ueaz' | 'eu' | 'weaz' | 'cn' | 'in';

export interface SoilSensorConfig {
  region: TuyaRegion;
  /** Access ID / Client ID del proyecto en iot.tuya.com. */
  accessId: string;
  /** Access Secret / Client Secret. Solo se guarda en el teléfono. */
  accessSecret: string;
  /** ID del sensor (en Smart Life: el dispositivo → lápiz → Información del dispositivo → ID virtual). */
  deviceId: string;
  /** Calibración: % que marca con el suelo recién regado a fondo (déficit 0) y cuando toca regar (déficit = umbral). */
  wetPct?: number;
  dryPct?: number;
  /** true: su lectura reemplaza al cálculo del balance (requiere calibración). */
  enabled: boolean;
  /** true: el sensor ya no sirve para la humedad (p. ej. se dañó) y solo se usa como termómetro del suelo. */
  tempOnly?: boolean;
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
  /** Solo hoy: lluvia ya medida por la estación (ver `dayRain`). */
  live?: LiveRain;
  /** Lluvia pronosticada por hora local (24 valores, mediana de los modelos): permite separar lo que falta del día. */
  hourlyRainMm?: number[];
  /**
   * Lluvia del día (mm) en cada escenario de los pronósticos por ensambles, de menor a mayor: da la probabilidad de
   * que llueva lo suficiente (ver `rainChancePct`). Solo de hoy en adelante y si se pudo consultar.
   */
  rainMembers?: number[];
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
  /** Lluvia pronosticada para lo que queda de hoy (después de la última lectura de la estación), o null. */
  rainForecastLeftMm: number | null;
  /** Lluvia medida hoy por la estación hasta su última lectura, o null si no hay estación/lecturas. */
  rainMeasuredMm: number | null;
  /** La estación registra lluvia en la última hora. */
  rainingNow: boolean;
  /** Motivo de la pausa: ya llovió lo suficiente, está lloviendo, lo dice el pronóstico de hoy o mañana llueve lo suficiente. */
  rainBlockReason: 'measured' | 'raining' | 'forecast' | 'tomorrow' | null;
  /** Probabilidad (%) de 4 mm o más hoy (o en lo que queda del día) según los ensambles; null sin ensambles. */
  rainUsefulProbPct: number | null;
  /** Pronóstico de mañana (para explicar "espera la lluvia de mañana"). */
  rainTomorrowMm: number;
  rainTomorrowProbPct: number;
  /** Probabilidad (%) de que la lluvia de mañana alcance para reponer el déficit, según los ensambles; null sin ellos. */
  rainTomorrowCoverProbPct: number | null;
  /** Modo Resiembra activo ese día y dónde se sembró (null si no está activo). */
  overseed: OverseedArea | null;
  /** Umbral de riego usado ese día (más bajo mientras germina una siembra de todo el jardín). */
  thresholdMm: number;
  /** Lluvia efectiva prevista hoy (80 % si > 2 mm); se descuenta del balance mañana. */
  effectiveRainTodayMm: number;
  etcTodayMm: number;
  /** Factor de exposición aplicado al consumo (1 = pleno sol; menos a la sombra). */
  exposureFactor: number;
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
  /** Canal de Android (ver `CHANNEL` en irrigation-core). */
  channelId: 'riego-matutino' | 'riego-resiembra' | 'riego-info';
  title: string;
  body: string;
  at: Date;
  /** Si es true, la notificación lleva los botones "Ya regué" / "Posponer a mañana". */
  actions: boolean;
}

/** Última lectura del sensor de suelo. */
export interface SoilReading {
  /** Nombre del sensor (como aparece en la app del fabricante). */
  name: string;
  /** Instante en que el sensor informó (ms). */
  at: number;
  /** Humedad del suelo que marca el sensor (%). */
  soilPct: number;
  tempC: number | null;
  battery: number | null;
  /** Déficit (mm) equivalente según la calibración del jardín; null si el sensor aún no está calibrado. */
  deficitMm: number | null;
}

export interface ChartDay {
  date: ISODate;
  etcMm: number;
  replenishedMm: number;
  irrigationMm: number;
  rainMm: number;
  estimated: boolean;
}
