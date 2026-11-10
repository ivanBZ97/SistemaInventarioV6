// Textos y cifras del Dashboard a partir del snapshot del motor. Funciones puras (sin Angular): la pantalla solo
// las muestra, y se pueden probar sin levantar la app.
import { DAY_MS, type ISODate, atTime, longDateEs, toISODate, weekdayEs } from '../../core/dates';
import { LIVE_FRESH_MS } from '../../core/dmc';
import { capitalize, clock, fmt, pad2 } from '../../core/format';
import type { Snapshot } from '../../core/irrigation-engine.service';
import { type ForecastDay, type MonthSummary, humidityPct, litersFor } from '../../core/irrigation-core';
import type { ChartDay, Evaluation, OverseedArea } from '../../core/models';

/** Ventana en que se recomienda regar (nunca de noche). */
const WINDOW = 'entre 06:30 y 08:30';

/** Umbral de riego usado si aún no hay ajustes cargados. */
const DEFAULT_THRESHOLD_MM = 8;

// ───────────── Tarjeta principal ─────────────

/** Déficit actual (mm): el evaluado hoy o, sin clima, el último guardado. */
export function deficitOf(snap: Snapshot | null): number {
  return snap?.evaluation?.deficitMm ?? snap?.state.deficitMm ?? 0;
}

/** Umbral de hoy: el de Ajustes, o el de siembra (2 mm) si hay Resiembra de todo el jardín. */
export function thresholdOf(snap: Snapshot | null): number {
  return snap?.evaluation?.thresholdMm ?? snap?.settings.thresholdMm ?? DEFAULT_THRESHOLD_MM;
}

/** La evaluación con el pronóstico de lluvia de lo que queda de hoy (si la estación ya midió parte del día). */
export function evaluationNow(ev: Evaluation | null | undefined): Evaluation | null {
  if (!ev || ev.rainForecastLeftMm === null) return ev ?? null;
  return { ...ev, rainForecastMm: ev.rainForecastLeftMm, rainProbPct: ev.rainForecastLeftMm >= 1 ? ev.rainProbPct : 0 };
}

/** "Buin · 458 m" */
export function placeLabel(snap: Snapshot | null): string {
  if (!snap) return '';
  const { placeName, latitude, longitude } = snap.settings;
  const name = (placeName ?? `${latitude}, ${longitude}`).split(',')[0];
  return snap.elevationM !== null ? `${name} · ${Math.round(snap.elevationM)} m` : name;
}

/** Lo que marca el sensor de suelo y si se está usando en el balance. */
export function sensorTag(snap: Snapshot | null, now: number): string | null {
  if (!snap) return null;
  if (snap.sensorError) return 'Sensor de suelo sin conexión';
  const inUse = snap.state.source === 'sensor';
  const r = snap.sensor;
  if (!r) return inUse ? 'Dato de sensor' : null;
  const min = Math.max(0, Math.round((now - r.at) / 60_000));
  const ago = min < 90 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
  const used = inUse ? ' · en uso' : r.deficitMm === null ? ' · sin calibrar' : !snap.settings.soilSensor?.enabled ? ' · solo informativo' : '';
  return `Sensor: ${fmt(r.soilPct)} % (${ago})${used}`;
}

// ───────────── Recomendación ─────────────

export interface Recommendation {
  /** Estilo de la tarjeta. */
  cls: 'water' | 'ok' | 'neutral';
  icon: string;
  title: string;
  detail: string;
}

/** Qué hacer hoy, en palabras: regar (y cuánto), esperar la lluvia o nada. */
export function recommendation(snap: Snapshot | null): Recommendation {
  const ev = snap?.evaluation;
  if (!snap || !ev) return { cls: 'neutral', icon: 'umbrella-outline', title: 'Sin datos del clima', detail: snap?.error ?? 'Cargando…' };
  const mm = fmt(ev.deficitMm);
  if (ev.status === 'irrigate' && snap.state.snoozedDate === snap.today) {
    return {
      cls: 'neutral',
      icon: 'time-outline',
      title: 'Riego pospuesto para mañana',
      detail: `Hoy no se riega. Mañana se recalcula con el déficit que haya (hoy ${mm} mm).`,
    };
  }
  const patches = ev.overseed === 'patches' ? ' Rocía también los parches sembrados unos 30 s.' : '';
  if (ev.status === 'irrigate') {
    const wind = ev.windWarning ? ` Viento de ${Math.round(ev.windMaxKmh)} km/h: riega temprano.` : '';
    if (ev.overseed === 'full') {
      return {
        cls: 'water',
        icon: 'water-outline',
        title: `Riego de siembra: ${ev.minutes} min`,
        detail: `Riego corto en todo el jardín para mantener húmeda la semilla. Si hace calor, repite a las 13:00.${wind}`,
      };
    }
    const liters = litersFor(ev.deficitMm, snap.settings.lawnAreaM2);
    return {
      cls: 'water',
      icon: 'water-outline',
      title: `Riega ${ev.minutes} minutos hoy`,
      detail: `${capitalize(WINDOW)}. Déficit acumulado de ${mm} mm${liters ? ` (≈ ${fmt(liters, 0)} L)` : ''}.${wind}${patches}`,
    };
  }
  const station = snap.backup?.name ?? snap.settings.dmc?.name ?? 'la estación';
  const fell = ev.rainMeasuredMm ?? 0;
  if (ev.status === 'paused_rain') {
    switch (ev.rainBlockReason) {
      case 'tomorrow':
        return {
          cls: 'neutral',
          icon: 'umbrella-outline',
          title: 'Espera la lluvia de mañana',
          detail: `Mañana se esperan ${fmt(ev.rainTomorrowMm)} mm (${Math.round(ev.rainTomorrowProbPct)} %): reponen el déficit de ${mm} mm sin regar hoy. Si no llueve, se riega mañana.`,
        };
      case 'raining':
        return {
          cls: 'neutral',
          icon: 'rainy-outline',
          title: 'Está lloviendo en tu sector',
          detail: `${fmt(fell)} mm hoy en ${station}. Espera a que pare: la app descuenta lo que cae.`,
        };
      case 'measured':
        return { cls: 'neutral', icon: 'rainy-outline', title: 'Riego en pausa por lluvia', detail: `Hoy ya llovieron ${fmt(fell)} mm en ${station}.` };
      default:
        return {
          cls: 'neutral',
          icon: 'umbrella-outline',
          title: 'Riego en pausa por lluvia',
          detail:
            ev.rainForecastLeftMm !== null
              ? `${Math.round(ev.rainProbPct)}% de probabilidad · ${fmt(ev.rainForecastLeftMm)} mm previstos para lo que queda de hoy.`
              : `${Math.round(ev.rainProbPct)}% de probabilidad · ${fmt(ev.rainForecastMm)} mm previstos hoy.`,
        };
    }
  }
  const threshold = `Se riega al llegar a ${fmt(thresholdOf(snap))} mm de déficit.`;
  return {
    cls: 'ok',
    icon: 'leaf-outline',
    title: 'No es necesario regar',
    detail: (fell > 0 ? `Hoy ya llovieron ${fmt(fell)} mm en ${station}. ` : 'El suelo tiene humedad suficiente. ') + threshold + patches,
  };
}

// ───────────── Lluvia en tu sector (casi en tiempo real) ─────────────

export interface LiveRainView {
  station: string;
  /** La elegida no publica: se muestra la de respaldo y se explica por qué. */
  backupNote: string | null;
  mm: string;
  /** Hay lecturas de hoy. */
  hasToday: boolean;
  anyRain: boolean;
  /** "las 18:45", "ayer a las 16:00"… */
  until: string;
  ago: string;
  chip: 'raining' | 'live' | 'stale';
  /** Con datos viejos: qué pasó en la última consulta. */
  check: string | null;
  /** Desde qué hora hay lecturas, si no es desde la medianoche. */
  since: string | null;
  lastHour: string | null;
  forecast: string | null;
  bars: { h: number; mm: number; pct: number; future: boolean }[];
}

/** Por qué no llegan lecturas nuevas, según el resultado de la última consulta. */
function staleReason(station: NonNullable<Snapshot['station']>): string {
  if (station.ok) return 'la DMC no tiene lecturas más nuevas de la estación';
  switch (station.error) {
    case 'sin lecturas':
      return 'la DMC no entregó lecturas de la estación';
    case 'sin conexión':
      return 'no se pudo conectar con la DMC';
    case 'sin campo de lluvia':
      return 'la respuesta no trae el dato de lluvia';
    default:
      return `la DMC respondió con error (${station.error ?? 'desconocido'})`;
  }
}

/** "hace 12 min", "hace 3 h 20 min" o "hace 2 días" */
function agoPrecise(min: number): string {
  if (min < 60) return `hace ${min} min`;
  if (min < 24 * 60) return `hace ${Math.floor(min / 60)} h ${min % 60} min`;
  const days = Math.floor(min / 1440);
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

export function liveRainView(snap: Snapshot | null, now: number): LiveRainView | null {
  const rain = snap?.liveRain;
  const dmc = snap?.settings.dmc;
  if (!snap || !dmc || !rain) return null;
  const midnight = atTime(snap.today, { hour: 0, minute: 0 }).getTime();
  /** "las 18:45", "ayer a las 16:00" o "el sábado 24/10 a las 16:00" */
  const when = (t: number) => {
    if (t >= midnight) return `las ${clock(t)}`;
    if (t >= midnight - DAY_MS) return `ayer a las ${clock(t)}`;
    const d = new Date(t);
    return `el ${weekdayEs(toISODate(d))} ${d.getDate()}/${d.getMonth() + 1} a las ${clock(t)}`;
  };
  const hasToday = rain.sinceMs !== null;
  const chip = rain.rainingNow ? 'raining' : now - rain.lastAtMs <= LIVE_FRESH_MS ? 'live' : 'stale';
  const station = snap.station;
  const ev = snap.evaluation;
  const max = Math.max(1, ...rain.hourly);
  const hourNow = new Date(now).getHours();
  return {
    station: snap.backup?.name ?? dmc.name,
    backupNote: snap.backup
      ? `${dmc.name} no está publicando: se usa ${snap.backup.name} (${fmt(snap.backup.distanceKm)} km), la siguiente más cercana.`
      : null,
    mm: fmt(hasToday ? rain.mm : 0),
    hasToday,
    anyRain: hasToday && rain.mm > 0,
    until: when(rain.lastAtMs),
    ago: agoPrecise(Math.max(0, Math.round((now - rain.lastAtMs) / 60_000))),
    chip,
    // Sin datos nuevos: se explica qué pasó en la última consulta (la estación no publica, error, sin red).
    check:
      chip === 'stale' && station
        ? `Última consulta ${station.attemptAt >= midnight ? `a las ${clock(station.attemptAt)}` : when(station.attemptAt)}: ${staleReason(station)}. Mientras tanto se usa el pronóstico.`
        : null,
    since: rain.sinceMs !== null && rain.sinceMs > midnight + 10 * 60_000 ? clock(rain.sinceMs) : null,
    // Con datos viejos, "la última hora" sería la de ayer: no se muestra.
    lastHour: chip === 'stale' ? null : fmt(rain.lastHourMm),
    forecast: !ev
      ? null
      : ev.rainForecastLeftMm !== null
        ? `Pronóstico para el resto del día: ${fmt(ev.rainForecastLeftMm)} mm`
        : `Pronóstico para hoy: ${fmt(ev.rainForecastMm)} mm (${Math.round(ev.rainProbPct)} %)`,
    bars: rain.hourly.map((mm, h) => ({ h, mm, pct: mm > 0 ? Math.max(8, (mm / max) * 100) : 0, future: h > hourNow })),
  };
}

/** "13:00–14:00 · 0,4 mm" */
export function hourDetail(view: LiveRainView | null, hour: number | null): string | null {
  if (hour === null || !view?.bars[hour]) return null;
  return `${pad2(hour)}:00–${pad2((hour + 1) % 24)}:00 · ${fmt(view.bars[hour].mm)} mm`;
}

// ───────────── Próximo riego (pronóstico) ─────────────

export interface NextIrrigationView {
  when: string;
  lead: string;
  minutes: number;
  deficit: string;
  notes: string[];
  /** Estimado más allá del pronóstico disponible. */
  beyond: boolean;
}

export function nextIrrigationView(snap: Snapshot | null): NextIrrigationView | null {
  const next = snap?.next;
  if (!snap || !next) return null;
  const days = next.daysAhead;
  const notes: string[] = [];
  if (next.beyondForecast) notes.push('Estimado más allá del pronóstico disponible; se irá ajustando.');
  if (next.delayedByRain === snap.today) notes.push('La lluvia de hoy retrasa el riego.');
  else if (next.delayedByRain) notes.push(`La lluvia prevista del ${weekdayEs(next.delayedByRain)} retrasa el riego.`);
  return {
    when: days === 0 ? 'Hoy' : days === 1 ? 'Mañana' : capitalize(longDateEs(next.date)),
    lead: days === 0 ? capitalize(WINDOW) : days === 1 ? `Mañana ${WINDOW}` : `En ${days} días, ${WINDOW}`,
    minutes: next.minutes,
    deficit: fmt(next.deficitMm),
    notes,
    beyond: next.beyondForecast,
  };
}

export interface StripDay extends ForecastDay {
  label: string;
  dayNum: number;
  /** Déficit relativo al umbral (0–100). */
  fill: number;
  rainy: boolean;
}

/** Franja de los próximos 7 días: barra = déficit relativo al umbral. */
export function forecastStrip(snap: Snapshot | null): StripDay[] {
  const threshold = thresholdOf(snap);
  return (snap?.next?.timeline ?? []).slice(0, 7).map((d, i) => ({
    ...d,
    label: i === 0 ? 'Hoy' : capitalize(weekdayEs(d.date).slice(0, 3)),
    dayNum: Number(d.date.slice(8)),
    fill: Math.min(100, (d.deficitMm / threshold) * 100),
    rainy: d.rainMm >= 1 || d.rainProbPct >= 50,
  }));
}

export function stripDetail(day: StripDay | undefined, thresholdMm: number): string | null {
  if (!day) return null;
  const what = day.irrigate
    ? 'Día de riego'
    : day.waitForRain
      ? 'Sin riego: llueve al día siguiente'
      : day.rainBlock
        ? 'Riego bloqueado por lluvia'
        : day.deficitMm >= thresholdMm
          ? 'Pospuesto'
          : 'Sin riego';
  return `${capitalize(longDateEs(day.date))} · ${what} · déficit ${fmt(day.deficitMm)} mm · lluvia ${fmt(day.rainMm)} mm (${Math.round(day.rainProbPct)}%)`;
}

// ───────────── Mosaicos ─────────────

export interface Tile {
  icon?: string;
  label: string;
  value: string;
  note: string;
  warn?: boolean;
}

/** Hoy en el jardín: temperatura, lluvia prevista, viento y consumo del pasto. */
export function todayTiles(ev: Evaluation | null | undefined): Tile[] {
  if (!ev) return [];
  return [
    { icon: 'thermometer-outline', label: 'Temp. máxima', value: `${Math.round(ev.tempMaxC)}°`, note: 'Hoy' },
    ev.rainForecastLeftMm !== null
      ? { icon: 'rainy-outline', label: 'Lluvia prevista', value: `${fmt(ev.rainForecastLeftMm)} mm`, note: `lo que falta de hoy (el día: ${fmt(ev.rainForecastMm)} mm)` }
      : { icon: 'rainy-outline', label: 'Lluvia prevista', value: `${fmt(ev.rainForecastMm)} mm`, note: `${Math.round(ev.rainProbPct)}% de prob.` },
    { icon: 'flag-outline', label: 'Viento máx.', value: `${Math.round(ev.windMaxKmh)} km/h`, note: ev.windWarning ? 'Fuerte: riega temprano' : 'Normal', warn: ev.windWarning },
    { icon: 'leaf-outline', label: 'Consumo del pasto', value: `${fmt(ev.etcTodayMm)} mm`, note: `ETc · Kc ${fmt(ev.kc, 2)}` },
  ];
}

/** Déficit estimado para mañana. */
export function tomorrowView(ev: Evaluation | null | undefined): { value: string; note: string } | null {
  if (!ev) return null;
  return {
    value: `${fmt(ev.projectedDeficitMm)} mm`,
    note: `Hoy consume ${fmt(ev.etcTodayMm)} mm y la lluvia aporta ${fmt(ev.effectiveRainTodayMm)} mm`,
  };
}

/** Últimos 30 días, en cifras (null si aún no hay días ni riegos registrados). */
export function monthTiles(month: MonthSummary | undefined): Tile[] | null {
  if (!month || (!month.days && !month.irrigations)) return null;
  return [
    { label: 'Riegos', value: String(month.irrigations), note: month.irrigations === 1 ? 'vez' : 'veces' },
    {
      label: 'Agua de riego',
      value: `${fmt(month.irrigationMm, 0)} mm`,
      note: month.liters !== null ? `≈ ${fmt(month.liters, 0)} litros` : 'indica la superficie en Ajustes para ver litros',
    },
    { label: 'Lluvia útil', value: `${fmt(month.rainMm, 0)} mm`, note: `en ${month.days} ${month.days === 1 ? 'día registrado' : 'días registrados'}` },
    { label: 'Consumo del pasto', value: `${fmt(month.etcMm, 0)} mm`, note: 'evapotranspiración (ETc)' },
  ];
}

// ───────────── Modo Resiembra ─────────────

export function overseedText(daysLeft: number, area: OverseedArea): string {
  if (daysLeft <= 0) return 'Riego especial mientras germina la semilla nueva (10 días)';
  const days = `quedan ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'}`;
  return area === 'full'
    ? `Todo el jardín · ${days}. Riego corto cada mañana y otro a las 13:00 si hace ≥ 20 °C.`
    : `Por sectores · ${days}. El pasto se riega normal; rocía lo sembrado 30 s cada día.`;
}

// ───────────── Gráfico de 7 días ─────────────

/** Alto del área de barras y ancho de cada día, en unidades del viewBox (320 × 152). */
export const WEEK_CHART = { height: 128, slot: 300 / 7, barWidth: 10 } as const;

export interface WeekBar {
  day: ChartDay;
  label: string;
  /** Columna del día (para el toque y el resaltado). */
  slotX: number;
  slot: number;
  /** Barra de pérdida (ETc) y de reposición (riego + lluvia). */
  etc: { x: number; y: number; h: number };
  water: { x: number; y: number; h: number };
  w: number;
  /** Centro de la columna (etiqueta del día). */
  lx: number;
}

/** Fecha larga con mayúscula inicial: "Lunes, 9 de noviembre". */
export function longDate(date: ISODate): string {
  return capitalize(atTime(date, { hour: 12, minute: 0 }).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' }));
}

export function weekBars(days: ChartDay[]): WeekBar[] {
  const { height, slot, barWidth } = WEEK_CHART;
  const max = Math.max(4, ...days.map((d) => Math.max(d.etcMm, d.replenishedMm)));
  const h = (v: number) => Math.max(v > 0 ? 3 : 0, (v / max) * (height - 12));
  return days.map((day, i) => {
    const x = 10 + i * slot;
    return {
      day,
      label: capitalize(weekdayEs(day.date).slice(0, 3)),
      slotX: x,
      slot,
      etc: { x: x + slot / 2 - 11, y: height - h(day.etcMm), h: h(day.etcMm) },
      water: { x: x + slot / 2 + 1, y: height - h(day.replenishedMm), h: h(day.replenishedMm) },
      w: barWidth,
      lx: x + slot / 2,
    };
  });
}

export interface SelectedDay {
  date: ISODate;
  title: string;
  loss: string;
  gain: string;
  detail: string;
  /** Se puede corregir la lluvia (solo días ya pasados). */
  canCorrect: boolean;
}

export function selectedDayView(day: ChartDay, snap: Snapshot | null): SelectedDay {
  const corrected = snap?.rainOverrides[day.date];
  return {
    date: day.date,
    title: longDate(day.date) + (day.estimated ? ' · estimado' : ''),
    loss: fmt(day.etcMm),
    gain: fmt(day.replenishedMm),
    detail: `Lluvia útil ${fmt(day.rainMm)} mm · Riego ${fmt(day.irrigationMm)} mm` + (corrected !== undefined ? ` · lluvia medida: ${fmt(corrected)} mm` : ''),
    canCorrect: !!snap && day.date < snap.today,
  };
}

// ───────────── Registrar riego ─────────────

/** Tope del selector de minutos de riego. */
export const MAX_IRRIGATION_MINUTES = 40;

export interface IrrigationOption {
  min: number;
  label: string;
  /** "Lo recomendado": repone todo el déficit (no los minutos redondeados). */
  full: boolean;
}

export function irrigationOptions(recommendedMinutes: number | null): IrrigationOption[] {
  const options: IrrigationOption[] = recommendedMinutes ? [{ min: recommendedMinutes, label: `Lo recomendado (${recommendedMinutes} min)`, full: true }] : [];
  for (const min of [5, 10, 15, 20]) if (min !== recommendedMinutes) options.push({ min, label: `${min} min`, full: false });
  return options;
}

/** Cuánta agua es el riego que se va a registrar y cómo queda el déficit. */
export function irrigationPreview(snap: Snapshot | null, minutes: number, full: boolean): { water: string; left: string } {
  const deficit = deficitOf(snap);
  const mm = full ? deficit : minutes * (snap?.settings.sprinklerRateMmMin ?? 0);
  const liters = litersFor(mm, snap?.settings.lawnAreaM2);
  const left = Math.max(0, deficit - mm);
  return {
    water: `≈ ${fmt(mm)} mm de agua${liters ? ` · ${fmt(liters, 0)} L` : ''}`,
    left: left > 0 ? `El déficit queda en ${fmt(left)} mm.` : 'Repone todo el déficit: el suelo queda en capacidad de campo.',
  };
}

/** Humedad útil (%) equivalente a un déficit, para la vista previa del ajuste manual. */
export const humidityOf = (deficitMm: number) => Math.round(humidityPct(deficitMm));
