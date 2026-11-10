import { InjectionToken, Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { STORAGE } from './storage-keys';
import {
  NO_HUMIDITY,
  type SoilStatus,
  TuyaError,
  type TuyaToken,
  normSoil,
  normTemp,
  readTuyaReportLogs,
  readTuyaSoil,
  tuyaErrorText,
  tuyaToken,
} from './tuya';
import { deficitFromSensor } from './soil-sensor';
import { type SensorSample, mergeSamples, samplesFromLogs } from './sensor-history';
import type { Settings, SoilReading, SoilSensorConfig } from './models';

/**
 * Sensor de suelo. Un proveedor entrega la lectura real; si es reciente, está calibrada y es posterior al último
 * riego o ajuste, el motor la usa en vez del déficit teórico (ver `applySensorReading`).
 */
export interface SoilSensorProvider {
  readonly id: string;
  /** Última lectura del sensor; null si no hay sensor configurado. Lanza si el sensor no responde. */
  read(settings: Settings, force?: boolean): Promise<SoilReading | null>;
  /** Reportes guardados en la nube del fabricante entre dos instantes (si el proveedor los ofrece). */
  reportLogs?(settings: Settings, sinceMs: number, untilMs: number): Promise<SensorSample[]>;
}

export const SOIL_SENSOR_PROVIDER = new InjectionToken<SoilSensorProvider>('SOIL_SENSOR_PROVIDER', {
  providedIn: 'root',
  factory: () => inject(TuyaSoilSensorProvider),
});

let historyQueue: Promise<unknown> = Promise.resolve();

/** Une muestras al historial guardado, en fila (dos escrituras seguidas no se pisan). Devuelve el historial. */
export function appendSensorSamples(storage: StorageService, samples: SensorSample[]): Promise<SensorSample[]> {
  const run = historyQueue.then(async () => {
    const prev = await storage.get<SensorSample[]>(STORAGE.sensorHistory, []);
    const next = mergeSamples(prev, samples, Date.now());
    if (samples.length || next.length !== prev.length) await storage.set(STORAGE.sensorHistory, next);
    return next;
  });
  historyQueue = run.catch(() => undefined);
  return run;
}

/** Con la app abierta, Tuya se consulta como máximo cada 10 min (el sensor a pilas reporta cada cierto rato). */
const CACHE_MS = 10 * 60_000;

/** Sensor configurado por completo (las tres claves), o null. */
function configured(settings: Settings): SoilSensorConfig | null {
  const cfg = settings.soilSensor;
  return cfg?.accessId?.trim() && cfg.accessSecret?.trim() && cfg.deviceId?.trim() ? cfg : null;
}

const cacheKey = (cfg: SoilSensorConfig) => `${cfg.region}|${cfg.accessId}|${cfg.deviceId}`;

/** Sensor Tuya / Smart Life (WiFi o Zigbee) leído desde la nube de Tuya con las claves del proyecto en iot.tuya.com. */
@Injectable({ providedIn: 'root' })
export class TuyaSoilSensorProvider implements SoilSensorProvider {
  readonly id = 'tuya';
  private storage = inject(StorageService);
  /** Última respuesta de Tuya (se reutiliza 10 min). */
  private last: { at: number; key: string; status: SoilStatus & { soilPct: number } } | null = null;

  async read(settings: Settings, force = false): Promise<SoilReading | null> {
    const cfg = configured(settings);
    if (!cfg) return null;
    const status = await this.status(cfg, force);
    return {
      name: status.name,
      at: status.updatedAt ?? this.last?.at ?? Date.now(),
      soilPct: status.soilPct,
      tempC: status.tempC,
      battery: status.battery,
      // La calibración y el umbral pueden cambiar sin volver a consultar el sensor.
      deficitMm: deficitFromSensor(status.soilPct, cfg, settings.thresholdMm),
    };
  }

  /** Estado del sensor: el guardado si tiene menos de 10 min; si no, se consulta a Tuya y queda en el historial. */
  private async status(cfg: SoilSensorConfig, force: boolean): Promise<SoilStatus & { soilPct: number }> {
    const key = cacheKey(cfg);
    const now = Date.now();
    if (!force && this.last?.key === key && now - this.last.at < CACHE_MS) return this.last.status;
    const token = await this.storage.get<TuyaToken | null>(STORAGE.tuyaToken, null);
    const r = await readTuyaSoil(cfg, now, token);
    if (r.token !== token) await this.storage.set(STORAGE.tuyaToken, r.token);
    const { soilPct } = r.status;
    if (soilPct === null)
      throw new TuyaError(NO_HUMIDITY, `el sensor no informa humedad (códigos: ${r.status.codes.join(', ') || 'ninguno'})`);
    const status = { ...r.status, soilPct };
    this.last = { at: now, key, status };
    // Sin almacenamiento disponible la lectura igual sirve: el historial es secundario.
    await appendSensorSamples(this.storage, [
      { t: status.updatedAt ?? now, soil: soilPct, tempC: status.tempC, battery: status.battery },
    ]).catch(() => undefined);
    return status;
  }

  async reportLogs(settings: Settings, sinceMs: number, untilMs: number): Promise<SensorSample[]> {
    const cfg = configured(settings);
    if (!cfg) return [];
    try {
      // Los códigos de humedad y temperatura dependen del modelo: se aprenden de una lectura.
      const { soilCode, tempCode } = await this.status(cfg, this.last?.key !== cacheKey(cfg));
      if (!soilCode) return [];
      const now = Date.now();
      let token = await this.storage.get<TuyaToken | null>(STORAGE.tuyaToken, null);
      if (!token || token.expiresAt <= now) {
        token = await tuyaToken(cfg, now);
        await this.storage.set(STORAGE.tuyaToken, token);
      }
      const logs = await readTuyaReportLogs(cfg, token, [soilCode, ...(tempCode ? [tempCode] : [])], sinceMs, untilMs);
      return samplesFromLogs(logs, soilCode, tempCode, { soil: normSoil, temp: normTemp });
    } catch (e) {
      throw new Error(tuyaErrorText(e));
    }
  }
}
