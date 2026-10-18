import { Injectable, inject } from '@angular/core';
import { Geolocation } from '@capacitor/geolocation';
import { StorageService } from './storage.service';
import { fetchForecast } from './open-meteo';
import type { DailyWeather, Settings } from './models';

interface WeatherCache {
  fetchedAt: string;
  lat: number;
  lon: number;
  days: DailyWeather[];
}

@Injectable({ providedIn: 'root' })
export class WeatherService {
  private storage = inject(StorageService);

  /** Clima actual; si no hay red usa el último caché (marcado como `stale`). */
  async getForecast(settings: Settings, force = false): Promise<{ days: DailyWeather[]; stale: boolean }> {
    const cache = await this.storage.get<WeatherCache | null>('weatherCache', null);
    const sameSpot = cache && cache.lat === settings.latitude && cache.lon === settings.longitude;
    const fresh = cache && Date.now() - Date.parse(cache.fetchedAt) < 3 * 3_600_000;
    if (!force && sameSpot && fresh) return { days: cache.days, stale: false };
    try {
      const days = await fetchForecast(settings.latitude, settings.longitude);
      await this.storage.set<WeatherCache>('weatherCache', {
        fetchedAt: new Date().toISOString(),
        lat: settings.latitude,
        lon: settings.longitude,
        days,
      });
      return { days, stale: false };
    } catch (e) {
      if (cache && sameSpot) return { days: cache.days, stale: true };
      throw e;
    }
  }

  /** Ubicación GPS; si el usuario la niega se conservan las coordenadas actuales. */
  async locate(): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const perm = await Geolocation.requestPermissions({ permissions: ['coarseLocation'] });
      if (perm.coarseLocation !== 'granted') return null;
      const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 15_000 });
      return {
        latitude: Math.round(p.coords.latitude * 100) / 100,
        longitude: Math.round(p.coords.longitude * 100) / 100,
      };
    } catch {
      return null;
    }
  }
}
