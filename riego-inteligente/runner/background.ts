// Worker en segundo plano (@capacitor/background-runner). Corre en un motor JS aislado, sin DOM:
// solo dispone de fetch, CapacitorKV y CapacitorNotifications. Se empaqueta con esbuild en un único
// archivo (runners/background.js) e incluye el mismo motor agronómico que usa la app.
import { applyRainOverrides, planNotifications, toISODate } from '../src/app/core/irrigation-core';
import { fetchForecast } from '../src/app/core/open-meteo';
import { applyObservedRain } from '../src/app/core/agromet';
import type { Settings, WaterState } from '../src/app/core/models';

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
}

function load(): Snapshot | null {
  const raw = CapacitorKV.get(KEY)?.value;
  return raw ? (JSON.parse(raw) as Snapshot) : null;
}

/** La app envía aquí su estado cada vez que cambia (ver BackgroundService.sync). */
addEventListener('syncState', (resolve, reject, args) => {
  try {
    if (args?.settings && args?.state) CapacitorKV.set(KEY, JSON.stringify({ settings: args.settings, state: args.state, rainOverrides: args.rainOverrides ?? {} }));
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
    const observed = await applyObservedRain(forecast, snap.settings.agromet, today);
    const weather = applyRainOverrides(observed.days, snap.rainOverrides, today);
    const { notifications, morningFor } = planNotifications({ state: snap.state, settings: snap.settings, weather, now: new Date() });
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
