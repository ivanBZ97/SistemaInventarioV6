import { Component, computed, inject, signal } from '@angular/core';
import { IonIcon, IonInput, IonRange, IonToggle } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { checkmarkOutline, earthOutline, sunnyOutline, timerOutline, waterOutline } from 'ionicons/icons';
import { EXPOSURE_FACTOR, THRESHOLD_MAX_MM, THRESHOLD_MIN_MM, minutesFor, rateFromBucket } from '../../../core/irrigation-core';
import { ROOT_DEPTH_CM, TEXTURES, TURF_P, autoThreshold, detectSoil, soilOf, totalAvailableWater } from '../../../core/soil-water';
import { decimal } from '../../../core/format';
import type { Exposure, LawnStage, SoilTexture } from '../../../core/models';
import { inputChecked, inputNumber, inputPositive } from '../../../ui/ion-events';
import { SnackbarService } from '../../../ui/snackbar.service';
import { SettingsForm } from '../settings-form';

const EXPOSURES: { id: Exposure; label: string; text: string }[] = [
  { id: 'sun', label: 'Pleno sol', text: '6 h o más de sol directo en verano: consumo normal.' },
  { id: 'partial', label: 'Media sombra', text: '3 a 6 h de sol directo: consume cerca de un 20 % menos.' },
  { id: 'shade', label: 'Sombra', text: 'Menos de 3 h de sol directo: consume cerca de un 35 % menos.' },
];

const STAGES: { id: LawnStage; label: string }[] = [
  { id: 'young', label: 'Nuevo (menos de un año)' },
  { id: 'established', label: 'Establecido' },
];

/**
 * Ajustes → Riego: umbral (fijo o automático según el suelo), sol sobre el pasto, tasa del aspersor, superficie y la
 * calculadora de tasa para riego a mano.
 */
@Component({
  selector: 'app-irrigation-section',
  imports: [IonIcon, IonInput, IonRange, IonToggle],
  templateUrl: './irrigation-section.component.html',
  styleUrl: '../../../ui/list.scss',
})
export class IrrigationSectionComponent {
  readonly form = inject(SettingsForm);
  private snackbar = inject(SnackbarService);

  readonly min = THRESHOLD_MIN_MM;
  readonly max = THRESHOLD_MAX_MM;
  readonly number = inputNumber;
  readonly positive = inputPositive;
  readonly checked = inputChecked;
  readonly decimal = decimal;
  readonly exposures = EXPOSURES;
  readonly stages = STAGES;
  readonly textures = (Object.keys(TEXTURES) as SoilTexture[]).map((id) => ({ id, ...TEXTURES[id] }));

  // ───────────── Umbral ─────────────

  readonly soilTexture = computed(() => soilOf({ soil: this.form.soil() }).texture);

  readonly thresholdText = computed(() =>
    this.form.thresholdAuto()
      ? 'Automático: según el suelo, las raíces del pasto y el consumo de cada día.'
      : `Se avisa cuando el déficit llega a ${decimal(this.form.threshold())} mm`,
  );

  /** Cómo sale el umbral automático, con lo que está en pantalla. */
  readonly autoDetail = computed(() => {
    const awc = soilOf({ soil: this.form.soil() }).awcPct;
    const depth = ROOT_DEPTH_CM[this.form.lawnStage()];
    const taw = totalAvailableWater(awc, depth);
    return (
      `Agua útil: ${decimal(awc)} % × ${depth} cm de raíces = ${decimal(taw)} mm. Se riega al gastar el ` +
      `${Math.round(TURF_P * 100)} % (${decimal(autoThreshold(awc, depth))} mm); en días de mucho consumo, antes ` +
      `(${decimal(autoThreshold(awc, depth, 7))} mm con 7 mm/día), y en días frescos, después (${decimal(autoThreshold(awc, depth, 3))} mm con 3 mm/día).`
    );
  });

  /** De dónde salió el suelo: la composición según SoilGrids o cómo reconocerlo a mano. */
  readonly soilNote = computed(() => {
    const soil = this.form.soil();
    const t = TEXTURES[this.soilTexture()];
    if (soil?.source === 'soilgrids' && soil.sandPct !== undefined && soil.clayPct !== undefined) {
      return `Según SoilGrids: ${decimal(soil.sandPct, 0)} % de arena y ${decimal(soil.clayPct, 0)} % de arcilla en los primeros 30 cm → ${t.label.toLowerCase()}, con ${decimal(soil.awcPct)} % de agua útil.`;
    }
    return `${t.label}: ${t.hint} (toma un puñado de tierra húmeda y apriétalo).`;
  });

  readonly detecting = signal(false);

  setTexture(texture: SoilTexture): void {
    if (this.form.soil()?.texture === texture) return;
    this.form.soil.set({ texture, awcPct: TEXTURES[texture].awcPct, source: 'manual' });
  }

  /** Consulta SoilGrids con la ubicación del jardín (redondeada a ~1 km). */
  async detectSoil(): Promise<void> {
    if (this.detecting()) return;
    this.detecting.set(true);
    try {
      const found = await detectSoil(this.form.lat(), this.form.lon());
      if (!found) {
        this.snackbar.show('SoilGrids no tiene datos de suelo para tu zona: elige el tipo a mano.');
        return;
      }
      this.form.soil.set(found.soil);
      const label = TEXTURES[found.soil.texture].label.toLowerCase();
      this.snackbar.show(`Suelo ${label}${found.nearby ? ' (de un punto cercano)' : ''}. Toca «Guardar cambios».`);
    } catch (e) {
      this.snackbar.show(`No se pudo consultar SoilGrids: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.detecting.set(false);
    }
  }

  // ───────────── Sol sobre el pasto ─────────────

  readonly exposureText = computed(() => {
    const e = EXPOSURES.find((x) => x.id === this.form.exposure()) ?? EXPOSURES[0];
    const factor = EXPOSURE_FACTOR[e.id];
    return factor === 1 ? e.text : `${e.text} El consumo calculado se multiplica por ${decimal(factor, 2)}.`;
  });

  // ───────────── Calculadora "con un balde" ─────────────

  // Caudal de la manguera repartido en la superficie del pasto.
  readonly bucketOpen = signal(false);
  readonly bucketLiters = signal<number | null>(20);
  readonly bucketSeconds = signal<number | null>(null);
  readonly bucketRate = computed(() => rateFromBucket(this.bucketLiters() ?? 0, this.bucketSeconds() ?? 0, this.form.area() ?? 0));
  readonly bucketText = computed(() => {
    const liters = this.bucketLiters();
    const seconds = this.bucketSeconds();
    if (liters === null || seconds === null) return 'Ingresa los litros del balde y los segundos que tardó.';
    const flow = `${decimal(liters / (seconds / 60))} L/min`;
    const rate = this.bucketRate();
    if (rate === null) return `Caudal: ${flow}. Ingresa la superficie del pasto (arriba) para calcular la tasa.`;
    const threshold = this.form.effectiveThreshold();
    return `Caudal: ${flow} en ${this.form.area()} m² = ${decimal(rate, 2)} mm/min. Un riego de ${decimal(threshold)} mm serían unos ${minutesFor(threshold, rate)} min en total.`;
  });

  constructor() {
    addIcons({ checkmarkOutline, earthOutline, sunnyOutline, timerOutline, waterOutline });
  }

  useBucketRate(rate: number): void {
    this.form.rate.set(rate);
    this.bucketOpen.set(false);
    this.snackbar.show(`Tasa: ${decimal(rate, 2)} mm/min. Toca «Guardar cambios».`);
  }
}
