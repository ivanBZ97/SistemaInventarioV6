// Contrato entre la app y el worker en segundo plano (runner/background.ts): nombres de eventos, claves de su
// almacén propio (CapacitorKV, distinto del de la app) y forma de los datos que se intercambian.
import type { RainOverrides } from './irrigation-core';
import type { SensorSample } from './sensor-history';
import type { DayRecord, Settings, WaterState } from './models';

/** Etiqueta del worker: debe coincidir con `BackgroundRunner.label` en capacitor.config.ts. */
export const RUNNER_LABEL = 'cl.riego.inteligente.check';

export const RUNNER_EVENT = {
  /** Lo dispara Android (~cada 15 min): baja el clima y reprograma los avisos. */
  refresh: 'refreshIrrigation',
  /** La app entrega su estado y ajustes. */
  syncState: 'syncState',
  /** La app pregunta cómo le fue a la última ejecución. */
  getStatus: 'getStatus',
  /** La app recoge las lecturas del sensor que hizo el worker. */
  getSensorHistory: 'getSensorHistory',
} as const;

/** Claves del almacén del worker. */
export const RUNNER_KV = {
  snapshot: 'snapshot',
  status: 'status',
  dmcStore: 'dmcStore',
  dmcStoreBackup: 'dmcStoreBackup',
  sensorReading: 'sensorReading',
  sensorHistory: 'sensorHistory',
  tuyaToken: 'tuyaToken',
} as const;

/** Lo que la app le entrega al worker para evaluar con la app cerrada. */
export interface RunnerSnapshot {
  settings: Settings;
  state: WaterState;
  rainOverrides?: RainOverrides;
  history?: DayRecord[];
}

export interface RunnerSensorHistory {
  samples: SensorSample[];
}
