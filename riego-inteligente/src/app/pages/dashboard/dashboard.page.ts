import { Component, OnInit, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonRefresher,
  IonRefresherContent,
  IonTitle,
  IonToggle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { settingsOutline, waterOutline, createOutline, locationOutline } from 'ionicons/icons';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { NotificationService } from '../../core/notification.service';
import { BackgroundService } from '../../core/background.service';
import { LocationService } from '../../core/location.service';
import { round1 } from '../../core/irrigation-core';

const RING_R = 82;
const RING_LEN = 2 * Math.PI * RING_R;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    RouterLink, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon, IonContent, IonCard,
    IonCardHeader, IonCardTitle, IonCardContent, IonItem, IonLabel, IonToggle, IonRefresher, IonRefresherContent,
  ],
  templateUrl: './dashboard.page.html',
  styleUrls: ['./dashboard.page.scss'],
})
export class DashboardPage implements OnInit {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);
  private location = inject(LocationService);
  private alerts = inject(AlertController);
  private toasts = inject(ToastController);
  private router = inject(Router);

  readonly snap = this.engine.snapshot;
  readonly ringLen = RING_LEN;
  readonly ringR = RING_R;

  constructor() {
    addIcons({ settingsOutline, waterOutline, createOutline, locationOutline });
  }

  readonly deficit = computed(() => round1(this.snap()?.evaluation?.deficitMm ?? this.snap()?.state.deficitMm ?? 0));
  readonly humidity = computed(() => Math.round(this.snap()?.evaluation?.humidityPct ?? 100));
  readonly ringOffset = computed(() => RING_LEN * (1 - this.humidity() / 100));
  readonly ringColor = computed(() => (this.humidity() >= 60 ? 'var(--ri-ok)' : this.humidity() >= 40 ? 'var(--ri-warn)' : '#d64545'));

  readonly status = computed(() => {
    const ev = this.snap()?.evaluation;
    if (!ev) return { cls: 'paused', title: 'Sin datos de clima', detail: this.snap()?.error ?? 'Cargando…' };
    const wind = ev.windWarning && ev.status === 'irrigate' ? ` · 💨 Viento ${Math.round(ev.windMaxKmh)} km/h: riega temprano` : '';
    if (ev.status === 'irrigate')
      return { cls: 'irrigate', title: `Toca regar ${ev.minutes} minutos`, detail: `Déficit ${round1(ev.deficitMm)} mm · Riega entre 06:30 y 08:30${wind}` };
    if (ev.status === 'paused_rain')
      return { cls: 'paused', title: 'Pausado por lluvia', detail: `${Math.round(ev.rainProbPct)}% de prob. de lluvia (${round1(ev.rainForecastMm)} mm previstos)` };
    return { cls: 'ok', title: 'No regar hoy (Suelo húmedo)', detail: `Déficit ${round1(ev.deficitMm)} mm · umbral ${this.snap()?.settings.thresholdMm} mm` };
  });

  /** Lluvia de hoy y déficit proyectado para mañana (la lluvia de hoy se descuenta mañana). */
  readonly outlook = computed(() => {
    const ev = this.snap()?.evaluation;
    if (!ev) return null;
    const rain =
      ev.rainForecastMm > 0 || ev.rainProbPct >= 30
        ? `🌧️ Hoy: ${round1(ev.rainForecastMm)} mm previstos (${Math.round(ev.rainProbPct)}% prob.)` +
          (ev.effectiveRainTodayMm > 0 ? ` · ${round1(ev.effectiveRainTodayMm)} mm útiles` : ' · lluvia insuficiente (< 2 mm)')
        : null;
    const tomorrow = `Mañana: ~${round1(ev.projectedDeficitMm)} mm de déficit (ETc −${round1(ev.etcTodayMm)}, lluvia +${round1(ev.effectiveRainTodayMm)})`;
    return { rain, tomorrow };
  });

  readonly overseedOn = computed(() => (this.snap()?.overseedDaysLeft ?? 0) > 0);

  // Gráfico de 7 días (SVG)
  readonly chartH = 130;
  readonly bars = computed(() => {
    const days = this.snap()?.chart ?? [];
    const max = Math.max(4, ...days.map((d) => Math.max(d.etcMm, d.replenishedMm)));
    const slot = 300 / 7;
    const h = (v: number) => (v / max) * (this.chartH - 10);
    return days.map((d, i) => {
      const x = 10 + i * slot;
      return {
        label: d.date.slice(8) + '/' + d.date.slice(5, 7),
        etc: { x: x + 2, y: this.chartH - h(d.etcMm), h: h(d.etcMm), v: round1(d.etcMm) },
        water: { x: x + slot / 2, y: this.chartH - h(d.replenishedMm), h: h(d.replenishedMm), v: round1(d.replenishedMm) },
        w: slot / 2 - 4,
        lx: x + slot / 2,
        estimated: d.estimated,
      };
    });
  });

  async ngOnInit(): Promise<void> {
    const snap = this.snap() ?? (await this.engine.refresh());
    if (!snap.settings.locationSet) await this.askLocation();
  }

  readonly placeLabel = computed(() => {
    const s = this.snap();
    if (!s) return '';
    const name = s.settings.placeName ?? `${s.settings.latitude}, ${s.settings.longitude}`;
    return s.elevationM != null ? `${name} · ${Math.round(s.elevationM)} m` : name;
  });

  /** Primer arranque: sin esto el clima sería el de Santiago (coordenadas por defecto). */
  private async askLocation(): Promise<void> {
    const alert = await this.alerts.create({
      header: '📍 ¿Dónde está tu jardín?',
      message:
        'El riego se calcula con el clima de tu ubicación. Por ahora se usa Santiago de Chile. ' +
        'Usamos solo una ubicación aproximada (~1 km).',
      backdropDismiss: false,
      buttons: [
        {
          text: 'Usar mi ubicación',
          handler: () => {
            this.useGps();
            return true;
          },
        },
        { text: 'Buscar ciudad', handler: () => { this.router.navigateByUrl('/settings'); return true; } },
        {
          text: 'Mantener Santiago',
          role: 'cancel',
          handler: () => { this.engine.saveSettings({ locationSet: true }); },
        },
      ],
    });
    await alert.present();
  }

  private async useGps(): Promise<void> {
    const fix = await this.location.detect();
    if (!fix) {
      (await this.toasts.create({ message: 'No se pudo obtener la ubicación. Búscala por ciudad en Ajustes.', duration: 3000 })).present();
      return;
    }
    await this.engine.saveSettings({
      latitude: fix.latitude,
      longitude: fix.longitude,
      placeName: fix.placeName ?? undefined,
      useGps: true,
      locationSet: true,
    });
    await this.notifications.reschedule();
    await this.background.sync();
  }

  async refresh(ev?: CustomEvent): Promise<void> {
    await this.engine.refresh(true);
    await this.notifications.reschedule();
    await this.background.sync();
    (ev?.target as HTMLIonRefresherElement | undefined)?.complete();
  }

  private async afterChange(msg: string): Promise<void> {
    await this.notifications.reschedule();
    await this.background.sync();
    (await this.toasts.create({ message: msg, duration: 2000, position: 'bottom' })).present();
  }

  async registerIrrigation(): Promise<void> {
    await this.engine.registerIrrigation('manual');
    await this.afterChange('Riego registrado: déficit en 0 mm');
  }

  async adjustManually(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Ajustar humedad manualmente',
      message: '¿Cómo ves la tierra hoy?',
      inputs: [
        { type: 'radio', label: 'Muy húmeda / encharcada (0 mm)', value: 0 },
        { type: 'radio', label: 'Húmeda (3 mm)', value: 3 },
        { type: 'radio', label: 'Normal (6 mm)', value: 6 },
        { type: 'radio', label: 'Seca (10 mm)', value: 10 },
        { type: 'radio', label: 'Muy seca / pasto marchito (14 mm)', value: 14 },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Aplicar',
          handler: async (mm: number | undefined) => {
            if (mm === undefined) return false;
            await this.engine.setDeficit(mm);
            await this.afterChange(`Déficit ajustado a ${mm} mm`);
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  async toggleOverseed(ev: CustomEvent): Promise<void> {
    await this.engine.setOverseed(!!ev.detail.checked);
    await this.afterChange(ev.detail.checked ? 'Modo Resiembra activado por 10 días' : 'Modo Resiembra desactivado');
  }
}
