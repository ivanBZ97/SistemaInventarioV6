import { Injectable, inject } from '@angular/core';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { IrrigationEngineService } from './irrigation-engine.service';
import { NOTIF_ID_MORNING, NOTIF_ID_OVERSEED } from './irrigation-core';

export const ACTION_TYPE_ID = 'RIEGO_ACTIONS';
export const ACTION_DONE = 'ya-regue';
export const ACTION_SNOOZE = 'posponer';
const NOTIF_ID_TEST = 1099;

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private engine = inject(IrrigationEngineService);
  private initialised = false;

  /** Canales de alta prioridad, botones de acción, listeners y permisos. */
  async init(): Promise<void> {
    if (this.initialised || !Capacitor.isNativePlatform()) return;
    this.initialised = true;

    await LocalNotifications.createChannel({
      id: 'riego-matutino',
      name: 'Evaluación matutina de riego',
      description: 'Alerta diaria matutina con el balance hídrico',
      importance: 5,
      visibility: 1,
      vibration: true,
      lights: true,
    });
    await LocalNotifications.createChannel({
      id: 'riego-resiembra',
      name: 'Modo Resiembra',
      description: 'Recordatorio de las 13:00 mientras dure la resiembra',
      importance: 5,
      visibility: 1,
      vibration: true,
    });

    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: ACTION_TYPE_ID,
          actions: [
            { id: ACTION_DONE, title: '✅ Ya regué' },
            { id: ACTION_SNOOZE, title: '⏳ Posponer a mañana' },
          ],
        },
      ],
    });

    await LocalNotifications.addListener('localNotificationActionPerformed', async (event) => {
      if (event.actionId === ACTION_DONE) await this.engine.registerIrrigation('notification');
      else if (event.actionId === ACTION_SNOOZE) await this.engine.snoozeToday();
      else return; // toque en el cuerpo: solo abre la app
      await LocalNotifications.cancel({ notifications: [{ id: NOTIF_ID_MORNING }] });
      await this.reschedule();
    });

    // Al volver a primer plano se refresca el balance y se reprograman las alertas.
    await App.addListener('resume', async () => {
      await this.engine.updateLocationIfMoved();
      await this.engine.refresh();
      await this.reschedule();
    });

    await this.ensurePermissions();
  }

  /** Permisos actuales, sin pedirlos (para el panel de estado). null fuera del teléfono. */
  async checkStatus(): Promise<{ notifications: boolean; exactAlarms: boolean } | null> {
    if (!Capacitor.isNativePlatform()) return null;
    const perm = await LocalNotifications.checkPermissions();
    const exact = await LocalNotifications.checkExactNotificationSetting();
    return { notifications: perm.display === 'granted', exactAlarms: exact.exact_alarm === 'granted' };
  }

  /** Aviso de prueba en 5 s, por el mismo canal que el aviso de la mañana. */
  async sendTest(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    await LocalNotifications.schedule({
      notifications: [{
        id: NOTIF_ID_TEST,
        title: '🧪 Prueba de aviso',
        body: 'Si ves esto, los avisos de riego funcionan.',
        channelId: 'riego-matutino',
        schedule: { at: new Date(Date.now() + 5_000), allowWhileIdle: true },
      }],
    });
    return true;
  }

  async ensurePermissions(): Promise<{ notifications: boolean; exactAlarms: boolean }> {
    if (!Capacitor.isNativePlatform()) return { notifications: false, exactAlarms: false };
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
    const exact = await LocalNotifications.checkExactNotificationSetting();
    return { notifications: perm.display === 'granted', exactAlarms: exact.exact_alarm === 'granted' };
  }

  /** Abre la pantalla del sistema "Alarmas y recordatorios" (Android 12+). */
  async requestExactAlarms(): Promise<void> {
    if (Capacitor.isNativePlatform()) await LocalNotifications.changeExactNotificationSetting();
  }

  /** (Re)programa el aviso matutino y el de resiembra (13:00) según el plan vigente. */
  async reschedule(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    let planned;
    try {
      planned = await this.engine.plan();
    } catch {
      return; // sin clima ni caché: se conservan las alertas ya programadas
    }
    await LocalNotifications.cancel({
      notifications: [{ id: NOTIF_ID_MORNING }, { id: NOTIF_ID_OVERSEED }],
    });
    if (!planned.length) return;
    await LocalNotifications.schedule({
      notifications: planned.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        channelId: n.channelId,
        actionTypeId: n.actions ? ACTION_TYPE_ID : undefined,
        schedule: { at: n.at, allowWhileIdle: true },
      })),
    });
  }
}
