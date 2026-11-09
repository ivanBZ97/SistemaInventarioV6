// Estación elegida + estación de respaldo: todo lo medido, listo para el balance hídrico.
import type { DailyWeather, DmcAuth, DmcConfig, ISODate, LiveRain, StationStatus } from '../models';
import { liveRainFromStore } from './live';
import { et0Correction, stationEt0 } from './met';
import { type StationSource, backupStationFor, stationMeta } from './stations';
import { type DmcStore, observedFromStore, recordEt0Pairs, refreshDmcStore, storeIsStale } from './store';

/** Lo medido por las estaciones, listo para el balance (lo usan la app y el worker, cada uno con su almacén). */
export interface StationData {
  /** Lluvia de días cerrados: de la estación elegida y, para los días que le falten, de la de respaldo. */
  rain: Map<ISODate, number>;
  /** ET0 FAO-56 de días cerrados (mismo criterio). */
  et0: Map<ISODate, number>;
  correction: { ratio: number; days: number } | null;
  /** Lluvia de hoy: de la elegida o, si no publica, de la de respaldo. */
  live: LiveRain | null;
  /** Estación de respaldo en uso porque la elegida no publica (null si no hace falta o tampoco publica). */
  backup: StationSource | null;
  /** Estación de respaldo que aportó lluvia de días que a la elegida le faltan (aunque ya publique). */
  rainFilledFrom: StationSource | null;
  /** Ídem para la ET0. */
  et0FilledFrom: StationSource | null;
  /** Última consulta a la estación elegida. */
  status: StationStatus;
  primary: DmcStore;
  /** Almacén de la de respaldo (consultado ahora o el guardado); se guarda solo si cambió. */
  backupStore: DmcStore | null;
}

/**
 * Consulta la estación elegida (si su almacén está viejo) y, si lleva más de 3 h sin publicar, la de respaldo.
 * Devuelve la lluvia y la ET0 de los días cerrados, la corrección del pronóstico de ET0 y la lluvia de hoy.
 * Lo guardado de la de respaldo sigue completando los días que a la elegida le faltan aunque ya haya vuelto.
 */
export async function loadStationData(o: {
  cfg: DmcConfig;
  auth?: DmcAuth;
  lat: number;
  lon: number;
  elevationM: number | null;
  modelDays: DailyWeather[];
  today: ISODate;
  now: number;
  maxAgeMs: number;
  primaryPrev: DmcStore | null;
  backupPrev: DmcStore | null;
  /** false: solo lo ya guardado, sin consultar la DMC (vista previa). */
  fetch?: boolean;
}): Promise<StationData> {
  const { cfg, auth, today, now } = o;
  const online = o.fetch !== false;
  const saved = o.primaryPrev?.code === cfg.code ? o.primaryPrev : { code: cfg.code, pts: [], attemptAt: 0, ok: false };
  const store = online ? (await refreshDmcStore(o.primaryPrev, cfg.code, now, o.maxAgeMs, false, auth)).store : saved;
  const rain = observedFromStore(store, cfg.code, today);
  const ownEt0 = stationEt0(store.met ?? [], stationMeta(cfg, o.lat, o.elevationM), today);
  const et0 = new Map(ownEt0);
  let live = liveRainFromStore(store, cfg.code, today, now);
  let backup: StationSource | null = null;
  let backupStore: DmcStore | null = null;
  const alt = backupStationFor(cfg.code, o.lat, o.lon);
  const altPrev = alt && o.backupPrev?.code === alt.code ? o.backupPrev : null;
  if (alt && storeIsStale(store, now)) {
    backupStore = online ? (await refreshDmcStore(altPrev, alt.code, now, o.maxAgeMs, false, auth)).store : altPrev;
    if (backupStore && !storeIsStale(backupStore, now)) {
      backup = { code: alt.code, name: alt.name, distanceKm: Math.round(alt.distanceKm * 10) / 10 };
      live = liveRainFromStore(backupStore, alt.code, today, now);
    }
  } else {
    backupStore = altPrev; // sin consultar: solo para los días que faltan
  }
  let rainFilled = 0;
  let et0Filled = 0;
  if (alt && backupStore) {
    // Días cerrados que a la elegida le faltan (p. ej. los de una caída ya superada): los de la de respaldo.
    for (const [day, mm] of observedFromStore(backupStore, alt.code, today)) {
      if (rain.has(day)) continue;
      rain.set(day, mm);
      rainFilled++;
    }
    const altMeta = stationMeta({ ...alt, elevationM: alt.elevationM ?? undefined }, o.lat, o.elevationM);
    for (const [day, v] of stationEt0(backupStore.met ?? [], altMeta, today)) {
      if (et0.has(day)) continue;
      et0.set(day, v);
      et0Filled++;
    }
  }
  const altSource = alt ? { code: alt.code, name: alt.name, distanceKm: Math.round(alt.distanceKm * 10) / 10 } : null;
  // El sesgo del pronóstico se mide solo con la estación elegida (no se mezclan estaciones).
  const primary = recordEt0Pairs(store, ownEt0, o.modelDays, today);
  return {
    rain,
    et0,
    correction: et0Correction(primary.et0Pairs, today),
    live,
    backup,
    rainFilledFrom: rainFilled ? altSource : null,
    et0FilledFrom: et0Filled ? altSource : null,
    status: { attemptAt: store.attemptAt, ok: store.ok, error: store.error },
    primary,
    backupStore,
  };
}
