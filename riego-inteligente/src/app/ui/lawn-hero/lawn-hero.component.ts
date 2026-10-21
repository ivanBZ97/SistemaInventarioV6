import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, input, signal } from '@angular/core';
import type { Mood, Scene } from '../../core/lawn-mood';

interface Blade {
  d: string;
  x: number;
  y: number;
  rot: number;
  dur: string;
  tone: 1 | 2;
}

const BODY = { cx: 160, cy: 150, rx: 66, ry: 44 };
const DROOP: Record<Mood, number> = { happy: 0, content: 0, thirsty: 14, wilted: 38 };
const RAIN_X = Array.from({ length: 16 }, (_, i) => 20 + i * 19 + (i % 3) * 4);
const SPRINKLE_X = Array.from({ length: 14 }, (_, i) => 70 + i * 14);

/** Pasto mascota: su cara, color y postura reflejan la humedad; el fondo refleja el clima. */
@Component({
  selector: 'app-lawn-hero',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lawn-hero.component.html',
  styleUrls: ['./lawn-hero.component.scss'],
  host: { '[class]': '"mood-" + shownMood() + " scene-" + scene() + (compact() ? " compact" : "")' },
})
export class LawnHeroComponent implements OnDestroy {
  readonly mood = input.required<Mood>();
  readonly scene = input.required<Scene>();
  readonly messages = input<string[]>([]);
  readonly compact = input(false);

  private readonly tapIndex = signal(0);
  readonly watering = signal(false);
  readonly bouncing = signal(false);
  private timers: ReturnType<typeof setTimeout>[] = [];

  readonly reduceMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  readonly shownMood = computed<Mood>(() => (this.watering() ? 'happy' : this.mood()));
  readonly message = computed(() => {
    if (this.watering()) return '¡Ahhh, qué rico! 💦';
    const list = this.messages();
    return list.length ? list[this.tapIndex() % list.length] : '';
  });

  readonly rainX = RAIN_X;
  readonly sprinkleX = SPRINKLE_X;
  readonly body = BODY;

  readonly blades = computed<Blade[]>(() => {
    const droop = DROOP[this.shownMood()];
    const defs = [
      { x: -50, h: 44, lean: -24 }, { x: -34, h: 62, lean: -14 }, { x: -17, h: 76, lean: -6 },
      { x: 0, h: 86, lean: 0 }, { x: 17, h: 74, lean: 6 }, { x: 34, h: 60, lean: 14 }, { x: 50, h: 42, lean: 24 },
    ];
    return defs.map((b, i) => {
      const baseY = BODY.cy - BODY.ry * Math.sqrt(1 - (b.x / BODY.rx) ** 2) + 8;
      const side = b.x >= 0 ? 1 : -1;
      const fall = side * droop * (0.5 + Math.abs(b.x) / 60);
      const lean = b.lean * 0.5;
      return {
        d: `M -7 0 Q ${lean * 0.5 - 5} ${-b.h * 0.55} ${lean} ${-b.h} Q ${lean * 0.5 + 5} ${-b.h * 0.55} 7 0 Z`,
        x: BODY.cx + b.x,
        y: baseY,
        rot: fall,
        dur: `${2.6 + (i % 4) * 0.5}s`,
        tone: (i % 2 === 0 ? 1 : 2) as 1 | 2,
      };
    });
  });

  constructor() {
    // al cambiar de ánimo/mensajes la primera frase vuelve a mostrarse
    effect(() => {
      this.messages();
      this.mood();
      this.tapIndex.set(0);
    });
  }

  /** Toque en el pasto: salta y dice otra frase. */
  poke(): void {
    this.tapIndex.update((i) => i + 1);
    this.bouncing.set(true);
    this.later(() => this.bouncing.set(false), 650);
  }

  /** Animación de riego (aspersor + celebración). */
  water(): void {
    this.watering.set(true);
    this.later(() => this.watering.set(false), 2800);
  }

  private later(fn: () => void, ms: number): void {
    this.timers.push(setTimeout(fn, ms));
  }

  ngOnDestroy(): void {
    this.timers.forEach(clearTimeout);
  }
}
