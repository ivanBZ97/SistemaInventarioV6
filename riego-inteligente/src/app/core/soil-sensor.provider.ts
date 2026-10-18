import { InjectionToken, Injectable } from '@angular/core';
import type { SoilReading } from './models';

/**
 * Fase 2 – sensor IoT. Un proveedor entrega la humedad útil real (0–100 %, misma escala del
 * Dashboard). Si `read()` devuelve una lectura reciente, el motor sobrescribe el déficit teórico.
 */
export interface SoilSensorProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  read(): Promise<SoilReading | null>;
}

export const SOIL_SENSOR_PROVIDER = new InjectionToken<SoilSensorProvider>('SOIL_SENSOR_PROVIDER', {
  providedIn: 'root',
  factory: () => new NullSoilSensorProvider(),
});

/** Fase 1: sin sensor; el balance hídrico teórico manda. */
@Injectable({ providedIn: 'root' })
export class NullSoilSensorProvider implements SoilSensorProvider {
  readonly id = 'none';
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async read(): Promise<SoilReading | null> {
    return null;
  }
}

/**
 * Esqueleto Fase 2 (Tuya Zigbee). Pasos previstos:
 *  1. Autenticar con Tuya Cloud (client id/secret + device id del sensor de suelo).
 *  2. GET /v1.0/devices/{id}/status → código `humidity` (% de humedad del suelo).
 *  3. Mapear a `moisturePct` y devolver `{ moisturePct, takenAt, source: 'tuya-zigbee' }`.
 * Para activarlo: `{ provide: SOIL_SENSOR_PROVIDER, useClass: TuyaZigbeeSoilSensorProvider }` en app.config.ts.
 */
export class TuyaZigbeeSoilSensorProvider implements SoilSensorProvider {
  readonly id = 'tuya-zigbee';
  async isAvailable(): Promise<boolean> {
    return false; // TODO Fase 2
  }
  async read(): Promise<SoilReading | null> {
    return null; // TODO Fase 2
  }
}
