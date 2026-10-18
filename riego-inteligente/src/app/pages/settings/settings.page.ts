import { Component, OnInit, inject, signal } from '@angular/core';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonRange,
  IonTitle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { NotificationService } from '../../core/notification.service';
import { BackgroundService } from '../../core/background.service';
import { WeatherService } from '../../core/weather.service';
import { DEFAULT_SETTINGS, THRESHOLD_MAX_MM, THRESHOLD_MIN_MM, clamp } from '../../core/irrigation-core';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonContent, IonList, IonListHeader,
    IonItem, IonLabel, IonRange, IonInput, IonButton, IonNote,
  ],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/dashboard" /></ion-buttons>
        <ion-title>Ajustes</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <ion-list>
        <ion-list-header>Riego</ion-list-header>
        <ion-item>
          <ion-range label="Umbral de disparo" labelPlacement="stacked" [min]="min" [max]="max" [step]="0.5" [pin]="true"
                     [value]="threshold()" (ionChange)="threshold.set(+$any($event).detail.value)">
            <ion-note slot="end">{{ threshold() }} mm</ion-note>
          </ion-range>
        </ion-item>
        <ion-item>
          <ion-input type="number" inputmode="decimal" label="Tasa del aspersor (mm/min)" labelPlacement="stacked"
                     [value]="rate()" (ionInput)="rate.set(+$any($event).detail.value)" />
        </ion-item>

        <ion-list-header>Ubicación</ion-list-header>
        <ion-item>
          <ion-input type="number" inputmode="decimal" label="Latitud" labelPlacement="stacked"
                     [value]="lat()" (ionInput)="lat.set(+$any($event).detail.value)" />
        </ion-item>
        <ion-item>
          <ion-input type="number" inputmode="decimal" label="Longitud" labelPlacement="stacked"
                     [value]="lon()" (ionInput)="lon.set(+$any($event).detail.value)" />
        </ion-item>
        <ion-item lines="none">
          <ion-button fill="outline" (click)="useGps()">Usar mi ubicación (GPS)</ion-button>
        </ion-item>

        <ion-list-header>Notificaciones</ion-list-header>
        <ion-item lines="none">
          <ion-label class="ion-text-wrap">
            Para que la alerta de las 06:30 llegue puntual, permite «Alarmas y recordatorios» y excluye la app del ahorro de batería.
          </ion-label>
        </ion-item>
        <ion-item lines="none">
          <ion-button fill="outline" (click)="permissions()">Permisos de notificación</ion-button>
          <ion-button fill="outline" (click)="exactAlarms()">Alarmas exactas</ion-button>
        </ion-item>
      </ion-list>
      <div class="ion-padding"><ion-button expand="block" (click)="save()">Guardar</ion-button></div>
    </ion-content>
  `,
})
export class SettingsPage implements OnInit {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);
  private weather = inject(WeatherService);
  private toasts = inject(ToastController);

  readonly min = THRESHOLD_MIN_MM;
  readonly max = THRESHOLD_MAX_MM;
  threshold = signal(DEFAULT_SETTINGS.thresholdMm);
  rate = signal(DEFAULT_SETTINGS.sprinklerRateMmMin);
  lat = signal(DEFAULT_SETTINGS.latitude);
  lon = signal(DEFAULT_SETTINGS.longitude);

  async ngOnInit(): Promise<void> {
    const s = this.engine.snapshot() ?? (await this.engine.refresh());
    this.threshold.set(s.settings.thresholdMm);
    this.rate.set(s.settings.sprinklerRateMmMin);
    this.lat.set(s.settings.latitude);
    this.lon.set(s.settings.longitude);
  }

  private async toast(message: string): Promise<void> {
    (await this.toasts.create({ message, duration: 2200 })).present();
  }

  async useGps(): Promise<void> {
    const pos = await this.weather.locate();
    if (!pos) return this.toast('No se pudo obtener la ubicación; se mantienen las coordenadas.');
    this.lat.set(pos.latitude);
    this.lon.set(pos.longitude);
    this.toast(`Ubicación: ${pos.latitude}, ${pos.longitude}`);
  }

  async permissions(): Promise<void> {
    const p = await this.notifications.ensurePermissions();
    this.toast(p.notifications ? 'Notificaciones permitidas' : 'Notificaciones bloqueadas: actívalas en Ajustes de Android');
  }

  exactAlarms(): Promise<void> {
    return this.notifications.requestExactAlarms();
  }

  async save(): Promise<void> {
    const rate = this.rate();
    if (!(rate > 0)) return this.toast('La tasa del aspersor debe ser mayor que 0');
    await this.engine.saveSettings({
      thresholdMm: clamp(this.threshold(), THRESHOLD_MIN_MM, THRESHOLD_MAX_MM),
      sprinklerRateMmMin: rate,
      latitude: clamp(this.lat(), -90, 90),
      longitude: clamp(this.lon(), -180, 180),
    });
    await this.notifications.reschedule();
    await this.background.sync();
    this.toast('Ajustes guardados');
  }
}
