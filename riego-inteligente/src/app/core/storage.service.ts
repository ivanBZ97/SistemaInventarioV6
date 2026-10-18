import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

/** Persistencia local (SharedPreferences en Android / localStorage en web). Sin servidor. */
@Injectable({ providedIn: 'root' })
export class StorageService {
  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      const { value } = await Preferences.get({ key });
      return value ? (JSON.parse(value) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await Preferences.set({ key, value: JSON.stringify(value) });
  }
}
