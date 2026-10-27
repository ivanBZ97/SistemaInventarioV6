// Núcleo agronómico: funciones puras sin dependencias de Angular/Capacitor.
// Se usa tanto desde la app (IrrigationEngineService) como desde el worker en segundo plano.
import type {
  ChartDay,
  DailyWeather,
  DayRecord,
  Evaluation,
  IrrigationEvent,
  ISODate,
  OverseedArea,
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
  locationSet: false,
};

/** Distancia en km entre dos coordenadas (haversine). */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Si te mueves más de esto, el clima de la ubicación anterior ya no vale. */
export const MOVED_THRESHOLD_KM = 10;

export const THRESHOLD_MIN_MM = 6;
export const THRESHOLD_MAX_MM = 12;

export const RAIN_PROB_BLOCK_PCT = 50;
export const RAIN_SUM_BLOCK_MM = 4;
/** Lluvia medida en la última hora desde la que "está lloviendo" (pausa el riego aunque el pronóstico no la vea). */
export const RAINING_NOW_MM = 0.5;
/** "Espera la lluvia de mañana": solo si es muy probable (≥ 70 %) y abundante (mediana de los modelos ≥ 5 mm)… */
export const LOOKAHEAD_PROB_PCT = 70;
export const LOOKAHEAD_MIN_MM = 5;
/** …y el pasto aguanta un día más sin pasar 3 mm sobre el umbral. */
export const LOOKAHEAD_MAX_OVER_MM = 3;
export const WIND_WARN_KMH = 25;
export const MIN_EFFECTIVE_RAIN_MM = 2;
export const EFFECTIVE_RAIN_FACTOR = 0.8;
export const OVERSEED_DAYS = 10;
export const OVERSEED_TEMP_C = 20;
/** Siembra de todo el jardín: se riega al llegar a 2 mm de déficit (riego corto casi a diario) para que la semilla no se seque. */
export const SEEDBED_THRESHOLD_MM = 2;
/** Riego corto de las 13:00 en días de calor (siembra de todo el jardín). */
export const SEEDBED_SPRAY_MM = 2;

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

/**
 * ¿Conviene no regar hoy porque mañana llueve lo suficiente? La lluvia de mañana tiene que ser muy probable y su
 * parte útil tiene que reponer todo el déficit de hoy; además, el pasto debe aguantar un día más sin pasar 3 mm
 * sobre el umbral (si la lluvia no llega, mañana se riega). Ahorra un riego antes de un día de lluvia.
 */
export function rainTomorrowCovers(deficitNow: number, etcToday: number, tomorrow: DailyWeather | undefined, thresholdMm: number): boolean {
  if (!tomorrow || tomorrow.precipitationProbMax < LOOKAHEAD_PROB_PCT || tomorrow.precipitationMm < LOOKAHEAD_MIN_MM) return false;
  if (deficitNow + etcToday > thresholdMm + LOOKAHEAD_MAX_OVER_MM) return false;
  return effectiveRain(tomorrow.precipitationMm) >= deficitNow;
}

/** Lluvia del día: la ya medida hoy por la estación manda si supera a la pronosticada. */
export function dayRain(w: DailyWeather): number {
  return w.live && w.live.date === w.date && w.live.sinceMs !== null ? Math.max(w.precipitationMm, w.live.mm) : w.precipitationMm;
}

/**
 * Lluvia medida hoy aplicada al balance. `afterReset` es lo caído después del riego/ajuste de hoy (si no
 * hubo, todo lo de hoy): ya está en el suelo y baja el déficit actual. Si el ajuste es de hoy pero no tiene
 * hora (versión anterior), no se descuenta nada: mejor no contar dos veces la misma lluvia.
 */
function measuredToday(state: WaterState, w: DailyWeather, date: ISODate) {
  const live = w.live && w.live.date === date ? w.live : null;
  if (!live) return { measured: null, afterReset: 0, beforeReset: 0, rainingNow: false };
  const measured = live.sinceMs !== null ? live.mm : null;
  const resetAt = state.resetDate === date ? (state.resetAt ?? Infinity) : -Infinity;
  const afterReset = round1(live.steps.reduce((s, [t, mm]) => (t > resetAt ? s + mm : s), 0));
  return { measured, afterReset, beforeReset: Math.max(0, (measured ?? 0) - afterReset), rainingNow: live.rainingNow };
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
    const rain = w ? effectiveRain(dayRain(w)) : 0;
    deficit = Math.max(0, deficit + dayEtc - rain);
    days.push({ date: d, etcMm: dayEtc, effectiveRainMm: rain });
  }
  return { state: { ...state, deficitMm: deficit, asOf: targetDate < state.asOf ? state.asOf : targetDate }, days };
}

/** Lluvia medida por el usuario (mm por día). Reemplaza al modelo/estación en días ya pasados. */
export type RainOverrides = Record<ISODate, number>;

export function applyRainOverrides(days: DailyWeather[], overrides: RainOverrides | undefined, today: ISODate): DailyWeather[] {
  if (!overrides) return days;
  return days.map((d) => (d.date < today && overrides[d.date] !== undefined ? { ...d, precipitationMm: overrides[d.date] } : d));
}

/**
 * Corrige la lluvia de un día pasado. Si ese día ya se contabilizó en el balance, ajusta el déficit
 * por la diferencia de lluvia efectiva (antes − ahora) y actualiza el historial.
 */
export function correctPastRain(
  state: WaterState,
  history: DayRecord[],
  date: ISODate,
  observedMm: number,
  modelPrecipMm = 0,
): { state: WaterState; history: DayRecord[] } {
  const rec = history.find((h) => h.date === date);
  const oldEff = rec ? rec.effectiveRainMm : effectiveRain(modelPrecipMm);
  const newEff = effectiveRain(Math.max(0, observedMm));
  // Solo cuenta si el día ya entró al balance y es posterior al último riego/ajuste (antes, la lluvia ya no influye).
  const counted = date < state.asOf && (!state.resetDate || date >= state.resetDate);
  return {
    state: counted ? { ...state, deficitMm: Math.max(0, state.deficitMm + oldEff - newEff) } : state,
    history: history.map((h) => (h.date === date ? { ...h, effectiveRainMm: newEff } : h)),
  };
}

/**
 * Reconcilia los días YA contabilizados con la lluvia medida por una estación (DMC/INIA) cuando difiere de
 * la que se usó (p. ej. el modelo). Las correcciones manuales del usuario mandan y no se tocan.
 */
export function reconcileObservedRain(
  state: WaterState,
  history: DayRecord[],
  observed: Record<ISODate, number> | undefined,
  overrides: RainOverrides | undefined,
): { state: WaterState; history: DayRecord[]; changed: boolean } {
  let s = state;
  let h = history;
  let changed = false;
  for (const [date, mm] of Object.entries(observed ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (overrides?.[date] !== undefined || date >= s.asOf) continue;
    const rec = h.find((x) => x.date === date);
    if (!rec || Math.abs(rec.effectiveRainMm - effectiveRain(mm)) < 0.05) continue;
    ({ state: s, history: h } = correctPastRain(s, h, date, mm));
    changed = true;
  }
  return { state: s, history: h, changed };
}

/**
 * Igual que con la lluvia, pero con la ET0: si la estación midió una ET0 distinta a la usada en un día ya
 * contabilizado, se corrige el consumo (ETc) de ese día y el déficit por la diferencia.
 */
export function reconcileObservedEt0(
  state: WaterState,
  history: DayRecord[],
  observed: Record<ISODate, number> | undefined,
): { state: WaterState; history: DayRecord[]; changed: boolean } {
  let s = state;
  let h = history;
  let changed = false;
  for (const [date, et0] of Object.entries(observed ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (date >= s.asOf) continue;
    const rec = h.find((x) => x.date === date);
    if (!rec) continue;
    const newEtc = etc(et0, date);
    if (Math.abs(rec.etcMm - newEtc) < 0.05) continue;
    if (!s.resetDate || date >= s.resetDate) s = { ...s, deficitMm: Math.max(0, s.deficitMm + newEtc - rec.etcMm) };
    h = h.map((x) => (x.date === date ? { ...x, etcMm: newEtc } : x));
    changed = true;
  }
  return { state: s, history: h, changed };
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
  const m = measuredToday(state, today, date);
  // La lluvia que ya cayó hoy está en el suelo: baja el déficit actual y el riego que corresponde.
  const deficit = Math.max(0, rolled.deficitMm - effectiveRain(m.afterReset));
  const forecastBlock =
    today.precipitationProbMax >= RAIN_PROB_BLOCK_PCT || today.precipitationMm >= RAIN_SUM_BLOCK_MM;
  const measuredBlock = (m.measured ?? 0) >= RAIN_SUM_BLOCK_MM;
  const threshold = thresholdFor(state, settings, date);
  const needs = deficit >= threshold;
  const etcToday = etc(today.et0Mm, date);
  const tomorrow = weather.find((w) => w.date === addDays(date, 1));
  // Mañana llueve lo suficiente: hoy no se riega (salvo siembra de todo el jardín: la semilla no puede secarse).
  const seedbed = overseedActive(state, date) && overseedArea(state) === 'full';
  const waitBlock =
    needs && !forecastBlock && !measuredBlock && !m.rainingNow && !seedbed && rainTomorrowCovers(deficit, etcToday, tomorrow, threshold);
  const rainBlock = forecastBlock || measuredBlock || m.rainingNow || waitBlock;
  // Para mañana cuenta la lluvia de todo el día, salvo la caída antes de un riego/ajuste de hoy.
  const rainToday = effectiveRain(Math.max(0, dayRain(today) - m.beforeReset));
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
    rainMeasuredMm: m.measured,
    rainingNow: m.rainingNow,
    rainBlockReason: measuredBlock ? 'measured' : m.rainingNow ? 'raining' : forecastBlock ? 'forecast' : waitBlock ? 'tomorrow' : null,
    rainTomorrowMm: tomorrow?.precipitationMm ?? 0,
    rainTomorrowProbPct: tomorrow?.precipitationProbMax ?? 0,
    overseed: overseedActive(state, date) ? overseedArea(state) : null,
    thresholdMm: threshold,
    effectiveRainTodayMm: rainToday,
    etcTodayMm: etcToday,
    projectedDeficitMm: Math.max(0, rolled.deficitMm + etcToday - rainToday),
    windMaxKmh: today.windMaxKmh,
    windWarning: today.windMaxKmh > WIND_WARN_KMH,
    rainBlock,
    humidityPct: humidityPct(deficit),
  };
}

// ───────────────────────── Próximo riego (pronóstico) ─────────────────────────

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "jueves" (sin depender de Intl: también corre en el worker en segundo plano). */
export function weekdayEs(date: ISODate): string {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

/** "jueves 23 de octubre" */
export function longDateEs(date: ISODate): string {
  const [, m, d] = date.split('-').map(Number);
  return `${weekdayEs(date)} ${d} de ${MONTHS[m - 1]}`;
}

export interface ForecastDay {
  date: ISODate;
  /** Déficit al inicio del día (mm). */
  deficitMm: number;
  etcMm: number;
  rainMm: number;
  effectiveRainMm: number;
  rainProbPct: number;
  /** El riego se bloquearía ese día por lluvia pronosticada (o porque al día siguiente llueve lo suficiente). */
  rainBlock: boolean;
  /** No se riega porque la lluvia del día siguiente repone el déficit. */
  waitForRain: boolean;
  /** Día en que tocaría regar. */
  irrigate: boolean;
}

export interface NextIrrigation {
  /** Fecha estimada del próximo riego. */
  date: ISODate;
  daysAhead: number;
  minutes: number;
  deficitMm: number;
  /** true si cae más allá de los días con pronóstico (se extrapola con el ETc promedio y sin lluvia). */
  beyondForecast: boolean;
  /** Primer día de lluvia útil que retrasa el riego, si lo hay. */
  delayedByRain: ISODate | null;
  timeline: ForecastDay[];
}

/**
 * Proyecta el balance con el pronóstico, día a día desde hoy, aplicando las mismas reglas que la
 * evaluación matutina (umbral + bloqueo por lluvia). Devuelve el primer día en que tocaría regar.
 */
export function forecastNextIrrigation(
  state: WaterState,
  weather: DailyWeather[],
  settings: Settings,
  today: ISODate,
): NextIrrigation | null {
  const start = rollForward(state, weather, today).state.deficitMm;
  const future = weather.filter((w) => w.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (!future.length) return null;

  const timeline: ForecastDay[] = [];
  let deficit = start;
  let found: ForecastDay | null = null;
  let delayedByRain: ISODate | null = null;
  for (const [i, w] of future.entries()) {
    // Hoy decide igual que la evaluación: déficit actual con la lluvia ya medida y pausa si llovió o llueve.
    const m = w.date === today ? measuredToday(state, w, today) : null;
    let rainBlock =
      w.precipitationProbMax >= RAIN_PROB_BLOCK_PCT ||
      w.precipitationMm >= RAIN_SUM_BLOCK_MM ||
      (!!m && ((m.measured ?? 0) >= RAIN_SUM_BLOCK_MM || m.rainingNow));
    const snoozed = state.snoozedDate === w.date;
    const rainMm = m ? Math.max(0, dayRain(w) - m.beforeReset) : w.precipitationMm;
    const current = m ? Math.max(0, deficit - effectiveRain(m.afterReset)) : deficit;
    const threshold = thresholdFor(state, settings, w.date);
    const etcMm = etc(w.et0Mm, w.date);
    const seedbed = overseedActive(state, w.date) && overseedArea(state) === 'full';
    const waitForRain = !rainBlock && !seedbed && current >= threshold && rainTomorrowCovers(current, etcMm, future[i + 1], threshold);
    rainBlock ||= waitForRain;
    const day: ForecastDay = {
      date: w.date,
      deficitMm: current,
      etcMm,
      rainMm,
      effectiveRainMm: effectiveRain(rainMm),
      rainProbPct: w.precipitationProbMax,
      rainBlock,
      waitForRain,
      irrigate: false,
    };
    if (!found && current >= threshold && !rainBlock && !snoozed) {
      day.irrigate = true;
      found = day;
    }
    if (!found && !delayedByRain && day.effectiveRainMm > 0) delayedByRain = w.date;
    timeline.push(day);
    // si hoy se riega, el balance proyectado vuelve a 0 desde ese día
    deficit = Math.max(0, (day.irrigate ? 0 : deficit) + day.etcMm - day.effectiveRainMm);
  }

  if (found) {
    return {
      date: found.date,
      daysAhead: diffDays(found.date, today),
      minutes: minutesFor(found.deficitMm, settings.sprinklerRateMmMin),
      deficitMm: found.deficitMm,
      beyondForecast: false,
      delayedByRain,
      timeline,
    };
  }

  // Más allá del pronóstico: se extrapola con el ETc promedio y sin lluvia.
  const avgEtc = timeline.reduce((s, d) => s + d.etcMm, 0) / timeline.length;
  if (avgEtc <= 0) return null;
  const extra = Math.max(1, Math.ceil((settings.thresholdMm - deficit) / avgEtc));
  const date = addDays(timeline[timeline.length - 1].date, extra);
  const deficitAt = deficit + avgEtc * (extra - 1);
  return {
    date,
    daysAhead: diffDays(date, today),
    minutes: minutesFor(deficitAt, settings.sprinklerRateMmMin),
    deficitMm: deficitAt,
    beyondForecast: true,
    delayedByRain,
    timeline,
  };
}

// ───────────────────────── Modo resiembra ─────────────────────────

export function overseedActive(state: WaterState, date: ISODate): boolean {
  return !!state.overseedUntil && date <= state.overseedUntil;
}

export function overseedDaysLeft(state: WaterState, date: ISODate): number {
  return state.overseedUntil && date <= state.overseedUntil ? diffDays(state.overseedUntil, date) + 1 : 0;
}

export function startOverseed(state: WaterState, today: ISODate, area: OverseedArea = 'patches'): WaterState {
  return { ...state, overseedUntil: addDays(today, OVERSEED_DAYS - 1), overseedArea: area };
}

/** Dónde se sembró (los estados guardados antes de poder elegirlo eran de parches). */
export function overseedArea(state: WaterState): OverseedArea {
  return state.overseedArea ?? 'patches';
}

/**
 * Umbral de riego del día. Mientras germina una siembra de todo el jardín, el suelo de la superficie no puede
 * secarse: se riega corto y seguido (umbral de 2 mm). Con parches el pasto sigue su umbral normal.
 */
export function thresholdFor(state: WaterState, settings: Settings, date: ISODate): number {
  return overseedActive(state, date) && overseedArea(state) === 'full'
    ? Math.min(settings.thresholdMm, SEEDBED_THRESHOLD_MM)
    : settings.thresholdMm;
}

// ───────────────────────── Notificaciones ─────────────────────────

/** Horas elegibles para el aviso matutino: cada 15 min dentro de la ventana 06:30–08:30. */
export const MORNING_TIME_OPTIONS = ['06:30', '06:45', '07:00', '07:15', '07:30', '07:45', '08:00', '08:15', '08:30'];

/** Hora del aviso elegida por el usuario, limitada a la ventana (jamás nocturna). */
export function morningTimeOf(settings: Pick<Settings, 'morningTime'>): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(settings.morningTime ?? '');
  const mins = m ? Number(m[1]) * 60 + Number(m[2]) : MORNING.hour * 60 + MORNING.minute;
  const lo = MORNING.hour * 60 + MORNING.minute;
  const hi = WINDOW_END.hour * 60 + WINDOW_END.minute;
  const c = clamp(mins, lo, hi);
  return { hour: Math.floor(c / 60), minute: c % 60 };
}

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
  // Siembra por parches: el pasto se riega normal y los parches se rocían a mano todos los días.
  const patches = ev.overseed === 'patches' ? ' 🌱 Rocía también los parches sembrados unos 30 segundos.' : '';
  if (ev.status === 'irrigate' && ev.overseed === 'full') {
    return {
      ...base,
      title: `🌱 Riego de siembra: ${ev.minutes} min en todo el jardín`,
      body:
        `Riego corto para mantener húmeda la semilla. Déficit: ${round1(ev.deficitMm)} mm | ` +
        `Temp máx hoy: ${Math.round(ev.tempMaxC)}°C.${wind}`,
      actions: true,
    };
  }
  if (ev.status === 'irrigate') {
    return {
      ...base,
      title: `💧 Hoy toca regar el pasto (${ev.minutes} min)`,
      body:
        `Déficit acumulado: ${round1(ev.deficitMm)} mm | ETc ayer: ${round1(ev.etcYesterdayMm)} mm | ` +
        `Temp máx hoy: ${Math.round(ev.tempMaxC)}°C.${wind}${patches}`,
      actions: true,
    };
  }
  const measured = ev.rainMeasuredMm ?? 0;
  if (ev.status === 'paused_rain' && ev.rainBlockReason === 'raining') {
    return {
      ...base,
      title: '🌧️ Riego pausado: está lloviendo',
      body: `Déficit de ${round1(ev.deficitMm)} mm, pero está lloviendo en tu sector${measured > 0 ? ` (${round1(measured)} mm hasta ahora)` : ''}.`,
      actions: false,
    };
  }
  if (ev.status === 'paused_rain' && ev.rainBlockReason === 'tomorrow') {
    return {
      ...base,
      title: '🌧️ Hoy no riegues: mañana llueve',
      body:
        `Déficit de ${round1(ev.deficitMm)} mm, pero mañana se esperan ${round1(ev.rainTomorrowMm)} mm ` +
        `(${Math.round(ev.rainTomorrowProbPct)}% de prob.), suficientes para reponerlo. Si no llueve, se riega mañana.`,
      actions: false,
    };
  }
  if (ev.status === 'paused_rain' && ev.rainBlockReason === 'measured') {
    return {
      ...base,
      title: '🌧️ Riego pausado por lluvia',
      body: `Déficit de ${round1(ev.deficitMm)} mm, pero hoy ya llovieron ${round1(measured)} mm en tu sector.`,
      actions: false,
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
    body:
      `Suelo con humedad suficiente (${Math.round(ev.humidityPct)}%). Déficit: ${round1(ev.deficitMm)} mm.` +
      (measured > 0 ? ` Hoy ya llovieron ${round1(measured)} mm.` : '') +
      patches,
    actions: false,
  };
}

export const OVERSEED_MESSAGE =
  '🌱 Modo Resiembra: Rocía solo los parches sembrados durante 30 segundos para mantener la semilla húmeda sin encharcar el resto del pasto';

/**
 * Aviso de las 13:00 en días de calor: rociar los parches o, si se sembró todo el jardín, un riego corto para
 * todo. Si la estación ya midió lluvia hoy (o está lloviendo), la semilla está húmeda y no hace falta.
 */
export function overseedMessage(state: WaterState, w: DailyWeather, settings: Settings, date: ISODate): string {
  const m = measuredToday(state, w, date);
  if (m.rainingNow || (m.measured ?? 0) > MIN_EFFECTIVE_RAIN_MM) {
    return '🌱 Modo Resiembra: la lluvia de hoy mantiene húmeda la semilla. No hace falta regar a mediodía.';
  }
  if (overseedArea(state) === 'full') {
    const min = Math.max(1, minutesFor(SEEDBED_SPRAY_MM, settings.sprinklerRateMmMin));
    return `🌱 Modo Resiembra: Riega todo el jardín ${min} min (riego corto) para que la semilla no se seque con el calor.`;
  }
  return OVERSEED_MESSAGE;
}

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
 *  - Matutina (id 1001): hoy a la hora elegida (06:30 por defecto) si aún no pasó; si estamos dentro de la
 *    ventana y hoy no se programó nada (p. ej. tras reiniciar el teléfono) se emite de inmediato; si no, mañana.
 *  - Resiembra (id 1002): 13:00 del día correspondiente si el modo está activo y tmax ≥ 20 °C (parches: rociarlos;
 *    todo el jardín: riego corto).
 */
export function planNotifications({ state, weather, settings, now }: PlanInput): Plan {
  const today = toISODate(now);
  const morning = morningTimeOf(settings);
  const morningToday = atTime(today, morning);
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
    at = atTime(targetDate, morning);
  }

  if (state.snoozedDate !== targetDate) {
    const ev = evaluate(state, weather, settings, targetDate);
    if (ev) {
      const n = morningNotification(ev, at);
      if (ev.status === 'ok') {
        const next = forecastNextIrrigation(state, weather, settings, targetDate);
        if (next && next.daysAhead > 0) n.body += ` Próximo riego estimado: ${weekdayEs(next.date)}.`;
      }
      notifications.push(n);
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
        body: overseedMessage(state, w, settings, seedDate),
        at: atTime(seedDate, OVERSEED_CHECK),
        actions: false,
      });
    }
  }
  return { notifications, morningFor };
}

// ───────────────────────── Agua usada ─────────────────────────

/** Litros de agua: 1 mm sobre 1 m² es 1 litro. null si no se indicó la superficie. */
export function litersFor(mm: number, areaM2: number | undefined): number | null {
  return areaM2 && areaM2 > 0 ? Math.round(mm * areaM2) : null;
}

export interface MonthSummary {
  /** Días con balance registrado en el periodo (de los últimos 30). */
  days: number;
  irrigations: number;
  irrigationMm: number;
  /** Lluvia útil (80 % de la que supera 2 mm). */
  rainMm: number;
  /** Lo que consumió el pasto (ETc). */
  etcMm: number;
  liters: number | null;
}

/** Resumen de los últimos 30 días: cuántas veces se regó, cuánta agua se puso y cuánta aportó la lluvia. */
export function monthSummary(today: ISODate, history: DayRecord[], irrigations: IrrigationEvent[], areaM2?: number): MonthSummary {
  const from = addDays(today, -30);
  const days = history.filter((h) => h.date >= from && h.date < today);
  const irr = irrigations.filter((e) => e.date >= from && e.date <= today);
  const irrigationMm = irr.reduce((s, e) => s + e.mm, 0);
  return {
    days: days.length,
    irrigations: irr.length,
    irrigationMm,
    rainMm: days.reduce((s, d) => s + d.effectiveRainMm, 0),
    etcMm: days.reduce((s, d) => s + d.etcMm, 0),
    liters: litersFor(irrigationMm, areaM2),
  };
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
    const rain = h ? h.effectiveRainMm : w ? effectiveRain(dayRain(w)) : 0;
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
