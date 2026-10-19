import { Injectable } from '@angular/core';
import { Geolocation } from '@capacitor/geolocation';
import { MOVED_THRESHOLD_KM, distanceKm } from './irrigation-core';
import { reverseGeocode } from './open-meteo';
import type { Settings } from './models';

export interface Fix {
  latitude: number;
  longitude: number;
  placeName: string | null;
}

/** GPS aproximado (≈1 km: suficiente, el clima viene de celdas de 2–25 km) + nombre del lugar. */
@Injectable({ providedIn: 'root' })
export class LocationService {
  private async position(askPermission: boolean): Promise<{ latitude: number; longitude: number } | null> {
    try {
      let perm = await Geolocation.checkPermissions();
      if (perm.coarseLocation !== 'granted' && perm.location !== 'granted') {
        if (!askPermission) return null;
        perm = await Geolocation.requestPermissions({ permissions: ['coarseLocation'] });
        if (perm.coarseLocation !== 'granted' && perm.location !== 'granted') return null;
      }
      const p = await Geolocation.getCurrentPosition({
        enableHighAccuracy: false,
        timeout: 15_000,
        maximumAge: 10 * 60_000,
      });
      return {
        latitude: Math.round(p.coords.latitude * 100) / 100,
        longitude: Math.round(p.coords.longitude * 100) / 100,
      };
    } catch {
      return null;
    }
  }

  /** Pide permiso si hace falta y devuelve coordenadas + nombre del lugar. */
  async detect(): Promise<Fix | null> {
    const pos = await this.position(true);
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
