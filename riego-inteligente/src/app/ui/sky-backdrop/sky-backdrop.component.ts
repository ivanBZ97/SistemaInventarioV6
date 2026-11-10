import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Scene } from '../../core/lawn-mood';
import { skyClasses, skyTheme } from './sky-theme';

/**
 * Cielo animado a pantalla completa detrás del panel, como el de una app del clima: su color cambia con la hora
 * (amanecer, día, atardecer, noche) y trae nubes, lluvia, viento, estrellas, sol o luna según el clima. Es solo
 * decoración (`aria-hidden`); con «reducir movimiento» queda quieto.
 */
@Component({
  selector: 'app-sky-backdrop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[class]': 'classes()' },
  template: `
    <div class="glow"></div>
    <div class="stars-layer"></div>
    <div class="clouds">
      @for (n of cloudIndexes(); track n) {
        <i class="cloud c{{ n }}"></i>
      }
    </div>
    <div class="rain"></div>
    <div class="rain far"></div>
    <div class="wind"></div>
    <div class="shade"></div>
  `,
  styleUrl: './sky-backdrop.component.scss',
})
export class SkyBackdropComponent {
  /** Clima que se dibuja. */
  readonly scene = input.required<Scene>();
  /** Hora local con fracción (13,5 = 13:30). */
  readonly hour = input.required<number>();

  private readonly theme = computed(() => skyTheme(this.scene(), this.hour()));
  protected readonly classes = computed(() => skyClasses(this.theme()));
  protected readonly cloudIndexes = computed(() => Array.from({ length: Math.max(this.theme().clouds, 1) + 2 }, (_, i) => i + 1));
}
