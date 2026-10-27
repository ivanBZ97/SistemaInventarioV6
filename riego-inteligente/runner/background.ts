// Worker en segundo plano (@capacitor/background-runner). Corre en un motor JS aislado, sin DOM:
// solo dispone de fetch, CapacitorKV y CapacitorNotifications. Se empaqueta con esbuild en un único
// archivo (runners/background.js) e incluye el mismo motor agronómico que usa la app.
import {
  applyRainOverrides,
  morningTimeOf,
  planNotifications,
  reconcileObservedEt0,
  reconcileObservedRain,
  toISODate,
} from '../src/app/core/irrigation-core';
import { fetchForecast } from '../src/app/core/open-meteo';
import { applyObservedRain, mergeObservedRain } from '../src/app/core/agromet';
import {
  type DmcStore,
  backgroundStationMaxAgeMs,
  liveRainFromStore,
  loadStationData,
  storeChanged,
  storeIsStale,
  withLiveRain,
  withStationEt0,
} from '../src/app/core/dmc';
import type { DailyWeather, DayRecord, DmcConfig, RunnerStatus, Settings, WaterState } from '../src/app/core/models';

declare const CapacitorKV: {
  get(key: string): { value: string } | null;
  set(key: string, value: string): void;
};
declare const CapacitorNotifications: { schedule(options: unknown[]): void };
declare function addEventListener(
  name: string,
  cb: (resolve: (v?: unknown) => void, reject: (e?: unknown) => void, args: any) => void,
): void;

const KEY = 'snapshot';
const STATUS = 'status';

/** Registra cómo terminó la ejecución: la app lo muestra en Ajustes → Estado del sistema. */
function saveStatus(status: Omit<RunnerStatus, 'lastRunAt'>): void {
  CapacitorKV.set(STATUS, JSON.stringify({ lastRunAt: Date.now(), ...status }));
}

interface Snapshot {
  settings: Settings;
  state: WaterState;
  rainOverrides?: Record<string, number>;
  history?: DayRecord[];
}

function load(): Snapshot | null {
  const raw = CapacitorKV.get(KEY)?.value;
  return raw ? (JSON.parse(raw) as Snapshot) : null;
}

const DMC_STORE = 'dmcStore';
const DMC_BACKUP_STORE = 'dmcStoreBackup';

const readStore = (key: string): DmcStore | null => {
  const raw = CapacitorKV.get(key)?.value;
  return raw ? (JSON.parse(raw) as DmcStore) : null;
};

/**
 * Datos medidos por la estación DMC (cada consulta trae ~12 h y se acumulan): lluvia y ET0 FAO-56 de los días
 * cerrados, corrección del pronóstico de ET0 y lluvia de hoy hasta la última lectura; si la elegida no publica,
 * de la de respaldo. Consulta cada 30 min si llueve, si se pronostica lluvia o antes del aviso; si no, cada 2 h.
 */
async function dmcData(cfg: DmcConfig, settings: Settings, today: string, modelDays: DailyWeather[]) {
  const primaryPrev = readStore(DMC_STORE);
  const backupPrev = readStore(DMC_BACKUP_STORE);
  const now = Date.now();
  const liveNow =
    storeIsStale(primaryPrev, now) && backupPrev ? liveRainFromStore(backupPrev, backupPrev.code, today, now) : liveRainFromStore(primaryPrev, cfg.code, today, now);
  const maxAgeMs = backgroundStationMaxAgeMs(now, liveNow, modelDays.find((d) => d.date === today), morningTimeOf(settings));
  const sd = await loadStationData({
    cfg,
    auth: settings.dmcAuth,
    lat: settings.latitude,
    lon: settings.longitude,
    elevationM: null,
    modelDays,
    today,
    now,
    maxAgeMs,
    primaryPrev,
    backupPrev,
  });
  if (storeChanged(sd.primary, primaryPrev)) CapacitorKV.set(DMC_STORE, JSON.stringify(sd.primary));
  if (storeChanged(sd.backupStore, backupPrev)) CapacitorKV.set(DMC_BACKUP_STORE, JSON.stringify(sd.backupStore));
  return sd;
}

/** La app envía aquí su estado cada vez que cambia (ver BackgroundService.sync). */
addEventListener('syncState', (resolve, reject, args) => {
  try {
    if (args?.settings && args?.state) CapacitorKV.set(
        KEY,
        JSON.stringify({ settings: args.settings, state: args.state, rainOverrides: args.rainOverrides ?? {}, history: args.history ?? [] }),
      );
    resolve();
  } catch (e) {
    reject(e);
  }
});

/**
 * Se ejecuta cada ~15 min (WorkManager). Baja el clima, planifica y deja programadas las alertas
 * de 06:30 / 13:00 (mismo id ⇒ reemplaza la anterior). Si el teléfono estuvo apagado y ya estamos
 * dentro de la ventana 06:30–08:30 sin alerta programada para hoy, la emite de inmediato.
 */
addEventListener('refreshIrrigation', async (resolve, reject) => {
  try {
    const snap = load();
    if (!snap) {
      saveStatus({ ok: false, error: 'la app aún no le ha entregado su estado (ábrela una vez)' });
      return resolve();
    }
    const forecast = await fetchForecast(snap.settings.latitude, snap.settings.longitude);
    const today = toISODate(new Date());
    let measured = forecast;
    let observed = new Map<string, number>();
    const cfg = snap.settings.dmc;
    const dmc = cfg ? await dmcData(cfg, snap.settings, today, forecast).catch(() => null) : null;
    if (dmc?.rain.size) {
      measured = mergeObservedRain(forecast, dmc.rain, today);
      observed = dmc.rain;
    } else {
      const inia = await applyObservedRain(forecast, snap.settings.agromet, today);
      measured = inia.days;
      observed = inia.observed;
    }
    let weather = applyRainOverrides(measured, snap.rainOverrides, today);
    // ET0 medida y, para hoy, la lluvia que ya cayó (pausa o descuenta el riego del aviso de la mañana).
    if (dmc) weather = withLiveRain(withStationEt0(weather, dmc.et0, dmc.correction, today), dmc.live, today);
    // Días ya contados con lluvia/ET0 del modelo → se corrigen en memoria (la app lo guarda al abrirse).
    const rec = reconcileObservedRain(snap.state, snap.history ?? [], Object.fromEntries(observed), snap.rainOverrides);
    const { state } = reconcileObservedEt0(rec.state, rec.history, Object.fromEntries(dmc?.et0 ?? []));
    const { notifications, morningFor } = planNotifications({ state, settings: snap.settings, weather, now: new Date() });
    if (notifications.length) {
      CapacitorNotifications.schedule(
        notifications.map((n) => ({
          id: n.id,
          title: n.title,
          body: n.body,
          scheduleAt: n.at,
          channelId: n.channelId,
          actionTypeId: n.actions ? 'RIEGO_ACTIONS' : undefined,
        })),
      );
    }
    if (morningFor) {
      snap.state.lastMorningScheduledFor = morningFor;
      CapacitorKV.set(KEY, JSON.stringify(snap));
    }
    saveStatus({ ok: true, planned: notifications.map((n) => ({ id: n.id, title: n.title, at: n.at.getTime() })), backup: dmc?.backup?.name ?? null });
    resolve();
  } catch (e) {
    try {
      saveStatus({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } catch {
      /* sin almacenamiento: solo se informa el error */
    }
    reject(e);
  }
});

/** La app pregunta cómo le fue a la última ejecución (Ajustes → Estado del sistema). */
addEventListener('getStatus', (resolve) => {
  const raw = CapacitorKV.get(STATUS)?.value;
  resolve(raw ? JSON.parse(raw) : { lastRunAt: null });
});
