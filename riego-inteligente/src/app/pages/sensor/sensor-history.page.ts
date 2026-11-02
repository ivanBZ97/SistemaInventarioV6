import { Component, OnInit, computed, inject, signal } from '@angular/core';
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
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { cloudDownloadOutline, copyOutline, waterOutline } from 'ionicons/icons';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { SensorHistoryService } from '../../core/sensor-history.service';
import { StorageService } from '../../core/storage.service';
import { type SensorSample, dailySensorSummary, sensorCsv } from '../../core/sensor-history';
import { addDays, toISODate, weekdayEs } from '../../core/irrigation-core';
import { ageText } from '../../core/dmc';
import type { IrrigationEvent } from '../../core/models';

type Range = '24h' | '7d' | '30d' | 'all';
const RANGES: { id: Range; label: string; ms: number | null }[] = [
  { id: '24h', label: '24 h', ms: 86_400_000 },
  { id: '7d', label: '7 días', ms: 7 * 86_400_000 },
  { id: '30d', label: '30 días', ms: 30 * 86_400_000 },
  { id: 'all', label: 'Todo', ms: null },
];

// Geometría del gráfico (unidades del viewBox).
const W = 320;
const H = 176;
const X0 = 30;
const X1 = 312;
const Y0 = 10;
const Y1 = 146;
const HOUR = 3_600_000;

const pad2 = (n: number) => String(n).padStart(2, '0');
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const dm = (t: number) => {
  const d = new Date(t);
  return `${d.getDate()}/${d.getMonth() + 1}`;
};
const num = (v: number | null, unit = '') => (v === null ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}${unit}`);

/** "hoy 14:39", "ayer 23:00" o "sáb 24/10 16:00" */
function when(t: number): string {
  const day = toISODate(new Date(t));
  const today = toISODate(new Date());
  if (day === today) return `hoy ${clock(t)}`;
  if (day === addDays(today, -1)) return `ayer ${clock(t)}`;
  return `${weekdayEs(day).slice(0, 3)} ${dm(t)} ${clock(t)}`;
}

@Component({
  selector: 'app-sensor-history',
  standalone: true,
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonContent, IonIcon, IonRefresher, IonRefresherContent],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/dashboard" text="" /></ion-buttons>
        <ion-title class="md-title-large">Historial del sensor</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <ion-refresher slot="fixed" (ionRefresh)="reload(true, $event)"><ion-refresher-content /></ion-refresher>

      @if (!samples().length) {
        <div class="card empty">
          <p class="md-body-large">{{ loading() ? 'Cargando historial…' : 'Aún no hay mediciones guardadas.' }}</p>
          @if (!loading()) {
            <p class="md-body-medium md-variant">
              Configura el sensor en Ajustes → Sensor de suelo. Desde entonces cada reporte del sensor queda guardado en este
              teléfono (un año), y al abrir esta pantalla se completan los últimos 7 días desde la nube de Tuya.
            </p>
          }
          @if (cloudError()) { <p class="md-body-medium err">Nube de Tuya: {{ cloudError() }}</p> }
        </div>
      } @else {
        <div class="chips" role="radiogroup" aria-label="Periodo">
          @for (r of ranges; track r.id) {
            <button class="chip" role="radio" [class.on]="range() === r.id" [attr.aria-checked]="range() === r.id" (click)="setRange(r.id)">{{ r.label }}</button>
          }
        </div>

        <div class="tiles">
          <div class="tile">
            <span class="md-label-medium md-variant">Ahora</span>
            <span class="md-headline-small">{{ num(latest()!.soil, ' %') }}</span>
            <span class="md-body-small md-variant">{{ when(latest()!.t) }} · hace {{ age(latest()!.t) }}</span>
          </div>
          <div class="tile">
            <span class="md-label-medium md-variant">Mín – máx</span>
            <span class="md-headline-small">{{ int(stats().min) }}–{{ int(stats().max) }} %</span>
            <span class="md-body-small md-variant">{{ stats().count }} reportes</span>
          </div>
          <div class="tile">
            <span class="md-label-medium md-variant">Temp. suelo</span>
            <span class="md-headline-small">{{ num(stats().tempMax, ' °C') }}</span>
            <span class="md-body-small md-variant">máxima del periodo</span>
          </div>
        </div>

        <div class="card chart-card">
          <div class="readout md-body-medium" aria-live="polite">
            @if (focus(); as f) {
              <strong>{{ num(f.soil, ' %') }}</strong> · {{ when(f.t) }}@if (f.tempC !== null) { · {{ num(f.tempC, ' °C') }} }
            }
          </div>
          <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" class="chart" role="img" [attr.aria-label]="ariaLabel()"
               (pointerdown)="pick($event)" (pointermove)="pick($event)" (pointerleave)="focusT.set(null)">
            @for (g of chart().grid; track g.v) {
              <line [attr.x1]="X0" [attr.x2]="X1" [attr.y1]="g.y" [attr.y2]="g.y" class="grid" />
              <text [attr.x]="X0 - 4" [attr.y]="g.y + 3" class="tick" text-anchor="end">{{ g.v }}</text>
            }
            @for (c of chart().calib; track c.label) {
              <line [attr.x1]="X0" [attr.x2]="X1" [attr.y1]="c.y" [attr.y2]="c.y" class="calib" />
              <text [attr.x]="X0 + 3" [attr.y]="c.y - 3" class="calib-label">{{ c.label }}</text>
            }
            @for (i of chart().irrigations; track i.x) {
              <line [attr.x1]="i.x" [attr.x2]="i.x" [attr.y1]="Y0" [attr.y2]="Y1" class="irr" />
              <circle [attr.cx]="i.x" [attr.cy]="Y1 - 4" r="4" class="irr-dot" />
            }
            <path [attr.d]="chart().path" class="line" />
            @for (x of chart().xticks; track x.x) {
              <text [attr.x]="x.x" [attr.y]="H - 14" class="tick" text-anchor="middle">{{ x.label }}</text>
            }
            @if (chart().focus; as f) {
              <line [attr.x1]="f.x" [attr.x2]="f.x" [attr.y1]="Y0" [attr.y2]="Y1" class="cross" />
              <circle [attr.cx]="f.x" [attr.cy]="f.y" r="4.5" class="focus-dot" />
            }
            <rect [attr.x]="X0" [attr.y]="Y0" [attr.width]="X1 - X0" [attr.height]="Y1 - Y0" class="hit" />
          </svg>
          <div class="legend md-body-small md-variant">
            <span><i class="sw line-sw"></i>Humedad del suelo (%)</span>
            @if (chart().calib.length) { <span><i class="sw calib-sw"></i>Tu calibración</span> }
            @if (chart().irrigations.length) { <span><i class="sw irr-sw"></i>Riego registrado</span> }
          </div>
        </div>

        <div class="chips">
          <button class="chip" (click)="copyCsv()"><ion-icon name="copy-outline" />Copiar CSV ({{ samples().length }})</button>
          <button class="chip" (click)="reload(true)" [disabled]="loading()"><ion-icon name="cloud-download-outline" />{{ loading() ? 'Actualizando…' : 'Traer de Tuya' }}</button>
        </div>
        @if (cloudError()) {
          <p class="note md-body-small md-variant">
            Cada reporte que lee el teléfono queda guardado aquí por un año. El historial de la nube de Tuya (para completar
            lo que no alcanzó a leer) no está disponible: {{ cloudError() }}.
          </p>
        } @else {
          <p class="note md-body-small md-variant">
            Cada reporte del sensor queda guardado en este teléfono por un año. El sensor es a pilas e informa cada cierto rato;
            lo que la app no alcanzó a leer se completa desde la nube de Tuya (guarda unos 7 días).
          </p>
        }

        <h2 class="section md-title-small">Por día · {{ rangeLabel() }}</h2>
        <div class="card table-card">
          <table>
            <thead>
              <tr><th>Día</th><th>Mín %</th><th>Máx %</th><th>Prom. %</th><th>Temp. °C</th></tr>
            </thead>
            <tbody>
              @for (d of days(); track d.date) {
                <tr>
                  <td>{{ dayLabel(d.date) }}</td>
                  <td>{{ num(d.min) }}</td>
                  <td>{{ num(d.max) }}</td>
                  <td>{{ num(d.avg) }}</td>
                  <td>{{ num(d.tempMax) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="bottom-space"></div>
      }
    </ion-content>
  `,
  styles: [`
    .section { margin: 24px 24px 8px; color: var(--md-primary); }
    .card { margin: 0 16px; padding: 12px 16px; border-radius: var(--md-shape-lg); background: var(--md-surface-container-low); }
    .card.empty { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; p { margin: 0; } }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; }
    .chip { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 16px; border-radius: 8px;
      border: 1px solid var(--md-outline); background: transparent; color: var(--md-on-surface-variant);
      font: 500 14px/20px var(--md-font); letter-spacing: .1px; cursor: pointer;
      ion-icon { font-size: 18px; color: var(--md-primary); } }
    .chip:has(ion-icon) { padding-left: 8px; }
    .chip.on { background: var(--md-secondary-container); color: var(--md-on-secondary-container); border-color: transparent; }
    .chip:disabled { opacity: .6; cursor: default; }
    .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 16px 12px; }
    .tile { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 12px; border-radius: var(--md-shape-md);
      background: var(--md-surface-container-low); }
    .tile .md-headline-small { font-size: 20px; line-height: 28px; white-space: nowrap; }
    .chart-card { padding: 12px 8px 8px; }
    .readout { min-height: 20px; padding: 0 8px 4px; color: var(--md-on-surface); }
    .chart { width: 100%; height: auto; display: block; touch-action: pan-y; }
    .grid { stroke: var(--md-outline-variant); stroke-width: 1; opacity: .6; }
    .tick { fill: var(--md-on-surface-variant); font: 400 9px var(--md-font); }
    .line { fill: none; stroke: var(--md-primary); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .calib { stroke: var(--md-on-surface-variant); stroke-width: 1; stroke-dasharray: 4 3; opacity: .7; }
    .calib-label { fill: var(--md-on-surface-variant); font: 500 8.5px var(--md-font);
      paint-order: stroke; stroke: var(--md-surface-container-low); stroke-width: 3px; stroke-linejoin: round; }
    .irr { stroke: var(--md-tertiary); stroke-width: 1; opacity: .35; }
    .irr-dot { fill: var(--md-tertiary); stroke: var(--md-surface-container-low); stroke-width: 2; }
    .cross { stroke: var(--md-on-surface); stroke-width: 1; opacity: .5; }
    .focus-dot { fill: var(--md-primary); stroke: var(--md-surface-container-low); stroke-width: 2; }
    .hit { fill: transparent; }
    .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 4px 8px 0; span { display: inline-flex; align-items: center; gap: 6px; } }
    .sw { display: inline-block; width: 14px; height: 0; border-top: 2px solid var(--md-primary); }
    .sw.calib-sw { border-top: 1px dashed var(--md-on-surface-variant); }
    .sw.irr-sw { width: 8px; height: 8px; border: 0; border-radius: 50%; background: var(--md-tertiary); }
    .note { margin: 0 24px; }
    .err { color: var(--md-error); }
    .table-card { padding: 4px 0; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font: 400 14px/20px var(--md-font); color: var(--md-on-surface); }
    th { text-align: right; font: 500 12px/16px var(--md-font); color: var(--md-on-surface-variant); padding: 8px 12px; }
    th, td { white-space: nowrap; }
    td { text-align: right; padding: 8px 12px; border-top: 1px solid var(--md-outline-variant); font-variant-numeric: tabular-nums; }
    th:first-child, td:first-child { text-align: left; }
    .bottom-space { height: 24px; }
  `],
})
export class SensorHistoryPage implements OnInit {
  private engine = inject(IrrigationEngineService);
  private history = inject(SensorHistoryService);
  private storage = inject(StorageService);
  private toasts = inject(ToastController);

  readonly W = W;
  readonly H = H;
  readonly X0 = X0;
  readonly X1 = X1;
  readonly Y0 = Y0;
  readonly Y1 = Y1;
  readonly ranges = RANGES;
  readonly num = num;
  readonly when = when;
  readonly age = (t: number) => ageText(Math.max(0, Date.now() - t));

  samples = signal<SensorSample[]>([]);
  irrigations = signal<IrrigationEvent[]>([]);
  loading = signal(true);
  cloudError = signal<string | null>(null);
  range = signal<Range>('7d');
  focusT = signal<number | null>(null);
  private calibration = signal<{ wet?: number; dry?: number }>({});

  constructor() {
    addIcons({ cloudDownloadOutline, copyOutline, waterOutline });
  }

  async ngOnInit(): Promise<void> {
    this.samples.set(await this.history.load());
    this.irrigations.set(await this.storage.get<IrrigationEvent[]>('irrigations', []));
    await this.reload(false);
  }

  async reload(force: boolean, ev?: Event): Promise<void> {
    this.loading.set(true);
    try {
      const settings = this.engine.snapshot()?.settings ?? (await this.engine.refresh()).settings;
      this.calibration.set({ wet: settings.soilSensor?.wetPct, dry: settings.soilSensor?.dryPct });
      const r = await this.history.sync(settings, force);
      this.samples.set(r.samples);
      this.cloudError.set(r.cloudError);
    } catch (e) {
      this.cloudError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
      (ev?.target as HTMLIonRefresherElement | undefined)?.complete();
    }
  }

  setRange(r: Range): void {
    this.range.set(r);
    this.focusT.set(null);
  }

  readonly latest = computed(() => this.samples().at(-1) ?? null);

  /** Muestras del periodo elegido. */
  readonly visible = computed(() => {
    const all = this.samples();
    const ms = RANGES.find((r) => r.id === this.range())!.ms;
    if (ms === null || !all.length) return all;
    const from = Date.now() - ms;
    return all.filter((s) => s.t >= from);
  });

  readonly stats = computed(() => {
    const v = this.visible();
    const soils = v.map((s) => s.soil);
    const temps = v.map((s) => s.tempC).filter((x): x is number => x !== null);
    return {
      min: soils.length ? Math.min(...soils) : null,
      max: soils.length ? Math.max(...soils) : null,
      tempMax: temps.length ? Math.max(...temps) : null,
      count: v.length,
    };
  });

  readonly days = computed(() => dailySensorSummary(this.visible()));
  readonly rangeLabel = computed(() => (this.range() === 'all' ? 'todo' : RANGES.find((r) => r.id === this.range())!.label));
  readonly int = (v: number | null) => (v === null ? '—' : String(Math.round(v)));

  /** Muestra bajo el dedo (o la última del periodo). */
  readonly focus = computed(() => {
    const v = this.visible();
    if (!v.length) return null;
    const t = this.focusT();
    if (t === null) return v[v.length - 1];
    let best = v[0];
    for (const s of v) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best;
  });

  private readonly domain = computed(() => {
    const ms = RANGES.find((r) => r.id === this.range())!.ms;
    const now = Date.now();
    const v = this.visible();
    const t0 = ms === null ? (v[0]?.t ?? now - 86_400_000) : now - ms;
    return { t0, t1: Math.max(now, t0 + HOUR) };
  });

  readonly chart = computed(() => {
    const v = this.visible();
    const { t0, t1 } = this.domain();
    const cal = this.calibration();
    const values = [...v.map((s) => s.soil), ...(cal.wet !== undefined ? [cal.wet] : []), ...(cal.dry !== undefined ? [cal.dry] : [])];
    let lo = values.length ? Math.floor((Math.min(...values) - 3) / 10) * 10 : 0;
    let hi = values.length ? Math.ceil((Math.max(...values) + 3) / 10) * 10 : 100;
    lo = Math.max(0, lo);
    hi = Math.min(100, Math.max(hi, lo + 20));
    const x = (t: number) => X0 + ((t - t0) / (t1 - t0)) * (X1 - X0);
    const y = (p: number) => Y1 - ((p - lo) / (hi - lo)) * (Y1 - Y0);

    // La línea se corta donde faltan reportes (sensor sin WiFi, sin pilas…).
    const gap = Math.max(3 * HOUR, (t1 - t0) / 40);
    let path = '';
    v.forEach((s, i) => {
      const cmd = i === 0 || s.t - v[i - 1].t > gap ? 'M' : 'L';
      path += `${cmd}${x(s.t).toFixed(1)},${y(s.soil).toFixed(1)}`;
    });
    // Un punto aislado se dibuja como un trazo mínimo para que se vea.
    path = path.replace(/M([\d.]+),([\d.]+)(?=M|$)/g, (_m, a, b) => `M${a},${b}l0.1,0`);

    const step = (hi - lo) / 20 > 2 ? 20 : 10;
    const grid: { v: number; y: number }[] = [];
    for (let g = lo; g <= hi; g += step) grid.push({ v: g, y: y(g) });

    const calib = [
      ...(cal.wet !== undefined ? [{ label: `húmedo ${num(cal.wet, ' %')}`, y: y(cal.wet) }] : []),
      ...(cal.dry !== undefined ? [{ label: `toca regar ${num(cal.dry, ' %')}`, y: y(cal.dry) }] : []),
    ];

    const irrigations = this.irrigations()
      .map((e) => Date.parse(e.at))
      .filter((t) => t >= t0 && t <= t1)
      .map((t) => ({ x: x(t) }));

    const f = this.focus();
    return {
      path,
      grid,
      calib,
      irrigations,
      xticks: this.xticks(t0, t1).map((t) => ({ x: x(t.t), label: t.label })),
      focus: f ? { x: x(f.t), y: y(f.soil) } : null,
    };
  });

  /** Marcas del eje de tiempo: horas en 24 h; días en periodos largos (máximo ~6). */
  private xticks(t0: number, t1: number): { t: number; label: string }[] {
    const span = t1 - t0;
    const out: { t: number; label: string }[] = [];
    if (span <= 2 * 86_400_000) {
      const stepH = 6;
      const d = new Date(t0);
      d.setMinutes(0, 0, 0);
      d.setHours(Math.ceil(d.getHours() / stepH) * stepH);
      for (let t = d.getTime(); t <= t1; t += stepH * HOUR) out.push({ t, label: clock(t) });
      return out;
    }
    const days = Math.ceil(span / 86_400_000);
    const stepD = days <= 8 ? 1 : days <= 16 ? 3 : days <= 45 ? 7 : Math.ceil(days / 6);
    const d = new Date(t0);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    for (let t = d.getTime(); t <= t1; ) {
      const iso = toISODate(new Date(t));
      out.push({ t, label: stepD === 1 ? weekdayEs(iso).slice(0, 3) : dm(t) });
      const n = new Date(t);
      n.setDate(n.getDate() + stepD);
      t = n.getTime();
    }
    return out;
  }

  readonly ariaLabel = computed(() => {
    const s = this.stats();
    return `Humedad del suelo en el periodo: entre ${num(s.min, ' %')} y ${num(s.max, ' %')}, ${s.count} reportes`;
  });

  pick(ev: PointerEvent): void {
    const svg = ev.currentTarget as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    if (!box.width) return;
    const vx = ((ev.clientX - box.left) / box.width) * W;
    const { t0, t1 } = this.domain();
    const t = t0 + ((Math.min(X1, Math.max(X0, vx)) - X0) / (X1 - X0)) * (t1 - t0);
    this.focusT.set(t);
  }

  dayLabel(iso: string): string {
    const today = toISODate(new Date());
    if (iso === today) return 'Hoy';
    if (iso === addDays(today, -1)) return 'Ayer';
    const [, m, d] = iso.split('-').map(Number);
    return `${weekdayEs(iso).slice(0, 3)} ${d}/${m}`;
  }

  async copyCsv(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sensorCsv(this.samples()));
      await this.toast('Historial copiado: pégalo en una planilla (separado por punto y coma).');
    } catch {
      await this.toast('No se pudo copiar al portapapeles.');
    }
  }

  private async toast(message: string): Promise<void> {
    const t = await this.toasts.create({ message, duration: 2500, position: 'bottom' });
    await t.present();
  }
}
