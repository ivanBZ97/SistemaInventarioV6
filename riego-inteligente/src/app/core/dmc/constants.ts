// Tiempos y distancias que comparten los módulos de la DMC.

/** Dos lecturas separadas por más de 1 h no se consideran continuas (hueco en los datos). */
export const MAX_GAP_MS = 60 * 60_000;

/** Las lecturas por minuto se resumen en bloques de 10 min. */
export const BUCKET_MS = 10 * 60_000;

/** Días de lecturas que se conservan en el almacén local. */
export const KEEP_MS = 5 * 86_400_000;

/** Una lectura de más de 3 h indica que la DMC no está recibiendo datos de la estación. */
export const STALE_STATION_MS = 3 * 3_600_000;

/** Más lejos que esto, la lluvia de otra estación ya no representa la del jardín: no se usa de respaldo. */
export const BACKUP_MAX_KM = 25;

/** Una lectura más vieja que esto (la DMC publica con ~25 min de atraso) ya no dice si está lloviendo. */
export const LIVE_FRESH_MS = 90 * 60_000;
