import { Component, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
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
  checkmarkOutline,
  downloadOutline,
  timeOutline,
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
import { humidityPct, litersFor, longDateEs, round1, toISODate, weekdayEs } from '../../core/irrigation-core';
import { LIVE_FRESH_MS } from '../../core/dmc';
import type { OverseedArea } from '../../core/models';
import { lawnMessages, lawnMood, lawnScene } from '../../core/lawn-mood';
import { LawnHeroComponent } from '../../ui/lawn-hero/lawn-hero.component';
import { UpdateService } from '../../core/update.service';
import { APK_URL } from '../../core/update';

const SLOT = 300 / 7;

/** Número con coma decimal chilena. */
export function fmt(v: number, digits = 1): string {
  return v.toLocaleString('es-CL', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** "18:45" */
const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Con la app abierta: lluvia de la estación cada 5 min (publica cada minuto, con ~25 min de atraso). */
const LIVE_REFRESH_MS = 5 * 60_000;

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
export class DashboardPage implements OnInit, OnDestroy {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);
  private location = inject(LocationService);
  private alerts = inject(AlertController);
  private toasts = inject(ToastController);
  private router = inject(Router);

  readonly snap = this.engine.snapshot;
  readonly updates = inject(UpdateService);
  readonly apkUrl = APK_URL;
  readonly hero = viewChild(LawnHeroComponent);
  readonly fmt = fmt;

  constructor() {
    addIcons({
      settingsOutline, waterOutline, locationOutline, leafOutline, umbrellaOutline, thermometerOutline,
      rainyOutline, flagOutline, calendarOutline, trendingUpOutline, flowerOutline, optionsOutline, checkmarkOutline, downloadOutline, timeOutline,
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
  /** Umbral de hoy: el de Ajustes, o el de siembra (2 mm) si hay Resiembra de todo el jardín. */
  readonly threshold = computed(() => this.snap()?.evaluation?.thresholdMm ?? this.snap()?.settings.thresholdMm ?? 8);
  /** Marcador "aquí se riega": humedad útil equivalente al umbral. */
  readonly thresholdPct = computed(() => humidityPct(this.threshold()));

  readonly placeLabel = computed(() => {
    const s = this.snap();
    if (!s) return '';
    const name = (s.settings.placeName ?? `${s.settings.latitude}, ${s.settings.longitude}`).split(',')[0];
    return s.elevationM != null ? `${name} · ${Math.round(s.elevationM)} m` : name;
  });

  // ───────────── Recomendación ─────────────
  /** Hoy se pospuso el riego ("Posponer a mañana"). */
  readonly snoozed = computed(() => !!this.snap() && this.snap()!.state.snoozedDate === this.snap()!.today);
  readonly status = computed(() => {
    const ev = this.snap()?.evaluation;
    const thr = this.threshold();
    if (!ev) return { cls: 'neutral', icon: 'umbrella-outline', title: 'Sin datos del clima', detail: this.snap()?.error ?? 'Cargando…' };
    if (ev.status === 'irrigate' && this.snoozed())
      return {
        cls: 'neutral', icon: 'time-outline', title: 'Riego pospuesto para mañana',
        detail: `Hoy no se riega. Mañana se recalcula con el déficit que haya (hoy ${fmt(ev.deficitMm)} mm).`,
      };
    const patches = ev.overseed === 'patches' ? ' Rocía también los parches sembrados unos 30 s.' : '';
    if (ev.status === 'irrigate') {
      const wind = ev.windWarning ? ` Viento de ${Math.round(ev.windMaxKmh)} km/h: riega temprano.` : '';
      if (ev.overseed === 'full')
        return {
          cls: 'water', icon: 'water-outline',
          title: `Riego de siembra: ${ev.minutes} min`,
          detail: `Riego corto en todo el jardín para mantener húmeda la semilla. Si hace calor, repite a las 13:00.${wind}`,
        };
      const liters = litersFor(ev.deficitMm, this.snap()?.settings.lawnAreaM2);
      return {
        cls: 'water', icon: 'water-outline',
        title: `Riega ${ev.minutes} minutos hoy`,
        detail: `Entre 06:30 y 08:30. Déficit acumulado de ${fmt(ev.deficitMm)} mm${liters ? ` (≈ ${fmt(liters, 0)} L)` : ''}.${wind}${patches}`,
      };
    }
    const station = this.snap()?.backup?.name ?? this.snap()?.settings.dmc?.name ?? 'la estación';
    if (ev.status === 'paused_rain' && ev.rainBlockReason === 'tomorrow')
      return {
        cls: 'neutral', icon: 'umbrella-outline', title: 'Espera la lluvia de mañana',
        detail: `Mañana se esperan ${fmt(ev.rainTomorrowMm)} mm (${Math.round(ev.rainTomorrowProbPct)} %): reponen el déficit de ${fmt(ev.deficitMm)} mm sin regar hoy. Si no llueve, se riega mañana.`,
      };
    if (ev.status === 'paused_rain' && ev.rainBlockReason === 'raining')
      return {
        cls: 'neutral', icon: 'rainy-outline', title: 'Está lloviendo en tu sector',
        detail: `${fmt(ev.rainMeasuredMm ?? 0)} mm hoy en ${station}. Espera a que pare: la app descuenta lo que cae.`,
      };
    if (ev.status === 'paused_rain' && ev.rainBlockReason === 'measured')
      return {
        cls: 'neutral', icon: 'rainy-outline', title: 'Riego en pausa por lluvia',
        detail: `Hoy ya llovieron ${fmt(ev.rainMeasuredMm ?? 0)} mm en ${station}.`,
      };
    if (ev.status === 'paused_rain')
      return {
        cls: 'neutral', icon: 'umbrella-outline', title: 'Riego en pausa por lluvia',
        detail: `${Math.round(ev.rainProbPct)}% de probabilidad · ${fmt(ev.rainForecastMm)} mm previstos hoy.`,
      };
    const fell = ev.rainMeasuredMm ?? 0;
    return {
      cls: 'ok', icon: 'leaf-outline', title: 'No es necesario regar',
      detail: (fell > 0
        ? `Hoy ya llovieron ${fmt(fell)} mm en ${station}. Se riega al llegar a ${fmt(thr)} mm de déficit.`
        : `El suelo tiene humedad suficiente. Se riega al llegar a ${fmt(thr)} mm de déficit.`) + patches,
    };
  });

  // ───────────── Lluvia en tu sector (casi en tiempo real) ─────────────
  /** Reloj para "hace X min". */
  readonly now = signal(Date.now());
  readonly selectedHour = signal<number | null>(null);
  readonly live = computed(() => {
    const s = this.snap();
    const r = s?.liveRain;
    if (!s?.settings.dmc || !r) return null;
    const now = this.now();
    const ago = Math.max(0, Math.round((now - r.lastAtMs) / 60_000));
    const midnight = new Date(`${s.today}T00:00:00`).getTime();
    const hasToday = r.sinceMs !== null;
    const max = Math.max(1, ...r.hourly);
    const hourNow = new Date(now).getHours();
    const ev = s.evaluation;
    /** "las 18:45", "ayer a las 16:00" o "el sábado 24/10 a las 16:00" */
    const when = (t: number) => {
      if (t >= midnight) return `las ${clock(t)}`;
      if (t >= midnight - 86_400_000) return `ayer a las ${clock(t)}`;
      const d = new Date(t);
      return `el ${weekdayEs(toISODate(d))} ${d.getDate()}/${d.getMonth() + 1} a las ${clock(t)}`;
    };
    const chip = r.rainingNow ? 'raining' : now - r.lastAtMs <= LIVE_FRESH_MS ? 'live' : 'stale';
    // Sin datos nuevos: se explica qué pasó en la última consulta (la estación no publica, error, sin red).
    const st = s.station;
    const why = !st
      ? null
      : st.ok
        ? 'la DMC no tiene lecturas más nuevas de la estación'
        : st.error === 'sin lecturas'
          ? 'la DMC no entregó lecturas de la estación'
          : st.error === 'sin conexión'
            ? 'no se pudo conectar con la DMC'
            : st.error === 'sin campo de lluvia'
              ? 'la respuesta no trae el dato de lluvia'
              : `la DMC respondió con error (${st.error})`;
    return {
      station: s.backup?.name ?? s.settings.dmc.name,
      // La elegida no publica: se muestra la de respaldo y se explica por qué.
      backupNote: s.backup
        ? `${s.settings.dmc.name} no está publicando: se usa ${s.backup.name} (${fmt(s.backup.distanceKm)} km), la siguiente más cercana.`
        : null,
      mm: fmt(hasToday ? r.mm : 0),
      hasToday,
      anyRain: hasToday && r.mm > 0,
      until: when(r.lastAtMs),
      ago: ago < 60 ? `hace ${ago} min` : ago < 24 * 60 ? `hace ${Math.floor(ago / 60)} h ${ago % 60} min` : `hace ${Math.floor(ago / 1440)} ${ago < 2880 ? 'día' : 'días'}`,
      chip,
      check:
        chip === 'stale' && st && why
          ? `Última consulta ${st.attemptAt >= midnight ? `a las ${clock(st.attemptAt)}` : when(st.attemptAt)}: ${why}. Mientras tanto se usa el pronóstico.`
          : null,
      since: r.sinceMs !== null && r.sinceMs > midnight + 10 * 60_000 ? clock(r.sinceMs) : null,
      // Con datos viejos, "la última hora" sería la de ayer: no se muestra.
      lastHour: chip === 'stale' ? null : fmt(r.lastHourMm),
      forecast: ev ? `${fmt(ev.rainForecastMm)} mm (${Math.round(ev.rainProbPct)} %)` : null,
      bars: r.hourly.map((mm, h) => ({ h, mm, pct: mm > 0 ? Math.max(8, (mm / max) * 100) : 0, future: h > hourNow })),
    };
  });
  readonly hourDetail = computed(() => {
    const h = this.selectedHour();
    const l = this.live();
    if (h === null || !l) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(h)}:00–${pad((h + 1) % 24)}:00 · ${fmt(l.bars[h].mm)} mm`;
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
    if (n.delayedByRain === this.snap()?.today) notes.push('La lluvia de hoy retrasa el riego.');
    else if (n.delayedByRain) notes.push(`La lluvia prevista del ${weekdayEs(n.delayedByRain)} retrasa el riego.`);
    return { when, lead, minutes: n.minutes, deficit: fmt(n.deficitMm), notes, beyond: n.beyondForecast };
  });
  /** Franja de días: barra = déficit relativo al umbral. */
  readonly strip = computed(() => {
    const n = this.snap()?.next;
    const thr = this.threshold();
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
    const what = d.irrigate
      ? 'Día de riego'
      : d.waitForRain
        ? 'Sin riego: llueve al día siguiente'
        : d.rainBlock
          ? 'Riego bloqueado por lluvia'
          : d.deficitMm >= this.threshold()
            ? 'Pospuesto'
            : 'Sin riego';
    return `${cap(longDateEs(d.date))} · ${what} · déficit ${fmt(d.deficitMm)} mm · lluvia ${fmt(d.rainMm)} mm (${Math.round(d.rainProbPct)}%)`;
  });

  // ───────────── Mosaicos de hoy ─────────────
  readonly tiles = computed(() => {
    const ev = this.snap()?.evaluation;
    if (!ev) return [];
    return [
      { icon: 'thermometer-outline', label: 'Temp. máxima', value: `${Math.round(ev.tempMaxC)}°`, note: 'Hoy' },
      { icon: 'rainy-outline', label: 'Lluvia prevista', value: `${fmt(ev.rainForecastMm)} mm`, note: `${Math.round(ev.rainProbPct)}% de prob.` },
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

  /** Últimos 30 días, en cifras (solo si ya hay días registrados). */
  readonly month = computed(() => {
    const m = this.snap()?.month;
    if (!m || (!m.days && !m.irrigations)) return null;
    return [
      { label: 'Riegos', value: String(m.irrigations), note: m.irrigations === 1 ? 'vez' : 'veces' },
      { label: 'Agua de riego', value: `${fmt(m.irrigationMm, 0)} mm`, note: m.liters !== null ? `≈ ${fmt(m.liters, 0)} litros` : 'indica la superficie en Ajustes para ver litros' },
      { label: 'Lluvia útil', value: `${fmt(m.rainMm, 0)} mm`, note: `en ${m.days} ${m.days === 1 ? 'día registrado' : 'días registrados'}` },
      { label: 'Consumo del pasto', value: `${fmt(m.etcMm, 0)} mm`, note: 'evapotranspiración (ETc)' },
    ];
  });
  readonly overseedArea = computed<OverseedArea>(() => this.snap()?.state.overseedArea ?? 'patches');
  readonly overseedText = computed(() => {
    const left = this.snap()?.overseedDaysLeft ?? 0;
    if (!this.overseedOn()) return 'Riego especial mientras germina la semilla nueva (10 días)';
    const days = `quedan ${left} ${left === 1 ? 'día' : 'días'}`;
    return this.overseedArea() === 'full'
      ? `Todo el jardín · ${days}. Riego corto cada mañana y otro a las 13:00 si hace ≥ 20 °C.`
      : `Por sectores · ${days}. El pasto se riega normal; rocía lo sembrado 30 s cada día.`;
  });

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
    const s = this.snap();
    const corrected = s?.rainOverrides[d.date];
    return {
      date: d.date,
      title: cap(new Date(`${d.date}T12:00:00`).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' })) +
        (d.estimated ? ' · estimado' : ''),
      loss: fmt(d.etcMm),
      gain: fmt(d.replenishedMm),
      detail:
        `Lluvia útil ${fmt(d.rainMm)} mm · Riego ${fmt(d.irrigationMm)} mm` +
        (corrected !== undefined ? ` · lluvia medida: ${fmt(corrected)} mm` : ''),
      canCorrect: !!s && d.date < s.today,
    };
  });

  // ───────────── Ajuste manual (hoja inferior) ─────────────
  readonly adjustOpen = signal(false);
  readonly adjustValue = signal(0);
  readonly previewMood = computed(() => {
    const mm = this.adjustValue();
    const thr = this.threshold();
    return lawnMood(humidityPct(mm), mm >= thr ? 'irrigate' : 'ok');
  });
  readonly previewMessages = computed(() => [`${Math.round(humidityPct(this.adjustValue()))}% de humedad útil`]);

  private timers: ReturnType<typeof setInterval>[] = [];

  async ngOnInit(): Promise<void> {
    this.timers.push(setInterval(() => this.now.set(Date.now()), 30_000));
    this.timers.push(setInterval(() => this.liveRefresh(), LIVE_REFRESH_MS));
    const snap = this.snap() ?? (await this.engine.refresh());
    if (!snap.settings.locationSet) await this.askLocation();
  }

  ngOnDestroy(): void {
    this.timers.forEach(clearInterval);
  }

  /** Lluvia nueva de la estación: si cambia la decisión, se reprograman los avisos. */
  private async liveRefresh(): Promise<void> {
    if (document.visibilityState !== 'visible') return;
    const before = this.snap()?.evaluation;
    const after = (await this.engine.refresh()).evaluation;
    this.now.set(Date.now());
    if (before?.status !== after?.status || before?.rainMeasuredMm !== after?.rainMeasuredMm) {
      await this.notifications.reschedule();
      await this.background.sync();
    }
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

  // ───────────── Registrar riego (hoja inferior) ─────────────
  readonly irrigateOpen = signal(false);
  readonly irrigateMinutes = signal(10);
  /** true: se registra "lo recomendado", que repone todo el déficit (no los minutos redondeados). */
  readonly irrigateFull = signal(false);
  /** Minutos recomendados hoy (los que reponen todo el déficit); null si no hay déficit que reponer. */
  readonly recommendedMinutes = computed(() => {
    const min = this.snap()?.evaluation?.minutes ?? 0;
    return min > 0 ? min : null;
  });
  readonly irrigateOptions = computed(() => {
    const rec = this.recommendedMinutes();
    const opts = rec ? [{ min: rec, label: `Lo recomendado (${rec} min)`, full: true }] : [];
    for (const m of [5, 10, 15, 20]) if (m !== rec) opts.push({ min: m, label: `${m} min`, full: false });
    return opts;
  });
  readonly irrigatePreview = computed(() => {
    const s = this.snap();
    const rate = s?.settings.sprinklerRateMmMin ?? 0.6;
    const mm = this.irrigateFull() ? this.deficit() : this.irrigateMinutes() * rate;
    const liters = litersFor(mm, s?.settings.lawnAreaM2);
    const left = Math.max(0, this.deficit() - mm);
    return {
      water: `≈ ${fmt(mm)} mm de agua${liters ? ` · ${fmt(liters, 0)} L` : ''}`,
      left: left > 0 ? `El déficit queda en ${fmt(left)} mm.` : 'Repone todo el déficit: el suelo queda en capacidad de campo.',
    };
  });

  openIrrigate(): void {
    const rec = this.recommendedMinutes();
    this.irrigateMinutes.set(Math.min(40, rec ?? 10));
    this.irrigateFull.set(!!rec);
    this.irrigateOpen.set(true);
  }

  pickIrrigate(min: number, full: boolean): void {
    this.irrigateMinutes.set(Math.min(40, min));
    this.irrigateFull.set(full);
  }

  /** Riega: la ilustración muestra el aspersor mientras se guarda el registro; se puede deshacer. */
  async applyIrrigate(): Promise<void> {
    const full = this.irrigateFull();
    const minutes = full ? (this.recommendedMinutes() ?? this.irrigateMinutes()) : this.irrigateMinutes();
    this.irrigateOpen.set(false);
    this.hero()?.water();
    const left = await this.engine.registerIrrigation('manual', full ? undefined : minutes);
    await this.notifications.reschedule();
    await this.background.sync();
    const msg = left > 0 ? `Riego de ${minutes} min registrado. Quedan ${fmt(left)} mm de déficit.` : `Riego de ${minutes} min registrado. El suelo quedó húmedo.`;
    (await this.toasts.create({
      message: msg,
      duration: 6000,
      position: 'bottom',
      cssClass: 'md-snackbar',
      buttons: [{ text: 'Deshacer', handler: () => void this.undoIrrigation() }],
    })).present();
  }

  private async undoIrrigation(): Promise<void> {
    if (await this.engine.undoIrrigation()) await this.afterChange('Riego deshecho');
  }

  /** Hoy no se puede regar: se silencia el aviso de hoy y se recalcula para mañana. */
  async snooze(): Promise<void> {
    await this.engine.snoozeToday();
    await this.afterChange('Riego pospuesto para mañana');
  }

  /** Corrige la lluvia de un día pasado con lo realmente medido (INIA, pluviómetro). */
  async correctRain(date: string): Promise<void> {
    const current = this.snap()?.rainOverrides[date];
    const alert = await this.alerts.create({
      header: 'Corregir lluvia',
      subHeader: cap(new Date(`${date}T12:00:00`).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' })),
      message: 'Ingresa los milímetros que realmente cayeron, por ejemplo los de agrometeorologia.cl o tu pluviómetro.',
      inputs: [{ name: 'mm', type: 'number', min: 0, max: 200, placeholder: 'mm de lluvia', value: current ?? '' }],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Guardar',
          handler: (v: { mm: string }) => {
            const mm = parseFloat(String(v.mm).replace(',', '.'));
            if (!Number.isFinite(mm) || mm < 0) return false;
            this.engine.correctRain(date, mm).then(() => this.afterChange(`Lluvia corregida a ${fmt(mm)} mm. Balance recalculado.`));
            return true;
          },
        },
      ],
    });
    await alert.present();
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

  async toggleOverseed(ev: CustomEvent): Promise<void> {
    if (!ev.detail.checked) {
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
