import { Component, computed, inject, signal } from '@angular/core';
import { AlertController, IonIcon, IonInput, IonInputPasswordToggle } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  checkmarkOutline,
  closeOutline,
  copyOutline,
  eyeOffOutline,
  eyeOutline,
  pulseOutline,
  radioOutline,
  searchOutline,
  syncOutline,
} from 'ionicons/icons';
import { fetchObservedRain, findRainVariable, listStations, nearestStations } from '../../../core/agromet';
import {
  BACKUP_MAX_KM,
  type DmcStation,
  type StationCheck,
  type StationHealth,
  bestStation,
  checkStations,
  listDmcStations,
  nearbyDmcStations,
  nearestDmcStation,
  stationsToCheck,
} from '../../../core/dmc';
import { addDays, toISODate } from '../../../core/dates';
import { clock, decimal, km, shortWhen, whenOf } from '../../../core/format';
import { WeatherService } from '../../../core/weather.service';
import { inputText } from '../../../ui/ion-events';
import { SnackbarService } from '../../../ui/snackbar.service';
import { SettingsForm } from '../settings-form';

type NearStation = DmcStation & { distanceKm: number };
/** Fila de la lista de estaciones: revisada, o aún consultándose. */
type StationRow = Omit<StationCheck, 'health'> & { health: StationHealth | 'checking' };

interface Report {
  lines: string[];
  error: boolean;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Ajustes → Estación meteorológica: estación automática de la DMC (con usuario y token se revisa cuáles están
 * enviando datos) y, como alternativa, una estación de INIA Agromet.
 */
@Component({
  selector: 'app-station-section',
  imports: [IonIcon, IonInput, IonInputPasswordToggle],
  templateUrl: './station-section.component.html',
  styleUrl: '../../../ui/list.scss',
  styles: `
    .stations {
      padding: 4px 0 8px;
    }
    .row.station {
      cursor: pointer;
      min-height: 64px;
    }
    .row.station:disabled {
      cursor: default;
      opacity: 0.6;
    }
    .row.station.sel {
      background: var(--md-secondary-container);
      color: var(--md-on-secondary-container);
    }
    .row.station .check {
      font-size: 22px;
      color: var(--md-primary);
    }
  `,
})
export class StationSectionComponent {
  readonly form = inject(SettingsForm);
  private weather = inject(WeatherService);
  private alerts = inject(AlertController);
  private snackbar = inject(SnackbarService);

  readonly text = inputText;
  readonly km = km;

  readonly dmcReport = signal<Report | null>(null);
  /** Estaciones cercanas revisadas al conectar (por distancia); null hasta la primera revisión. */
  readonly checks = signal<StationRow[] | null>(null);
  readonly checking = signal(false);
  private readonly checkedAt = signal<number | null>(null);

  readonly dmcSummary = computed(() => {
    const dmc = this.form.dmc();
    if (!dmc) return 'Estaciones automáticas públicas · sin clave';
    return `Estación DMC ${dmc.code} · a ${km(dmc.distanceKm)} km · ${this.form.dmcAuth() ? 'con token' : 'sin clave'}`;
  });

  readonly checksSummary = computed(() => {
    const list = this.checks();
    if (!list) return '';
    if (this.checking()) return `Revisando las ${list.length} estaciones más cercanas…`;
    const live = list.filter((c) => c.health === 'live').length;
    const at = this.checkedAt();
    const chosen = list.find((c) => c.code === this.form.dmc()?.code);
    const warning = chosen && !this.usable(chosen) ? ` ${chosen.name} no está enviando datos: elige otra.` : '';
    return `${live} de ${list.length} estaciones están al día${at ? ` (revisado a las ${clock(at)})` : ''}. Toca una para usarla.${warning}`;
  });

  constructor() {
    addIcons({
      checkmarkOutline,
      closeOutline,
      copyOutline,
      eyeOffOutline,
      eyeOutline,
      pulseOutline,
      radioOutline,
      searchOutline,
      syncOutline,
    });
  }

  // ───────────── DMC ─────────────

  /** Con usuario y token se revisa qué estaciones responden; sin ellos, se elige de la lista por distancia. */
  changeDmc(): Promise<void> {
    return this.form.dmcAuth() ? this.connectDmc() : this.findDmc();
  }

  /** Sin credenciales: la primera vez, la estación más cercana; después, a elegir entre las 5 más cercanas. */
  private async findDmc(): Promise<void> {
    this.dmcReport.set(null);
    const stations = await listDmcStations();
    const { lat, lon } = this.spot();
    const station = this.form.dmc() ? await this.pickDmc(nearbyDmcStations(stations, lat, lon, 5)) : nearestDmcStation(stations, lat, lon);
    if (!station) {
      if (!this.form.dmc()) this.snackbar.show('No se encontraron estaciones de la DMC');
      return;
    }
    this.useStation(station);
    if (station.distanceKm > BACKUP_MAX_KM) {
      this.snackbar.show(
        `La estación más cercana está a ${station.distanceKm.toFixed(0)} km: puede no representar la lluvia de tu jardín.`,
      );
    }
    await this.testDmc();
  }

  /**
   * Con usuario y token: revisa las estaciones más cercanas, muestra cuáles están enviando datos y, si aún no hay
   * una elegida, toma la más cercana al día (si la más cercana no publica, la siguiente que sí).
   */
  async connectDmc(): Promise<void> {
    const auth = this.form.dmcAuth();
    if (!auth) return this.snackbar.show('Escribe tu usuario (correo) y tu token de la DMC');
    if (this.checking()) return;
    this.checking.set(true);
    this.dmcReport.set(null);
    try {
      const { lat, lon } = this.spot();
      const near = stationsToCheck(await listDmcStations(), lat, lon);
      this.checks.set(near.map((s) => ({ ...s, health: 'checking', newest: null, readings: 0 })));
      const now = Date.now();
      const done = await checkStations(near, auth, now, (c) =>
        this.checks.update((list) => list?.map((r) => (r.code === c.code ? c : r)) ?? null),
      );
      this.checks.set(done);
      this.checkedAt.set(now);
      const best = bestStation(done);
      if (!best) {
        const said = done.find((c) => c.snippet)?.snippet;
        return this.snackbar.show(
          said ? `Ninguna estación respondió. La DMC dice: ${said}` : 'Ninguna estación cercana está enviando datos ahora.',
        );
      }
      if (this.form.dmc()) return;
      this.useStation(best);
      const nearest = done[0];
      this.snackbar.show(
        best.code === nearest.code
          ? `Estación más cercana: ${best.name} (${km(best.distanceKm)} km), al día. Pulsa «Guardar cambios».`
          : `${nearest.name} (la más cercana) no está enviando datos: se eligió ${best.name}. Pulsa «Guardar cambios».`,
      );
    } catch (e) {
      this.snackbar.show(`No se pudieron revisar las estaciones: ${errorText(e, 'error inesperado')}`);
    } finally {
      this.checking.set(false);
    }
  }

  /** Solo se puede elegir una estación con datos de las últimas 24 h. */
  usable(c: StationRow): c is StationCheck {
    return c.health === 'live' || c.health === 'late';
  }

  selectStation(c: StationRow): void {
    if (!this.usable(c)) return;
    this.useStation(c);
    this.snackbar.show(`Estación: ${c.name} (${km(c.distanceKm)} km). Pulsa «Guardar cambios».`);
  }

  healthText(c: StationRow): string {
    switch (c.health) {
      case 'checking':
        return 'consultando…';
      case 'live':
        return `al día (${c.newest === null ? 'recién' : shortWhen(c.newest)})`;
      case 'late':
        return `atrasada (${c.newest === null ? 'sin hora' : shortWhen(c.newest)})`;
      case 'stale':
        return c.newest ? `sin datos desde ${whenOf(c.newest)}` : 'sin datos';
      case 'error':
        return `no responde (${c.error ?? 'sin detalle'})`;
    }
  }

  /** Prueba la estación y muestra qué entregó (para contrastar con agrometeorologia.cl o reportar un cambio). */
  async testDmc(): Promise<void> {
    const cfg = this.form.dmc();
    if (!cfg) return;
    this.dmcReport.set({ lines: ['Consultando la estación…'], error: false });
    try {
      const { lat, lon } = this.spot();
      const r = await this.weather.diagnoseStation(
        { dmcAuth: this.form.dmcAuth(), latitude: lat, longitude: lon },
        cfg,
        this.form.elevation(),
      );
      const hint = !r.ok
        ? 'Mientras tanto, la app sigue usando el pronóstico.'
        : this.form.saved.dmc?.code === cfg.code
          ? null
          : 'Pulsa «Guardar cambios» para usar esta estación.';
      this.dmcReport.set({ lines: hint ? [...r.lines, hint] : r.lines, error: !r.ok });
    } catch (e) {
      this.dmcReport.set({ lines: [`Error inesperado al probar la estación: ${errorText(e, String(e))}`], error: true });
    }
  }

  /** Copia el diagnóstico para enviarlo como texto (no incluye usuario ni token). */
  async copyReport(): Promise<void> {
    const report = this.dmcReport();
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.lines.join('\n'));
      this.snackbar.show('Diagnóstico copiado');
    } catch {
      this.snackbar.show('No se pudo copiar; envía una captura de pantalla');
    }
  }

  private spot(): { lat: number; lon: number } {
    return { lat: this.form.lat(), lon: this.form.lon() };
  }

  private useStation(st: NearStation): void {
    this.dmcReport.set(null);
    this.form.dmc.set({
      code: st.code,
      name: st.name,
      distanceKm: Math.round(st.distanceKm * 10) / 10,
      latitude: st.latitude,
      longitude: st.longitude,
      elevationM: st.elevationM ?? undefined,
    });
  }

  /** Lista de estaciones cercanas para elegir (con su distancia al jardín). */
  private async pickDmc(options: NearStation[]): Promise<NearStation | null> {
    const alert = await this.alerts.create({
      header: 'Estación de la DMC',
      message: 'Elige la estación. La más cercana representa mejor la lluvia de tu jardín.',
      inputs: options.map((o) => ({
        type: 'radio' as const,
        label: `${o.name} · ${km(o.distanceKm)} km`,
        value: o.code,
        checked: o.code === this.form.dmc()?.code,
      })),
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Elegir', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role, data } = await alert.onDidDismiss<{ values?: string }>();
    return role === 'confirm' ? (options.find((o) => o.code === data?.values) ?? null) : null;
  }

  // ───────────── INIA Agromet ─────────────

  /** Busca la estación INIA más cercana que mida precipitación. */
  async findAgromet(): Promise<void> {
    const apiKey = this.form.agrometKey().trim();
    if (!apiKey) return this.snackbar.show('Ingresa tu clave de API de Agromet');
    this.snackbar.show('Buscando estaciones…');
    try {
      const { lat, lon } = this.spot();
      const near = nearestStations(await listStations(apiKey), lat, lon, 6);
      if (!near.length) return this.snackbar.show('La API no devolvió estaciones');
      for (const st of near) {
        const rainVariableId = await findRainVariable(apiKey, st.id);
        if (!rainVariableId) continue; // estación sin pluviómetro
        this.form.agromet.set({
          apiKey,
          stationId: st.id,
          stationName: st.comuna ? `${st.name}, ${st.comuna}` : st.name,
          distanceKm: st.distanceKm,
          rainVariableId,
        });
        return this.snackbar.show(`Estación: ${st.name} a ${km(st.distanceKm)} km. Pulsa «Guardar cambios».`);
      }
      this.snackbar.show('Las estaciones cercanas no miden lluvia');
    } catch (e) {
      this.snackbar.show(errorText(e, 'No se pudo consultar Agromet'));
    }
  }

  /** Muestra la lluvia que reporta la estación (para contrastar con tu pluviómetro o la realidad). */
  async testAgromet(): Promise<void> {
    const cfg = this.form.agromet();
    if (!cfg) return;
    try {
      const today = toISODate(new Date());
      const observed = await fetchObservedRain({ ...cfg, apiKey: this.form.agrometKey().trim() || cfg.apiKey }, addDays(today, -2), today);
      if (!observed.size) return this.snackbar.show('Sin muestras recientes en la estación');
      const days = [...observed.entries()].sort().map(([date, mm]) => `${date.slice(8)}/${date.slice(5, 7)}: ${decimal(mm)} mm`);
      this.snackbar.show(`Lluvia observada → ${days.join(' · ')}`);
    } catch (e) {
      this.snackbar.show(errorText(e, 'No se pudo consultar Agromet'));
    }
  }
}
