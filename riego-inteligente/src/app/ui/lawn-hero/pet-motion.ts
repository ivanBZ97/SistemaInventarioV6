// Geometría y movimiento del pasto mascota. Funciones puras (sin Angular): se prueban solas.
import type { Mood } from '../../core/lawn-mood';

/** Cuerpo del pasto en el lienzo del SVG (viewBox 320 × 220). */
export const BODY = { cx: 160, cy: 150, rx: 66, ry: 44 } as const;

/** Cuánto se doblan las hojas hacia los lados (grados): tiesas si está bien, caídas si tiene sed. */
const DROOP: Record<Mood, number> = { happy: 0, content: 0, thirsty: 14, wilted: 38 };

/** Hojas: posición horizontal respecto al centro, alto y cuánto se inclinan en reposo. */
const BLADE_DEFS = [
  { x: -50, h: 44, lean: -24 },
  { x: -34, h: 62, lean: -14 },
  { x: -17, h: 76, lean: -6 },
  { x: 0, h: 86, lean: 0 },
  { x: 17, h: 74, lean: 6 },
  { x: 34, h: 60, lean: 14 },
  { x: 50, h: 42, lean: 24 },
] as const;

export interface Blade {
  /** Contorno de la hoja, con su base en el origen (0, 0). */
  d: string;
  /** Posición de la base y giro en reposo (caída según el ánimo). */
  x: number;
  y: number;
  rot: number;
  /** Duración del vaivén (segundos), desfase (negativo: ya va a medio camino) y qué tanto se mece esta hoja. */
  dur: number;
  delay: number;
  k: number;
  tone: 1 | 2;
}

/** Hojas del pasto para un ánimo: cada una con su propio ritmo, para que no se muevan todas a la vez. */
export function layoutBlades(mood: Mood): Blade[] {
  const droop = DROOP[mood];
  return BLADE_DEFS.map((b, i) => {
    const baseY = BODY.cy - BODY.ry * Math.sqrt(1 - (b.x / BODY.rx) ** 2) + 8;
    const side = b.x >= 0 ? 1 : -1;
    const lean = b.lean * 0.5;
    return {
      d: `M -7 0 Q ${lean * 0.5 - 5} ${-b.h * 0.55} ${lean} ${-b.h} Q ${lean * 0.5 + 5} ${-b.h * 0.55} 7 0 Z`,
      x: BODY.cx + b.x,
      y: baseY,
      rot: side * droop * (0.5 + Math.abs(b.x) / 60),
      dur: 2.4 + ((i * 7) % 5) * 0.45,
      delay: -((i * 13) % 9) * 0.33,
      // Las hojas altas se mecen más que las bajas.
      k: Math.round((0.55 + b.h / 100) * 100) / 100,
      tone: i % 2 === 0 ? 1 : 2,
    };
  });
}

/** Lo que flota al tocar al pasto: cada ánimo reacciona distinto. */
const PUFFS: Record<Mood, string[]> = {
  happy: ['💚', '✨', '💚'],
  content: ['🌱', '✨'],
  thirsty: ['💧', '💧'],
  wilted: ['💧'],
};

/** Un efecto flotante para el toque número `n` (rota entre los del ánimo). */
export function puffFor(mood: Mood, n: number): string {
  const list = PUFFS[mood];
  return list[Math.abs(n) % list.length];
}

/** Posición horizontal del efecto `n`: se reparte alrededor del centro, sin repetirse seguido. */
export function puffX(n: number): number {
  return BODY.cx + (((n * 37) % 11) - 5) * 9;
}
