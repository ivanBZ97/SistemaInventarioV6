import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { alarmOutline, downloadOutline, informationCircleOutline, notificationsOutline, syncOutline } from 'ionicons/icons';
import { BackgroundService } from '../../../core/background.service';
import { BUILD_INFO } from '../../../core/build-info';
import { HOUR_MS } from '../../../core/dates';
import { agoText, whenOf } from '../../../core/format';
import { IrrigationEngineService } from '../../../core/irrigation-engine.service';
import { NotificationService, type PermissionStatus } from '../../../core/notification.service';
import type { PlannedNotification, RunnerStatus } from '../../../core/models';
import { APK_URL } from '../../../core/update';
import { UpdateService } from '../../../core/update.service';
import { SnackbarService } from '../../../ui/snackbar.service';

/** Semáforo de una fila: al día, con observaciones, con error, sin dato o consultando. */
type Level = 'live' | 'late' | 'error' | 'stale' | 'checking';
interface Info {
  level: Level;
  text: string;
}

const CHECKING: Info = { level: 'checking', text: 'Consultando…' };
const PHONE_ONLY: Info = { level: 'stale', text: 'Solo se puede revisar en el teléfono.' };
/** Android corre el worker cada ~15 min; si lleva más que esto, lo está restringiendo. */
const RUNNER_LATE_MS = 3 * HOUR_MS;

/** Ajustes → Estado del sistema: ¿está funcionando todo? Worker, próximo aviso, permisos y versión. */
@Component({
  selector: 'app-status-section',
  imports: [IonIcon],
  templateUrl: './status-section.component.html',
  styleUrl: '../../../ui/list.scss',
})
export class StatusSectionComponent implements OnInit {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);
  private snackbar = inject(SnackbarService);
  readonly updates = inject(UpdateService);

  readonly apkUrl = APK_URL;
  readonly versionText = BUILD_INFO.run ? `Versión: build ${BUILD_INFO.run} (${BUILD_INFO.sha.slice(0, 7)})` : 'Versión de desarrollo';

  readonly loading = signal(false);
  /** undefined: consultando · null: fuera del teléfono. */
  private readonly runner = signal<RunnerStatus | null | undefined>(undefined);
  private readonly permissions = signal<PermissionStatus | null | undefined>(undefined);
  private readonly nextAlert = signal<PlannedNotification | null | undefined>(undefined);
  private readonly loadedAt = signal(Date.now());

  readonly runnerInfo = computed<Info>(() => {
    const r = this.runner();
    if (r === undefined) return CHECKING;
    if (r === null) return PHONE_ONLY;
    if (!r.lastRunAt) {
      return r.error
        ? { level: 'error', text: `No se pudo consultar: ${r.error}.` }
        : {
            level: 'late',
            text: 'Aún no se ha ejecutado. Android la corre cada ~15 min; si en una hora sigue igual, deja la app sin restricciones de batería.',
          };
    }
    const age = this.loadedAt() - r.lastRunAt;
    if (r.ok === false) return { level: 'error', text: `Falló ${agoText(age)}: ${r.error ?? 'error desconocido'}.` };
    if (age > RUNNER_LATE_MS) {
      return {
        level: 'late',
        text: `Última revisión ${agoText(age)}: Android la está retrasando. Deja la app sin restricciones de batería (Ajustes de Android → Apps → Riego → Batería).`,
      };
    }
    return { level: 'live', text: `Funcionando · última revisión ${agoText(age)}${r.backup ? ` · usando ${r.backup} (respaldo)` : ''}.` };
  });

  readonly nextAlertText = computed(() => {
    const n = this.nextAlert();
    if (n === undefined) return CHECKING.text;
    return n ? `${whenOf(n.at.getTime())} · ${n.title}` : 'Ninguno programado (pospusiste el de hoy o falta el pronóstico).';
  });

  readonly permissionInfo = computed<Info>(() => {
    const p = this.permissions();
    if (p === undefined) return CHECKING;
    if (p === null) return PHONE_ONLY;
    if (!p.notifications) return { level: 'error', text: 'Notificaciones bloqueadas: actívalas en «Permiso de notificaciones».' };
    if (p.exactAlarms === null)
      return { level: 'late', text: 'Notificaciones permitidas · no se pudo comprobar el permiso de alarmas exactas.' };
    if (!p.exactAlarms)
      return { level: 'late', text: 'Notificaciones permitidas · alarmas exactas sin permiso: el aviso puede llegar tarde.' };
    return { level: 'live', text: 'Notificaciones y alarmas exactas permitidas.' };
  });

  readonly updateText = computed(() => {
    if (this.updates.available()) {
      const run = this.updates.release()?.run;
      return `Hay una versión nueva${run ? ` (build ${run})` : ''}: descárgala e instálala encima; conserva tus datos.`;
    }
    const checked = this.updates.checked();
    if (!checked) return 'Revisando si hay una versión nueva…';
    return checked.ok ? 'Es la versión más reciente.' : 'No se pudo revisar si hay una versión nueva (sin conexión).';
  });

  constructor() {
    addIcons({ alarmOutline, downloadOutline, informationCircleOutline, notificationsOutline, syncOutline });
  }

  ngOnInit(): void {
    void this.load();
  }

  /** Consulta el worker, los permisos, el próximo aviso y (con `force`) si hay una versión nueva. */
  async load(force = false): Promise<void> {
    this.loading.set(true);
    try {
      const [runner, permissions, plan] = await Promise.all([
        this.background.status(),
        this.notifications.checkStatus().catch(() => null),
        this.engine.plan(true).catch((): PlannedNotification[] => []),
        this.updates.check(force), // nunca falla
      ]);
      const now = Date.now();
      this.loadedAt.set(now);
      this.runner.set(runner);
      this.permissions.set(permissions);
      this.nextAlert.set(plan.filter((n) => n.at.getTime() > now - 60_000).sort((a, b) => a.at.getTime() - b.at.getTime())[0] ?? null);
    } finally {
      this.loading.set(false);
    }
  }

  async testNotification(): Promise<void> {
    const sent = await this.notifications.sendTest().catch(() => false);
    this.snackbar.show(
      sent ? 'En 5 segundos llega un aviso de prueba (puedes salir de la app para verlo).' : 'Los avisos solo funcionan en el teléfono.',
    );
  }
}
