import { Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
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
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  calendarOutline,
  flagOutline,
  flowerOutline,
  leafOutline,
  locationOutline,
  optionsOutline,
  rainyOutline,
  settingsOutline,
  thermometerOutline,
  trendingUpOutline,
  umbrellaOutline,
  waterOutline,
} from 'ionicons/icons';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { NotificationService } from '../../core/notification.service';
import { BackgroundService } from '../../core/background.service';
import { LocationService } from '../../core/location.service';
import { humidityPct, longDateEs, round1, weekdayEs } from '../../core/irrigation-core';
import { lawnMessages, lawnMood, lawnScene } from '../../core/lawn-mood';
import { LawnHeroComponent } from '../../ui/lawn-hero/lawn-hero.component';

const SLOT = 300 / 7;

/** Número con coma decimal chilena. */
export function fmt(v: number, digits = 1): string {
  return v.toLocaleString('es-CL', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    RouterLink, IonHeader, IonToolbar, IonButton, IonIcon, IonContent, IonFab, IonToggle, IonRefresher,
    IonRefresherContent, IonModal, IonRange, LawnHeroComponent,
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
  readonly hero = viewChild(LawnHeroComponent);
  readonly fmt = fmt;

  constructor() {
    addIcons({
      settingsOutline, waterOutline, locationOutline, leafOutline, umbrellaOutline, thermometerOutline,
      rainyOutline, flagOutline, calendarOutline, trendingUpOutline, flowerOutline, optionsOutline,
    });
  }

  // ───────────── Tarjeta principal ─────────────
  readonly deficit = computed(() => this.snap()?.evaluation?.deficitMm ?? this.snap()?.state.deficitMm ?? 0);
  readonly humidity = computed(() => Math.round(this.snap()?.evaluation?.humidityPct ?? 100));
  readonly mood = computed(() => lawnMood(this.humidity(), this.snap()?.evaluation?.status ?? 'ok'));
  readonly scene = computed(() => {
    const ev = this.snap()?.evaluation;
    return ev ? lawnScene(ev) : 'sun';
  });
  readonly messages = computed(() => lawnMessages(this.mood(), this.scene(), this.snap()?.evaluation ?? null));
  readonly level = computed(() => (this.humidity() >= 60 ? 'good' : this.humidity() >= 40 ? 'warn' : 'bad'));
  /** Marcador "aquí se riega": humedad útil equivalente al umbral. */
  readonly thresholdPct = computed(() => humidityPct(this.snap()?.settings.thresholdMm ?? 8));

  readonly placeLabel = computed(() => {
    const s = this.snap();
    if (!s) return '';
    const name = (s.settings.placeName ?? `${s.settings.latitude}, ${s.settings.longitude}`).split(',')[0];
    return s.elevationM != null ? `${name} · ${Math.round(s.elevationM)} m` : name;
  });

  // ───────────── Recomendación ─────────────
  readonly status = computed(() => {
    const ev = this.snap()?.evaluation;
    const thr = this.snap()?.settings.thresholdMm ?? 8;
    if (!ev) return { cls: 'neutral', icon: 'umbrella-outline', title: 'Sin datos del clima', detail: this.snap()?.error ?? 'Cargando…' };
    if (ev.status === 'irrigate') {
      const wind = ev.windWarning ? ` Viento de ${Math.round(ev.windMaxKmh)} km/h: riega temprano.` : '';
      return {
        cls: 'water', icon: 'water-outline',
        title: `Riega ${ev.minutes} minutos hoy`,
        detail: `Entre 06:30 y 08:30. Déficit acumulado de ${fmt(ev.deficitMm)} mm.${wind}`,
      };
    }
    if (ev.status === 'paused_rain')
      return {
        cls: 'neutral', icon: 'umbrella-outline', title: 'Riego en pausa por lluvia',
        detail: `${Math.round(ev.rainProbPct)}% de probabilidad · ${fmt(ev.rainForecastMm)} mm previstos hoy.`,
      };
    return {
      cls: 'ok', icon: 'leaf-outline', title: 'No es necesario regar',
      detail: `El suelo tiene humedad suficiente. Se riega al llegar a ${fmt(thr)} mm de déficit.`,
    };
  });

  // ───────────── Próximo riego (pronóstico) ─────────────
  readonly selectedForecast = signal<number | null>(null);
  readonly next = computed(() => {
    const n = this.snap()?.next;
    if (!n) return null;
    const when =
      n.daysAhead === 0 ? 'Hoy' : n.daysAhead === 1 ? 'Mañana' : cap(longDateEs(n.date));
    const lead =
      n.daysAhead === 0 ? 'Entre 06:30 y 08:30' : n.daysAhead === 1 ? 'Mañana entre 06:30 y 08:30' : `En ${n.daysAhead} días, entre 06:30 y 08:30`;
    const notes: string[] = [];
    if (n.beyondForecast) notes.push('Estimado más allá del pronóstico disponible; se irá ajustando.');
    if (n.delayedByRain) notes.push(`La lluvia prevista del ${weekdayEs(n.delayedByRain)} retrasa el riego.`);
    return { when, lead, minutes: n.minutes, deficit: fmt(n.deficitMm), notes, beyond: n.beyondForecast };
  });
  /** Franja de días: barra = déficit relativo al umbral. */
  readonly strip = computed(() => {
    const n = this.snap()?.next;
    const thr = this.snap()?.settings.thresholdMm ?? 8;
    if (!n) return [];
    return n.timeline.slice(0, 7).map((d, i) => ({
      ...d,
      label: i === 0 ? 'Hoy' : cap(weekdayEs(d.date).slice(0, 3)),
      dayNum: Number(d.date.slice(8)),
      fill: Math.min(100, (d.deficitMm / thr) * 100),
      rainy: d.rainMm >= 1 || d.rainProbPct >= 50,
    }));
  });
  readonly stripDetail = computed(() => {
    const days = this.strip();
    const i = this.selectedForecast();
    if (i === null || !days[i]) return null;
    const d = days[i];
    const what = d.irrigate ? 'Día de riego' : d.rainBlock ? 'Riego bloqueado por lluvia' : d.deficitMm >= (this.snap()?.settings.thresholdMm ?? 8) ? 'Pospuesto' : 'Sin riego';
    return `${cap(longDateEs(d.date))} · ${what} · déficit ${fmt(d.deficitMm)} mm · lluvia ${fmt(d.rainMm)} mm (${Math.round(d.rainProbPct)}%)`;
  });

  // ───────────── Mosaicos de hoy ─────────────
  readonly tiles = computed(() => {
    const ev = this.snap()?.evaluation;
    if (!ev) return [];
    return [
      { icon: 'thermometer-outline', label: 'Temp. máxima', value: `${Math.round(ev.tempMaxC)}°`, note: 'Hoy' },
      {
        icon: 'rainy-outline', label: 'Lluvia', value: `${fmt(ev.rainForecastMm)} mm`,
        note: ev.effectiveRainTodayMm > 0 ? `${Math.round(ev.rainProbPct)}% · ${fmt(ev.effectiveRainTodayMm)} mm útiles` : `${Math.round(ev.rainProbPct)}% de prob.`,
      },
      {
        icon: 'flag-outline', label: 'Viento máx.', value: `${Math.round(ev.windMaxKmh)} km/h`,
        note: ev.windWarning ? 'Fuerte: riega temprano' : 'Normal', warn: ev.windWarning,
      },
      { icon: 'leaf-outline', label: 'Consumo del pasto', value: `${fmt(ev.etcTodayMm)} mm`, note: `ETc · Kc ${fmt(ev.kc, 2)}` },
    ];
  });

  readonly tomorrow = computed(() => {
    const ev = this.snap()?.evaluation;
    if (!ev) return null;
    return {
      value: `${fmt(ev.projectedDeficitMm)} mm`,
      note: `Hoy consume ${fmt(ev.etcTodayMm)} mm y la lluvia aporta ${fmt(ev.effectiveRainTodayMm)} mm`,
    };
  });

  readonly overseedOn = computed(() => (this.snap()?.overseedDaysLeft ?? 0) > 0);

  // ───────────── Gráfico de 7 días ─────────────
  readonly chartH = 128;
  readonly selected = signal<number | null>(null);
  readonly bars = computed(() => {
    const days = this.snap()?.chart ?? [];
    const max = Math.max(4, ...days.map((d) => Math.max(d.etcMm, d.replenishedMm)));
    const h = (v: number) => Math.max(v > 0 ? 3 : 0, (v / max) * (this.chartH - 12));
    return days.map((d, i) => {
      const x = 10 + i * SLOT;
      const wd = new Date(`${d.date}T12:00:00`).toLocaleDateString('es-CL', { weekday: 'short' }).replace('.', '');
      return {
        day: d,
        label: cap(wd.slice(0, 3)),
        slotX: x,
        slot: SLOT,
        etc: { x: x + SLOT / 2 - 11, y: this.chartH - h(d.etcMm), h: h(d.etcMm) },
        water: { x: x + SLOT / 2 + 1, y: this.chartH - h(d.replenishedMm), h: h(d.replenishedMm) },
        w: 10,
        lx: x + SLOT / 2,
      };
    });
  });
  readonly selectedDay = computed(() => {
    const bars = this.bars();
    if (!bars.length) return null;
    const d = bars[this.selected() ?? bars.length - 1].day;
    return {
      title: cap(new Date(`${d.date}T12:00:00`).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' })) +
        (d.estimated ? ' · estimado' : ''),
      loss: fmt(d.etcMm),
      gain: fmt(d.replenishedMm),
      detail: `Lluvia ${fmt(d.rainMm)} mm · Riego ${fmt(d.irrigationMm)} mm`,
    };
  });

  // ───────────── Ajuste manual (hoja inferior) ─────────────
  readonly adjustOpen = signal(false);
  readonly adjustValue = signal(0);
  readonly previewMood = computed(() => {
    const mm = this.adjustValue();
    const thr = this.snap()?.settings.thresholdMm ?? 8;
    return lawnMood(humidityPct(mm), mm >= thr ? 'irrigate' : 'ok');
  });
  readonly previewMessages = computed(() => [`${Math.round(humidityPct(this.adjustValue()))}% de humedad útil`]);

  async ngOnInit(): Promise<void> {
    const snap = this.snap() ?? (await this.engine.refresh());
    if (!snap.settings.locationSet) await this.askLocation();
  }

  async refresh(ev?: CustomEvent): Promise<void> {
    await this.engine.refresh(true);
    await this.notifications.reschedule();
    await this.background.sync();
    (ev?.target as HTMLIonRefresherElement | undefined)?.complete();
  }

  private async snackbar(message: string): Promise<void> {
    (await this.toasts.create({ message, duration: 2500, position: 'bottom', cssClass: 'md-snackbar' })).present();
  }

  private async afterChange(msg: string): Promise<void> {
    await this.notifications.reschedule();
    await this.background.sync();
    await this.snackbar(msg);
  }

  /** Riega: la ilustración muestra el aspersor mientras se guarda el registro. */
  async registerIrrigation(): Promise<void> {
    this.hero()?.water();
    await this.engine.registerIrrigation('manual');
    await this.afterChange('Riego registrado. El déficit volvió a 0 mm.');
  }

  openAdjust(): void {
    this.adjustValue.set(round1(this.snap()?.state.deficitMm ?? 0));
    this.adjustOpen.set(true);
  }

  async applyAdjust(): Promise<void> {
    const mm = this.adjustValue();
    this.adjustOpen.set(false);
    await this.engine.setDeficit(mm);
    await this.afterChange(`Déficit ajustado a ${fmt(mm)} mm`);
  }

  async toggleOverseed(ev: CustomEvent): Promise<void> {
    await this.engine.setOverseed(!!ev.detail.checked);
    await this.afterChange(ev.detail.checked ? 'Modo Resiembra activado por 10 días' : 'Modo Resiembra desactivado');
  }

  // ───────────── Ubicación (primer arranque) ─────────────
  /** Sin esto el clima sería el de Santiago (coordenadas por defecto). */
  private async askLocation(): Promise<void> {
    const alert = await this.alerts.create({
      header: '¿Dónde está tu jardín?',
      message:
        'El riego se calcula con el clima de tu ubicación. Por ahora se usa Santiago de Chile. ' +
        'Solo se usa una ubicación aproximada (~1 km).',
      backdropDismiss: false,
      buttons: [
        { text: 'Mantener Santiago', role: 'cancel', handler: () => { this.engine.saveSettings({ locationSet: true }); } },
        { text: 'Buscar ciudad', handler: () => { this.router.navigateByUrl('/settings'); return true; } },
        { text: 'Usar ubicación', handler: () => { this.useGps(); return true; } },
      ],
    });
    await alert.present();
  }

  private async useGps(): Promise<void> {
    const fix = await this.location.detect();
    if (!fix) return this.snackbar('No se pudo obtener la ubicación. Búscala por ciudad en Ajustes.');
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
}
