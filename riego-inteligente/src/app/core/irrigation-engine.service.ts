import { Injectable, inject, signal } from '@angular/core';
import { StorageService } from './storage.service';
import { STATION_LIVE_MAX_AGE_MS, WeatherService } from './weather.service';
import type { StationSource } from './dmc';
import { LocationService } from './location.service';
import { SOIL_SENSOR_PROVIDER } from './soil-sensor.provider';
import {
  DEFAULT_SETTINGS,
  addDays,
  applyRainOverrides,
  correctPastRain,
  reconcileObservedEt0,
  reconcileObservedRain,
  applyIrrigation,
  buildChart,
  deficitFromHumidity,
  evaluate,
  forecastNextIrrigation,
  overseedActive,
  overseedDaysLeft,
  planNotifications,
  rollForward,
  startOverseed,
  toISODate,
} from './irrigation-core';
import type { NextIrrigation, RainOverrides } from './irrigation-core';
import type {
  ChartDay,
  DailyWeather,
  DayRecord,
  Evaluation,
  IrrigationEvent,
  LiveRain,
  OverseedArea,
  StationStatus,
  PlannedNotification,
  Settings,
  WaterState,
} from './models';

export interface Snapshot {
  settings: Settings;
  state: WaterState;
  today: string;
  evaluation: Evaluation | null;
  /** Próximo riego estimado con el pronóstico. */
  next: NextIrrigation | null;
  /** Lluvia corregida por el usuario, por día. */
  rainOverrides: RainOverrides;
  chart: ChartDay[];
  overseedDaysLeft: number;
  staleWeather: boolean;
  elevationM: number | null;
  /** Estación INIA que aportó la lluvia observada, o null si se usa el modelo. */
  rainSource: string | null;
  /** Estación que aportó la ET0 medida (días pasados) y la corrección aplicada al pronóstico de ET0. */
  et0Source: string | null;
  et0Ratio: number | null;
  /** Lluvia de hoy medida por la estación hasta su última lectura (se actualiza cada 5 min con la app abierta). */
  liveRain: LiveRain | null;
  /** Última consulta a la estación: si no trae lecturas nuevas, el panel explica por qué. */
  station: StationStatus | null;
  /** Estación de respaldo en uso porque la elegida lleva más de 3 h sin publicar. */
  backup: StationSource | null;
  error: string | null;
}

const SENSOR_MAX_AGE_MS = 3 * 3_600_000;

/**
 * IrrigationEngineService: orquesta el motor agronómico (reglas puras en irrigation-core.ts)
 * con persistencia, clima y sensor. Es la única clase que muta el estado del balance hídrico.
 */
@Injectable({ providedIn: 'root' })
export class IrrigationEngineService {
  private storage = inject(StorageService);
  private weather = inject(WeatherService);
  private location = inject(LocationService);
  private sensor = inject(SOIL_SENSOR_PROVIDER);

  readonly snapshot = signal<Snapshot | null>(null);

  private async loadAll() {
    const settings = { ...DEFAULT_SETTINGS, ...(await this.storage.get<Partial<Settings>>('settings', {})) };
    const state = await this.storage.get<WaterState>('state', {
      deficitMm: 0, // suelo en capacidad de campo tras un riego profundo
      asOf: toISODate(new Date()),
      source: 'model',
    });
    const history = await this.storage.get<DayRecord[]>('history', []);
    const irrigations = await this.storage.get<IrrigationEvent[]>('irrigations', []);
    const rainOverrides = await this.storage.get<RainOverrides>('rainOverrides', {});
    return { settings, state, history, irrigations, rainOverrides };
  }

  /**
   * Recalcula todo: avanza el balance hasta hoy, aplica sensor (si hay), evalúa y refresca el snapshot.
   * `forceWeather` (deslizar para actualizar) vuelve a pedir el pronóstico y la estación.
   */
  async refresh(forceWeather = false): Promise<Snapshot> {
    const now = new Date();
    const today = toISODate(now);
    const { settings, state: stored, history, irrigations, rainOverrides } = await this.loadAll();

    let days: DailyWeather[] = [];
    let stale = false;
    let elevationM: number | null = null;
    let rainSource: string | null = null;
    let observedRain: Record<string, number> = {};
    let observedEt0: Record<string, number> = {};
    let et0Source: string | null = null;
    let et0Ratio: number | null = null;
    let liveRain: LiveRain | null = null;
    let station: StationStatus | null = null;
    let backup: StationSource | null = null;
    let error: string | null = null;
    try {
      ({ days, stale, elevationM, rainSource, observedRain, observedEt0, et0Source, et0Ratio, liveRain, station, backup } = await this.weather.getForecast(
        settings,
        forceWeather,
        forceWeather ? 60_000 : STATION_LIVE_MAX_AGE_MS,
      ));
    } catch (e) {
      error = 'Sin conexión y sin datos en caché. Se muestra el último balance guardado.';
    }
    // La lluvia medida por el usuario manda sobre el modelo y la estación.
    days = applyRainOverrides(days, rainOverrides, today);

    // 0) Días ya contabilizados con lluvia del modelo: se corrigen con la lluvia medida por la estación.
    const rec = reconcileObservedRain(stored, history, observedRain, rainOverrides);
    const recEt = reconcileObservedEt0(rec.state, rec.history, observedEt0);
    if (rec.changed || recEt.changed) {
      await this.storage.set('history', recEt.history);
      history.splice(0, history.length, ...recEt.history);
    }

    // 1) Avanzar el balance hasta hoy y guardar el historial de días cerrados.
    let state = recEt.state;
    if (days.length && state.asOf < today) {
      const rolled = rollForward(state, days, today);
      state = rolled.state;
      const merged = new Map(history.map((h) => [h.date, h]));
      rolled.days.forEach((d) => merged.set(d.date, d));
      const cutoff = addDays(today, -30);
      const trimmed = [...merged.values()].filter((h) => h.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
      await this.storage.set('history', trimmed);
      history.splice(0, history.length, ...trimmed);
    }

    // 2) Fase 2: un sensor real sobrescribe el cálculo teórico.
    try {
      const reading = await this.sensor.read();
      if (reading && Date.now() - Date.parse(reading.takenAt) < SENSOR_MAX_AGE_MS) {
        state = { ...state, deficitMm: deficitFromHumidity(reading.moisturePct), source: 'sensor', resetDate: today, resetAt: Date.parse(reading.takenAt) };
      }
    } catch {
      /* sensor caído: se mantiene el balance teórico */
    }
    await this.storage.set('state', state);

    const evaluation = days.length ? evaluate(state, days, settings, today) : null;
    const snap: Snapshot = {
      settings,
      state,
      today,
      evaluation,
      rainOverrides,
      next: days.length ? forecastNextIrrigation(state, days, settings, today) : null,
      chart: buildChart(today, history, days, irrigations),
      overseedDaysLeft: overseedDaysLeft(state, today),
      staleWeather: stale,
      elevationM,
      rainSource,
      et0Source,
      et0Ratio,
      liveRain,
      station,
      backup,
      error,
    };
    this.snapshot.set(snap);
    return snap;
  }

  /** "Corregir lluvia": mm realmente caídos un día pasado (INIA, pluviómetro…). Recalcula el balance. */
  async correctRain(date: string, observedMm: number): Promise<void> {
    const { settings, state, history, rainOverrides } = await this.loadAll();
    let modelMm = 0;
    try {
      modelMm = (await this.weather.getForecast(settings)).days.find((d) => d.date === date)?.precipitationMm ?? 0;
    } catch {
      /* sin clima: se usa el historial */
    }
    const fixed = correctPastRain(state, history, date, observedMm, rainOverrides[date] ?? modelMm);
    await this.storage.set('rainOverrides', { ...rainOverrides, [date]: Math.max(0, observedMm) });
    await this.storage.set('history', fixed.history);
    await this.storage.set('state', fixed.state);
    await this.refresh();
  }

  /** Notificaciones que deben quedar programadas según el estado y pronóstico actuales. */
  async plan(): Promise<PlannedNotification[]> {
    const { settings, state, rainOverrides } = await this.loadAll();
    const days = applyRainOverrides((await this.weather.getForecast(settings)).days, rainOverrides, toISODate(new Date()));
    const { notifications, morningFor } = planNotifications({ state, weather: days, settings, now: new Date() });
    if (morningFor && morningFor !== state.lastMorningScheduledFor) {
      await this.storage.set('state', { ...state, lastMorningScheduledFor: morningFor });
    }
    return notifications;
  }

  // ───────────── Acciones del usuario ─────────────

  /** "Ya regué" / "Registrar riego ahora": déficit → 0 mm y se anota en el historial. */
  async registerIrrigation(source: IrrigationEvent['source'] = 'manual'): Promise<void> {
    const snap = await this.refresh();
    const { state, irrigations } = await this.loadAll();
    // Lo que faltaba reponer ahora: el déficit actual ya descuenta la lluvia caída hoy.
    const mm = snap.evaluation?.deficitMm ?? state.deficitMm;
    const event: IrrigationEvent = { date: toISODate(new Date()), at: new Date().toISOString(), mm, source };
    await this.storage.set('irrigations', [...irrigations, event].slice(-200));
    await this.storage.set('state', { ...applyIrrigation(state), snoozedDate: undefined, resetDate: event.date, resetAt: Date.parse(event.at) });
    await this.refresh();
  }

  /** "Ajustar humedad manualmente": fija el déficit a un valor (0 = muy húmedo, 12+ = muy seco). */
  async setDeficit(mm: number): Promise<void> {
    const { state } = await this.loadAll();
    const now = new Date();
    await this.storage.set('state', { ...state, deficitMm: Math.max(0, mm), source: 'manual', resetDate: toISODate(now), resetAt: now.getTime() });
    await this.refresh();
  }

  /** "Posponer a mañana": mantiene el déficit y silencia las alertas de hoy. */
  async snoozeToday(): Promise<void> {
    const { state } = await this.loadAll();
    await this.storage.set('state', { ...state, snoozedDate: toISODate(new Date()) });
    await this.refresh();
  }

  /** Modo Resiembra por 10 días, en todo el jardín o solo en parches (cambia cómo se riega). */
  async setOverseed(active: boolean, area: OverseedArea = 'patches'): Promise<void> {
    const { state } = await this.loadAll();
    const today = toISODate(new Date());
    const next = active ? startOverseed(state, today, area) : { ...state, overseedUntil: undefined, overseedArea: undefined };
    await this.storage.set('state', next);
    await this.refresh();
  }

  /** Cambia dónde se sembró sin reiniciar los días del modo Resiembra. */
  async setOverseedArea(area: OverseedArea): Promise<void> {
    const { state } = await this.loadAll();
    await this.storage.set('state', { ...state, overseedArea: area });
    await this.refresh();
  }

  async saveSettings(partial: Partial<Settings>): Promise<void> {
    const { settings } = await this.loadAll();
    await this.storage.set('settings', { ...settings, ...partial });
    await this.refresh(true);
  }

  /** Si el usuario se movió > 10 km (y activó la ubicación automática), actualiza sin pedir permisos. */
  async updateLocationIfMoved(): Promise<boolean> {
    const { settings } = await this.loadAll();
    const moved = await this.location.detectIfMoved(settings);
    if (!moved) return false;
    await this.saveSettings(moved);
    return true;
  }

  /** Estado + ajustes que necesita el worker en segundo plano para evaluar sin la app abierta. */
  async exportForRunner(): Promise<{ settings: Settings; state: WaterState; rainOverrides: RainOverrides; history: DayRecord[] }> {
    const { settings, state, rainOverrides, history } = await this.loadAll();
    return { settings, state, rainOverrides, history };
  }

  isOverseedActive(state: WaterState): boolean {
    return overseedActive(state, toISODate(new Date()));
  }
}
