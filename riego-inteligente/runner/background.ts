// Worker en segundo plano (@capacitor/background-runner). Corre en un motor JS aislado, sin DOM: solo dispone de
// fetch, CapacitorKV y CapacitorNotifications. Se empaqueta con esbuild en un único archivo
// (runner/dist/background.js → www/runners/background.js) e incluye el mismo motor agronómico que usa la app.
import {
  ACTION_TYPE_ID,
  applyRainOverrides,
  morningTimeOf,
  planNotifications,
  reconcileObservedEt0,
  reconcileObservedRain,
  toISODate,
} from '../src/app/core/irrigation-core';
import { fetchForecast } from '../src/app/core/open-meteo';
import { applyObservedRain, mergeObservedRain } from '../src/app/core/agromet';
import { type DmcStore, backgroundStationMaxAgeMs, loadStationData, storeChanged, withLiveRain, withStationEt0 } from '../src/app/core/dmc';
import { type TuyaToken, readTuyaSoil } from '../src/app/core/tuya';
import { applySensorReading } from '../src/app/core/soil-sensor';
import { RUNNER_HISTORY_KEEP_DAYS, type SensorSample, mergeSamples } from '../src/app/core/sensor-history';
import { RUNNER_EVENT, RUNNER_KV, type RunnerSensorHistory, type RunnerSnapshot } from '../src/app/core/runner-protocol';
import type { DailyWeather, DmcConfig, ISODate, RunnerStatus, Settings, WaterState } from '../src/app/core/models';

// ───────────── API del motor del worker ─────────────

declare const CapacitorKV: {
  get(key: string): { value: string } | null;
  set(key: string, value: string): void;
};
declare const CapacitorNotifications: { schedule(options: unknown[]): void };
declare function addEventListener(
  name: string,
  cb: (resolve: (value?: unknown) => void, reject: (reason?: unknown) => void, args: unknown) => void,
): void;

type KvKey = (typeof RUNNER_KV)[keyof typeof RUNNER_KV];

/** Lee un valor JSON del almacén del worker (null si no existe o está dañado). */
function kvGet<T>(key: KvKey): T | null {
  const raw = CapacitorKV.get(key)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function kvSet(key: KvKey, value: unknown): void {
  CapacitorKV.set(key, JSON.stringify(value));
}

/** Registra cómo terminó la ejecución: la app lo muestra en Ajustes → Estado del sistema. */
function saveStatus(status: Omit<RunnerStatus, 'lastRunAt'>): void {
  kvSet(RUNNER_KV.status, { lastRunAt: Date.now(), ...status });
}

// ───────────── Estación meteorológica ─────────────

/**
 * Datos medidos por la estación DMC (cada consulta trae ~12 h y se acumulan): lluvia y ET0 FAO-56 de los días
 * cerrados, corrección del pronóstico de ET0 y lluvia de hoy hasta la última lectura; si la elegida no publica,
 * de la de respaldo. Consulta cada 30 min si llueve, si se pronostica lluvia o antes del aviso; si no, cada 3 h.
 */
async function stationData(cfg: DmcConfig, settings: Settings, today: ISODate, modelDays: DailyWeather[]) {
  const primaryPrev = kvGet<DmcStore>(RUNNER_KV.dmcStore);
  const backupPrev = kvGet<DmcStore>(RUNNER_KV.dmcStoreBackup);
  const now = Date.now();
  const base = { cfg, auth: settings.dmcAuth, lat: settings.latitude, lon: settings.longitude, elevationM: null, modelDays, today, now, primaryPrev, backupPrev };
  // Para decidir cada cuánto consultar: la lluvia de hoy según lo guardado, con la misma regla de respaldo.
  const liveNow = (await loadStationData({ ...base, maxAgeMs: 0, fetch: false })).live;
  const maxAgeMs = backgroundStationMaxAgeMs(now, liveNow, modelDays.find((d) => d.date === today), morningTimeOf(settings));
  const data = await loadStationData({ ...base, maxAgeMs });
  if (storeChanged(data.primary, primaryPrev)) kvSet(RUNNER_KV.dmcStore, data.primary);
  if (storeChanged(data.backupStore, backupPrev)) kvSet(RUNNER_KV.dmcStoreBackup, data.backupStore);
  return data;
}

// ───────────── Sensor de suelo ─────────────

const SENSOR_EVERY_MS = 60 * 60_000;

interface CachedReading {
  /** Cuándo se consultó a Tuya. */
  at: number;
  soilPct: number;
  /** Cuándo informó el sensor. */
  updatedAt: number;
}

/** Las lecturas del worker quedan aquí (dos semanas) hasta que la app las recoja para su historial. */
function saveSensorSample(sample: SensorSample, now: number): void {
  const prev = kvGet<SensorSample[]>(RUNNER_KV.sensorHistory) ?? [];
  kvSet(RUNNER_KV.sensorHistory, mergeSamples(prev, [sample], now, RUNNER_HISTORY_KEEP_DAYS));
}

/**
 * Sensor de suelo: se consulta a Tuya como máximo cada hora y cada lectura queda en el historial. Si además está
 * calibrado y activado, una lectura reciente y posterior al último riego o ajuste reemplaza al balance teórico
 * (así el aviso de la mañana usa la humedad real).
 */
async function withSensor(state: WaterState, settings: Settings, today: ISODate, now: number): Promise<WaterState> {
  const cfg = settings.soilSensor;
  if (!cfg?.accessId || !cfg.accessSecret || !cfg.deviceId) return state;
  let cached = kvGet<CachedReading>(RUNNER_KV.sensorReading);
  if (!cached || now - cached.at > SENSOR_EVERY_MS) {
    const token = kvGet<TuyaToken>(RUNNER_KV.tuyaToken);
    const r = await readTuyaSoil(cfg, now, token);
    if (r.token !== token) kvSet(RUNNER_KV.tuyaToken, r.token);
    if (r.status.soilPct === null) return state;
    cached = { at: now, soilPct: r.status.soilPct, updatedAt: r.status.updatedAt ?? now };
    kvSet(RUNNER_KV.sensorReading, cached);
    saveSensorSample({ t: cached.updatedAt, soil: cached.soilPct, tempC: r.status.tempC, battery: r.status.battery }, now);
  }
  return applySensorReading(state, cfg, { soilPct: cached.soilPct, at: cached.updatedAt }, settings.thresholdMm, today, now);
}

// ───────────── Evaluación periódica ─────────────

/**
 * Baja el clima, recalcula el balance con lo medido (estación, INIA, sensor) y deja programados el aviso de la
 * mañana y el de las 13:00 (mismo id ⇒ reemplaza al anterior). Si el teléfono estuvo apagado y ya estamos dentro
 * de la ventana 06:30–08:30 sin aviso programado para hoy, lo emite de inmediato.
 */
async function refreshIrrigation(): Promise<void> {
  const snap = kvGet<RunnerSnapshot>(RUNNER_KV.snapshot);
  if (!snap) {
    saveStatus({ ok: false, error: 'la app aún no le ha entregado su estado (ábrela una vez)' });
    return;
  }
  const { settings } = snap;
  const forecast = await fetchForecast(settings.latitude, settings.longitude);
  const today = toISODate(new Date());

  // Lluvia medida en días pasados: estación DMC y, si no hay, INIA Agromet.
  const dmc = settings.dmc ? await stationData(settings.dmc, settings, today, forecast).catch(() => null) : null;
  let measured = forecast;
  let observed = new Map<ISODate, number>();
  if (dmc?.rain.size) {
    measured = mergeObservedRain(forecast, dmc.rain, today);
    observed = dmc.rain;
  } else {
    const inia = await applyObservedRain(forecast, settings.agromet, today);
    measured = inia.days;
    observed = inia.observed;
  }
  let weather = applyRainOverrides(measured, snap.rainOverrides, today);
  // ET0 medida y, para hoy, la lluvia que ya cayó (pausa o descuenta el riego del aviso de la mañana).
  if (dmc) weather = withLiveRain(withStationEt0(weather, dmc.et0, dmc.correction, today), dmc.live, today);

  // Días ya contados con lluvia/ET0 del modelo → se corrigen en memoria (la app lo guarda al abrirse).
  const rain = reconcileObservedRain(snap.state, snap.history ?? [], Object.fromEntries(observed), snap.rainOverrides);
  const reconciled = reconcileObservedEt0(rain.state, rain.history, Object.fromEntries(dmc?.et0 ?? [])).state;
  const state = await withSensor(reconciled, settings, today, Date.now()).catch(() => reconciled);

  const { notifications, morningFor } = planNotifications({ state, settings, weather, now: new Date() });
  if (notifications.length) {
    CapacitorNotifications.schedule(
      notifications.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        scheduleAt: n.at,
        channelId: n.channelId,
        actionTypeId: n.actions ? ACTION_TYPE_ID : undefined,
      })),
    );
  }
  if (morningFor) kvSet(RUNNER_KV.snapshot, { ...snap, state: { ...snap.state, lastMorningScheduledFor: morningFor } });
  saveStatus({ ok: true, backup: dmc?.backup?.name ?? null });
}

// ───────────── Eventos ─────────────

addEventListener(RUNNER_EVENT.refresh, (resolve, reject) => {
  refreshIrrigation().then(
    () => resolve(),
    (e: unknown) => {
      try {
        saveStatus({ ok: false, error: e instanceof Error ? e.message : String(e) });
      } catch {
        /* sin almacenamiento: solo se informa el error */
      }
      reject(e);
    },
  );
});

/** La app envía aquí su estado cada vez que cambia (ver BackgroundService.sync). */
addEventListener(RUNNER_EVENT.syncState, (resolve, reject, args) => {
  try {
    const snap = args as Partial<RunnerSnapshot> | null;
    if (snap?.settings && snap.state) {
      const stored: RunnerSnapshot = { settings: snap.settings, state: snap.state, rainOverrides: snap.rainOverrides ?? {}, history: snap.history ?? [] };
      kvSet(RUNNER_KV.snapshot, stored);
    }
    resolve();
  } catch (e) {
    reject(e);
  }
});

/** La app pregunta cómo le fue a la última ejecución (Ajustes → Estado del sistema). */
addEventListener(RUNNER_EVENT.getStatus, (resolve) => {
  resolve(kvGet<RunnerStatus>(RUNNER_KV.status) ?? ({ lastRunAt: null } satisfies RunnerStatus));
});

/** La app recoge las lecturas del sensor que hizo el worker (para el historial). */
addEventListener(RUNNER_EVENT.getSensorHistory, (resolve) => {
  resolve({ samples: kvGet<SensorSample[]>(RUNNER_KV.sensorHistory) ?? [] } satisfies RunnerSensorHistory);
});
