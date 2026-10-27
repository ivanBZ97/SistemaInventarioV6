import { Component, OnInit, computed, inject, signal } from '@angular/core';
import {
  AlertController,
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
  notificationsOutline, pulseOutline, radioOutline, searchOutline, syncOutline, timeOutline, waterOutline, downloadOutline, informationCircleOutline,
} from 'ionicons/icons';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { NotificationService } from '../../core/notification.service';
import { BackgroundService } from '../../core/background.service';
import { LocationService } from '../../core/location.service';
import { Place, searchPlaces } from '../../core/open-meteo';
import { fetchObservedRain, findRainVariable, listStations, nearestStations } from '../../core/agromet';
import {
  type DmcStation,
  type DmcStore,
  type StationCheck,
  type StationHealth,
  ageText,
  bestStation,
  checkStations,
  diagnoseDmc,
  listDmcStations,
  nearbyDmcStations,
  nearestDmcStation,
  stationMeta,
  stationsToCheck,
} from '../../core/dmc';
import { StorageService } from '../../core/storage.service';
import type { AgrometConfig, DmcAuth, DmcConfig, PlannedNotification, RunnerStatus } from '../../core/models';
import { UpdateService } from '../../core/update.service';
import { APK_URL } from '../../core/update';
import { BUILD_INFO } from '../../core/build-info';
import { DEFAULT_SETTINGS, MORNING_TIME_OPTIONS, THRESHOLD_MAX_MM, THRESHOLD_MIN_MM, addDays, clamp, round1, toISODate, weekdayEs } from '../../core/irrigation-core';

/** Fila de la lista de estaciones: revisada, o aún consultándose. */
type StationRow = Omit<StationCheck, 'health'> & { health: StationHealth | 'checking' };

const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** "07:35", "ayer 23:00" o "24/10 16:00" (para la lista) */
function shortWhen(t: number): string {
  const day = toISODate(new Date(t));
  const today = toISODate(new Date());
  if (day === today) return clock(t);
  if (day === addDays(today, -1)) return `ayer ${clock(t)}`;
  const d = new Date(t);
  return `${d.getDate()}/${d.getMonth() + 1} ${clock(t)}`;
}

/** "hace 12 min", "hace 3 h" o "hace 2 días" */
const agoText = (ms: number) => `hace ${ageText(Math.max(0, ms))}`;

/** "hoy a las 07:35", "mañana a las 06:30", "ayer a las 23:00" o "el sábado 24/10 a las 16:00" */
function whenOf(t: number): string {
  const day = toISODate(new Date(t));
  const today = toISODate(new Date());
  if (day === today) return `hoy a las ${clock(t)}`;
  if (day === addDays(today, 1)) return `mañana a las ${clock(t)}`;
  if (day === addDays(today, -1)) return `ayer a las ${clock(t)}`;
  const d = new Date(t);
  return `el ${weekdayEs(day)} ${d.getDate()}/${d.getMonth() + 1} a las ${clock(t)}`;
}

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
        <div class="field">
          <ion-input fill="outline" type="number" inputmode="decimal" label="Superficie del pasto (opcional)" labelPlacement="floating"
                     helperText="Para ver cada riego en litros (1 mm en 1 m² = 1 litro)." [value]="area()" (ionInput)="area.set(+$any($event).detail.value || null)">
            <span slot="end" class="md-body-medium md-variant">m²</span>
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

      <!-- Estación meteorológica: lluvia y ET0 medidas -->
      <h2 class="section md-title-small">Estación meteorológica</h2>
      <div class="card">
        <p class="md-body-medium md-variant intro">
          Usa la lluvia (la de hoy, casi en tiempo real) y la evapotranspiración (ET0) medidas por una estación real cerca de tu jardín en lugar de las del pronóstico.
        </p>
        <div class="row">
          <div class="li-icon"><ion-icon name="radio-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">{{ dmc()?.name ?? 'Dirección Meteorológica de Chile' }}</span>
            <span class="md-body-medium md-variant">
              {{ dmc() ? 'Estación DMC ' + dmc()!.code + ' · a ' + km(dmc()!.distanceKm) + ' km · ' + (dmcUser().trim() && dmcToken().trim() ? 'con token' : 'sin clave') : 'Estaciones automáticas públicas · sin clave' }}
            </span>
          </div>
        </div>
        <div class="chips">
          <button class="chip" (click)="changeDmc()"><ion-icon name="search-outline" />{{ dmc() ? 'Cambiar estación' : 'Usar la estación más cercana' }}</button>
          @if (dmc()) {
            <button class="chip" (click)="testDmc()"><ion-icon name="pulse-outline" />Probar</button>
            <button class="chip" (click)="dmc.set(undefined)"><ion-icon name="close-outline" />Quitar</button>
          }
        </div>
        <p class="md-body-small md-variant intro">
          Credenciales del servicio oficial de la DMC (gratis): regístrate en climatologia.meteochile.gob.cl y te
          enviarán un token al confirmar la cuenta. Se guardan solo en este teléfono.
        </p>
        <div class="field two">
          <ion-input fill="outline" type="email" inputmode="email" autocomplete="email" label="Usuario (correo)" labelPlacement="floating"
                     [value]="dmcUser()" (ionInput)="dmcUser.set($any($event).detail.value ?? '')" />
          <ion-input fill="outline" type="password" label="Token" labelPlacement="floating"
                     [value]="dmcToken()" (ionInput)="dmcToken.set($any($event).detail.value ?? '')" />
        </div>
        <div class="chips">
          <button class="chip" (click)="connectDmc()" [disabled]="checking()">
            <ion-icon name="sync-outline" />{{ checking() ? 'Revisando estaciones…' : checks() ? 'Volver a revisar' : 'Conectar y ver estaciones' }}
          </button>
        </div>
        @if (checks(); as list) {
          <p class="md-body-small md-variant intro">{{ checksSummary() }}</p>
          <div class="stations" role="radiogroup" aria-label="Estaciones de la DMC cercanas">
            @for (c of list; track c.code; let first = $first) {
              <button class="row station" role="radio" [class.sel]="dmc()?.code === c.code" [attr.aria-checked]="dmc()?.code === c.code"
                      [disabled]="c.health !== 'live' && c.health !== 'late'" (click)="selectStation(c)">
                <i [class]="'dot ' + c.health"></i>
                <div class="li-text">
                  <span class="md-body-large">{{ c.name }}@if (first) {<span class="tag">Más cercana</span>}</span>
                  <span class="md-body-medium md-variant">{{ km(c.distanceKm) }} km · {{ healthText(c) }}</span>
                </div>
                @if (dmc()?.code === c.code) { <ion-icon name="checkmark-outline" class="check" /> }
              </button>
            }
          </div>
        } @else {
          <p class="md-body-small md-variant intro">
            Con tu usuario y token, revisa las 6 estaciones más cercanas y muestra cuáles están enviando datos
            (usa algunos MB de datos; mejor con Wi-Fi).
          </p>
        }
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
      <!-- Estado del sistema: ¿está funcionando todo? -->
      <h2 class="section md-title-small">Estado del sistema</h2>
      <div class="card">
        <div class="row">
          <div class="li-icon"><ion-icon name="sync-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">Revisión automática</span>
            <span class="md-body-medium md-variant">{{ runnerInfo().text }}</span>
          </div>
          <i [class]="'dot ' + runnerInfo().level"></i>
        </div>
        <div class="row">
          <div class="li-icon"><ion-icon name="alarm-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">Próximo aviso</span>
            <span class="md-body-medium md-variant">{{ nextAlertText() }}</span>
          </div>
        </div>
        <div class="row">
          <div class="li-icon"><ion-icon name="notifications-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">Permisos</span>
            <span class="md-body-medium md-variant">{{ permInfo().text }}</span>
          </div>
          <i [class]="'dot ' + permInfo().level"></i>
        </div>
        <div class="row">
          <div class="li-icon"><ion-icon name="information-circle-outline" /></div>
          <div class="li-text">
            <span class="md-body-large">{{ versionText }}</span>
            <span class="md-body-medium md-variant">{{ updateText() }}</span>
          </div>
        </div>
        <div class="chips">
          <button class="chip" (click)="testNotification()"><ion-icon name="notifications-outline" />Probar aviso</button>
          <button class="chip" (click)="loadStatus(true)"><ion-icon name="sync-outline" />Actualizar</button>
          @if (updates.available()) {
            <a class="chip" [href]="apkUrl"><ion-icon name="download-outline" />Descargar la versión nueva</a>
          }
        </div>
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
    .chip:disabled { opacity: .6; cursor: default; }
    .stations { padding: 4px 0 8px; }
    .row.station { cursor: pointer; min-height: 64px; }
    .row.station:disabled { cursor: default; opacity: .6; }
    .row.station.sel { background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
    .row.station .check { font-size: 22px; color: var(--md-primary); }
    .dot { width: 12px; height: 12px; flex: none; margin: 0 14px; border-radius: 50%; background: var(--md-outline); }
    .dot.live { background: var(--md-primary); }
    .dot.late { background: var(--md-warning); }
    .dot.error { background: var(--md-error); }
    .dot.checking { background: var(--md-outline-variant); animation: blink 1s ease-in-out infinite; }
    @keyframes blink { 50% { opacity: .3; } }
    a.chip { text-decoration: none; }
    .dot.stale { background: var(--md-outline); }
    .tag { margin-left: 8px; padding: 1px 8px; border-radius: 6px; border: 1px solid var(--md-outline-variant);
      font: 500 11px/16px var(--md-font); color: var(--md-on-surface-variant); vertical-align: middle; }
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
  private alerts = inject(AlertController);
  private storage = inject(StorageService);

  constructor() {
    addIcons({
      alarmOutline, checkmarkOutline, chevronForwardOutline, copyOutline, closeOutline, locateOutline, locationOutline, navigateOutline,
      notificationsOutline, pulseOutline, radioOutline, searchOutline, syncOutline, timeOutline, waterOutline, downloadOutline, informationCircleOutline,
    });
  }

  readonly timeOptions = MORNING_TIME_OPTIONS;
  readonly km = (v: number) => v.toFixed(1).replace('.', ',');
  morningTime = signal('06:30');
  readonly min = THRESHOLD_MIN_MM;
  readonly max = THRESHOLD_MAX_MM;
  threshold = signal(DEFAULT_SETTINGS.thresholdMm);
  rate = signal(DEFAULT_SETTINGS.sprinklerRateMmMin);
  area = signal<number | null>(null);
  lat = signal(DEFAULT_SETTINGS.latitude);
  lon = signal(DEFAULT_SETTINGS.longitude);
  placeName = signal<string | undefined>(undefined);
  elevation = signal<number | null>(null);
  auto = signal(false);
  agromet = signal<AgrometConfig | undefined>(undefined);
  dmc = signal<DmcConfig | undefined>(undefined);
  dmcReport = signal<{ lines: string[]; error: boolean } | null>(null);
  /** Estaciones cercanas revisadas al conectar (por distancia); null hasta la primera revisión. */
  checks = signal<StationRow[] | null>(null);
  checking = signal(false);
  checkedAt = signal<number | null>(null);
  readonly checksSummary = computed(() => {
    const list = this.checks();
    if (!list) return '';
    if (this.checking()) return `Revisando las ${list.length} estaciones más cercanas…`;
    const live = list.filter((c) => c.health === 'live').length;
    const at = this.checkedAt();
    const sel = list.find((c) => c.code === this.dmc()?.code);
    const warn = sel && sel.health !== 'live' && sel.health !== 'late' ? ` ${sel.name} no está enviando datos: elige otra.` : '';
    return `${live} de ${list.length} estaciones están al día${at ? ` (revisado a las ${clock(at)})` : ''}. Toca una para usarla.${warn}`;
  });
  dmcUser = signal('');
  dmcToken = signal('');
  agrometKey = signal('');

  // ───────────── Estado del sistema ─────────────
  readonly updates = inject(UpdateService);
  readonly apkUrl = APK_URL;
  readonly versionText = BUILD_INFO.run ? `Versión: build ${BUILD_INFO.run} (${BUILD_INFO.sha.slice(0, 7)})` : 'Versión de desarrollo';
  /** undefined: consultando · null: fuera del teléfono o el worker no respondió. */
  runner = signal<RunnerStatus | null | undefined>(undefined);
  perms = signal<{ notifications: boolean; exactAlarms: boolean | null } | null | undefined>(undefined);
  nextAlert = signal<PlannedNotification | null | undefined>(undefined);
  statusAt = signal(Date.now());
  readonly runnerInfo = computed(() => {
    const r = this.runner();
    if (r === undefined) return { level: 'checking', text: 'Consultando…' };
    if (r === null) return { level: 'stale', text: 'Solo se puede revisar en el teléfono.' };
    if (!r.lastRunAt && r.error) return { level: 'error', text: `No se pudo consultar: ${r.error}.` };
    if (!r.lastRunAt)
      return { level: 'late', text: 'Aún no se ha ejecutado. Android la corre cada ~15 min; si en una hora sigue igual, deja la app sin restricciones de batería.' };
    const age = this.statusAt() - r.lastRunAt;
    if (r.ok === false) return { level: 'error', text: `Falló ${agoText(age)}: ${r.error ?? 'error desconocido'}.` };
    if (age > 3 * 3_600_000)
      return { level: 'late', text: `Última revisión ${agoText(age)}: Android la está retrasando. Deja la app sin restricciones de batería (Ajustes de Android → Apps → Riego → Batería).` };
    return { level: 'live', text: `Funcionando · última revisión ${agoText(age)}${r.backup ? ` · usando ${r.backup} (respaldo)` : ''}.` };
  });
  readonly nextAlertText = computed(() => {
    const n = this.nextAlert();
    if (n === undefined) return 'Consultando…';
    return n ? `${whenOf(n.at.getTime())} · ${n.title}` : 'Ninguno programado (pospusiste el de hoy o falta el pronóstico).';
  });
  readonly permInfo = computed(() => {
    const p = this.perms();
    if (p === undefined) return { level: 'checking', text: 'Consultando…' };
    if (p === null) return { level: 'stale', text: 'Solo se puede revisar en el teléfono.' };
    if (!p.notifications) return { level: 'error', text: 'Notificaciones bloqueadas: actívalas en «Permiso de notificaciones».' };
    if (p.exactAlarms === null) return { level: 'late', text: 'Notificaciones permitidas · no se pudo comprobar el permiso de alarmas exactas.' };
    if (!p.exactAlarms) return { level: 'late', text: 'Notificaciones permitidas · alarmas exactas sin permiso: el aviso puede llegar tarde.' };
    return { level: 'live', text: 'Notificaciones y alarmas exactas permitidas.' };
  });
  readonly updateText = computed(() => {
    const c = this.updates.checked();
    if (this.updates.available()) {
      const run = this.updates.release()?.run;
      return `Hay una versión nueva${run ? ` (build ${run})` : ''}: descárgala e instálala encima; conserva tus datos.`;
    }
    if (!c) return 'Revisando si hay una versión nueva…';
    return c.ok ? 'Es la versión más reciente.' : 'No se pudo revisar si hay una versión nueva (sin conexión).';
  });

  /** Estado del worker, permisos, próximo aviso y versión. */
  async loadStatus(force = false): Promise<void> {
    const [runner, perms, plan] = await Promise.all([
      this.background.status(),
      this.notifications.checkStatus().catch(() => null),
      this.engine.plan(true).catch(() => [] as PlannedNotification[]),
      this.updates.check(force).catch(() => undefined),
    ]);
    this.statusAt.set(Date.now());
    this.runner.set(runner);
    this.perms.set(perms);
    this.nextAlert.set(plan.filter((n) => n.at.getTime() > Date.now() - 60_000).sort((a, b) => a.at.getTime() - b.at.getTime())[0] ?? null);
  }

  async testNotification(): Promise<void> {
    const ok = await this.notifications.sendTest().catch(() => false);
    this.toast(ok ? 'En 5 segundos llega un aviso de prueba (puedes salir de la app para verlo).' : 'Los avisos solo funcionan en el teléfono.');
  }
  query = signal('');
  results = signal<Place[]>([]);

  async ngOnInit(): Promise<void> {
    const s = this.engine.snapshot() ?? (await this.engine.refresh());
    this.threshold.set(s.settings.thresholdMm);
    this.rate.set(s.settings.sprinklerRateMmMin);
    this.area.set(s.settings.lawnAreaM2 ?? null);
    this.lat.set(s.settings.latitude);
    this.lon.set(s.settings.longitude);
    this.placeName.set(s.settings.placeName);
    this.elevation.set(s.elevationM !== null ? Math.round(s.elevationM) : null);
    this.auto.set(s.settings.useGps);
    this.morningTime.set(s.settings.morningTime ?? '06:30');
    this.agromet.set(s.settings.agromet);
    this.dmc.set(s.settings.dmc);
    this.dmcUser.set(s.settings.dmcAuth?.user ?? '');
    this.dmcToken.set(s.settings.dmcAuth?.token ?? '');
    this.agrometKey.set(s.settings.agromet?.apiKey ?? '');
    void this.loadStatus();
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
    const stations = await listDmcStations();
    // La primera vez, la más cercana; después se puede elegir entre las 5 más cercanas.
    const st = this.dmc() ? await this.pickDmc(nearbyDmcStations(stations, this.lat(), this.lon(), 5)) : nearestDmcStation(stations, this.lat(), this.lon());
    if (!st) return this.dmc() ? undefined : this.toast('No se encontraron estaciones de la DMC');
    this.dmc.set({
      code: st.code,
      name: st.name,
      distanceKm: Math.round(st.distanceKm * 10) / 10,
      latitude: st.latitude,
      longitude: st.longitude,
      elevationM: st.elevationM ?? undefined,
    });
    if (st.distanceKm > 25) {
      this.toast(`La estación más cercana está a ${st.distanceKm.toFixed(0)} km: puede no representar la lluvia de tu jardín.`);
    }
    await this.testDmc();
  }

  /** Con usuario y token se revisa qué estaciones responden; sin ellos, se elige de la lista por distancia. */
  changeDmc(): Promise<void> {
    return this.dmcAuth() ? this.connectDmc() : this.findDmc();
  }

  /**
   * Con usuario y token: revisa las estaciones más cercanas, muestra cuáles están enviando datos y, si aún no hay
   * una elegida, toma la más cercana al día (si la más cercana no publica, la siguiente que sí).
   */
  async connectDmc(): Promise<void> {
    const auth = this.dmcAuth();
    if (!auth) return this.toast('Escribe tu usuario (correo) y tu token de la DMC');
    if (this.checking()) return;
    this.checking.set(true);
    this.dmcReport.set(null);
    try {
      const near = stationsToCheck(await listDmcStations(), this.lat(), this.lon());
      this.checks.set(near.map((s) => ({ ...s, health: 'checking' as const, newest: null, readings: 0 })));
      const now = Date.now();
      const done = await checkStations(near, auth, now, (c) => this.checks.update((list) => list?.map((r) => (r.code === c.code ? c : r)) ?? null));
      this.checks.set(done);
      this.checkedAt.set(now);
      const best = bestStation(done);
      if (!best) {
        const said = done.find((c) => c.snippet)?.snippet;
        return this.toast(said ? `Ninguna estación respondió. La DMC dice: ${said}` : 'Ninguna estación cercana está enviando datos ahora.');
      }
      if (!this.dmc()) {
        this.useStation(best);
        const nearest = done[0];
        this.toast(
          best.code === nearest.code
            ? `Estación más cercana: ${best.name} (${this.km(best.distanceKm)} km), al día. Pulsa Guardar cambios.`
            : `${nearest.name} (la más cercana) no está enviando datos: se eligió ${best.name}. Pulsa Guardar cambios.`,
        );
      }
    } finally {
      this.checking.set(false);
    }
  }

  selectStation(c: StationRow): void {
    if (c.health !== 'live' && c.health !== 'late') return;
    this.useStation(c);
    this.toast(`Estación: ${c.name} (${this.km(c.distanceKm)} km). Pulsa Guardar cambios.`);
  }

  private useStation(st: DmcStation & { distanceKm: number }): void {
    this.dmcReport.set(null);
    this.dmc.set({
      code: st.code,
      name: st.name,
      distanceKm: Math.round(st.distanceKm * 10) / 10,
      latitude: st.latitude,
      longitude: st.longitude,
      elevationM: st.elevationM ?? undefined,
    });
  }

  healthText(c: StationRow): string {
    switch (c.health) {
      case 'checking':
        return 'consultando…';
      case 'live':
        return `al día (${shortWhen(c.newest!)})`;
      case 'late':
        return `atrasada (${shortWhen(c.newest!)})`;
      case 'stale':
        return c.newest ? `sin datos desde ${whenOf(c.newest)}` : 'sin datos';
      case 'error':
        return `no responde (${c.error})`;
    }
  }

  /** Lista de estaciones cercanas para elegir (con su distancia al jardín). */
  private async pickDmc<T extends { code: string; name: string; distanceKm: number }>(options: T[]): Promise<T | null> {
    const alert = await this.alerts.create({
      header: 'Estación de la DMC',
      message: 'Elige la estación. La más cercana representa mejor la lluvia de tu jardín.',
      inputs: options.map((o) => ({ type: 'radio' as const, label: `${o.name} · ${this.km(Math.round(o.distanceKm * 10) / 10)} km`, value: o.code, checked: o.code === this.dmc()?.code })),
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Elegir', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role, data } = await alert.onDidDismiss<{ values?: string }>();
    return role === 'confirm' ? (options.find((o) => o.code === data?.values) ?? null) : null;
  }

  /** Prueba la estación y muestra qué entregó (para contrastar con agrometeorologia.cl o reportar un cambio). */
  async testDmc(): Promise<void> {
    const cfg = this.dmc();
    if (!cfg) return;
    this.dmcReport.set({ lines: ['Consultando la estación…'], error: false });
    let r: Awaited<ReturnType<typeof diagnoseDmc>>;
    try {
      const prev = await this.storage.get<DmcStore | null>('dmcStore', null);
      const meta = stationMeta(cfg, this.lat(), this.elevation());
      // Si la estación no tiene datos nuevos, el diagnóstico prueba las dos más cercanas siguientes.
      const others = nearbyDmcStations(await listDmcStations(), this.lat(), this.lon(), 3).filter((s) => s.code !== cfg.code).slice(0, 2);
      r = await diagnoseDmc(cfg.code, prev, toISODate(new Date()), Date.now(), this.dmcAuth(), meta, others);
      await this.storage.set('dmcStore', r.store);
    } catch (e) {
      this.dmcReport.set({ lines: [`Error inesperado al probar la estación: ${e instanceof Error ? e.message : e}`], error: true });
      return;
    }
    const saved = this.engine.snapshot()?.settings.dmc?.code === cfg.code;
    this.dmcReport.set({
      lines: !r.ok
        ? [...r.lines, 'Mientras tanto, la app sigue usando el pronóstico.']
        : saved
          ? r.lines
          : [...r.lines, 'Pulsa Guardar cambios para usar esta estación.'],
      error: !r.ok,
    });
  }

  /** Credenciales escritas en pantalla (aunque aún no se hayan guardado). */
  private dmcAuth(): DmcAuth | undefined {
    const user = this.dmcUser().trim();
    const token = this.dmcToken().trim();
    return user && token ? { user, token } : undefined;
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
      lawnAreaM2: (this.area() ?? 0) > 0 ? clamp(this.area()!, 1, 100_000) : undefined,
      latitude: clamp(this.lat(), -90, 90),
      longitude: clamp(this.lon(), -180, 180),
      placeName: this.placeName(),
      dmc: this.dmc(),
      dmcAuth: this.dmcAuth(),
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
