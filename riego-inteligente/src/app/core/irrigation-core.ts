// Núcleo agronómico: funciones puras sin dependencias de Angular/Capacitor.
// Se usa tanto desde la app (IrrigationEngineService) como desde el worker en segundo plano.
import type {
  ChartDay,
  DailyWeather,
  DayRecord,
  Evaluation,
  IrrigationEvent,
  ISODate,
  PlannedNotification,
  Settings,
  WaterState,
} from './models';

export const DEFAULT_SETTINGS: Settings = {
  thresholdMm: 8.0,
  sprinklerRateMmMin: 0.6,
  latitude: -33.59,
  longitude: -70.7,
  useGps: false,
};

export const THRESHOLD_MIN_MM = 6;
export const THRESHOLD_MAX_MM = 12;

export const RAIN_PROB_BLOCK_PCT = 50;
export const RAIN_SUM_BLOCK_MM = 4;
export const WIND_WARN_KMH = 25;
export const MIN_EFFECTIVE_RAIN_MM = 2;
export const EFFECTIVE_RAIN_FACTOR = 0.8;
export const OVERSEED_DAYS = 10;
export const OVERSEED_TEMP_C = 20;

/** Ventana permitida para alertas de riego (nunca riego nocturno). */
export const MORNING = { hour: 6, minute: 30 };
export const WINDOW_END = { hour: 8, minute: 30 };
export const OVERSEED_CHECK = { hour: 13, minute: 0 };

export const NOTIF_ID_MORNING = 1001;
export const NOTIF_ID_OVERSEED = 1002;

/** Déficit (mm) en el que la humedad útil llega al nivel crítico de 20 %. */
const CRITICAL_DEFICIT_MM = 12;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ───────────────────────── Fechas (calendario local) ─────────────────────────

export function toISODate(d: Date): ISODate {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function addDays(iso: ISODate, n: number): ISODate {
  const [y, m, d] = iso.split('-').map(Number);
  return toISODate(new Date(y, m - 1, d + n));
}

export function diffDays(a: ISODate, b: ISODate): number {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(ya, ma - 1, da) - Date.UTC(yb, mb - 1, db)) / 86_400_000);
}

export function atTime(iso: ISODate, t: { hour: number; minute: number }): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, t.hour, t.minute, 0, 0);
}

// ───────────────────────── Modelo agronómico ─────────────────────────

/** Kc dinámico para ballica/festuca fina, Hemisferio Sur. `date` = YYYY-MM-DD. */
export function kcForDate(date: ISODate): number {
  const month = Number(date.slice(5, 7)); // 1-12
  if (month >= 9 && month <= 11) return 0.8; // primavera
  if (month === 12 || month <= 2) return 0.85; // verano
  if (month >= 3 && month <= 5) return 0.7; // otoño
  return 0.55; // invierno (jun–ago)
}

export function etc(et0Mm: number, date: ISODate): number {
  return et0Mm * kcForDate(date);
}

/** 80 % de la lluvia si supera 2 mm; lluvias menores se descuentan como 0. */
export function effectiveRain(precipitationMm: number): number {
  return precipitationMm > MIN_EFFECTIVE_RAIN_MM ? precipitationMm * EFFECTIVE_RAIN_FACTOR : 0;
}

export function minutesFor(deficitMm: number, rateMmMin: number): number {
  return Math.round(deficitMm / rateMmMin);
}

/** 0 mm = 100 %; 12 mm = 20 % (lineal). */
export function humidityPct(deficitMm: number): number {
  return clamp(100 - (deficitMm / CRITICAL_DEFICIT_MM) * 80, 0, 100);
}

/** Inversa de `humidityPct`; usada para convertir una lectura de sensor en déficit. */
export function deficitFromHumidity(pct: number): number {
  return clamp(((100 - pct) / 80) * CRITICAL_DEFICIT_MM, 0, 40);
}

/**
 * Avanza el balance día a día desde `state.asOf` hasta `targetDate`:
 *   Deficit_Hoy = max(0, Deficit_Ayer + ETc_Ayer − Lluvia_Efectiva_Ayer − Riego_Ayer)
 * El riego registrado ya descontó el déficit en el momento de registrarse (ver `applyIrrigation`),
 * por eso aquí no se resta de nuevo. Si falta clima de un día (app sin abrir > 2 días),
 * se usa el ETc promedio de los días conocidos y lluvia 0.
 */
export function rollForward(
  state: WaterState,
  weather: DailyWeather[],
  targetDate: ISODate,
): { state: WaterState; days: DayRecord[] } {
  const byDate = new Map(weather.map((w) => [w.date, w]));
  const known = weather.filter((w) => w.date < targetDate);
  const avgEtc = known.length ? known.reduce((s, w) => s + etc(w.et0Mm, w.date), 0) / known.length : 0;

  let deficit = state.deficitMm;
  const days: DayRecord[] = [];
  for (let d = state.asOf; d < targetDate; d = addDays(d, 1)) {
    const w = byDate.get(d);
    const dayEtc = w ? etc(w.et0Mm, d) : avgEtc;
    const rain = w ? effectiveRain(w.precipitationMm) : 0;
    deficit = Math.max(0, deficit + dayEtc - rain);
    days.push({ date: d, etcMm: dayEtc, effectiveRainMm: rain });
  }
  return { state: { ...state, deficitMm: deficit, asOf: targetDate < state.asOf ? state.asOf : targetDate }, days };
}

/** Riego aplicado: repone `mm` (por defecto todo el déficit → capacidad de campo). */
export function applyIrrigation(state: WaterState, mm?: number): WaterState {
  const left = mm === undefined ? 0 : Math.max(0, state.deficitMm - mm);
  return { ...state, deficitMm: left, source: 'manual' };
}

export function evaluate(
  state: WaterState,
  weather: DailyWeather[],
  settings: Settings,
  date: ISODate,
): Evaluation | null {
  const today = weather.find((w) => w.date === date);
  if (!today) return null;
  const yesterday = weather.find((w) => w.date === addDays(date, -1));
  const rolled = rollForward(state, weather, date).state;
  const deficit = rolled.deficitMm;
  const rainBlock =
    today.precipitationProbMax >= RAIN_PROB_BLOCK_PCT || today.precipitationMm >= RAIN_SUM_BLOCK_MM;
  const needs = deficit >= settings.thresholdMm;
  return {
    date,
    status: !needs ? 'ok' : rainBlock ? 'paused_rain' : 'irrigate',
    deficitMm: deficit,
    minutes: minutesFor(deficit, settings.sprinklerRateMmMin),
    etcYesterdayMm: yesterday ? etc(yesterday.et0Mm, yesterday.date) : 0,
    kc: kcForDate(date),
    tempMaxC: today.tempMaxC,
    rainProbPct: today.precipitationProbMax,
    rainForecastMm: today.precipitationMm,
    windMaxKmh: today.windMaxKmh,
    windWarning: today.windMaxKmh > WIND_WARN_KMH,
    rainBlock,
    humidityPct: humidityPct(deficit),
  };
}

// ───────────────────────── Modo resiembra ─────────────────────────

export function overseedActive(state: WaterState, date: ISODate): boolean {
  return !!state.overseedUntil && date <= state.overseedUntil;
}

export function overseedDaysLeft(state: WaterState, date: ISODate): number {
  return state.overseedUntil && date <= state.overseedUntil ? diffDays(state.overseedUntil, date) + 1 : 0;
}

export function startOverseed(state: WaterState, today: ISODate): WaterState {
  return { ...state, overseedUntil: addDays(today, OVERSEED_DAYS - 1) };
}

// ───────────────────────── Notificaciones ─────────────────────────

/** Fuerza una hora de alerta de riego dentro de 06:30–08:30 (jamás riego nocturno). */
export function clampToIrrigationWindow(at: Date): Date {
  const start = atTime(toISODate(at), MORNING);
  const end = atTime(toISODate(at), WINDOW_END);
  return new Date(clamp(at.getTime(), start.getTime(), end.getTime()));
}

export function morningNotification(ev: Evaluation, at: Date): PlannedNotification {
  const wind = ev.windWarning
    ? ` 💨 Viento fuerte (${Math.round(ev.windMaxKmh)} km/h): riega temprano, antes de que suba el viento.`
    : '';
  const base = {
    id: NOTIF_ID_MORNING,
    channelId: 'riego-matutino' as const,
    at: clampToIrrigationWindow(at),
  };
  if (ev.status === 'irrigate') {
    return {
      ...base,
      title: `💧 Hoy toca regar el pasto (${ev.minutes} min)`,
      body:
        `Déficit acumulado: ${round1(ev.deficitMm)} mm | ETc ayer: ${round1(ev.etcYesterdayMm)} mm | ` +
        `Temp máx hoy: ${Math.round(ev.tempMaxC)}°C.${wind}`,
      actions: true,
    };
  }
  if (ev.status === 'paused_rain') {
    return {
      ...base,
      title: '🌧️ Riego pausado por pronóstico de lluvia',
      body: `Déficit de ${round1(ev.deficitMm)} mm, pero hay ${Math.round(ev.rainProbPct)}% de prob. de lluvia hoy.`,
      actions: false,
    };
  }
  // El worker nativo no puede cancelar alertas; este mensaje sobrescribe (mismo id) cualquier alerta obsoleta.
  return {
    ...base,
    title: '✅ Hoy no hace falta regar',
    body: `Suelo con humedad suficiente (${Math.round(ev.humidityPct)}%). Déficit: ${round1(ev.deficitMm)} mm.`,
    actions: false,
  };
}

export const OVERSEED_MESSAGE =
  '🌱 Modo Resiembra: Rocía solo los parches sembrados durante 30 segundos para mantener la semilla húmeda sin encharcar el resto del pasto';

export interface PlanInput {
  state: WaterState;
  weather: DailyWeather[];
  settings: Settings;
  now: Date;
}

export interface Plan {
  notifications: PlannedNotification[];
  /** Fecha para la que se programó la alerta matutina. */
  morningFor: ISODate | null;
}

/**
 * Decide qué notificaciones dejar programadas:
 *  - Matutina (id 1001): hoy a las 06:30 si aún no pasó; si estamos dentro de la ventana y hoy no se
 *    programó nada (p. ej. tras reiniciar el teléfono) se emite de inmediato; si no, mañana 06:30.
 *  - Resiembra (id 1002): 13:00 del día correspondiente si el modo está activo y tmax ≥ 20 °C.
 */
export function planNotifications({ state, weather, settings, now }: PlanInput): Plan {
  const today = toISODate(now);
  const morningToday = atTime(today, MORNING);
  const windowEnd = atTime(today, WINDOW_END);
  const notifications: PlannedNotification[] = [];
  let morningFor: ISODate | null = null;

  let targetDate: ISODate;
  let at: Date;
  if (now < morningToday) {
    targetDate = today;
    at = morningToday;
  } else if (now < windowEnd && state.lastMorningScheduledFor !== today) {
    targetDate = today;
    at = new Date(now.getTime() + 5_000);
  } else {
    targetDate = addDays(today, 1);
    at = atTime(targetDate, MORNING);
  }

  if (state.snoozedDate !== targetDate) {
    const ev = evaluate(state, weather, settings, targetDate);
    if (ev) {
      notifications.push(morningNotification(ev, at));
      morningFor = targetDate;
    }
  }

  // Chequeo secundario de resiembra (13:00)
  const seedDate = now < atTime(today, OVERSEED_CHECK) ? today : addDays(today, 1);
  if (overseedActive(state, seedDate)) {
    const w = weather.find((x) => x.date === seedDate);
    if (w && w.tempMaxC >= OVERSEED_TEMP_C) {
      notifications.push({
        id: NOTIF_ID_OVERSEED,
        channelId: 'riego-resiembra',
        title: '🌱 Modo Resiembra',
        body: OVERSEED_MESSAGE,
        at: atTime(seedDate, OVERSEED_CHECK),
        actions: false,
      });
    }
  }
  return { notifications, morningFor };
}

// ───────────────────────── Gráfico de 7 días ─────────────────────────

export function buildChart(
  today: ISODate,
  history: DayRecord[],
  weather: DailyWeather[],
  irrigations: IrrigationEvent[],
): ChartDay[] {
  const hist = new Map(history.map((h) => [h.date, h]));
  const wx = new Map(weather.map((w) => [w.date, w]));
  const out: ChartDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    const h = hist.get(date);
    const w = wx.get(date);
    const dayEtc = h ? h.etcMm : w ? etc(w.et0Mm, date) : 0;
    const rain = h ? h.effectiveRainMm : w ? effectiveRain(w.precipitationMm) : 0;
    const irr = irrigations.filter((e) => e.date === date).reduce((s, e) => s + e.mm, 0);
    out.push({
      date,
      etcMm: dayEtc,
      rainMm: rain,
      irrigationMm: irr,
      replenishedMm: rain + irr,
      estimated: !h,
    });
  }
  return out;
}
