import { Component, OnInit, inject } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { IrrigationEngineService } from './core/irrigation-engine.service';
import { NotificationService } from './core/notification.service';
import { BackgroundService } from './core/background.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [IonApp, IonRouterOutlet],
  template: `<ion-app><ion-router-outlet /></ion-app>`,
})
export class AppComponent implements OnInit {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);

  async ngOnInit(): Promise<void> {
    await this.notifications.init();
    await this.engine.updateLocationIfMoved();
    await this.engine.refresh();
    await this.notifications.reschedule();
    await this.background.sync();
  }
}
