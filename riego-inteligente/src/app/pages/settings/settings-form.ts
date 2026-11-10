import { Injectable, computed, inject, signal } from '@angular/core';
import { IrrigationEngineService } from '../../core/irrigation-engine.service';
import { NotificationService } from '../../core/notification.service';
import { BackgroundService } from '../../core/background.service';
import { DEFAULT_SETTINGS, MORNING, THRESHOLD_MAX_MM, THRESHOLD_MIN_MM, clamp } from '../../core/irrigation-core';
import { pad2 } from '../../core/format';
import { calibrationPoints } from '../../core/soil-sensor';
import type { AgrometConfig, DmcAuth, DmcConfig, Settings, SoilSensorConfig, TuyaRegion } from '../../core/models';
import { SnackbarService } from '../../ui/snackbar.service';

const DEFAULT_MORNING_TIME = `${pad2(MORNING.hour)}:${pad2(MORNING.minute)}`;

/**
 * Borrador de los ajustes mientras se editan. Las secciones de la pantalla leen y escriben aquí; nada se aplica
 * hasta "Guardar cambios" (`save`), salvo el sensor de suelo, cuya calibración se guarda al marcarla (`saveSensor`).
 * Vive lo que vive la pantalla de Ajustes (se provee en SettingsPage).
 */
@Injectable()
export class SettingsForm {
  private engine = inject(IrrigationEngineService);
  private notifications = inject(NotificationService);
  private background = inject(BackgroundService);
  private snackbar = inject(SnackbarService);

  // ───────────── Riego ─────────────
  readonly threshold = signal(DEFAULT_SETTINGS.thresholdMm);
  /** Tasa del aspersor (mm/min); NaN mientras el campo está vacío. */
  readonly rate = signal(DEFAULT_SETTINGS.sprinklerRateMmMin);
  readonly area = signal<number | null>(null);

  // ───────────── Ubicación ─────────────
  readonly lat = signal(DEFAULT_SETTINGS.latitude);
  readonly lon = signal(DEFAULT_SETTINGS.longitude);
  readonly placeName = signal<string | undefined>(undefined);
  /** Altura del lugar según el pronóstico (m); null si aún no se conoce (ubicación recién cambiada). */
  readonly elevation = signal<number | null>(null);
  /** Actualizar la ubicación sola si el teléfono se mueve más de 10 km. */
  readonly autoLocation = signal(false);

  // ───────────── Estaciones ─────────────
  readonly dmc = signal<DmcConfig | undefined>(undefined);
  readonly dmcUser = signal('');
  readonly dmcToken = signal('');
  /** Credenciales de la DMC escritas en pantalla (aunque aún no se hayan guardado). */
  readonly dmcAuth = computed<DmcAuth | undefined>(() => {
    const user = this.dmcUser().trim();
    const token = this.dmcToken().trim();
    return user && token ? { user, token } : undefined;
  });
  readonly agromet = signal<AgrometConfig | undefined>(undefined);
  readonly agrometKey = signal('');

  // ───────────── Sensor de suelo ─────────────
  readonly tuyaRegion = signal<TuyaRegion>('us');
  readonly tuyaId = signal('');
  readonly tuyaSecret = signal('');
  readonly tuyaDevice = signal('');
  readonly wetPct = signal<number | undefined>(undefined);
  readonly dryPct = signal<number | undefined>(undefined);
  readonly sensorOn = signal(false);
  /** Puntos de calibración en uso (con uno solo marcado, el otro es provisional); null si falta calibrar. */
  readonly calibration = computed(() => calibrationPoints({ wetPct: this.wetPct(), dryPct: this.dryPct() }));
  /** Sensor tal como está escrito en pantalla; undefined mientras falte alguna de sus tres claves. */
  readonly sensor = computed<SoilSensorConfig | undefined>(() => {
    const accessId = this.tuyaId().trim();
    const accessSecret = this.tuyaSecret().trim();
    const deviceId = this.tuyaDevice().trim();
    if (!accessId || !accessSecret || !deviceId) return undefined;
    return {
      region: this.tuyaRegion(),
      accessId,
      accessSecret,
      deviceId,
      wetPct: this.wetPct(),
      dryPct: this.dryPct(),
      enabled: this.sensorOn() && this.calibration() !== null,
    };
  });

  // ───────────── Notificaciones ─────────────
  readonly morningTime = signal(DEFAULT_MORNING_TIME);
  readonly quietOk = signal(false);

  /** Ajustes en uso (los últimos guardados). */
  get saved(): Settings {
    return this.engine.snapshot()?.settings ?? DEFAULT_SETTINGS;
  }

  /** Carga en el borrador los ajustes guardados. */
  async load(): Promise<void> {
    const { settings: s, elevationM } = await this.engine.ready();
    this.threshold.set(s.thresholdMm);
    this.rate.set(s.sprinklerRateMmMin);
    this.area.set(s.lawnAreaM2 ?? null);
    this.lat.set(s.latitude);
    this.lon.set(s.longitude);
    this.placeName.set(s.placeName);
    this.elevation.set(elevationM !== null ? Math.round(elevationM) : null);
    this.autoLocation.set(s.useGps);
    this.dmc.set(s.dmc);
    this.dmcUser.set(s.dmcAuth?.user ?? '');
    this.dmcToken.set(s.dmcAuth?.token ?? '');
    this.agromet.set(s.agromet);
    this.agrometKey.set(s.agromet?.apiKey ?? '');
    const sensor = s.soilSensor;
    if (sensor) {
      this.tuyaRegion.set(sensor.region);
      this.tuyaId.set(sensor.accessId);
      this.tuyaSecret.set(sensor.accessSecret);
      this.tuyaDevice.set(sensor.deviceId);
      this.wetPct.set(sensor.wetPct);
      this.dryPct.set(sensor.dryPct);
      this.sensorOn.set(sensor.enabled);
    }
    this.morningTime.set(s.morningTime ?? DEFAULT_MORNING_TIME);
    this.quietOk.set(!!s.quietOkAlerts);
  }

  /** Fija la ubicación del jardín (GPS o búsqueda). La altura se vuelve a conocer con el próximo pronóstico. */
  setLocation(latitude: number, longitude: number, placeName: string | undefined, auto: boolean): void {
    this.lat.set(latitude);
    this.lon.set(longitude);
    this.placeName.set(placeName);
    this.autoLocation.set(auto);
    this.elevation.set(null);
  }

  /** "Guardar cambios": valida, guarda todo el borrador y reprograma los avisos. */
  async save(): Promise<void> {
    const rate = this.rate();
    if (!(rate > 0)) return this.snackbar.show('La tasa del aspersor debe ser mayor que 0');
    if (!Number.isFinite(this.lat()) || !Number.isFinite(this.lon())) return this.snackbar.show('Revisa la latitud y la longitud');
    const area = this.area();
    const agromet = this.agromet();
    await this.apply({
      thresholdMm: clamp(this.threshold(), THRESHOLD_MIN_MM, THRESHOLD_MAX_MM),
      sprinklerRateMmMin: rate,
      lawnAreaM2: area !== null && area > 0 ? clamp(area, 1, 100_000) : undefined,
      latitude: clamp(this.lat(), -90, 90),
      longitude: clamp(this.lon(), -180, 180),
      placeName: this.placeName(),
      useGps: this.autoLocation(),
      locationSet: true,
      dmc: this.dmc(),
      dmcAuth: this.dmcAuth(),
      agromet: agromet ? { ...agromet, apiKey: this.agrometKey().trim() || agromet.apiKey } : undefined,
      soilSensor: this.sensor(),
      morningTime: this.morningTime(),
      quietOkAlerts: this.quietOk(),
    });
    this.snackbar.show('Ajustes guardados');
  }

  /**
   * Guarda solo el sensor (claves, calibración y si se usa), sin tocar el resto del borrador: es fácil olvidar
   * "Guardar cambios" después de calibrar y perder el punto recién marcado.
   */
  saveSensor(): Promise<void> {
    return this.apply({ soilSensor: this.sensor() });
  }

  private async apply(settings: Partial<Settings>): Promise<void> {
    await this.engine.saveSettings(settings);
    await this.notifications.reschedule();
    await this.background.sync();
  }
}
