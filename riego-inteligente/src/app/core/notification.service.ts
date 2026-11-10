import { Injectable, inject } from '@angular/core';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { IrrigationEngineService } from './irrigation-engine.service';
import type { PlannedNotification } from './models';
import { ACTION_TYPE_ID, CHANNEL, NOTIF_ID_MORNING, NOTIF_ID_OVERSEED } from './irrigation-core';

/** Permisos de Android para los avisos. `exactAlarms` es null si no se pudo comprobar. */
export interface PermissionStatus {
  notifications: boolean;
  exactAlarms: boolean | null;
}

const ACTION_DONE = 'ya-regue';
const ACTION_SNOOZE = 'posponer';
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
      id: CHANNEL.morning,
      name: 'Evaluación matutina de riego',
      description: 'Alerta diaria matutina con el balance hídrico',
      importance: 5,
      visibility: 1,
      vibration: true,
      lights: true,
    });
    await LocalNotifications.createChannel({
      id: CHANNEL.info,
      name: 'Días sin riego',
      description: 'Aviso de la mañana cuando no hace falta regar (sin sonido)',
      importance: 2,
      visibility: 1,
      vibration: false,
    });
    await LocalNotifications.createChannel({
      id: CHANNEL.overseed,
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

    await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
      void this.onAction(event.actionId).catch((e: unknown) => console.error('No se pudo aplicar la acción del aviso', e));
    });

    // Al volver a primer plano se refresca el balance y se reprograman las alertas.
    await App.addListener('resume', () => {
      void this.onResume().catch((e: unknown) => console.error('No se pudo refrescar al volver a la app', e));
    });

    await this.ensurePermissions();
  }

  /** Botones del aviso de riego: "Ya regué" y "Posponer a mañana" (un toque en el cuerpo solo abre la app). */
  private async onAction(actionId: string): Promise<void> {
    if (actionId === ACTION_DONE) await this.engine.registerIrrigation('notification');
    else if (actionId === ACTION_SNOOZE) await this.engine.snoozeToday();
    else return;
    await LocalNotifications.cancel({ notifications: [{ id: NOTIF_ID_MORNING }] });
    await this.reschedule();
  }

  private async onResume(): Promise<void> {
    await this.engine.refresh();
    await this.reschedule();
    if (await this.engine.updateLocationIfMoved()) await this.reschedule();
  }

  /** Permisos actuales, sin pedirlos. null fuera del teléfono. */
  async checkStatus(): Promise<PermissionStatus | null> {
    if (!Capacitor.isNativePlatform()) return null;
    const perm = await LocalNotifications.checkPermissions();
    return { notifications: perm.display === 'granted', exactAlarms: await this.exactAlarmsAllowed() };
  }

  /**
   * Alarmas exactas permitidas. Si la función no existe en este Android (anterior a 12, donde no hace falta el
   * permiso) se da por permitida; ante otro error, null: no se pudo comprobar.
   */
  private async exactAlarmsAllowed(): Promise<boolean | null> {
    try {
      return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted';
    } catch (e) {
      return (e as { code?: string })?.code === 'UNIMPLEMENTED' ? true : null;
    }
  }

  /** Aviso de prueba en 5 s, por el mismo canal que el aviso de la mañana. */
  async sendTest(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIF_ID_TEST,
          title: '🧪 Prueba de aviso',
          body: 'Si ves esto, los avisos de riego funcionan.',
          channelId: CHANNEL.morning,
          schedule: { at: new Date(Date.now() + 5_000), allowWhileIdle: true },
        },
      ],
    });
    return true;
  }

  async ensurePermissions(): Promise<PermissionStatus> {
    if (!Capacitor.isNativePlatform()) return { notifications: false, exactAlarms: false };
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
    return { notifications: perm.display === 'granted', exactAlarms: await this.exactAlarmsAllowed() };
  }

  /** Abre la pantalla del sistema "Alarmas y recordatorios" (Android 12+). */
  async requestExactAlarms(): Promise<void> {
    if (Capacitor.isNativePlatform()) await LocalNotifications.changeExactNotificationSetting();
  }

  /** (Re)programa el aviso matutino y el de resiembra (13:00) según el plan vigente. */
  async reschedule(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    let planned: PlannedNotification[];
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
