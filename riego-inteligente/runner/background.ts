// Worker en segundo plano (@capacitor/background-runner). Corre en un motor JS aislado, sin DOM:
// solo dispone de fetch, CapacitorKV y CapacitorNotifications. Se empaqueta con esbuild en un único
// archivo (runners/background.js) e incluye el mismo motor agronómico que usa la app.
import { addDays, applyRainOverrides, planNotifications, reconcileObservedRain, toISODate } from '../src/app/core/irrigation-core';
import { fetchForecast } from '../src/app/core/open-meteo';
import { applyObservedRain, mergeObservedRain } from '../src/app/core/agromet';
import { fetchDmcDailyRain } from '../src/app/core/dmc';
import type { DayRecord, Settings, WaterState } from '../src/app/core/models';

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

const DMC_CACHE = 'dmcRain';
const DMC_MAX_AGE_MS = 6 * 3_600_000;

/** Lluvia medida por la estación DMC, con caché de 6 h (evita bajar el mes completo cada 15 min). */
async function dmcRain(code: string, today: string): Promise<Map<string, number>> {
  const raw = CapacitorKV.get(DMC_CACHE)?.value;
  const cached = raw ? (JSON.parse(raw) as { code: string; at: number; daily: Record<string, number> }) : null;
  if (cached && cached.code === code && Date.now() - cached.at < DMC_MAX_AGE_MS) return new Map(Object.entries(cached.daily));
  const daily = await fetchDmcDailyRain(code, addDays(today, -3), addDays(today, -1));
  CapacitorKV.set(DMC_CACHE, JSON.stringify({ code, at: Date.now(), daily: Object.fromEntries(daily) }));
  return daily;
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
    const dmcDaily = dmcCode ? await dmcRain(dmcCode, today).catch(() => new Map<string, number>()) : new Map<string, number>();
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
