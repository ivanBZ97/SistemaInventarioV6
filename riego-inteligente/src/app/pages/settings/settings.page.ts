import { Component, type OnInit, inject, signal } from '@angular/core';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { SettingsForm } from './settings-form';
import { IrrigationSectionComponent } from './sections/irrigation-section.component';
import { LocationSectionComponent } from './sections/location-section.component';
import { NotificationsSectionComponent } from './sections/notifications-section.component';
import { SensorSectionComponent } from './sections/sensor-section.component';
import { StationSectionComponent } from './sections/station-section.component';
import { StatusSectionComponent } from './sections/status-section.component';

/**
 * Ajustes. Cada sección edita el borrador compartido (`SettingsForm`), que se aplica completo con «Guardar
 * cambios». Las secciones se muestran cuando el borrador ya tiene los ajustes guardados.
 */
@Component({
  selector: 'app-settings',
  imports: [
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    IrrigationSectionComponent,
    LocationSectionComponent,
    NotificationsSectionComponent,
    SensorSectionComponent,
    StationSectionComponent,
    StatusSectionComponent,
  ],
  providers: [SettingsForm],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
})
export class SettingsPage implements OnInit {
  readonly form = inject(SettingsForm);

  readonly loaded = signal(false);
  readonly saving = signal(false);

  async ngOnInit(): Promise<void> {
    await this.form.load();
    this.loaded.set(true);
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      await this.form.save();
    } finally {
      this.saving.set(false);
    }
  }
}
