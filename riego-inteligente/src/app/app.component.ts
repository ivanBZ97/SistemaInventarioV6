import { Component, type OnInit, inject } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { IrrigationEngineService } from './core/irrigation-engine.service';
import { NotificationService } from './core/notification.service';
import { BackgroundService } from './core/background.service';
import { UpdateService } from './core/update.service';

@Component({
  selector: 'app-root',
  imports: [IonApp, IonRouterOutlet],
  template: `<ion-app><ion-router-outlet /></ion-app>`,
})
export class AppComponent implements OnInit {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);
  private updates = inject(UpdateService);

  /**
   * Arranque: el balance (es lo que se ve) y, con él listo, los avisos y el worker. Cada paso es independiente:
   * si uno falla (p. ej. Android niega un permiso), los demás siguen.
   */
  async ngOnInit(): Promise<void> {
    void this.updates.check();
    // Los avisos se preparan en paralelo: si la app se abrió desde el botón "Ya regué" de un aviso, esa acción
    // debe tener quien la reciba cuanto antes (el motor la pone en fila detrás del primer cálculo).
    const notificationsReady = this.step('preparar los avisos', () => this.notifications.init());
    await this.step('calcular el balance', () => this.engine.ready());
    await notificationsReady;
    await this.step('programar los avisos', () => this.notifications.reschedule());
    await this.step('sincronizar el worker', () => this.background.sync());
    // El GPS puede tardar: se revisa al final, y solo si el usuario se movió se recalcula todo.
    await this.step('revisar la ubicación', async () => {
      if (!(await this.engine.updateLocationIfMoved())) return;
      await this.notifications.reschedule();
      await this.background.sync();
    });
  }

  private async step(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (e) {
      console.error(`No se pudo ${name}`, e);
    }
  }
}
