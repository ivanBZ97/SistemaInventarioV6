import { Component, computed, inject, signal } from '@angular/core';
import { IonIcon, IonInput, IonRange } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { checkmarkOutline, timerOutline, waterOutline } from 'ionicons/icons';
import { THRESHOLD_MAX_MM, THRESHOLD_MIN_MM, minutesFor, rateFromBucket } from '../../../core/irrigation-core';
import { decimal } from '../../../core/format';
import { inputNumber, inputPositive } from '../../../ui/ion-events';
import { SnackbarService } from '../../../ui/snackbar.service';
import { SettingsForm } from '../settings-form';

/** Ajustes → Riego: umbral, tasa del aspersor, superficie y la calculadora de tasa para riego a mano. */
@Component({
  selector: 'app-irrigation-section',
  imports: [IonIcon, IonInput, IonRange],
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
  readonly decimal = decimal;

  // Calculadora "con un balde": caudal de la manguera repartido en la superficie del pasto.
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
    const threshold = this.form.threshold();
    return `Caudal: ${flow} en ${this.form.area()} m² = ${decimal(rate, 2)} mm/min. Un riego de ${threshold} mm serían unos ${minutesFor(threshold, rate)} min en total.`;
  });

  constructor() {
    addIcons({ checkmarkOutline, timerOutline, waterOutline });
  }

  useBucketRate(rate: number): void {
    this.form.rate.set(rate);
    this.bucketOpen.set(false);
    this.snackbar.show(`Tasa: ${decimal(rate, 2)} mm/min. Toca «Guardar cambios».`);
  }
}
