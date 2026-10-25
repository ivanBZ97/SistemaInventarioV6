import { Component, OnInit, inject, signal } from '@angular/core';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonRange,
  IonToggle,
  IonTitle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  alarmOutline, checkmarkOutline, chevronForwardOutline, copyOutline, closeOutline, locateOutline, locationOutline, navigateOutline,
  notificationsOutline, pulseOutline, radioOutline, searchOutline, timeOutline, waterOutline,
} from 'ionicons/icons';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { NotificationService } from '../../core/notification.service';
import { BackgroundService } from '../../core/background.service';
import { LocationService } from '../../core/location.service';
import { Place, searchPlaces } from '../../core/open-meteo';
import { fetchObservedRain, findRainVariable, listStations, nearestStations } from '../../core/agromet';
import { type DmcStore, diagnoseDmc, listDmcStations, nearestDmcStation } from '../../core/dmc';
import { StorageService } from '../../core/storage.service';
import type { AgrometConfig, DmcConfig } from '../../core/models';
import { DEFAULT_SETTINGS, MORNING_TIME_OPTIONS, THRESHOLD_MAX_MM, THRESHOLD_MIN_MM, addDays, clamp, round1, toISODate } from '../../core/irrigation-core';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonContent, IonRange, IonInput, IonButton, IonToggle, IonIcon,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/dashboard" text="" /></ion-buttons>
        <ion-title class="md-title-large">Ajustes</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <!-- Riego -->
      <h2 class="section md-title-small">Riego</h2>
      <div class="card">
        <div class="row">
          <div class="li-icon"><ion-icon name="water-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">Umbral de riego</span>
            <span class="md-body-medium md-variant">Se avisa cuando el déficit llega a {{ threshold() }} mm</span>
          </div>
          <span class="md-title-medium value">{{ threshold() }} mm</span>
        </div>
        <ion-range class="m3-slider" [min]="min" [max]="max" [step]="0.5" [ticks]="true" [snaps]="true"
                   [value]="threshold()" (ionInput)="threshold.set(+$any($event).detail.value)" aria-label="Umbral de riego" />
        <div class="divider"></div>
        <div class="field">
          <ion-input fill="outline" type="number" inputmode="decimal" label="Tasa del aspersor" labelPlacement="floating"
                     helperText="mm por minuto. Mídela con el test de latas." [value]="rate()" (ionInput)="rate.set(+$any($event).detail.value)">
            <span slot="end" class="md-body-medium md-variant">mm/min</span>
          </ion-input>
        </div>
      </div>

      <!-- Ubicación -->
      <h2 class="section md-title-small">Ubicación del jardín</h2>
      <div class="card">
        <div class="row">
          <div class="li-icon"><ion-icon name="location-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">{{ placeName() || 'Ubicación sin nombre' }}</span>
            <span class="md-body-medium md-variant">{{ lat() }}, {{ lon() }}@if (elevation() !== null) { · {{ elevation() }} m }</span>
          </div>
        </div>
        <div class="chips">
          <button class="chip" (click)="useGps()"><ion-icon name="locate-outline" />GPS aproximado</button>
          <button class="chip" (click)="usePreciseGps()"><ion-icon name="navigate-outline" />GPS preciso (en el jardín)</button>
        </div>
        <div class="field">
          <ion-input fill="outline" type="search" label="Buscar ciudad o comuna" labelPlacement="floating"
                     [value]="query()" (ionInput)="query.set($any($event).detail.value ?? '')" (keyup.enter)="search()">
            <ion-button slot="end" fill="clear" (click)="search()" aria-label="Buscar"><ion-icon slot="icon-only" name="search-outline" /></ion-button>
          </ion-input>
        </div>
        @for (r of results(); track r.label + r.latitude) {
          <button class="row result" (click)="pick(r)">
            <ion-icon name="location-outline" class="md-variant" /><span class="md-body-large">{{ r.label }}</span>
          </button>
        }
        <div class="divider"></div>
        <div class="row">
          <div class="li-text">
            <span class="md-body-large">Actualizar automáticamente</span>
            <span class="md-body-medium md-variant">Si te mueves más de 10 km</span>
          </div>
          <ion-toggle [checked]="auto()" (ionChange)="auto.set($any($event).detail.checked)" aria-label="Actualizar ubicación automáticamente" />
        </div>
        <div class="field two">
          <ion-input fill="outline" type="number" inputmode="decimal" label="Latitud" labelPlacement="floating"
                     [value]="lat()" (ionInput)="lat.set(+$any($event).detail.value)" />
          <ion-input fill="outline" type="number" inputmode="decimal" label="Longitud" labelPlacement="floating"
                     [value]="lon()" (ionInput)="lon.set(+$any($event).detail.value)" />
        </div>
      </div>

      <!-- Lluvia observada -->
      <h2 class="section md-title-small">Lluvia observada</h2>
      <div class="card">
        <p class="md-body-medium md-variant intro">
          Usa la lluvia medida por una estación real cerca de tu jardín en lugar de la del pronóstico.
        </p>
        <div class="row">
          <div class="li-icon"><ion-icon name="radio-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">{{ dmc()?.name ?? 'Dirección Meteorológica de Chile' }}</span>
            <span class="md-body-medium md-variant">
              {{ dmc() ? 'Estación DMC ' + dmc()!.code + ' · a ' + km(dmc()!.distanceKm) + ' km · sin clave' : 'Estaciones automáticas públicas · sin clave' }}
            </span>
          </div>
        </div>
        <div class="chips">
          <button class="chip" (click)="findDmc()"><ion-icon name="search-outline" />{{ dmc() ? 'Cambiar estación' : 'Usar la estación más cercana' }}</button>
          @if (dmc()) {
            <button class="chip" (click)="testDmc()"><ion-icon name="pulse-outline" />Probar</button>
            <button class="chip" (click)="dmc.set(undefined)"><ion-icon name="close-outline" />Quitar</button>
          }
        </div>
        @if (dmcReport(); as r) {
          <div class="md-body-small report" [class.err]="r.error">
            @for (l of r.lines; track $index) { <p>{{ l }}</p> }
            <button class="copy" (click)="copyReport()"><ion-icon name="copy-outline" />Copiar diagnóstico</button>
          </div>
        }
        <div class="divider"></div>
        <p class="md-body-medium md-variant intro">INIA Agromet (opcional, requiere una clave personal de la API de INIA).</p>
        <div class="field">
          <ion-input fill="outline" type="password" label="Clave de API" labelPlacement="floating"
                     [value]="agrometKey()" (ionInput)="agrometKey.set($any($event).detail.value ?? '')" />
        </div>
        @if (agromet(); as a) {
          <div class="row">
            <div class="li-icon"><ion-icon name="radio-outline" /></div>
            <div class="li-text">
              <span class="md-body-large">{{ a.stationName }}</span>
              <span class="md-body-medium md-variant">A {{ km(a.distanceKm) }} km de tu jardín</span>
            </div>
          </div>
        }
        <div class="chips">
          <button class="chip" (click)="findStation()"><ion-icon name="search-outline" />Buscar estación cercana</button>
          @if (agromet()) {
            <button class="chip" (click)="testStation()"><ion-icon name="pulse-outline" />Probar</button>
            <button class="chip" (click)="agromet.set(undefined)"><ion-icon name="close-outline" />Quitar</button>
          }
        </div>
      </div>

      <!-- Notificaciones -->
      <h2 class="section md-title-small">Notificaciones</h2>
      <div class="card">
        <div class="row">
          <div class="li-icon"><ion-icon name="time-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">Hora del aviso matutino</span>
            <span class="md-body-medium md-variant">Dentro de 06:30–08:30: nunca de noche, para prevenir hongos</span>
          </div>
        </div>
        <div class="chips times" role="radiogroup" aria-label="Hora del aviso matutino">
          @for (t of timeOptions; track t) {
            <button class="chip" role="radio" [class.on]="morningTime() === t" [attr.aria-checked]="morningTime() === t"
                    (click)="morningTime.set(t)">
              @if (morningTime() === t) { <ion-icon name="checkmark-outline" /> }{{ t }}
            </button>
          }
        </div>
        <div class="divider inset"></div>
        <button class="row link" (click)="permissions()">
          <div class="li-icon"><ion-icon name="notifications-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">Permiso de notificaciones</span>
            <span class="md-body-medium md-variant">Necesario para el aviso matutino</span>
          </div>
          <ion-icon name="chevron-forward-outline" class="md-variant" />
        </button>
        <div class="divider inset"></div>
        <button class="row link" (click)="exactAlarms()">
          <div class="li-icon"><ion-icon name="alarm-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">Alarmas exactas</span>
            <span class="md-body-medium md-variant">Permite «Alarmas y recordatorios» y excluye la app del ahorro de batería</span>
          </div>
          <ion-icon name="chevron-forward-outline" class="md-variant" />
        </button>
      </div>
      <div class="bottom-space"></div>
    </ion-content>
    <div class="save-bar">
      <ion-button expand="block" (click)="save()">Guardar cambios</ion-button>
    </div>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100%; }
    ion-content { flex: 1; }
    .section { margin: 24px 24px 8px; color: var(--md-primary); }
    .card { margin: 0 16px; padding: 8px 0; border-radius: var(--md-shape-lg); background: var(--md-surface-container-low); }
    .row { display: flex; align-items: center; gap: 16px; width: 100%; padding: 12px 16px; min-height: 56px;
      background: none; border: 0; text-align: left; color: inherit; font: inherit; }
    .row.link, .row.result { cursor: pointer; }
    .row.result { min-height: 48px; padding-left: 20px; }
    .li-icon { width: 40px; height: 40px; flex: none; border-radius: 50%; display: grid; place-items: center;
      background: var(--md-secondary-container); color: var(--md-on-secondary-container); font-size: 20px; }
    .li-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .value { color: var(--md-primary); }
    .m3-slider { padding: 0 20px; }
    .field { padding: 8px 16px; }
    .field.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    ion-input[fill='outline'] { --border-radius: 4px; --border-color: var(--md-outline); --highlight-color-focused: var(--md-primary); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 16px; }
    .chip.on { background: var(--md-secondary-container); color: var(--md-on-secondary-container); border-color: transparent; }
    .chips.times .chip { padding: 0 12px; }
    .chips.times .chip.on { padding-left: 8px; }
    .chip { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 16px 0 8px; border-radius: 8px;
      border: 1px solid var(--md-outline); background: transparent; color: var(--md-on-surface-variant);
      font: 500 14px/20px var(--md-font); letter-spacing: .1px; cursor: pointer;
      ion-icon { font-size: 18px; color: var(--md-primary); } }
    .intro { margin: 8px 16px 0; }
    .report { margin: 4px 16px 8px; padding: 8px 12px; border-radius: 8px; background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
    .report.err { background: var(--md-error-container); color: var(--md-on-error-container); }
    .report p { margin: 0 0 4px; }
    .report .copy { display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 4px 0; border: 0;
      background: none; color: inherit; font: 500 12px/16px var(--md-font); text-decoration: underline; cursor: pointer; }
    .divider { height: 1px; margin: 8px 0; background: var(--md-outline-variant); }
    .divider.inset { margin-left: 72px; }
    .bottom-space { height: 24px; }
    .save-bar { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: var(--md-surface-container); }
    .save-bar ion-button { margin: 0; height: 48px; }
  `],
})
export class SettingsPage implements OnInit {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);
  private location = inject(LocationService);
  private toasts = inject(ToastController);
  private storage = inject(StorageService);

  constructor() {
    addIcons({
      alarmOutline, checkmarkOutline, chevronForwardOutline, copyOutline, closeOutline, locateOutline, locationOutline, navigateOutline,
      notificationsOutline, pulseOutline, radioOutline, searchOutline, timeOutline, waterOutline,
    });
  }

  readonly timeOptions = MORNING_TIME_OPTIONS;
  readonly km = (v: number) => v.toFixed(1).replace('.', ',');
  morningTime = signal('06:30');
  readonly min = THRESHOLD_MIN_MM;
  readonly max = THRESHOLD_MAX_MM;
  threshold = signal(DEFAULT_SETTINGS.thresholdMm);
  rate = signal(DEFAULT_SETTINGS.sprinklerRateMmMin);
  lat = signal(DEFAULT_SETTINGS.latitude);
  lon = signal(DEFAULT_SETTINGS.longitude);
  placeName = signal<string | undefined>(undefined);
  elevation = signal<number | null>(null);
  auto = signal(false);
  agromet = signal<AgrometConfig | undefined>(undefined);
  dmc = signal<DmcConfig | undefined>(undefined);
  dmcReport = signal<{ lines: string[]; error: boolean } | null>(null);
  agrometKey = signal('');
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
    this.morningTime.set(s.settings.morningTime ?? '06:30');
    this.agromet.set(s.settings.agromet);
    this.dmc.set(s.settings.dmc);
    this.agrometKey.set(s.settings.agromet?.apiKey ?? '');
  }

  private async toast(message: string): Promise<void> {
    (await this.toasts.create({ message, duration: 2500, cssClass: 'md-snackbar' })).present();
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

  /** Busca la estación INIA más cercana que mida precipitación. */
  /** Elige la estación automática de la DMC más cercana al jardín (lista pública, sin clave). */
  async findDmc(): Promise<void> {
    this.dmcReport.set(null);
    const st = nearestDmcStation(await listDmcStations(), this.lat(), this.lon());
    if (!st) return this.toast('No se encontraron estaciones de la DMC');
    this.dmc.set({ code: st.code, name: st.name, distanceKm: Math.round(st.distanceKm * 10) / 10 });
    if (st.distanceKm > 25) {
      this.toast(`La estación más cercana está a ${st.distanceKm.toFixed(0)} km: puede no representar la lluvia de tu jardín.`);
    }
    await this.testDmc();
  }

  /** Prueba la estación y muestra qué entregó (para contrastar con agrometeorologia.cl o reportar un cambio). */
  async testDmc(): Promise<void> {
    const cfg = this.dmc();
    if (!cfg) return;
    this.dmcReport.set({ lines: ['Consultando la estación…'], error: false });
    let r: Awaited<ReturnType<typeof diagnoseDmc>>;
    try {
      const prev = await this.storage.get<DmcStore | null>('dmcStore', null);
      r = await diagnoseDmc(cfg.code, prev, toISODate(new Date()));
      await this.storage.set('dmcStore', r.store);
    } catch (e) {
      this.dmcReport.set({ lines: [`Error inesperado al probar la estación: ${e instanceof Error ? e.message : e}`], error: true });
      return;
    }
    this.dmcReport.set({
      lines: r.ok ? [...r.lines, 'Pulsa Guardar cambios para usar esta estación.'] : [...r.lines, 'Mientras tanto, la app sigue usando el pronóstico.'],
      error: !r.ok,
    });
  }

  /** Copia el diagnóstico para enviarlo como texto. */
  async copyReport(): Promise<void> {
    const r = this.dmcReport();
    if (!r) return;
    try {
      await navigator.clipboard.writeText(r.lines.join('\n'));
      this.toast('Diagnóstico copiado');
    } catch {
      this.toast('No se pudo copiar; envía una captura de pantalla');
    }
  }

  async findStation(): Promise<void> {
    const apiKey = this.agrometKey().trim();
    if (!apiKey) return this.toast('Ingresa tu clave de API de Agromet');
    this.toast('Buscando estaciones…');
    try {
      const near = nearestStations(await listStations(apiKey), this.lat(), this.lon(), 6);
      if (!near.length) return this.toast('La API no devolvió estaciones');
      for (const st of near) {
        const rainVariableId = await findRainVariable(apiKey, st.id);
        if (!rainVariableId) continue; // estación sin pluviómetro
        this.agromet.set({ apiKey, stationId: st.id, stationName: `${st.name}${st.comuna ? ', ' + st.comuna : ''}`, distanceKm: st.distanceKm, rainVariableId });
        return this.toast(`Estación: ${st.name} a ${st.distanceKm.toFixed(1)} km. Pulsa Guardar.`);
      }
      this.toast('Las estaciones cercanas no miden lluvia');
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'No se pudo consultar Agromet');
    }
  }

  /** Muestra la lluvia que reporta la estación (para contrastar con tu pluviómetro o la realidad). */
  async testStation(): Promise<void> {
    const cfg = this.agromet();
    if (!cfg) return;
    try {
      const today = toISODate(new Date());
      const obs = await fetchObservedRain({ ...cfg, apiKey: this.agrometKey().trim() || cfg.apiKey }, addDays(today, -2), today);
      if (!obs.size) return this.toast('Sin muestras recientes en la estación');
      const txt = [...obs.entries()].sort().map(([d, mm]) => `${d.slice(5)}: ${round1(mm)} mm`).join(' · ');
      this.toast(`Lluvia observada → ${txt}`);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'No se pudo consultar Agromet');
    }
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
      dmc: this.dmc(),
      agromet: this.agromet() ? { ...this.agromet()!, apiKey: this.agrometKey().trim() || this.agromet()!.apiKey } : undefined,
      useGps: this.auto(),
      locationSet: true,
      morningTime: this.morningTime(),
    });
    await this.notifications.reschedule();
    await this.background.sync();
    this.toast('Ajustes guardados');
  }
}
