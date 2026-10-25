import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { fetchForecastWithMeta } from './open-meteo';
import { applyObservedRain } from './agromet';
import { type DmcStore, observedFromStore, refreshDmcStore, withDmcRain } from './dmc';
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
}

export interface WeatherResult {
  days: DailyWeather[];
  stale: boolean;
  elevationM: number | null;
  rainSource: string | null;
  observedRain: Record<string, number>;
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
      if (settings.dmc) {
        // Cada consulta trae ~24 h de lecturas: se acumulan en un almacén local para armar días completos.
        const prev = await this.storage.get<DmcStore | null>('dmcStore', null);
        const { store } = await refreshDmcStore(prev, settings.dmc.code, Date.now(), 60 * 60_000, false, settings.dmcAuth);
        await this.storage.set('dmcStore', store);
        dmc = withDmcRain(forecast.days, observedFromStore(store, settings.dmc.code, today), settings.dmc, today);
      }
      const measured = dmc.source ? dmc : await applyObservedRain(forecast.days, settings.agromet, today);
      const days = measured.days;
      const rainSource = measured.source;
      const observedRain = Object.fromEntries(measured.observed);
      await this.storage.set<WeatherCache>('weatherCache', {
        fetchedAt: new Date().toISOString(),
        lat: settings.latitude,
        lon: settings.longitude,
        days,
        elevationM,
        rainSource,
        observedRain,
      });
      return { days, stale: false, elevationM, rainSource, observedRain };
    } catch (e) {
      if (cache && sameSpot) return this.fromCache(cache, true);
      throw e;
    }
  }

}
