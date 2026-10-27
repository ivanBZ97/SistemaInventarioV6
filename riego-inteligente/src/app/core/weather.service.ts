import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { fetchForecastWithMeta } from './open-meteo';
import { applyObservedRain, mergeObservedRain } from './agromet';
import { type DmcStore, type StationSource, loadStationData, storeChanged, withDmcRain, withLiveRain, withStationEt0 } from './dmc';
import { toISODate } from './irrigation-core';
import type { DailyWeather, LiveRain, Settings, StationStatus } from './models';

interface WeatherCache {
  fetchedAt: string;
  lat: number;
  lon: number;
  /** Último resultado ya combinado con la estación (cachés de versiones anteriores solo traen esto). */
  days: DailyWeather[];
  /** Pronóstico tal como lo entregan los modelos: se vuelve a combinar con la estación en cada consulta. */
  modelDays?: DailyWeather[];
  elevationM?: number | null;
  /** Lluvia observada por INIA (con clave), pedida junto con el pronóstico. */
  inia?: { source: string | null; observed: Record<string, number> };
  rainSource?: string | null;
  /** Lluvia medida por estación (mm/día), para reconciliar días ya contabilizados. */
  observedRain?: Record<string, number>;
  observedEt0?: Record<string, number>;
  et0Source?: string | null;
  et0Ratio?: number | null;
}

export interface WeatherResult {
  days: DailyWeather[];
  stale: boolean;
  elevationM: number | null;
  rainSource: string | null;
  observedRain: Record<string, number>;
  /** ET0 medida por la estación (mm/día) en días pasados, y corrección aplicada al pronóstico de ET0. */
  observedEt0: Record<string, number>;
  et0Source: string | null;
  et0Ratio: number | null;
  /** Lluvia de hoy medida por la estación hasta su última lectura. */
  liveRain: LiveRain | null;
  /** Última consulta a la estación (para explicar en el panel si no llegan datos nuevos). */
  station: StationStatus | null;
  /** Estación de respaldo en uso porque la elegida no publica. */
  backup: StationSource | null;
}

/** El pronóstico cambia poco: se pide cada 3 h. */
const MODEL_MAX_AGE_MS = 3 * 3_600_000;
/**
 * Con la app abierta la estación se vuelve a consultar si lo último tiene más de 9 min (el panel refresca cada
 * 10 min): publica una lectura por minuto, con ~25–30 min de atraso.
 */
export const STATION_LIVE_MAX_AGE_MS = 9 * 60_000;

@Injectable({ providedIn: 'root' })
export class WeatherService {
  private storage = inject(StorageService);

  private fromCache(cache: WeatherCache, stale: boolean): WeatherResult {
    return {
      days: cache.days,
      stale,
      elevationM: cache.elevationM ?? null,
      rainSource: cache.rainSource ?? null,
      observedRain: cache.observedRain ?? {},
      observedEt0: cache.observedEt0 ?? {},
      et0Source: cache.et0Source ?? null,
      et0Ratio: cache.et0Ratio ?? null,
      liveRain: null,
      station: null,
      backup: null,
    };
  }

  /**
   * Clima de hoy y los próximos días: pronóstico de los modelos (cada 3 h) combinado con lo medido por la
   * estación (cada `stationMaxAgeMs`). Sin red usa el último pronóstico guardado (marcado como `stale`).
   */
  async getForecast(settings: Settings, force = false, stationMaxAgeMs = STATION_LIVE_MAX_AGE_MS, offline = false): Promise<WeatherResult> {
    const cache = await this.storage.get<WeatherCache | null>('weatherCache', null);
    const sameSpot = !!cache && cache.lat === settings.latitude && cache.lon === settings.longitude;
    const cachedModel = sameSpot && cache?.modelDays ? { days: cache.modelDays, elevationM: cache.elevationM ?? null, fetchedAt: cache.fetchedAt } : null;
    // offline (vista previa): la estación no se consulta ni se guarda; el pronóstico se renueva igual que al
    // programar los avisos (si tiene más de 3 h), para que la vista previa coincida con lo programado.
    const reuse = !force && !!cachedModel && Date.now() - Date.parse(cachedModel.fetchedAt) < MODEL_MAX_AGE_MS;
    let model = reuse ? cachedModel : null;
    let inia = model ? cache?.inia : undefined;
    let stale = false;
    if (!model) {
      try {
        model = { ...(await fetchForecastWithMeta(settings.latitude, settings.longitude)), fetchedAt: new Date().toISOString() };
      } catch (e) {
        if (cache && sameSpot && !cachedModel) return this.fromCache(cache, true);
        if (!cachedModel) throw e;
        model = cachedModel;
        inia = cache?.inia;
        stale = true;
      }
    }

    const now = Date.now();
    const today = toISODate(new Date(now));
    let dmc: ReturnType<typeof withDmcRain> | null = null;
    let stEt0 = new Map<string, number>();
    let correction: { ratio: number; days: number } | null = null;
    let liveRain: LiveRain | null = null;
    let station: StationStatus | null = null;
    let backup: StationSource | null = null;
    let et0Helper: string | null = null;
    if (settings.dmc) {
      // Cada consulta trae ~12 h de lecturas: se acumulan en un almacén local para armar días completos.
      // Si la estación elegida lleva más de 3 h sin publicar, se usa la siguiente más cercana (respaldo).
      const primaryPrev = await this.storage.get<DmcStore | null>('dmcStore', null);
      const backupPrev = await this.storage.get<DmcStore | null>('dmcStoreBackup', null);
      const sd = await loadStationData({
        cfg: settings.dmc,
        auth: settings.dmcAuth,
        lat: settings.latitude,
        lon: settings.longitude,
        elevationM: model.elevationM,
        modelDays: model.days,
        today,
        now,
        maxAgeMs: stationMaxAgeMs,
        primaryPrev,
        backupPrev,
        fetch: !offline,
      });
      if (!offline && storeChanged(sd.primary, primaryPrev)) await this.storage.set('dmcStore', sd.primary);
      if (!offline && storeChanged(sd.backupStore, backupPrev)) await this.storage.set('dmcStoreBackup', sd.backupStore);
      stEt0 = sd.et0;
      et0Helper = sd.et0FilledFrom?.name ?? null;
      correction = sd.correction;
      liveRain = sd.live;
      station = sd.status;
      backup = sd.backup;
      dmc = withDmcRain(model.days, sd.rain, settings.dmc, today);
      const helper = backup ?? sd.rainFilledFrom;
      if (dmc.source && helper) dmc = { ...dmc, source: `${dmc.source} · respaldo: ${helper.name}` };
    }
    // Lluvia medida en días pasados: estación DMC y, si no hay, INIA Agromet (con clave).
    let measured: { days: DailyWeather[]; source: string | null; observed: Record<string, number> } = { days: model.days, source: null, observed: {} };
    if (dmc?.source) {
      measured = { days: dmc.days, source: dmc.source, observed: Object.fromEntries(dmc.observed) };
    } else if (settings.agromet) {
      if (!inia && !offline) {
        const r = await applyObservedRain(model.days, settings.agromet, today);
        inia = { source: r.source, observed: Object.fromEntries(r.observed) };
      }
      if (inia?.source) {
        measured = { days: mergeObservedRain(model.days, new Map(Object.entries(inia.observed)), today), source: inia.source, observed: inia.observed };
      }
    }
    // Días pasados con ET0 medida; hoy y futuro con la ET0 del modelo corregida por su sesgo reciente.
    // Hoy, además, la lluvia ya caída según la estación.
    const days = withLiveRain(withStationEt0(measured.days, stEt0, correction, today), liveRain, today);
    const result: WeatherResult = {
      days,
      stale,
      elevationM: model.elevationM,
      rainSource: measured.source,
      observedRain: measured.observed,
      observedEt0: Object.fromEntries(stEt0),
      et0Source: settings.dmc && (stEt0.size || correction) ? settings.dmc.name + (et0Helper ? ` y ${et0Helper}` : '') : null,
      et0Ratio: correction?.ratio ?? null,
      liveRain,
      station,
      backup,
    };
    if (offline && reuse) return result;
    await this.storage.set<WeatherCache>('weatherCache', {
      fetchedAt: model.fetchedAt,
      lat: settings.latitude,
      lon: settings.longitude,
      days,
      modelDays: model.days,
      elevationM: model.elevationM,
      inia,
      rainSource: result.rainSource,
      observedRain: result.observedRain,
      observedEt0: result.observedEt0,
      et0Source: result.et0Source,
      et0Ratio: result.et0Ratio,
    });
    return result;
  }
}
