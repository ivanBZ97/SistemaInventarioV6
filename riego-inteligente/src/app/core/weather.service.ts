import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { fetchForecastWithMeta } from './open-meteo';
import { applyObservedRain } from './agromet';
import { applyDmcRain } from './dmc';
import { toISODate } from './irrigation-core';
import type { DailyWeather, Settings } from './models';

interface WeatherCache {
  fetchedAt: string;
  lat: number;
  lon: number;
  days: DailyWeather[];
  elevationM?: number | null;
  rainSource?: string | null;
}

@Injectable({ providedIn: 'root' })
export class WeatherService {
  private storage = inject(StorageService);

  /** Clima actual; si no hay red usa el último caché (marcado como `stale`). */
  async getForecast(settings: Settings, force = false): Promise<{ days: DailyWeather[]; stale: boolean; elevationM: number | null; rainSource: string | null }> {
    const cache = await this.storage.get<WeatherCache | null>('weatherCache', null);
    const sameSpot = cache && cache.lat === settings.latitude && cache.lon === settings.longitude;
    const fresh = cache && Date.now() - Date.parse(cache.fetchedAt) < 3 * 3_600_000;
    if (!force && sameSpot && fresh) return { days: cache.days, stale: false, elevationM: cache.elevationM ?? null, rainSource: cache.rainSource ?? null };
    try {
      const forecast = await fetchForecastWithMeta(settings.latitude, settings.longitude);
      const { elevationM } = forecast;
      // Lluvia observada de la estación INIA (si hay) reemplaza la del modelo en días pasados.
      const today = toISODate(new Date());
      // Lluvia medida: estación DMC (sin clave) y, si no hay, INIA Agromet (con clave).
      const dmc = await applyDmcRain(forecast.days, settings.dmc, today);
      const inia = dmc.source ? { days: dmc.days, source: null } : await applyObservedRain(forecast.days, settings.agromet, today);
      const days = inia.days;
      const rainSource = dmc.source ?? inia.source;
      await this.storage.set<WeatherCache>('weatherCache', {
        fetchedAt: new Date().toISOString(),
        lat: settings.latitude,
        lon: settings.longitude,
        days,
        elevationM,
        rainSource,
      });
      return { days, stale: false, elevationM, rainSource };
    } catch (e) {
      if (cache && sameSpot) return { days: cache.days, stale: true, elevationM: cache.elevationM ?? null, rainSource: cache.rainSource ?? null };
      throw e;
    }
  }

}
