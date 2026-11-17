import { ChangeDetectionStrategy, Component, type OnDestroy, computed, effect, input, signal, untracked } from '@angular/core';
import type { Mood, Scene } from '../../core/lawn-mood';
import { BODY, layoutBlades, puffFor, puffX } from './pet-motion';

const RAIN_X = Array.from({ length: 16 }, (_, i) => 20 + i * 19 + (i % 3) * 4);
const SPRINKLE_X = Array.from({ length: 14 }, (_, i) => 70 + i * 14);

/** Pasto mascota: su cara, color y postura reflejan la humedad; el fondo refleja el clima. */
@Component({
  selector: 'app-lawn-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lawn-hero.component.html',
  styleUrl: './lawn-hero.component.scss',
  host: { '[class]': '"mood-" + shownMood() + " scene-" + scene() + (compact() ? " compact" : "") + (bare() ? " bare" : "")' },
})
export class LawnHeroComponent implements OnDestroy {
  readonly mood = input.required<Mood>();
  readonly scene = input.required<Scene>();
  readonly messages = input<string[]>([]);
  readonly compact = input(false);
  /** Sin cielo propio: el pasto se dibuja sobre el fondo de la pantalla. */
  readonly bare = input(false);

  private readonly tapIndex = signal(0);
  readonly watering = signal(false);
  readonly bouncing = signal(false);
  private timers: ReturnType<typeof setTimeout>[] = [];

  readonly reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  readonly shownMood = computed<Mood>(() => (this.watering() ? 'happy' : this.mood()));
  readonly message = computed(() => {
    if (this.watering()) return '¡Ahhh, qué rico! 💦';
    const list = this.messages();
    return list.length ? list[this.tapIndex() % list.length] : '';
  });

  readonly rainX = RAIN_X;
  readonly sprinkleX = SPRINKLE_X;
  readonly body = BODY;

  readonly blades = computed(() => layoutBlades(this.shownMood()));

  /** Efectos flotantes (corazones, gotas) que salen al tocar al pasto. */
  readonly puffs = signal<{ id: number; x: number; ch: string }[]>([]);
  private puffCount = 0;
  private lastMood: Mood | null = null;

  constructor() {
    // Cuando el ánimo cambia (llegó la lluvia, se regó, se secó) el pasto da un saltito.
    effect(() => {
      const mood = this.shownMood();
      untracked(() => {
        if (this.lastMood !== null && mood !== this.lastMood) this.hop();
        this.lastMood = mood;
      });
    });

    // al cambiar de ánimo/mensajes la primera frase vuelve a mostrarse
    effect(() => {
      this.messages();
      this.mood();
      this.tapIndex.set(0);
    });
  }

  /** Toque en el pasto: salta con rebote elástico, dice otra frase y suelta un efecto (corazón, gota…). */
  poke(): void {
    this.tapIndex.update((i) => i + 1);
    this.hop();
    const n = ++this.puffCount;
    const puff = { id: n, x: puffX(n), ch: puffFor(this.shownMood(), n) };
    this.puffs.update((list) => [...list.slice(-3), puff]);
    this.later(() => this.puffs.update((list) => list.filter((p) => p.id !== puff.id)), 1400);
  }

  /** Salto del pasto (también cuando cambia de ánimo: se nota que reacciona). */
  private hop(): void {
    this.bouncing.set(false);
    // Un instante sin la clase reinicia la animación aunque se toque varias veces seguidas.
    this.later(() => {
      this.bouncing.set(true);
      this.later(() => this.bouncing.set(false), 800);
    }, 20);
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
