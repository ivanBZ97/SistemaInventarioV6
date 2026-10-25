// Worker en segundo plano (@capacitor/background-runner). Corre en un motor JS aislado, sin DOM:
// solo dispone de fetch, CapacitorKV y CapacitorNotifications. Se empaqueta con esbuild en un único
// archivo (runners/background.js) e incluye el mismo motor agronómico que usa la app.
import { applyRainOverrides, planNotifications, reconcileObservedRain, toISODate } from '../src/app/core/irrigation-core';
import { fetchForecast } from '../src/app/core/open-meteo';
import { applyObservedRain, mergeObservedRain } from '../src/app/core/agromet';
import { type DmcStore, observedFromStore, refreshDmcStore } from '../src/app/core/dmc';
import type { DayRecord, DmcAuth, Settings, WaterState } from '../src/app/core/models';

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
const DMC_MAX_AGE_MS = 4 * 3_600_000;

/** Lluvia medida por la estación DMC: consulta cada 4 h (cada consulta trae las últimas horas) y acumula. */
async function dmcRain(code: string, today: string, auth?: DmcAuth): Promise<Map<string, number>> {
  const raw = CapacitorKV.get(DMC_STORE)?.value;
  const prev = raw ? (JSON.parse(raw) as DmcStore) : null;
  const { store } = await refreshDmcStore(prev, code, Date.now(), DMC_MAX_AGE_MS, false, auth);
  CapacitorKV.set(DMC_STORE, JSON.stringify(store));
  return observedFromStore(store, code, today);
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
    if (!snap) return resolve(); // la app aún no ha sincronizado
    const forecast = await fetchForecast(snap.settings.latitude, snap.settings.longitude);
    const today = toISODate(new Date());
    let measured = forecast;
    let observed = new Map<string, number>();
    const dmcCode = snap.settings.dmc?.code;
    const dmcDaily = dmcCode ? await dmcRain(dmcCode, today, snap.settings.dmcAuth).catch(() => new Map<string, number>()) : new Map<string, number>();
    if (dmcDaily.size) {
      measured = mergeObservedRain(forecast, dmcDaily, today);
      observed = dmcDaily;
    } else {
      const inia = await applyObservedRain(forecast, snap.settings.agromet, today);
      measured = inia.days;
      observed = inia.observed;
    }
    const weather = applyRainOverrides(measured, snap.rainOverrides, today);
    // Días ya contados con lluvia del modelo → se corrigen en memoria (la app lo guarda al abrirse).
    const { state } = reconcileObservedRain(snap.state, snap.history ?? [], Object.fromEntries(observed), snap.rainOverrides);
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
    resolve();
  } catch (e) {
    reject(e);
  }
});
