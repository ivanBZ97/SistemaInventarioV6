import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { STORAGE } from './storage-keys';
import { fetchForecastWithMeta } from './open-meteo';
import { applyObservedRain, mergeObservedRain } from './agromet';
import {
  type DmcStore,
  type StationData,
  type StationSource,
  diagnoseDmc,
  listDmcStations,
  loadStationData,
  nearbyDmcStations,
  stationMeta,
  storeChanged,
  withDmcRain,
  withLiveRain,
  withStationEt0,
} from './dmc';
import { toISODate } from './dates';
import type { DailyWeather, DmcConfig, ISODate, LiveRain, Settings, StationStatus } from './models';

/** Pronóstico tal como lo entregan los modelos, con la hora en que se pidió. */
interface ModelForecast {
  days: DailyWeather[];
  elevationM: number | null;
  fetchedAt: string;
}

/** Lluvia observada por INIA Agromet (con clave), pedida junto con el pronóstico. */
interface IniaRain {
  source: string | null;
  observed: Record<ISODate, number>;
}

/**
 * Lo que se guarda entre sesiones: el pronóstico de los modelos y la lluvia de INIA para una ubicación. Lo medido
 * por la estación DMC tiene su propio almacén y se vuelve a combinar en cada consulta.
 */
interface WeatherCache {
  fetchedAt: string;
  lat: number;
  lon: number;
  modelDays?: DailyWeather[];
  elevationM?: number | null;
  inia?: IniaRain;
}

export interface WeatherResult {
  /** Días (pasados, hoy y pronóstico) con lo medido ya aplicado. */
  days: DailyWeather[];
  /** true: no hubo red y se usa el último pronóstico guardado. */
  stale: boolean;
  elevationM: number | null;
  /** Estación que aportó la lluvia medida de días pasados, o null si se usa el modelo. */
  rainSource: string | null;
  /** Lluvia medida por estación (mm/día), para reconciliar días ya contabilizados. */
  observedRain: Record<ISODate, number>;
  /** ET0 medida por la estación (mm/día) en días pasados, y corrección aplicada al pronóstico de ET0. */
  observedEt0: Record<ISODate, number>;
  et0Source: string | null;
  et0Ratio: number | null;
  /** Lluvia de hoy medida por la estación hasta su última lectura. */
  liveRain: LiveRain | null;
  /** Última consulta a la estación (para explicar en el panel si no llegan datos nuevos). */
  station: StationStatus | null;
  /** Estación de respaldo en uso porque la elegida no publica. */
  backup: StationSource | null;
}

/** Resultado cuando no hay clima disponible (sin red y sin nada guardado). */
export const NO_WEATHER: WeatherResult = {
  days: [],
  stale: false,
  elevationM: null,
  rainSource: null,
  observedRain: {},
  observedEt0: {},
  et0Source: null,
  et0Ratio: null,
  liveRain: null,
  station: null,
  backup: null,
};

export interface ForecastOptions {
  /** Vuelve a pedir el pronóstico aunque el guardado sea reciente (deslizar para actualizar). */
  force?: boolean;
  /** Antigüedad máxima de las lecturas de la estación antes de volver a consultarla. */
  stationMaxAgeMs?: number;
  /** Vista previa: no consulta la estación ni INIA, ni guarda nada de ellas (solo lo ya almacenado). */
  offline?: boolean;
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

  /**
   * Clima de hoy y los próximos días: pronóstico de los modelos (cada 3 h) combinado con lo medido por la
   * estación (cada `stationMaxAgeMs`). Sin red usa el último pronóstico guardado (marcado como `stale`); si
   * tampoco hay uno guardado para esta ubicación, lanza.
   */
  async getForecast(settings: Settings, options: ForecastOptions = {}): Promise<WeatherResult> {
    const { force = false, stationMaxAgeMs = STATION_LIVE_MAX_AGE_MS, offline = false } = options;
    const cache = await this.storage.get<WeatherCache | null>(STORAGE.weatherCache, null);
    const sameSpot = !!cache && cache.lat === settings.latitude && cache.lon === settings.longitude;
    const cached: ModelForecast | null =
      sameSpot && cache?.modelDays ? { days: cache.modelDays, elevationM: cache.elevationM ?? null, fetchedAt: cache.fetchedAt } : null;

    const { model, stale, fresh } = await this.modelForecast(settings, cached, force);
    // La lluvia de INIA se pide junto con el pronóstico: con un pronóstico nuevo, se vuelve a pedir.
    let inia = fresh ? undefined : cache?.inia;

    const now = Date.now();
    const today = toISODate(new Date(now));
    const station = settings.dmc ? await this.stationData(settings, settings.dmc, model, today, now, stationMaxAgeMs, offline) : null;

    // Lluvia medida en días pasados: estación DMC y, si no tiene, INIA Agromet (con clave).
    let measured: { days: DailyWeather[]; source: string | null; observed: Record<ISODate, number> } = { days: model.days, source: null, observed: {} };
    const dmcRain = station && settings.dmc ? withDmcRain(model.days, station.rain, settings.dmc, today) : null;
    if (dmcRain?.source) {
      const helper = station?.backup ?? station?.rainFilledFrom;
      measured = {
        days: dmcRain.days,
        source: helper ? `${dmcRain.source} · respaldo: ${helper.name}` : dmcRain.source,
        observed: Object.fromEntries(dmcRain.observed),
      };
    } else if (settings.agromet) {
      if (!inia && !offline) {
        const r = await applyObservedRain(model.days, settings.agromet, today);
        inia = { source: r.source, observed: Object.fromEntries(r.observed) };
      }
      if (inia?.source) {
        measured = { days: mergeObservedRain(model.days, new Map(Object.entries(inia.observed)), today), source: inia.source, observed: inia.observed };
      }
    }

    // Se guarda solo lo que cambió: un pronóstico nuevo o la lluvia de INIA recién pedida.
    if (fresh || inia !== cache?.inia) {
      await this.storage.set<WeatherCache>(STORAGE.weatherCache, {
        fetchedAt: model.fetchedAt,
        lat: settings.latitude,
        lon: settings.longitude,
        modelDays: model.days,
        elevationM: model.elevationM,
        inia,
      });
    }

    // Días pasados con ET0 medida; hoy y futuro con la ET0 del modelo corregida por su sesgo reciente.
    // Hoy, además, la lluvia ya caída según la estación.
    const et0 = station?.et0 ?? new Map<ISODate, number>();
    const correction = station?.correction ?? null;
    const liveRain = station?.live ?? null;
    const et0Helper = station?.et0FilledFrom?.name;
    return {
      days: withLiveRain(withStationEt0(measured.days, et0, correction, today), liveRain, today),
      stale,
      elevationM: model.elevationM,
      rainSource: measured.source,
      observedRain: measured.observed,
      observedEt0: Object.fromEntries(et0),
      et0Source: settings.dmc && (et0.size || correction) ? settings.dmc.name + (et0Helper ? ` y ${et0Helper}` : '') : null,
      et0Ratio: correction?.ratio ?? null,
      liveRain,
      station: station?.status ?? null,
      backup: station?.backup ?? null,
    };
  }

  /**
   * "Probar" una estación DMC: la consulta ahora, explica en texto qué entregó y deja las lecturas en el almacén
   * (así la prueba también sirve para el balance). `settings` son los ajustes en pantalla, guardados o no.
   */
  async diagnoseStation(settings: Pick<Settings, 'dmcAuth' | 'latitude' | 'longitude'>, cfg: DmcConfig, elevationM: number | null): Promise<{ ok: boolean; lines: string[] }> {
    const { latitude, longitude, dmcAuth } = settings;
    const prev = await this.storage.get<DmcStore | null>(STORAGE.dmcStore, null);
    // Si la estación no tiene datos nuevos, el diagnóstico prueba además las dos más cercanas siguientes.
    const others = nearbyDmcStations(await listDmcStations(), latitude, longitude, 3)
      .filter((s) => s.code !== cfg.code)
      .slice(0, 2);
    const now = Date.now();
    const r = await diagnoseDmc(cfg.code, prev, toISODate(new Date(now)), now, dmcAuth, stationMeta(cfg, latitude, elevationM), others);
    await this.storage.set(STORAGE.dmcStore, r.store);
    return { ok: r.ok, lines: r.lines };
  }

  /** Pronóstico de los modelos: el guardado si es reciente; si no, uno nuevo (o el guardado, si no hay red). */
  private async modelForecast(
    settings: Settings,
    cached: ModelForecast | null,
    force: boolean,
  ): Promise<{ model: ModelForecast; stale: boolean; fresh: boolean }> {
    if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < MODEL_MAX_AGE_MS) return { model: cached, stale: false, fresh: false };
    try {
      const fetched = await fetchForecastWithMeta(settings.latitude, settings.longitude);
      return { model: { ...fetched, fetchedAt: new Date().toISOString() }, stale: false, fresh: true };
    } catch (e) {
      if (!cached) throw e;
      return { model: cached, stale: true, fresh: false };
    }
  }

  /**
   * Lo medido por la estación DMC. Cada consulta trae ~12 h de lecturas, que se acumulan en un almacén local para
   * armar días completos; si la estación elegida lleva más de 3 h sin publicar, se usa la siguiente más cercana.
   */
  private async stationData(
    settings: Settings,
    cfg: DmcConfig,
    model: ModelForecast,
    today: ISODate,
    now: number,
    maxAgeMs: number,
    offline: boolean,
  ): Promise<StationData> {
    const primaryPrev = await this.storage.get<DmcStore | null>(STORAGE.dmcStore, null);
    const backupPrev = await this.storage.get<DmcStore | null>(STORAGE.dmcStoreBackup, null);
    const data = await loadStationData({
      cfg,
      auth: settings.dmcAuth,
      lat: settings.latitude,
      lon: settings.longitude,
      elevationM: model.elevationM,
      modelDays: model.days,
      today,
      now,
      maxAgeMs,
      primaryPrev,
      backupPrev,
      fetch: !offline,
    });
    if (!offline && storeChanged(data.primary, primaryPrev)) await this.storage.set(STORAGE.dmcStore, data.primary);
    if (!offline && storeChanged(data.backupStore, backupPrev)) await this.storage.set(STORAGE.dmcStoreBackup, data.backupStore);
    return data;
  }
}
