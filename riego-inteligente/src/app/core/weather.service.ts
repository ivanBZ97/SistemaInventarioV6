import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { fetchForecastWithMeta } from './open-meteo';
import { applyObservedRain } from './agromet';
import {
  type DmcStore,
  et0Correction,
  observedFromStore,
  recordEt0Pairs,
  refreshDmcStore,
  stationEt0,
  stationMeta,
  withDmcRain,
  withStationEt0,
} from './dmc';
import { toISODate } from './irrigation-core';
import type { DailyWeather, Settings } from './models';

interface WeatherCache {
  fetchedAt: string;
  lat: number;
  lon: number;
  days: DailyWeather[];
  elevationM?: number | null;
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
}

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
    };
  }

  /** Clima actual; si no hay red usa el último caché (marcado como `stale`). */
  async getForecast(settings: Settings, force = false): Promise<WeatherResult> {
    const cache = await this.storage.get<WeatherCache | null>('weatherCache', null);
    const sameSpot = cache && cache.lat === settings.latitude && cache.lon === settings.longitude;
    const fresh = cache && Date.now() - Date.parse(cache.fetchedAt) < 3 * 3_600_000;
    if (!force && sameSpot && fresh) return this.fromCache(cache, false);
    try {
      const forecast = await fetchForecastWithMeta(settings.latitude, settings.longitude);
      const { elevationM } = forecast;
      // Lluvia medida en días pasados: estación DMC (sin clave) y, si no hay, INIA Agromet (con clave).
      const today = toISODate(new Date());
      let dmc = withDmcRain(forecast.days, new Map(), undefined, today);
      let stEt0 = new Map<string, number>();
      let correction: { ratio: number; days: number } | null = null;
      if (settings.dmc) {
        // Cada consulta trae ~12 h de lecturas: se acumulan en un almacén local para armar días completos.
        const prev = await this.storage.get<DmcStore | null>('dmcStore', null);
        const { store } = await refreshDmcStore(prev, settings.dmc.code, Date.now(), 60 * 60_000, false, settings.dmcAuth);
        // ET0 FAO-56 con temperatura, humedad, radiación y viento de la estación; y sesgo del modelo.
        stEt0 = stationEt0(store.met ?? [], stationMeta(settings.dmc, settings.latitude, elevationM), today);
        const saved = recordEt0Pairs(store, stEt0, forecast.days, today);
        await this.storage.set('dmcStore', saved);
        correction = et0Correction(saved.et0Pairs, today);
        dmc = withDmcRain(forecast.days, observedFromStore(saved, settings.dmc.code, today), settings.dmc, today);
      }
      const measured = dmc.source ? dmc : await applyObservedRain(forecast.days, settings.agromet, today);
      // Días pasados con ET0 medida; hoy y futuro con la ET0 del modelo corregida por su sesgo reciente.
      const days = withStationEt0(measured.days, stEt0, correction, today);
      const rainSource = measured.source;
      const observedRain = Object.fromEntries(measured.observed);
      const observedEt0 = Object.fromEntries(stEt0);
      const et0Source = settings.dmc && (stEt0.size || correction) ? settings.dmc.name : null;
      const et0Ratio = correction?.ratio ?? null;
      await this.storage.set<WeatherCache>('weatherCache', {
        fetchedAt: new Date().toISOString(),
        lat: settings.latitude,
        lon: settings.longitude,
        days,
        elevationM,
        rainSource,
        observedRain,
        observedEt0,
        et0Source,
        et0Ratio,
      });
      return { days, stale: false, elevationM, rainSource, observedRain, observedEt0, et0Source, et0Ratio };
    } catch (e) {
      if (cache && sameSpot) return this.fromCache(cache, true);
      throw e;
    }
  }

}
