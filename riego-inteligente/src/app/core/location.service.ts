import { Injectable } from '@angular/core';
import { Geolocation } from '@capacitor/geolocation';
import { MOVED_THRESHOLD_KM, distanceKm } from './irrigation-core';
import { reverseGeocode } from './open-meteo';
import type { Settings } from './models';

export interface Fix {
  latitude: number;
  longitude: number;
  placeName: string | null;
  /** Precisión estimada del GPS en metros. */
  accuracyM: number;
}

/** GPS aproximado (≈1 km: suficiente, el clima viene de celdas de 2–25 km) + nombre del lugar. */
@Injectable({ providedIn: 'root' })
export class LocationService {
  private async position(
    askPermission: boolean,
    precise = false,
  ): Promise<{ latitude: number; longitude: number; accuracyM: number } | null> {
    try {
      let perm = await Geolocation.checkPermissions();
      const ok = () => (precise ? perm.location === 'granted' : perm.coarseLocation === 'granted' || perm.location === 'granted');
      if (!ok()) {
        if (!askPermission) return null;
        perm = await Geolocation.requestPermissions({ permissions: precise ? ['location'] : ['coarseLocation'] });
        if (!ok()) return null;
      }
      const p = await Geolocation.getCurrentPosition(
        precise
          ? { enableHighAccuracy: true, timeout: 30_000, maximumAge: 0 }
          : { enableHighAccuracy: false, timeout: 15_000, maximumAge: 10 * 60_000 },
      );
      const k = precise ? 10_000 : 100; // 4 decimales (~10 m) vs 2 (~1 km)
      return {
        latitude: Math.round(p.coords.latitude * k) / k,
        longitude: Math.round(p.coords.longitude * k) / k,
        accuracyM: Math.round(p.coords.accuracy),
      };
    } catch {
      return null;
    }
  }

  /** Pide permiso si hace falta y devuelve coordenadas + nombre del lugar. */
  async detect(precise = false): Promise<Fix | null> {
    const pos = await this.position(true, precise);
    if (!pos) return null;
    return { ...pos, placeName: await reverseGeocode(pos.latitude, pos.longitude) };
  }

  /** Sin pedir permisos: si el usuario se movió > 10 km devuelve la nueva ubicación (para guardar). */
  async detectIfMoved(current: Settings): Promise<Partial<Settings> | null> {
    if (!current.useGps) return null;
    const pos = await this.position(false);
    if (!pos) return null;
    if (distanceKm(current.latitude, current.longitude, pos.latitude, pos.longitude) < MOVED_THRESHOLD_KM) return null;
    return {
      latitude: pos.latitude,
      longitude: pos.longitude,
      placeName: (await reverseGeocode(pos.latitude, pos.longitude)) ?? undefined,
    };
  }
}
