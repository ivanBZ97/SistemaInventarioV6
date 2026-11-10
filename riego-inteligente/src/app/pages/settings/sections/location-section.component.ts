import { Component, inject, signal } from '@angular/core';
import { IonButton, IonIcon, IonInput, IonToggle } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { locateOutline, locationOutline, navigateOutline, searchOutline } from 'ionicons/icons';
import { LocationService } from '../../../core/location.service';
import { type Place, searchPlaces } from '../../../core/open-meteo';
import { inputChecked, inputNumber, inputText } from '../../../ui/ion-events';
import { SnackbarService } from '../../../ui/snackbar.service';
import { SettingsForm } from '../settings-form';

/** Ajustes → Ubicación del jardín: GPS, búsqueda por ciudad o coordenadas a mano. */
@Component({
  selector: 'app-location-section',
  imports: [IonButton, IonIcon, IonInput, IonToggle],
  templateUrl: './location-section.component.html',
  styleUrl: '../../../ui/list.scss',
  styles: `
    .row.result { min-height: 48px; padding-left: 20px; cursor: pointer; }
  `,
})
export class LocationSectionComponent {
  readonly form = inject(SettingsForm);
  private location = inject(LocationService);
  private snackbar = inject(SnackbarService);

  readonly text = inputText;
  readonly number = inputNumber;
  readonly checked = inputChecked;

  readonly query = signal('');
  readonly results = signal<Place[]>([]);
  readonly locating = signal(false);

  constructor() {
    addIcons({ locateOutline, locationOutline, navigateOutline, searchOutline });
  }

  /** Ubicación aproximada (~1 km: suficiente para el clima); además activa la actualización automática. */
  async useGps(): Promise<void> {
    const fix = await this.locate(false);
    if (!fix) return this.snackbar.show('No se pudo obtener la ubicación; busca tu ciudad o ingresa las coordenadas.');
    this.form.setLocation(fix.latitude, fix.longitude, fix.placeName ?? undefined, true);
    this.snackbar.show(`Ubicación: ${fix.placeName ?? `${fix.latitude}, ${fix.longitude}`}`);
  }

  /** GPS de alta precisión (~10 m): para usarlo parado en el jardín. Fija el punto (sin actualización automática). */
  async usePreciseGps(): Promise<void> {
    this.snackbar.show('Obteniendo ubicación precisa… (puede tardar hasta 30 s, mejor al aire libre)');
    const fix = await this.locate(true);
    if (!fix) return this.snackbar.show('No se pudo obtener la ubicación precisa. Revisa el permiso de ubicación precisa.');
    this.form.setLocation(fix.latitude, fix.longitude, fix.placeName ?? undefined, false);
    this.snackbar.show(`Punto fijado (±${fix.accuracyM} m). Pulsa «Guardar cambios».`);
  }

  private async locate(precise: boolean) {
    this.locating.set(true);
    try {
      return await this.location.detect(precise);
    } finally {
      this.locating.set(false);
    }
  }

  async search(): Promise<void> {
    try {
      const found = await searchPlaces(this.query());
      this.results.set(found);
      if (!found.length) this.snackbar.show('Sin resultados');
    } catch {
      this.snackbar.show('No se pudo buscar (¿sin conexión?)');
    }
  }

  pick(place: Place): void {
    this.form.setLocation(place.latitude, place.longitude, place.label, false);
    this.results.set([]);
  }
}
