import { InjectionToken, Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { humidityPct } from './irrigation-core';
import { type TuyaToken, deficitFromSensor, readTuyaSoil } from './tuya';
import type { Settings, SoilReading } from './models';

/**
 * Sensor de suelo. Un proveedor entrega la lectura real; si es reciente, está calibrada y es posterior al último
 * riego o ajuste, el motor la usa en vez del déficit teórico.
 */
export interface SoilSensorProvider {
  readonly id: string;
  read(settings: Settings, force?: boolean): Promise<SoilReading | null>;
}

export const SOIL_SENSOR_PROVIDER = new InjectionToken<SoilSensorProvider>('SOIL_SENSOR_PROVIDER', {
  providedIn: 'root',
  factory: () => inject(TuyaSoilSensorProvider),
});

/** Con la app abierta, Tuya se consulta como máximo cada 10 min (el sensor a pilas reporta cada cierto rato). */
const CACHE_MS = 10 * 60_000;

/** Sensor Tuya / Smart Life (WiFi o Zigbee) leído desde la nube de Tuya con las claves del proyecto en iot.tuya.com. */
@Injectable({ providedIn: 'root' })
export class TuyaSoilSensorProvider implements SoilSensorProvider {
  readonly id = 'tuya';
  private storage = inject(StorageService);
  private last: { at: number; key: string; reading: SoilReading } | null = null;

  async read(settings: Settings, force = false): Promise<SoilReading | null> {
    const cfg = settings.soilSensor;
    if (!cfg?.accessId?.trim() || !cfg.accessSecret?.trim() || !cfg.deviceId?.trim()) return null;
    const key = `${cfg.region}|${cfg.accessId}|${cfg.deviceId}`;
    const now = Date.now();
    let reading = !force && this.last?.key === key && now - this.last.at < CACHE_MS ? this.last.reading : null;
    if (!reading) {
      const token = await this.storage.get<TuyaToken | null>('tuyaToken', null);
      const r = await readTuyaSoil(cfg, now, token);
      if (r.token !== token) await this.storage.set('tuyaToken', r.token);
      const s = r.status;
      if (s.soilPct === null) throw new Error(`el sensor no informa humedad (códigos: ${s.codes.join(', ') || 'ninguno'})`);
      reading = {
        moisturePct: 0,
        takenAt: new Date(s.updatedAt ?? now).toISOString(),
        source: `tuya:${s.name}`,
        raw: { soilPct: s.soilPct, tempC: s.tempC, battery: s.battery },
      };
      this.last = { at: now, key, reading };
    }
    // La calibración y el umbral pueden cambiar sin volver a consultar el sensor.
    const deficit = deficitFromSensor(reading.raw!.soilPct!, cfg, settings.thresholdMm);
    return {
      ...reading,
      deficitMm: cfg.enabled ? deficit : null,
      moisturePct: deficit === null ? 0 : humidityPct(deficit),
    };
  }
}
