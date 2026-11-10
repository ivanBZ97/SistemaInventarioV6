import { Injectable, inject } from '@angular/core';
import { ToastController } from '@ionic/angular/standalone';

export interface SnackbarOptions {
  /** Milisegundos en pantalla; por defecto, según el largo del mensaje. */
  duration?: number;
  /** Botón de acción (p. ej. "Deshacer"). */
  action?: { text: string; run: () => void };
}

/** Avisos breves al pie de la pantalla (snackbar de Material 3). */
@Injectable({ providedIn: 'root' })
export class SnackbarService {
  private toasts = inject(ToastController);

  /** Muestra el mensaje sin esperar a que se cierre. Nunca falla: es solo informativo. */
  show(message: string, options: SnackbarOptions = {}): void {
    void this.present(message, options).catch((e: unknown) => console.warn('No se pudo mostrar el aviso', e));
  }

  private async present(message: string, { duration, action }: SnackbarOptions): Promise<void> {
    const toast = await this.toasts.create({
      message,
      duration: duration ?? Math.max(2500, message.length * 60),
      position: 'bottom',
      cssClass: 'md-snackbar',
      buttons: action ? [{ text: action.text, handler: action.run }] : undefined,
    });
    await toast.present();
  }
}
