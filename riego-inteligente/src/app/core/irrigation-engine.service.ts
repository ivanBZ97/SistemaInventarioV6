import { Injectable, inject, signal } from '@angular/core';
import { StorageService } from './storage.service';
import { STORAGE } from './storage-keys';
import { NO_WEATHER, STATION_LIVE_MAX_AGE_MS, WeatherService, type WeatherResult } from './weather.service';
import type { StationSource } from './dmc';
import { tuyaErrorText } from './tuya';
import { applySensorReading } from './soil-sensor';
import { LocationService } from './location.service';
import { SOIL_SENSOR_PROVIDER } from './soil-sensor.provider';
import { addDays, toISODate } from './dates';
import {
  DEFAULT_SETTINGS,
  type MonthSummary,
  type NextIrrigation,
  type RainOverrides,
  applyIrrigation,
  applyRainOverrides,
  buildChart,
  correctPastRain,
  evaluate,
  forecastNextIrrigation,
  monthSummary,
  overseedDaysLeft,
  planNotifications,
  reconcileObservedEt0,
  reconcileObservedRain,
  rollForward,
  startOverseed,
} from './irrigation-core';
import type { RunnerSnapshot } from './runner-protocol';
import type {
  ChartDay,
  DayRecord,
  Evaluation,
  IrrigationEvent,
  ISODate,
  LiveRain,
  OverseedArea,
  PlannedNotification,
  Settings,
  SoilReading,
  StationStatus,
  WaterState,
} from './models';

/** Todo lo que muestra la interfaz, calculado en un instante. */
export interface Snapshot {
  settings: Settings;
  state: WaterState;
  today: ISODate;
  evaluation: Evaluation | null;
  /** Próximo riego estimado con el pronóstico. */
  next: NextIrrigation | null;
  /** Lluvia corregida por el usuario, por día. */
  rainOverrides: RainOverrides;
  chart: ChartDay[];
  /** Últimos 30 días: riegos, agua y lluvia. */
  month: MonthSummary;
  overseedDaysLeft: number;
  staleWeather: boolean;
  elevationM: number | null;
  /** Estación que aportó la lluvia observada, o null si se usa el modelo. */
  rainSource: string | null;
  /** Estación que aportó la ET0 medida (días pasados) y la corrección aplicada al pronóstico de ET0. */
  et0Source: string | null;
  et0Ratio: number | null;
  /** Lluvia de hoy medida por la estación hasta su última lectura (se actualiza cada 10 min con la app abierta). */
  liveRain: LiveRain | null;
  /** Última consulta a la estación: si no trae lecturas nuevas, el panel explica por qué. */
  station: StationStatus | null;
  /** Estación de respaldo en uso porque la elegida lleva más de 3 h sin publicar. */
  backup: StationSource | null;
  /** Última lectura del sensor de suelo (si hay uno configurado) y, si falló, por qué. */
  sensor: SoilReading | null;
  sensorError: string | null;
  error: string | null;
}

/** Días de balance cerrado que se conservan. */
const HISTORY_DAYS = 30;
/** Riegos registrados que se conservan. */
const MAX_IRRIGATIONS = 200;

interface Stored {
  settings: Settings;
  state: WaterState;
  history: DayRecord[];
  irrigations: IrrigationEvent[];
  rainOverrides: RainOverrides;
}

/**
 * Orquesta el motor agronómico (reglas puras en irrigation-core.ts) con persistencia, clima y sensor. Es la única
 * clase que modifica el balance hídrico guardado.
 *
 * Todas las operaciones públicas pasan por una fila (`exclusive`): cada una lee el estado, puede esperar a la red
 * y vuelve a escribirlo, así que dos a la vez (p. ej. el refresco automático y "Ya regué") se pisarían.
 */
@Injectable({ providedIn: 'root' })
export class IrrigationEngineService {
  private storage = inject(StorageService);
  private weather = inject(WeatherService);
  private location = inject(LocationService);
  private sensor = inject(SOIL_SENSOR_PROVIDER);

  /** Último cálculo; null hasta el primero (ver `ready`). */
  readonly snapshot = signal<Snapshot | null>(null);

  private queue: Promise<unknown> = Promise.resolve();
  private first: Promise<Snapshot> | null = null;
  /** Lo que cambió el último riego registrado, para "Deshacer" (solo en esta sesión). */
  private beforeIrrigation: { state: WaterState; eventAt: string } | null = null;

  /** Ejecuta `task` cuando terminen las operaciones anteriores (una a la vez, en orden de llegada). */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** El snapshot actual o, si aún no hay, el del primer cálculo (compartido por quienes lo pidan a la vez). */
  ready(): Promise<Snapshot> {
    const snap = this.snapshot();
    if (snap) return Promise.resolve(snap);
    this.first ??= this.refresh().finally(() => (this.first = null));
    return this.first;
  }

  /**
   * Recalcula todo: avanza el balance hasta hoy, aplica el sensor (si hay), evalúa y publica el snapshot.
   * `forceWeather` (deslizar para actualizar) vuelve a pedir el pronóstico, la estación y el sensor.
   */
  refresh(forceWeather = false): Promise<Snapshot> {
    return this.exclusive(() => this.recalculate(forceWeather));
  }

  // ───────────── Acciones del usuario ─────────────

  /** "Corregir lluvia": mm realmente caídos un día pasado (INIA, pluviómetro…). Recalcula el balance. */
  correctRain(date: ISODate, observedMm: number): Promise<Snapshot> {
    return this.exclusive(async () => {
      const { settings, state, history, rainOverrides } = await this.load();
      let modelMm = 0;
      try {
        modelMm = (await this.weather.getForecast(settings)).days.find((d) => d.date === date)?.precipitationMm ?? 0;
      } catch {
        /* sin clima: se usa el historial */
      }
      const fixed = correctPastRain(state, history, date, observedMm, rainOverrides[date] ?? modelMm);
      await this.storage.set(STORAGE.rainOverrides, { ...rainOverrides, [date]: Math.max(0, observedMm) });
      await this.storage.set(STORAGE.history, fixed.history);
      await this.storage.set(STORAGE.state, fixed.state);
      return this.recalculate();
    });
  }

  /**
   * "Ya regué" / "Registrar riego": sin `minutes` repone todo el déficit actual (lo recomendado); con `minutes`,
   * minutos × tasa del aspersor (si fue menos, queda déficit). Se anota en el historial. Devuelve el déficit que queda.
   */
  registerIrrigation(source: IrrigationEvent['source'] = 'manual', minutes?: number): Promise<number> {
    return this.exclusive(async () => {
      const snap = await this.recalculate();
      const { settings, state, irrigations } = await this.load();
      // Lo que faltaba reponer ahora: el déficit actual ya descuenta la lluvia caída hoy.
      const current = snap.evaluation?.deficitMm ?? state.deficitMm;
      const mm = minutes === undefined ? current : Math.max(0, minutes) * settings.sprinklerRateMmMin;
      const watered = applyIrrigation({ ...state, deficitMm: current }, minutes === undefined ? undefined : mm);
      const now = new Date();
      const event: IrrigationEvent = { date: toISODate(now), at: now.toISOString(), mm: Math.round(mm * 10) / 10, source };
      this.beforeIrrigation = { state, eventAt: event.at };
      await this.storage.set(STORAGE.irrigations, [...irrigations, event].slice(-MAX_IRRIGATIONS));
      await this.storage.set(STORAGE.state, { ...watered, snoozedDate: undefined, resetDate: event.date, resetAt: now.getTime() });
      await this.recalculate();
      return watered.deficitMm;
    });
  }

  /**
   * "Deshacer": quita el último riego registrado y devuelve el balance a como estaba. Solo revierte lo que cambió el
   * riego (lo demás, p. ej. qué aviso ya se programó hoy, se conserva).
   */
  undoIrrigation(): Promise<boolean> {
    return this.exclusive(async () => {
      const before = this.beforeIrrigation;
      if (!before) return false;
      this.beforeIrrigation = null;
      const { state, irrigations } = await this.load();
      const { deficitMm, source, snoozedDate, resetDate, resetAt } = before.state;
      await this.storage.set(STORAGE.irrigations, irrigations.filter((e) => e.at !== before.eventAt));
      await this.storage.set(STORAGE.state, { ...state, deficitMm, source, snoozedDate, resetDate, resetAt });
      await this.recalculate();
      return true;
    });
  }

  /** "Ajustar humedad manualmente": fija el déficit a un valor (0 = muy húmedo, 12+ = muy seco). */
  setDeficit(mm: number): Promise<Snapshot> {
    const now = new Date();
    return this.updateState((state) => ({ ...state, deficitMm: Math.max(0, mm), source: 'manual', resetDate: toISODate(now), resetAt: now.getTime() }));
  }

  /** "Posponer a mañana": mantiene el déficit y silencia las alertas de hoy. */
  snoozeToday(): Promise<Snapshot> {
    return this.updateState((state) => ({ ...state, snoozedDate: toISODate(new Date()) }));
  }

  /** Modo Resiembra por 10 días, en todo el jardín o solo en parches (cambia cómo se riega). */
  setOverseed(active: boolean, area: OverseedArea = 'patches'): Promise<Snapshot> {
    return this.updateState((state) =>
      active ? startOverseed(state, toISODate(new Date()), area) : { ...state, overseedUntil: undefined, overseedArea: undefined },
    );
  }

  /** Cambia dónde se sembró sin reiniciar los días del modo Resiembra. */
  setOverseedArea(area: OverseedArea): Promise<Snapshot> {
    return this.updateState((state) => ({ ...state, overseedArea: area }));
  }

  /**
   * Guarda ajustes y recalcula. No fuerza el pronóstico: si cambió la ubicación o la estación, sus datos guardados
   * ya no corresponden y se vuelven a pedir solos.
   */
  saveSettings(partial: Partial<Settings>): Promise<Snapshot> {
    return this.exclusive(async () => {
      const { settings } = await this.load();
      await this.storage.set(STORAGE.settings, { ...settings, ...partial });
      return this.recalculate();
    });
  }

  /** Si el usuario se movió > 10 km (y activó la ubicación automática), actualiza sin pedir permisos. */
  async updateLocationIfMoved(): Promise<boolean> {
    const { settings } = await this.load();
    const moved = await this.location.detectIfMoved(settings);
    if (!moved) return false;
    await this.saveSettings(moved);
    return true;
  }

  // ───────────── Avisos y worker ─────────────

  /**
   * Notificaciones que deben quedar programadas según el estado y pronóstico actuales. Con `preview` solo se
   * consultan (panel de estado): no se pide nada a la estación ni se anota que se programó el aviso de la mañana.
   */
  plan(preview = false): Promise<PlannedNotification[]> {
    return this.exclusive(async () => {
      const { settings, state, rainOverrides } = await this.load();
      const forecast = await this.weather.getForecast(settings, { offline: preview });
      const now = new Date();
      const days = applyRainOverrides(forecast.days, rainOverrides, toISODate(now));
      const { notifications, morningFor } = planNotifications({ state, weather: days, settings, now });
      if (!preview && morningFor && morningFor !== state.lastMorningScheduledFor) {
        await this.storage.set(STORAGE.state, { ...state, lastMorningScheduledFor: morningFor });
      }
      return notifications;
    });
  }

  /** Estado + ajustes que necesita el worker en segundo plano para evaluar sin la app abierta. */
  async exportForRunner(): Promise<Required<RunnerSnapshot>> {
    const { settings, state, rainOverrides, history } = await this.load();
    return { settings, state, rainOverrides, history };
  }

  // ───────────── Implementación ─────────────

  private async load(): Promise<Stored> {
    const [settings, state, history, irrigations, rainOverrides] = await Promise.all([
      this.storage.get<Partial<Settings>>(STORAGE.settings, {}),
      this.storage.get<WaterState>(STORAGE.state, {
        deficitMm: 0, // suelo en capacidad de campo tras un riego profundo
        asOf: toISODate(new Date()),
        source: 'model',
      }),
      this.storage.get<DayRecord[]>(STORAGE.history, []),
      this.storage.get<IrrigationEvent[]>(STORAGE.irrigations, []),
      this.storage.get<RainOverrides>(STORAGE.rainOverrides, {}),
    ]);
    return { settings: { ...DEFAULT_SETTINGS, ...settings }, state, history, irrigations, rainOverrides };
  }

  /** Aplica un cambio al balance guardado y recalcula. */
  private updateState(change: (state: WaterState) => WaterState): Promise<Snapshot> {
    return this.exclusive(async () => {
      const { state } = await this.load();
      await this.storage.set(STORAGE.state, change(state));
      return this.recalculate();
    });
  }

  private async recalculate(forceWeather = false): Promise<Snapshot> {
    const today = toISODate(new Date());
    const { settings, state: stored, history: storedHistory, irrigations, rainOverrides } = await this.load();

    let weather: WeatherResult = NO_WEATHER;
    let error: string | null = null;
    try {
      weather = await this.weather.getForecast(settings, { force: forceWeather, stationMaxAgeMs: forceWeather ? 60_000 : STATION_LIVE_MAX_AGE_MS });
    } catch {
      error = 'Sin conexión y sin datos en caché. Se muestra el último balance guardado.';
    }
    // La lluvia medida por el usuario manda sobre el modelo y la estación.
    const days = applyRainOverrides(weather.days, rainOverrides, today);

    // 1) Días ya contabilizados con lluvia o ET0 del modelo: se corrigen con lo medido por la estación.
    const rain = reconcileObservedRain(stored, storedHistory, weather.observedRain, rainOverrides);
    const et0 = reconcileObservedEt0(rain.state, rain.history, weather.observedEt0);
    let state = et0.state;
    let history = et0.history;
    let historyChanged = rain.changed || et0.changed;

    // 2) Avanzar el balance hasta hoy; los días que se cierran pasan al historial.
    if (days.length && state.asOf < today) {
      const rolled = rollForward(state, days, today);
      state = rolled.state;
      const merged = new Map(history.map((h) => [h.date, h]));
      rolled.days.forEach((d) => merged.set(d.date, d));
      const cutoff = addDays(today, -HISTORY_DAYS);
      history = [...merged.values()].filter((h) => h.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
      historyChanged = true;
    }
    if (historyChanged) await this.storage.set(STORAGE.history, history);

    // 3) Sensor de suelo: una lectura reciente, calibrada y posterior al último riego/ajuste reemplaza al cálculo.
    let sensor: SoilReading | null = null;
    let sensorError: string | null = null;
    try {
      sensor = await this.sensor.read(settings, forceWeather);
      state = applySensorReading(state, settings.soilSensor, sensor && { soilPct: sensor.soilPct, at: sensor.at }, settings.thresholdMm, today, Date.now());
    } catch (e) {
      sensorError = tuyaErrorText(e); // sensor caído: se mantiene el balance teórico
    }
    await this.storage.set(STORAGE.state, state);

    const snap: Snapshot = {
      settings,
      state,
      today,
      evaluation: days.length ? evaluate(state, days, settings, today) : null,
      rainOverrides,
      next: days.length ? forecastNextIrrigation(state, days, settings, today) : null,
      chart: buildChart(today, history, days, irrigations),
      month: monthSummary(today, history, irrigations, settings.lawnAreaM2),
      overseedDaysLeft: overseedDaysLeft(state, today),
      staleWeather: weather.stale,
      elevationM: weather.elevationM,
      rainSource: weather.rainSource,
      et0Source: weather.et0Source,
      et0Ratio: weather.et0Ratio,
      liveRain: weather.liveRain,
      station: weather.station,
      backup: weather.backup,
      sensor,
      sensorError,
      error,
    };
    this.snapshot.set(snap);
    return snap;
  }
}
