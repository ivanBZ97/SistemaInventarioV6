import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { BackgroundRunner } from '@capacitor/background-runner';
import { StorageService } from './storage.service';
import type { SensorSample } from './sensor-history';
import { SOIL_SENSOR_PROVIDER, appendSensorSamples } from './soil-sensor.provider';
import { RUNNER_EVENT, RUNNER_LABEL, type RunnerSensorHistory } from './runner-protocol';
import { STORAGE } from './storage-keys';
import type { Settings } from './models';

/** Tuya guarda ~7 días de reportes; se le piden como máximo cada 30 min. */
const CLOUD_DAYS = 7;
const CLOUD_EVERY_MS = 30 * 60_000;

/**
 * Historial de mediciones del sensor de suelo, guardado en el teléfono (un año). Se alimenta de cada lectura de
 * la app, de las que hizo el worker en segundo plano y del historial de la nube de Tuya (reportes de los últimos
 * 7 días que nadie alcanzó a consultar).
 */
@Injectable({ providedIn: 'root' })
export class SensorHistoryService {
  private storage = inject(StorageService);
  private sensor = inject(SOIL_SENSOR_PROVIDER);
  private lastCloudAt = 0;

  load(): Promise<SensorSample[]> {
    return this.storage.get<SensorSample[]>(STORAGE.sensorHistory, []);
  }

  add(samples: SensorSample[]): Promise<SensorSample[]> {
    return appendSensorSamples(this.storage, samples);
  }

  /**
   * Trae lo que midió el worker y, si el sensor lo permite, el historial de la nube de Tuya. Devuelve el
   * historial completo y, si la nube falló, por qué (el historial local sigue sirviendo).
   */
  async sync(settings: Settings, force = false): Promise<{ samples: SensorSample[]; cloudError: string | null }> {
    const incoming: SensorSample[] = [];
    if (Capacitor.isNativePlatform()) {
      try {
        const r = await BackgroundRunner.dispatchEvent<Partial<RunnerSensorHistory>>({ label: RUNNER_LABEL, event: RUNNER_EVENT.getSensorHistory, details: {} });
        if (Array.isArray(r?.samples)) incoming.push(...r.samples);
      } catch {
        /* worker sin datos: no importa */
      }
    }
    let cloudError: string | null = null;
    const now = Date.now();
    if (this.sensor.reportLogs && (force || now - this.lastCloudAt > CLOUD_EVERY_MS)) {
      try {
        const have = await this.load();
        const newest = have.length ? have[have.length - 1].t : 0;
        const since = Math.max(now - CLOUD_DAYS * 86_400_000, newest - 3_600_000);
        incoming.push(...(await this.sensor.reportLogs(settings, since, now)));
        this.lastCloudAt = now;
      } catch (e) {
        cloudError = e instanceof Error ? e.message : String(e);
      }
    }
    return { samples: await this.add(incoming), cloudError };
  }
}
