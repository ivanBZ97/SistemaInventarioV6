import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { fetchForecastWithMeta } from './open-meteo';
import type { DailyWeather, Settings } from './models';

interface WeatherCache {
  fetchedAt: string;
  lat: number;
  lon: number;
  days: DailyWeather[];
  elevationM?: number | null;
}

@Injectable({ providedIn: 'root' })
export class WeatherService {
  private storage = inject(StorageService);

  /** Clima actual; si no hay red usa el último caché (marcado como `stale`). */
  async getForecast(settings: Settings, force = false): Promise<{ days: DailyWeather[]; stale: boolean; elevationM: number | null }> {
    const cache = await this.storage.get<WeatherCache | null>('weatherCache', null);
    const sameSpot = cache && cache.lat === settings.latitude && cache.lon === settings.longitude;
    const fresh = cache && Date.now() - Date.parse(cache.fetchedAt) < 3 * 3_600_000;
    if (!force && sameSpot && fresh) return { days: cache.days, stale: false, elevationM: cache.elevationM ?? null };
    try {
      const { days, elevationM } = await fetchForecastWithMeta(settings.latitude, settings.longitude);
      await this.storage.set<WeatherCache>('weatherCache', {
        fetchedAt: new Date().toISOString(),
        lat: settings.latitude,
        lon: settings.longitude,
        days,
        elevationM,
      });
      return { days, stale: false, elevationM };
    } catch (e) {
      if (cache && sameSpot) return { days: cache.days, stale: true, elevationM: cache.elevationM ?? null };
      throw e;
    }
  }

}
