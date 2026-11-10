import { Component, inject } from '@angular/core';
import { IonIcon, IonToggle } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { alarmOutline, checkmarkOutline, chevronForwardOutline, notificationsOutline, timeOutline } from 'ionicons/icons';
import { MORNING_TIME_OPTIONS } from '../../../core/irrigation-core';
import { NotificationService } from '../../../core/notification.service';
import { inputChecked } from '../../../ui/ion-events';
import { SnackbarService } from '../../../ui/snackbar.service';
import { SettingsForm } from '../settings-form';

/** Ajustes → Notificaciones: hora del aviso de la mañana y permisos de Android. */
@Component({
  selector: 'app-notifications-section',
  imports: [IonIcon, IonToggle],
  templateUrl: './notifications-section.component.html',
  styleUrl: '../../../ui/list.scss',
})
export class NotificationsSectionComponent {
  readonly form = inject(SettingsForm);
  private notifications = inject(NotificationService);
  private snackbar = inject(SnackbarService);

  readonly timeOptions = MORNING_TIME_OPTIONS;
  readonly checked = inputChecked;

  constructor() {
    addIcons({ alarmOutline, checkmarkOutline, chevronForwardOutline, notificationsOutline, timeOutline });
  }

  async askPermission(): Promise<void> {
    const granted = (await this.notifications.ensurePermissions()).notifications;
    this.snackbar.show(granted ? 'Notificaciones permitidas' : 'Notificaciones bloqueadas: actívalas en Ajustes de Android');
  }

  /** Abre la pantalla del sistema «Alarmas y recordatorios» (Android 12+). */
  async openExactAlarms(): Promise<void> {
    try {
      await this.notifications.requestExactAlarms();
    } catch {
      this.snackbar.show('No se pudo abrir el ajuste de alarmas exactas en este teléfono.');
    }
  }
}
