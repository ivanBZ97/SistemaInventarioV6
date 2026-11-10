import { Component, type OnDestroy, type OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonContent,
  IonFab,
  IonHeader,
  IonIcon,
  IonModal,
  IonRange,
  IonRefresher,
  IonRefresherContent,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  calendarOutline,
  checkmarkOutline,
  downloadOutline,
  flagOutline,
  flowerOutline,
  leafOutline,
  locationOutline,
  optionsOutline,
  rainyOutline,
  settingsOutline,
  thermometerOutline,
  timeOutline,
  trendingUpOutline,
  umbrellaOutline,
  waterOutline,
} from 'ionicons/icons';
import { BackgroundService } from '../../core/background.service';
import type { ISODate } from '../../core/dates';
import { fmt } from '../../core/format';
import { humidityPct, round1 } from '../../core/irrigation-core';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { lawnMessages, lawnMood, lawnScene } from '../../core/lawn-mood';
import { LocationService } from '../../core/location.service';
import type { OverseedArea } from '../../core/models';
import { NotificationService } from '../../core/notification.service';
import { APK_URL } from '../../core/update';
import { UpdateService } from '../../core/update.service';
import { inputChecked, inputNumber } from '../../ui/ion-events';
import { LawnHeroComponent } from '../../ui/lawn-hero/lawn-hero.component';
import { SkyBackdropComponent } from '../../ui/sky-backdrop/sky-backdrop.component';
import { hourOfDay } from '../../ui/sky-backdrop/sky-theme';
import { SnackbarService } from '../../ui/snackbar.service';
import {
  MAX_IRRIGATION_MINUTES,
  WEEK_CHART,
  deficitOf,
  evaluationNow,
  forecastStrip,
  hourDetail,
  humidityOf,
  irrigationOptions,
  irrigationPreview,
  liveRainView,
  longDate,
  monthTiles,
  nextIrrigationView,
  overseedText,
  placeLabel,
  recommendation,
  selectedDayView,
  sensorTag,
  stripDetail,
  thresholdOf,
  todayTiles,
  tomorrowView,
  weekBars,
} from './dashboard.view';

/**
 * Con la app abierta: lluvia de la estación cada 10 min. Publica con ~25–30 min de atraso y cada consulta pesa
 * ~0,5 MB (12 h de lecturas), así que consultar más seguido gasta datos sin ganar mucho.
 */
const LIVE_REFRESH_MS = 10 * 60_000;
/** Cada cuánto se actualizan los textos "hace X min". */
const CLOCK_TICK_MS = 30_000;

/**
 * Pantalla principal: estado del pasto, recomendación de hoy, lluvia medida, próximo riego y balance de la semana.
 * Los textos y cifras salen de funciones puras (dashboard.view.ts); aquí solo hay estado de la pantalla y acciones.
 */
@Component({
  selector: 'app-dashboard',
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButton,
    IonIcon,
    IonContent,
    IonFab,
    IonToggle,
    IonRefresher,
    IonRefresherContent,
    IonModal,
    IonRange,
    LawnHeroComponent,
    SkyBackdropComponent,
  ],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.scss',
})
export class DashboardPage implements OnInit, OnDestroy {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);
  private location = inject(LocationService);
  private alerts = inject(AlertController);
  private snackbar = inject(SnackbarService);
  private router = inject(Router);

  readonly updates = inject(UpdateService);
  readonly snap = this.engine.snapshot;
  readonly hero = viewChild(LawnHeroComponent);
  readonly apkUrl = APK_URL;
  readonly fmt = fmt;
  readonly number = inputNumber;
  readonly chartH = WEEK_CHART.height;
  readonly maxMinutes = MAX_IRRIGATION_MINUTES;

  /** Reloj para los textos "hace X min". */
  readonly now = signal(Date.now());
  /** Hora local del día: el cielo cambia con ella. */
  readonly hour = computed(() => hourOfDay(this.now()));
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor() {
    addIcons({
      calendarOutline,
      checkmarkOutline,
      downloadOutline,
      flagOutline,
      flowerOutline,
      leafOutline,
      locationOutline,
      optionsOutline,
      rainyOutline,
      settingsOutline,
      thermometerOutline,
      timeOutline,
      trendingUpOutline,
      umbrellaOutline,
      waterOutline,
    });
  }

  // ───────────── Tarjeta principal ─────────────
  readonly deficit = computed(() => deficitOf(this.snap()));
  readonly humidity = computed(() => Math.round(this.snap()?.evaluation?.humidityPct ?? 100));
  readonly threshold = computed(() => thresholdOf(this.snap()));
  /** Marcador "aquí se riega": humedad útil equivalente al umbral. */
  readonly thresholdPct = computed(() => humidityPct(this.threshold()));
  readonly level = computed(() => (this.humidity() >= 60 ? 'good' : this.humidity() >= 40 ? 'warn' : 'bad'));
  readonly placeLabel = computed(() => placeLabel(this.snap()));
  readonly sensorTag = computed(() => sensorTag(this.snap(), this.now()));

  // El pasto ilustrado: ánimo, clima de fondo y lo que dice al tocarlo.
  private readonly evNow = computed(() => evaluationNow(this.snap()?.evaluation));
  readonly mood = computed(() => lawnMood(this.humidity(), this.snap()?.evaluation?.status ?? 'ok'));
  readonly scene = computed(() => {
    const ev = this.evNow();
    return ev ? lawnScene(ev) : 'sun';
  });
  readonly messages = computed(() => lawnMessages(this.mood(), this.scene(), this.evNow()));

  // ───────────── Recomendación ─────────────
  readonly status = computed(() => recommendation(this.snap()));
  /** Hoy se pospuso el riego ("Posponer a mañana"). */
  readonly snoozed = computed(() => {
    const s = this.snap();
    return !!s && s.state.snoozedDate === s.today;
  });

  // ───────────── Lluvia en tu sector ─────────────
  readonly selectedHour = signal<number | null>(null);
  readonly live = computed(() => liveRainView(this.snap(), this.now()));
  readonly hourDetail = computed(() => hourDetail(this.live(), this.selectedHour()));

  // ───────────── Próximo riego ─────────────
  readonly selectedForecast = signal<number | null>(null);
  readonly next = computed(() => nextIrrigationView(this.snap()));
  readonly strip = computed(() => forecastStrip(this.snap()));
  readonly stripDetail = computed(() => {
    const i = this.selectedForecast();
    return i === null ? null : stripDetail(this.strip()[i], this.threshold());
  });

  // ───────────── Hoy en el jardín ─────────────
  readonly tiles = computed(() => todayTiles(this.snap()?.evaluation));
  readonly tomorrow = computed(() => tomorrowView(this.snap()?.evaluation));
  readonly month = computed(() => monthTiles(this.snap()?.month));

  // ───────────── Modo Resiembra ─────────────
  readonly overseedOn = computed(() => (this.snap()?.overseedDaysLeft ?? 0) > 0);
  readonly overseedArea = computed<OverseedArea>(() => this.snap()?.state.overseedArea ?? 'patches');
  readonly overseedText = computed(() => overseedText(this.snap()?.overseedDaysLeft ?? 0, this.overseedArea()));

  // ───────────── Gráfico de 7 días ─────────────
  readonly selected = signal<number | null>(null);
  readonly bars = computed(() => weekBars(this.snap()?.chart ?? []));
  /** Día elegido en el gráfico (por defecto, hoy: el último). */
  readonly selectedIndex = computed(() => this.selected() ?? this.bars().length - 1);
  readonly selectedDay = computed(() => {
    const bar = this.bars()[this.selectedIndex()];
    return bar ? selectedDayView(bar.day, this.snap()) : null;
  });

  // ───────────── Registrar riego (hoja inferior) ─────────────
  readonly irrigateOpen = signal(false);
  readonly irrigateMinutes = signal(10);
  /** true: se registra "lo recomendado", que repone todo el déficit (no los minutos redondeados). */
  readonly irrigateFull = signal(false);
  /** Minutos recomendados hoy (los que reponen todo el déficit); null si no hay déficit que reponer. */
  readonly recommendedMinutes = computed(() => {
    const minutes = this.snap()?.evaluation?.minutes ?? 0;
    return minutes > 0 ? minutes : null;
  });
  readonly irrigateOptions = computed(() => irrigationOptions(this.recommendedMinutes()));
  readonly irrigatePreview = computed(() => irrigationPreview(this.snap(), this.irrigateMinutes(), this.irrigateFull()));

  // ───────────── Ajuste manual (hoja inferior) ─────────────
  readonly adjustOpen = signal(false);
  readonly adjustValue = signal(0);
  readonly previewMood = computed(() => {
    const mm = this.adjustValue();
    return lawnMood(humidityPct(mm), mm >= this.threshold() ? 'irrigate' : 'ok');
  });
  readonly previewMessages = computed(() => [`${humidityOf(this.adjustValue())}% de humedad útil`]);

  // ───────────── Ciclo de vida ─────────────

  async ngOnInit(): Promise<void> {
    this.timers.push(setInterval(() => this.now.set(Date.now()), CLOCK_TICK_MS));
    this.timers.push(setInterval(() => void this.liveRefresh(), LIVE_REFRESH_MS));
    const snap = await this.engine.ready();
    if (!snap.settings.locationSet) await this.askLocation();
  }

  ngOnDestroy(): void {
    this.timers.forEach(clearInterval);
  }

  /** Lluvia nueva de la estación: si cambia la decisión, se reprograman los avisos. */
  private async liveRefresh(): Promise<void> {
    if (document.visibilityState !== 'visible') return;
    try {
      const before = this.snap()?.evaluation;
      const after = (await this.engine.refresh()).evaluation;
      this.now.set(Date.now());
      if (before?.status !== after?.status || before?.rainMeasuredMm !== after?.rainMeasuredMm) await this.syncAlerts();
    } catch (e) {
      console.warn('No se pudo refrescar la lluvia de la estación', e);
    }
  }

  /** Deslizar para actualizar: vuelve a pedir el pronóstico, la estación y el sensor. */
  async refresh(ev?: Event): Promise<void> {
    try {
      await this.engine.refresh(true);
      await this.syncAlerts();
    } finally {
      this.now.set(Date.now());
      void (ev?.target as HTMLIonRefresherElement | undefined)?.complete();
    }
  }

  /** Tras cualquier cambio en el balance: los avisos y el worker deben quedar al día. */
  private async syncAlerts(): Promise<void> {
    await this.notifications.reschedule();
    await this.background.sync();
  }

  private async afterChange(message: string): Promise<void> {
    await this.syncAlerts();
    this.snackbar.show(message);
  }

  // ───────────── Registrar riego ─────────────

  openIrrigate(): void {
    const recommended = this.recommendedMinutes();
    this.irrigateMinutes.set(Math.min(MAX_IRRIGATION_MINUTES, recommended ?? 10));
    this.irrigateFull.set(recommended !== null);
    this.irrigateOpen.set(true);
  }

  pickIrrigate(minutes: number, full: boolean): void {
    if (!Number.isFinite(minutes)) return;
    this.irrigateMinutes.set(Math.min(MAX_IRRIGATION_MINUTES, minutes));
    this.irrigateFull.set(full);
  }

  /** Riega: la ilustración muestra el aspersor mientras se guarda el registro; se puede deshacer. */
  async applyIrrigate(): Promise<void> {
    const full = this.irrigateFull();
    const minutes = full ? (this.recommendedMinutes() ?? this.irrigateMinutes()) : this.irrigateMinutes();
    this.irrigateOpen.set(false);
    this.hero()?.water();
    const left = await this.engine.registerIrrigation('manual', full ? undefined : minutes);
    await this.syncAlerts();
    this.snackbar.show(
      `Riego de ${minutes} min registrado. ${left > 0 ? `Quedan ${fmt(left)} mm de déficit.` : 'El suelo quedó húmedo.'}`,
      {
        duration: 6000,
        action: { text: 'Deshacer', run: () => void this.undoIrrigation() },
      },
    );
  }

  private async undoIrrigation(): Promise<void> {
    if (await this.engine.undoIrrigation()) await this.afterChange('Riego deshecho');
  }

  /** Hoy no se puede regar: se silencia el aviso de hoy y se recalcula para mañana. */
  async snooze(): Promise<void> {
    await this.engine.snoozeToday();
    await this.afterChange('Riego pospuesto para mañana');
  }

  // ───────────── Correcciones manuales ─────────────

  /** Corrige la lluvia de un día pasado con lo realmente medido (INIA, pluviómetro). */
  async correctRain(date: ISODate): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Corregir lluvia',
      subHeader: longDate(date),
      message: 'Ingresa los milímetros que realmente cayeron, por ejemplo los de agrometeorologia.cl o tu pluviómetro.',
      inputs: [
        { name: 'mm', type: 'number', min: 0, max: 200, placeholder: 'mm de lluvia', value: this.snap()?.rainOverrides[date] ?? '' },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Guardar', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role, data } = await alert.onDidDismiss<{ values?: { mm?: string | number } }>();
    if (role !== 'confirm') return;
    const mm = parseFloat(String(data?.values?.mm ?? '').replace(',', '.'));
    if (!Number.isFinite(mm) || mm < 0) return this.snackbar.show('Ingresa los milímetros como un número (0 o más).');
    await this.engine.correctRain(date, mm);
    await this.afterChange(`Lluvia corregida a ${fmt(mm)} mm. Balance recalculado.`);
  }

  openAdjust(): void {
    this.adjustValue.set(round1(this.deficit()));
    this.adjustOpen.set(true);
  }

  async applyAdjust(): Promise<void> {
    const mm = this.adjustValue();
    this.adjustOpen.set(false);
    await this.engine.setDeficit(mm);
    await this.afterChange(`Déficit ajustado a ${fmt(mm)} mm`);
  }

  // ───────────── Modo Resiembra ─────────────

  async toggleOverseed(ev: Event): Promise<void> {
    if (!inputChecked(ev)) {
      await this.engine.setOverseed(false);
      return this.afterChange('Modo Resiembra desactivado');
    }
    const area = await this.askSeedArea();
    if (!area) {
      (ev.target as HTMLIonToggleElement).checked = false;
      return;
    }
    await this.engine.setOverseed(true, area);
    await this.afterChange(area === 'full' ? 'Resiembra de todo el jardín por 10 días' : 'Resiembra por sectores por 10 días');
  }

  /** Dónde se sembró: cambia cómo se riega mientras dura el modo Resiembra. */
  private async askSeedArea(): Promise<OverseedArea | null> {
    const alert = await this.alerts.create({
      header: 'Modo Resiembra',
      message:
        '¿Dónde sembraste? Todo el jardín: riego corto cada mañana para todo el pasto, y otro a las 13:00 si hace calor. ' +
        'Por sectores: el pasto se riega normal y tú rocías lo sembrado.',
      inputs: [
        { type: 'radio', label: 'Todo el jardín', value: 'full' },
        { type: 'radio', label: 'Por sectores (parches)', value: 'patches', checked: true },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Activar', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role, data } = await alert.onDidDismiss<{ values?: OverseedArea }>();
    return role === 'confirm' ? (data?.values ?? 'patches') : null;
  }

  async setOverseedArea(area: OverseedArea): Promise<void> {
    if (area === this.overseedArea()) return;
    await this.engine.setOverseedArea(area);
    await this.afterChange(area === 'full' ? 'Resiembra: todo el jardín' : 'Resiembra: por sectores');
  }

  // ───────────── Ubicación (primer arranque) ─────────────

  /** Sin esto el clima sería el de Santiago (coordenadas por defecto). */
  private async askLocation(): Promise<void> {
    const alert = await this.alerts.create({
      header: '¿Dónde está tu jardín?',
      message:
        'El riego se calcula con el clima de tu ubicación. Por ahora se usa Santiago de Chile. Solo se usa una ubicación aproximada (~1 km).',
      backdropDismiss: false,
      buttons: [
        { text: 'Mantener Santiago', role: 'keep' },
        { text: 'Buscar ciudad', role: 'search' },
        { text: 'Usar ubicación', role: 'gps' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role === 'search') await this.router.navigateByUrl('/settings');
    else if (role === 'gps') await this.useGps();
    else await this.engine.saveSettings({ locationSet: true });
  }

  private async useGps(): Promise<void> {
    const fix = await this.location.detect();
    if (!fix) return this.snackbar.show('No se pudo obtener la ubicación. Búscala por ciudad en Ajustes.');
    await this.engine.saveSettings({
      latitude: fix.latitude,
      longitude: fix.longitude,
      placeName: fix.placeName ?? undefined,
      useGps: true,
      locationSet: true,
    });
    await this.syncAlerts();
  }
}
