import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/app/pages/dashboard/dashboard.view.ts';

process.env.TZ = 'America/Santiago';

const NOW = Date.parse('2026-11-09T10:00:00-03:00');
const MIN = 60_000;

const evaluation = (o = {}) => ({
  date: '2026-11-09',
  status: 'irrigate',
  deficitMm: 8.4,
  minutes: 9,
  etcYesterdayMm: 3.6,
  kc: 0.8,
  tempMaxC: 27,
  rainProbPct: 5,
  rainForecastMm: 0,
  rainForecastLeftMm: null,
  rainMeasuredMm: null,
  rainingNow: false,
  rainBlockReason: null,
  rainTomorrowMm: 0,
  rainTomorrowProbPct: 0,
  overseed: null,
  thresholdMm: 8,
  effectiveRainTodayMm: 0,
  etcTodayMm: 3.7,
  projectedDeficitMm: 12.1,
  windMaxKmh: 14,
  windWarning: false,
  rainBlock: false,
  humidityPct: 44,
  ...o,
});

const snapshot = (o = {}) => ({
  settings: { thresholdMm: 8, sprinklerRateMmMin: 0.93, lawnAreaM2: 24, latitude: -33.73, longitude: -70.77, useGps: false, locationSet: true, placeName: 'Buin, Región Metropolitana' },
  state: { deficitMm: 8.4, asOf: '2026-11-09', source: 'model' },
  today: '2026-11-09',
  evaluation: evaluation(),
  next: null,
  rainOverrides: {},
  chart: [],
  irrigations: [],
  month: { days: 0, irrigations: 0, irrigationMm: 0, rainMm: 0, etcMm: 0, liters: null },
  overseedDaysLeft: 0,
  staleWeather: false,
  elevationM: 458,
  rainSource: null,
  et0Source: null,
  et0Ratio: null,
  liveRain: null,
  station: null,
  backup: null,
  sensor: null,
  sensorError: null,
  error: null,
  ...o,
});

test('recomendación: regar con minutos y litros; pospuesto; sin clima', () => {
  const water = v.recommendation(snapshot());
  assert.equal(water.cls, 'water');
  assert.equal(water.title, 'Riega 9 minutos hoy');
  assert.match(water.detail, /^Entre 06:30 y 08:30\. Déficit acumulado de 8,4 mm \(≈ 202 L\)\.$/);

  const snoozed = v.recommendation(snapshot({ state: { deficitMm: 8.4, asOf: '2026-11-09', source: 'model', snoozedDate: '2026-11-09' } }));
  assert.equal(snoozed.title, 'Riego pospuesto para mañana');

  assert.deepEqual(v.recommendation(snapshot({ evaluation: null, error: 'Sin conexión' })), {
    cls: 'neutral', icon: 'umbrella-outline', title: 'Sin datos del clima', detail: 'Sin conexión',
  });
  assert.equal(v.recommendation(null).detail, 'Cargando…');
});

test('recomendación: cada motivo de pausa por lluvia se explica distinto', () => {
  const paused = (o) => v.recommendation(snapshot({ evaluation: evaluation({ status: 'paused_rain', rainBlock: true, ...o }), settings: { ...snapshot().settings, dmc: { code: '1', name: 'El Milagro', distanceKm: 4 } } }));
  assert.equal(paused({ rainBlockReason: 'tomorrow', rainTomorrowMm: 12, rainTomorrowProbPct: 80 }).title, 'Espera la lluvia de mañana');
  assert.match(paused({ rainBlockReason: 'raining', rainMeasuredMm: 1.2 }).detail, /^1,2 mm hoy en El Milagro\./);
  assert.equal(paused({ rainBlockReason: 'measured', rainMeasuredMm: 5 }).detail, 'Hoy ya llovieron 5 mm en El Milagro.');
  assert.match(paused({ rainBlockReason: 'forecast', rainProbPct: 70, rainForecastMm: 6 }).detail, /^70% de probabilidad · 6 mm previstos hoy\.$/);
  assert.match(paused({ rainBlockReason: 'forecast', rainProbPct: 70, rainForecastMm: 6, rainForecastLeftMm: 2.5 }).detail, /2,5 mm previstos para lo que queda de hoy/);
});

test('recomendación sin riego: menciona la lluvia medida y el umbral del día', () => {
  const ok = v.recommendation(snapshot({ evaluation: evaluation({ status: 'ok', deficitMm: 3, rainMeasuredMm: 0.6, thresholdMm: 2 }) }));
  assert.equal(ok.cls, 'ok');
  assert.equal(ok.detail, 'Hoy ya llovieron 0,6 mm en la estación. Se riega al llegar a 2 mm de déficit.');
});

test('etiqueta del sensor: en uso, sin calibrar, solo informativo o sin conexión', () => {
  const reading = (o = {}) => ({ name: 'S', at: NOW - 20 * MIN, soilPct: 92, tempC: 25, battery: 100, deficitMm: 1.3, ...o });
  const sensor = (enabled) => ({ ...snapshot().settings, soilSensor: { region: 'us', accessId: 'a', accessSecret: 'b', deviceId: 'c', enabled } });
  assert.equal(v.sensorTag(snapshot({ sensor: reading(), settings: sensor(false) }), NOW), 'Sensor: 92 % (hace 20 min) · solo informativo');
  assert.equal(v.sensorTag(snapshot({ sensor: reading({ deficitMm: null }), settings: sensor(false) }), NOW), 'Sensor: 92 % (hace 20 min) · sin calibrar');
  assert.equal(v.sensorTag(snapshot({ sensor: reading({ at: NOW - 200 * MIN }), state: { deficitMm: 1.3, asOf: '2026-11-09', source: 'sensor' }, settings: sensor(true) }), NOW), 'Sensor: 92 % (hace 3 h) · en uso');
  assert.equal(v.sensorTag(snapshot({ sensorError: 'sin conexión con Tuya' }), NOW), 'Sensor de suelo sin conexión');
  assert.equal(v.sensorTag(snapshot(), NOW), null);
});

test('lluvia en tu sector: con datos viejos explica qué pasó en la última consulta', () => {
  const hourly = new Array(24).fill(0);
  hourly[8] = 0.6;
  const liveRain = { date: '2026-11-09', mm: 0.6, sinceMs: NOW - 10 * 60 * MIN, lastAtMs: NOW - 30 * MIN, lastHourMm: 0, rainingNow: false, hourly, steps: [] };
  const settings = { ...snapshot().settings, dmc: { code: '330160', name: 'El Milagro', distanceKm: 4.2 } };
  const live = v.liveRainView(snapshot({ liveRain, settings }), NOW);
  assert.equal(live.chip, 'live');
  assert.equal(live.until, 'las 09:30');
  assert.equal(live.ago, 'hace 30 min');
  assert.equal(live.check, null);
  assert.equal(live.bars[8].pct, 60); // la escala llega al menos a 1 mm
  assert.equal(live.bars[11].future, true);
  assert.equal(v.hourDetail(live, 8), '08:00–09:00 · 0,6 mm');

  const stale = v.liveRainView(snapshot({ liveRain: { ...liveRain, lastAtMs: NOW - 5 * 60 * MIN }, settings, station: { attemptAt: NOW - 5 * MIN, ok: false, error: 'HTTP 503' } }), NOW);
  assert.equal(stale.chip, 'stale');
  assert.equal(stale.lastHour, null);
  assert.equal(stale.check, 'Última consulta a las 09:55: la DMC respondió con error (HTTP 503). Mientras tanto se usa el pronóstico.');
  assert.equal(v.liveRainView(snapshot({ liveRain }), NOW), null); // sin estación configurada
});

test('registrar riego: opciones sin repetir lo recomendado y vista previa del agua', () => {
  assert.deepEqual(v.irrigationOptions(10).map((o) => o.label), ['Lo recomendado (10 min)', '5 min', '15 min', '20 min']);
  assert.deepEqual(v.irrigationOptions(null).map((o) => o.min), [5, 10, 15, 20]);
  const full = v.irrigationPreview(snapshot(), 9, true);
  assert.equal(full.water, '≈ 8,4 mm de agua · 202 L');
  assert.match(full.left, /^Repone todo el déficit/);
  assert.equal(v.irrigationPreview(snapshot(), 5, false).left, 'El déficit queda en 3,8 mm.');
});

test('próximo riego y franja de días', () => {
  const day = (date, o = {}) => ({ date, deficitMm: 4, etcMm: 3.5, rainMm: 0, effectiveRainMm: 0, rainProbPct: 5, rainBlock: false, waitForRain: false, irrigate: false, ...o });
  const next = { date: '2026-11-11', daysAhead: 2, minutes: 11, deficitMm: 10.1, beyondForecast: false, delayedByRain: '2026-11-10', timeline: [day('2026-11-09'), day('2026-11-10', { rainMm: 6 }), day('2026-11-11', { deficitMm: 10.1, irrigate: true })] };
  const view = v.nextIrrigationView(snapshot({ next }));
  assert.equal(view.when, 'Miércoles 11 de noviembre');
  assert.equal(view.lead, 'En 2 días, entre 06:30 y 08:30');
  assert.deepEqual(view.notes, ['La lluvia prevista del martes retrasa el riego.']);
  const strip = v.forecastStrip(snapshot({ next }));
  assert.deepEqual(strip.map((d) => d.label), ['Hoy', 'Mar', 'Mié']);
  assert.equal(strip[2].fill, 100);
  assert.equal(strip[1].rainy, true);
  assert.match(v.stripDetail(strip[2], 8), /^Miércoles 11 de noviembre · Día de riego · déficit 10,1 mm/);
});
