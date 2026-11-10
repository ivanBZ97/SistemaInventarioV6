import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { cloudDownloadOutline, copyOutline } from 'ionicons/icons';
import { DAY_MS, HOUR_MS, type ISODate, addDays, toISODate, weekdayEs } from '../../core/dates';
import { ageText, clock, dayMonth, decimal } from '../../core/format';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { type SensorSample, dailySensorSummary, sensorCsv } from '../../core/sensor-history';
import { SensorHistoryService } from '../../core/sensor-history.service';
import { SnackbarService } from '../../ui/snackbar.service';
import { CHART_GEOMETRY, sensorChart, timeAt } from './sensor-chart';

type Range = '24h' | '7d' | '30d' | 'all';
/** Periodos que se pueden ver (`ms` null = todo lo guardado). */
const RANGES: { id: Range; label: string; ms: number | null }[] = [
  { id: '24h', label: '24 h', ms: DAY_MS },
  { id: '7d', label: '7 días', ms: 7 * DAY_MS },
  { id: '30d', label: '30 días', ms: 30 * DAY_MS },
  { id: 'all', label: 'Todo', ms: null },
];

/** "12,5 %" o "—" si no hay dato. */
const num = (v: number | null, unit = '') => (v === null ? '—' : `${decimal(v)}${unit}`);

/** "hoy 14:39", "ayer 23:00" o "sáb 24/10 16:00" */
function when(t: number): string {
  const day = toISODate(new Date(t));
  const today = toISODate(new Date());
  if (day === today) return `hoy ${clock(t)}`;
  if (day === addDays(today, -1)) return `ayer ${clock(t)}`;
  return `${weekdayEs(day).slice(0, 3)} ${dayMonth(t)} ${clock(t)}`;
}

/** Historial de mediciones del sensor de suelo: cifras del periodo, gráfico y tabla por día. */
@Component({
  selector: 'app-sensor-history',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonContent, IonIcon, IonRefresher, IonRefresherContent],
  templateUrl: './sensor-history.page.html',
  styleUrls: ['../../ui/list.scss', './sensor-history.page.scss'],
})
export class SensorHistoryPage implements OnInit {
  private engine = inject(IrrigationEngineService);
  private history = inject(SensorHistoryService);
  private snackbar = inject(SnackbarService);

  readonly geo = CHART_GEOMETRY;
  readonly viewBox = `0 0 ${CHART_GEOMETRY.W} ${CHART_GEOMETRY.H}`;
  readonly ranges = RANGES;
  readonly num = num;
  readonly when = when;
  readonly age = (t: number) => ageText(Math.max(0, Date.now() - t));
  readonly int = (v: number | null) => (v === null ? '—' : String(Math.round(v)));

  readonly samples = signal<SensorSample[]>([]);
  readonly loading = signal(true);
  /** Por qué no se pudo completar el historial desde la nube de Tuya (el guardado en el teléfono sirve igual). */
  readonly cloudError = signal<string | null>(null);
  readonly range = signal<Range>('7d');
  /** Instante bajo el dedo en el gráfico; null si no se está tocando. */
  readonly focusT = signal<number | null>(null);
  /** Momento de la última carga: fija el borde derecho del periodo. */
  private readonly now = signal(Date.now());

  constructor() {
    addIcons({ cloudDownloadOutline, copyOutline });
  }

  async ngOnInit(): Promise<void> {
    this.samples.set(await this.history.load());
    await this.reload(false);
  }

  /** Trae lo que midió el worker y, si se puede, el historial de la nube de Tuya. */
  async reload(force: boolean, ev?: Event): Promise<void> {
    this.loading.set(true);
    try {
      const { settings } = await this.engine.ready();
      const r = await this.history.sync(settings, force);
      this.samples.set(r.samples);
      this.cloudError.set(r.cloudError);
    } catch (e) {
      this.cloudError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.now.set(Date.now());
      this.loading.set(false);
      void (ev?.target as HTMLIonRefresherElement | undefined)?.complete();
    }
  }

  setRange(range: Range): void {
    this.range.set(range);
    this.focusT.set(null);
  }

  readonly latest = computed(() => this.samples().at(-1) ?? null);
  readonly rangeLabel = computed(() => (this.range() === 'all' ? 'todo' : this.rangeOf().label));
  private readonly rangeOf = computed(() => RANGES.find((r) => r.id === this.range()) ?? RANGES[1]);

  /** Periodo visible: termina ahora y dura lo elegido (o desde la primera muestra, si se ve todo). */
  private readonly domain = computed(() => {
    const { ms } = this.rangeOf();
    const now = this.now();
    const t0 = ms === null ? (this.samples()[0]?.t ?? now - DAY_MS) : now - ms;
    return { t0, t1: Math.max(now, t0 + HOUR_MS) };
  });

  /** Muestras del periodo elegido. */
  readonly visible = computed(() => {
    const { t0 } = this.domain();
    return this.samples().filter((s) => s.t >= t0);
  });

  readonly stats = computed(() => {
    const visible = this.visible();
    const soils = visible.map((s) => s.soil);
    const temps = visible.map((s) => s.tempC).filter((t): t is number => t !== null);
    return {
      min: soils.length ? Math.min(...soils) : null,
      max: soils.length ? Math.max(...soils) : null,
      tempMax: temps.length ? Math.max(...temps) : null,
      count: visible.length,
    };
  });

  readonly days = computed(() => dailySensorSummary(this.visible()));

  /** Muestra bajo el dedo (o la última del periodo). */
  readonly focus = computed(() => {
    const visible = this.visible();
    const t = this.focusT();
    if (t === null || !visible.length) return visible.at(-1) ?? null;
    return visible.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best));
  });

  readonly chart = computed(() => {
    const snap = this.engine.snapshot();
    const sensor = snap?.settings.soilSensor;
    return sensorChart({
      samples: this.samples(),
      ...this.domain(),
      now: this.now(),
      calibration: { wet: sensor?.wetPct, dry: sensor?.dryPct },
      irrigationTimes: (snap?.irrigations ?? []).map((e) => Date.parse(e.at)),
      focus: this.focus(),
    });
  });

  readonly ariaLabel = computed(() => {
    const s = this.stats();
    return `Humedad del suelo en el periodo: entre ${num(s.min, ' %')} y ${num(s.max, ' %')}, ${s.count} reportes`;
  });

  /** Dedo o cursor sobre el gráfico: destaca la muestra más cercana a ese instante. */
  pick(ev: PointerEvent): void {
    const box = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (!box.width) return;
    const { t0, t1 } = this.domain();
    this.focusT.set(timeAt(((ev.clientX - box.left) / box.width) * CHART_GEOMETRY.W, t0, t1));
  }

  dayLabel(iso: ISODate): string {
    const today = toISODate(new Date());
    if (iso === today) return 'Hoy';
    if (iso === addDays(today, -1)) return 'Ayer';
    const [, month, day] = iso.split('-').map(Number);
    return `${weekdayEs(iso).slice(0, 3)} ${day}/${month}`;
  }

  async copyCsv(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sensorCsv(this.samples()));
      this.snackbar.show('Historial copiado: pégalo en una planilla (separado por punto y coma).');
    } catch {
      this.snackbar.show('No se pudo copiar al portapapeles.');
    }
  }
}
