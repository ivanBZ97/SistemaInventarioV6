// Qué cielo dibujar detrás del panel: depende del clima (el mismo que ve el pasto) y de la hora del día.
// Funciones puras: se prueban sin Angular.
import type { Scene } from '../../core/lawn-mood';

/** Momento del día. En Chile central, en primavera, amanece cerca de las 6:30 y anochece cerca de las 20:30. */
export type DayPhase = 'night' | 'dawn' | 'day' | 'dusk';

/** Límites de cada tramo, en horas locales (con fracción). */
const DAWN_FROM = 6.5;
const DAY_FROM = 8;
const DUSK_FROM = 19.5;
const NIGHT_FROM = 21;

/** Momento del día para una hora local con fracción (13,5 = 13:30). */
export function dayPhase(hour: number): DayPhase {
  if (hour >= NIGHT_FROM || hour < DAWN_FROM) return 'night';
  if (hour < DAY_FROM) return 'dawn';
  if (hour < DUSK_FROM) return 'day';
  return 'dusk';
}

/** Hora local con fracción de un instante (ms). */
export function hourOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
}

export interface SkyTheme {
  phase: DayPhase;
  scene: Scene;
  /** Se ven estrellas: noche sin lluvia ni nubes. */
  stars: boolean;
  /** Se ve el sol (o la luna): el cielo está despejado o con viento. */
  celestial: boolean;
  /** Cantidad de nubes (0 = ninguna): más con lluvia y nublado. */
  clouds: 0 | 1 | 2 | 3;
}

export function skyTheme(scene: Scene, hour: number): SkyTheme {
  const phase = dayPhase(hour);
  const clear = scene === 'sun' || scene === 'wind';
  return {
    phase,
    scene,
    stars: phase === 'night' && clear,
    celestial: clear,
    clouds: scene === 'rain' ? 3 : scene === 'cloud' ? 2 : scene === 'wind' ? 1 : 1,
  };
}

/** Clases CSS del cielo: una por momento del día y una por clima. */
export function skyClasses(theme: SkyTheme): string {
  return `phase-${theme.phase} scene-${theme.scene}${theme.stars ? ' stars' : ''}${theme.celestial ? ' celestial' : ''}`;
}
