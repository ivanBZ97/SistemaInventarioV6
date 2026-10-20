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
  IonToggle,
  IonTitle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { NotificationService } from '../../core/notification.service';
import { BackgroundService } from '../../core/background.service';
import { LocationService } from '../../core/location.service';
import { Place, searchPlaces } from '../../core/open-meteo';
import { DEFAULT_SETTINGS, THRESHOLD_MAX_MM, THRESHOLD_MIN_MM, clamp } from '../../core/irrigation-core';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonContent, IonList, IonListHeader,
    IonItem, IonLabel, IonRange, IonInput, IonButton, IonNote, IonToggle,
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
        <ion-item lines="none">
          <ion-label class="ion-text-wrap">
            📍 {{ placeName() || 'Ubicación sin nombre' }}
            <p>{{ lat() }}, {{ lon() }}@if (elevation() !== null) { · {{ elevation() }} m }</p>
          </ion-label>
        </ion-item>
        <ion-item>
          <ion-input type="search" label="Buscar ciudad o comuna" labelPlacement="stacked" placeholder="p. ej. Rancagua"
                     [value]="query()" (ionInput)="query.set($any($event).detail.value ?? '')" (keyup.enter)="search()" />
          <ion-button slot="end" fill="outline" (click)="search()">Buscar</ion-button>
        </ion-item>
        @for (r of results(); track r.label + r.latitude) {
          <ion-item button detail="false" (click)="pick(r)"><ion-label>{{ r.label }}</ion-label></ion-item>
        }
        <ion-item>
          <ion-toggle [checked]="auto()" (ionChange)="auto.set($any($event).detail.checked)">
            Actualizar ubicación automáticamente
            <p>Si te mueves más de 10 km</p>
          </ion-toggle>
        </ion-item>
        <ion-item>
          <ion-input type="number" inputmode="decimal" label="Latitud" labelPlacement="stacked"
                     [value]="lat()" (ionInput)="lat.set(+$any($event).detail.value)" />
        </ion-item>
        <ion-item>
          <ion-input type="number" inputmode="decimal" label="Longitud" labelPlacement="stacked"
                     [value]="lon()" (ionInput)="lon.set(+$any($event).detail.value)" />
        </ion-item>
        <ion-item lines="none">
          <ion-button fill="outline" (click)="useGps()">GPS aproximado</ion-button>
          <ion-button fill="outline" (click)="usePreciseGps()">GPS preciso (en el jardín)</ion-button>
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
  private location = inject(LocationService);
  private toasts = inject(ToastController);

  readonly min = THRESHOLD_MIN_MM;
  readonly max = THRESHOLD_MAX_MM;
  threshold = signal(DEFAULT_SETTINGS.thresholdMm);
  rate = signal(DEFAULT_SETTINGS.sprinklerRateMmMin);
  lat = signal(DEFAULT_SETTINGS.latitude);
  lon = signal(DEFAULT_SETTINGS.longitude);
  placeName = signal<string | undefined>(undefined);
  elevation = signal<number | null>(null);
  auto = signal(false);
  query = signal('');
  results = signal<Place[]>([]);

  async ngOnInit(): Promise<void> {
    const s = this.engine.snapshot() ?? (await this.engine.refresh());
    this.threshold.set(s.settings.thresholdMm);
    this.rate.set(s.settings.sprinklerRateMmMin);
    this.lat.set(s.settings.latitude);
    this.lon.set(s.settings.longitude);
    this.placeName.set(s.settings.placeName);
    this.elevation.set(s.elevationM !== null ? Math.round(s.elevationM) : null);
    this.auto.set(s.settings.useGps);
  }

  private async toast(message: string): Promise<void> {
    (await this.toasts.create({ message, duration: 2200 })).present();
  }

  async useGps(): Promise<void> {
    const fix = await this.location.detect();
    if (!fix) return this.toast('No se pudo obtener la ubicación; busca tu ciudad o ingresa las coordenadas.');
    this.lat.set(fix.latitude);
    this.lon.set(fix.longitude);
    this.placeName.set(fix.placeName ?? undefined);
    this.auto.set(true);
    this.toast(`Ubicación: ${fix.placeName ?? fix.latitude + ', ' + fix.longitude}`);
  }

  /** GPS de alta precisión (~10 m): úsalo parado en el jardín. Fija el punto (sin auto-actualizar). */
  async usePreciseGps(): Promise<void> {
    this.toast('Obteniendo ubicación precisa… (puede tardar hasta 30 s, mejor al aire libre)');
    const fix = await this.location.detect(true);
    if (!fix) return this.toast('No se pudo obtener la ubicación precisa. Revisa el permiso de ubicación precisa.');
    this.lat.set(fix.latitude);
    this.lon.set(fix.longitude);
    this.placeName.set(fix.placeName ?? undefined);
    this.auto.set(false);
    this.toast(`Punto fijado (±${fix.accuracyM} m). Pulsa Guardar.`);
  }

  async search(): Promise<void> {
    try {
      const found = await searchPlaces(this.query());
      this.results.set(found);
      if (!found.length) this.toast('Sin resultados');
    } catch {
      this.toast('No se pudo buscar (¿sin conexión?)');
    }
  }

  pick(place: Place): void {
    this.lat.set(place.latitude);
    this.lon.set(place.longitude);
    this.placeName.set(place.label);
    this.auto.set(false);
    this.results.set([]);
    this.elevation.set(null);
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
      placeName: this.placeName(),
      useGps: this.auto(),
      locationSet: true,
    });
    await this.notifications.reschedule();
    await this.background.sync();
    this.toast('Ajustes guardados');
  }
}
