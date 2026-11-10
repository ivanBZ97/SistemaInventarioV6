import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonIcon, IonInput, IonInputPasswordToggle, IonToggle } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  alarmOutline,
  checkmarkOutline,
  eyeOffOutline,
  eyeOutline,
  leafOutline,
  pulseOutline,
  statsChartOutline,
  waterOutline,
} from 'ionicons/icons';
import { ageText, decimal, whenOf } from '../../../core/format';
import { SENSOR_MAX_AGE_MS } from '../../../core/soil-sensor';
import { SOIL_SENSOR_PROVIDER } from '../../../core/soil-sensor.provider';
import { TUYA_REGIONS, tuyaErrorText } from '../../../core/tuya';
import type { SoilReading, TuyaRegion } from '../../../core/models';
import { inputChecked, inputText } from '../../../ui/ion-events';
import { SnackbarService } from '../../../ui/snackbar.service';
import { SettingsForm } from '../settings-form';

/** Centros de datos que se ofrecen (los de América y Europa central; el resto se puede agregar aquí). */
const REGIONS: TuyaRegion[] = ['us', 'ueaz', 'eu'];
/** Justo después de regar, el sensor marca el suelo encharcado y no lo que retiene una vez drenado. */
const SATURATED_PCT = 97;

const pct = (v: number | undefined) => (v === undefined ? '—' : `${decimal(v)} %`);
const value = (v: number | null, unit: string) => (v === null ? '—' : `${decimal(v)}${unit}`);

/** Ajustes → Sensor de suelo: claves de Tuya, prueba, calibración de dos puntos y si se usa en el balance. */
@Component({
  selector: 'app-sensor-section',
  imports: [IonIcon, IonInput, IonInputPasswordToggle, IonToggle, RouterLink],
  templateUrl: './sensor-section.component.html',
  styleUrl: '../../../ui/list.scss',
})
export class SensorSectionComponent {
  readonly form = inject(SettingsForm);
  private soil = inject(SOIL_SENSOR_PROVIDER);
  private snackbar = inject(SnackbarService);

  readonly text = inputText;
  readonly checked = inputChecked;
  readonly regions = REGIONS.map((id) => ({ id, label: TUYA_REGIONS[id].label }));

  readonly busy = signal(false);
  readonly report = signal<{ lines: string[]; error: boolean } | null>(null);

  readonly calibrationText = computed(() => {
    const wet = this.form.wetPct();
    const dry = this.form.dryPct();
    const cal = this.form.calibration();
    if (!cal) {
      return wet !== undefined && dry !== undefined
        ? `Húmedo ${pct(wet)} · seco ${pct(dry)}: están muy juntos; repite con el suelo bien regado y cuando toque regar.`
        : `Húmedo: ${pct(wet)} · toca regar: ${pct(dry)}. Marca el «húmedo» a la mañana siguiente de un riego profundo y el «seco» el día que la app diga que toca regar.`;
    }
    if (!cal.provisional) return `Húmedo (déficit 0): ${pct(cal.wet)} · toca regar (${this.form.threshold()} mm): ${pct(cal.dry)}.`;
    const [missing, when] =
      wet === undefined
        ? ['húmedo', 'a la mañana siguiente de un riego profundo']
        : ['toca regar', 'el día que la app diga que toca regar'];
    return `Provisional: húmedo ${pct(cal.wet)} · toca regar ${pct(cal.dry)} (el «${missing}» es estimado). Ya puedes usar el sensor; se afina cuando marques el «${missing}» ${when}.`;
  });

  constructor() {
    addIcons({ alarmOutline, checkmarkOutline, eyeOffOutline, eyeOutline, leafOutline, pulseOutline, statsChartOutline, waterOutline });
  }

  /** Lee el sensor ahora con lo escrito en pantalla (aunque aún no se haya guardado). */
  private async read(): Promise<SoilReading | null> {
    const sensor = this.form.sensor();
    if (!sensor) {
      this.report.set({ lines: ['Completa Access ID, Access Secret e ID del sensor.'], error: true });
      return null;
    }
    this.busy.set(true);
    try {
      return await this.soil.read({ ...this.form.saved, thresholdMm: this.form.threshold(), soilSensor: sensor }, true);
    } catch (e) {
      this.report.set({ lines: [`No se pudo leer el sensor: ${tuyaErrorText(e)}.`], error: true });
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  async test(): Promise<void> {
    const r = await this.read();
    if (!r) return;
    const age = Math.max(0, Date.now() - r.at);
    this.report.set({
      lines: [
        `✓ ${r.name}: humedad del suelo ${value(r.soilPct, ' %')} · ${value(r.tempC, ' °C')} · batería ${value(r.battery, ' %')}.`,
        `Último reporte: ${whenOf(r.at)} (hace ${ageText(age)})${age > SENSOR_MAX_AGE_MS ? ': viejo, revisa que tenga WiFi y pilas' : ''}.`,
        'Es a pilas: duerme y se conecta cada cierto rato o cuando la humedad cambia; Tuya entrega su último dato.',
        r.deficitMm !== null
          ? `Con tu calibración equivale a ${value(r.deficitMm, ' mm')} de déficit.`
          : 'Falta calibrarlo para usarlo en el balance.',
      ],
      error: false,
    });
  }

  /** Guarda la lectura actual como punto «húmedo» (déficit 0) o «toca regar» (déficit = umbral). */
  async calibrate(point: 'wet' | 'dry'): Promise<void> {
    const r = await this.read();
    if (!r) return;
    (point === 'wet' ? this.form.wetPct : this.form.dryPct).set(r.soilPct);
    await this.form.saveSensor();
    const label = `${point === 'wet' ? 'Húmedo' : 'Toca regar'}: ${pct(r.soilPct)} (guardado).`;
    this.snackbar.show(
      point === 'wet' && r.soilPct >= SATURATED_PCT
        ? `${label} Recién regado marca saturado: para afinar, vuelve a marcarlo mañana temprano.`
        : label,
    );
  }

  async toggle(on: boolean): Promise<void> {
    this.form.sensorOn.set(on);
    await this.form.saveSensor();
    this.snackbar.show(on ? 'El sensor ahora manda en el balance (guardado).' : 'El sensor ya no se usa en el balance (guardado).');
  }
}
