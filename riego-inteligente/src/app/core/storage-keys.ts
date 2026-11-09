/** Claves del almacenamiento local de la app (Capacitor Preferences). Todo queda solo en el teléfono. */
export const STORAGE = {
  settings: 'settings',
  state: 'state',
  /** Balance de los días ya cerrados (30 días). */
  history: 'history',
  irrigations: 'irrigations',
  rainOverrides: 'rainOverrides',
  weatherCache: 'weatherCache',
  /** Lecturas de la estación DMC elegida y de la de respaldo. */
  dmcStore: 'dmcStore',
  dmcStoreBackup: 'dmcStoreBackup',
  sensorHistory: 'sensorHistory',
  tuyaToken: 'tuyaToken',
  updateCheck: 'updateCheck',
} as const;
