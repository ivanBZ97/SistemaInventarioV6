import { InjectionToken, Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { humidityPct } from './irrigation-core';
import { type TuyaToken, deficitFromSensor, normSoil, normTemp, readTuyaReportLogs, readTuyaSoil, tuyaErrorText, tuyaToken } from './tuya';
import { type SensorSample, mergeSamples, samplesFromLogs } from './sensor-history';
import type { Settings, SoilReading } from './models';

/**
 * Sensor de suelo. Un proveedor entrega la lectura real; si es reciente, está calibrada y es posterior al último
 * riego o ajuste, el motor la usa en vez del déficit teórico.
 */
export interface SoilSensorProvider {
  readonly id: string;
  read(settings: Settings, force?: boolean): Promise<SoilReading | null>;
  /** Reportes guardados en la nube del fabricante entre dos instantes (si el proveedor los ofrece). */
  reportLogs?(settings: Settings, sinceMs: number, untilMs: number): Promise<SensorSample[]>;
}

export const SOIL_SENSOR_PROVIDER = new InjectionToken<SoilSensorProvider>('SOIL_SENSOR_PROVIDER', {
  providedIn: 'root',
  factory: () => inject(TuyaSoilSensorProvider),
});

export const SENSOR_HISTORY_KEY = 'sensorHistory';
let historyQueue: Promise<unknown> = Promise.resolve();

/** Une muestras al historial guardado, en fila (dos escrituras seguidas no se pisan). Devuelve el historial. */
export function appendSensorSamples(storage: StorageService, samples: SensorSample[]): Promise<SensorSample[]> {
  const run = historyQueue.then(async () => {
    const prev = await storage.get<SensorSample[]>(SENSOR_HISTORY_KEY, []);
    const next = mergeSamples(prev, samples, Date.now());
    if (samples.length || next.length !== prev.length) await storage.set(SENSOR_HISTORY_KEY, next);
    return next;
  });
  historyQueue = run.catch(() => undefined);
  return run;
}

/** Con la app abierta, Tuya se consulta como máximo cada 10 min (el sensor a pilas reporta cada cierto rato). */
const CACHE_MS = 10 * 60_000;

/** Sensor Tuya / Smart Life (WiFi o Zigbee) leído desde la nube de Tuya con las claves del proyecto en iot.tuya.com. */
@Injectable({ providedIn: 'root' })
export class TuyaSoilSensorProvider implements SoilSensorProvider {
  readonly id = 'tuya';
  private storage = inject(StorageService);
  private last: { at: number; key: string; reading: SoilReading } | null = null;
  private codes: { key: string; soil: string; temp: string | null } | null = null;

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
      if (s.soilCode) this.codes = { key, soil: s.soilCode, temp: s.tempCode };
      await this.saveSample({ t: Date.parse(reading.takenAt), soil: s.soilPct, tempC: s.tempC, battery: s.battery });
    }
    // La calibración y el umbral pueden cambiar sin volver a consultar el sensor.
    const deficit = deficitFromSensor(reading.raw!.soilPct!, cfg, settings.thresholdMm);
    return {
      ...reading,
      deficitMm: cfg.enabled ? deficit : null,
      moisturePct: deficit === null ? 0 : humidityPct(deficit),
    };
  }

  /** Cada lectura nueva queda en el historial del teléfono. */
  private async saveSample(sample: SensorSample): Promise<void> {
    await appendSensorSamples(this.storage, [sample]).catch(() => undefined); // sin almacenamiento: la lectura igual sirve
  }

  async reportLogs(settings: Settings, sinceMs: number, untilMs: number): Promise<SensorSample[]> {
    const cfg = settings.soilSensor;
    if (!cfg?.accessId?.trim() || !cfg.accessSecret?.trim() || !cfg.deviceId?.trim()) return [];
    const key = `${cfg.region}|${cfg.accessId}|${cfg.deviceId}`;
    if (this.codes?.key !== key) await this.read(settings, true); // aprende los códigos de este modelo
    const codes = this.codes?.key === key ? this.codes : null;
    if (!codes) return [];
    try {
      const now = Date.now();
      let token = await this.storage.get<TuyaToken | null>('tuyaToken', null);
      if (!token || token.expiresAt <= now) {
        token = await tuyaToken(cfg, now);
        await this.storage.set('tuyaToken', token);
      }
      const logs = await readTuyaReportLogs(cfg, token, [codes.soil, ...(codes.temp ? [codes.temp] : [])], sinceMs, untilMs);
      return samplesFromLogs(logs, codes.soil, codes.temp, { soil: normSoil, temp: normTemp });
    } catch (e) {
      throw new Error(tuyaErrorText(e));
    }
  }
}
