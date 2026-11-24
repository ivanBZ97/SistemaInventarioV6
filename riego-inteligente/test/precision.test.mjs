// Mejoras de precisión: probabilidad de lluvia útil con ensambles, factor de sombra y umbral automático (FAO-56).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/app/core/irrigation-core.ts';
import * as rc from '../src/app/core/rain-chance.ts';
import * as sw from '../src/app/core/soil-water.ts';
import * as v from '../src/app/pages/dashboard/dashboard.view.ts';

process.env.TZ = 'America/Santiago';

const wx = (date, o = {}) => ({ date, et0Mm: 5, precipitationMm: 0, precipitationProbMax: 0, tempMaxC: 27, windMaxKmh: 10, ...o });
const S = c.DEFAULT_SETTINGS;
const st = (o = {}) => ({ deficitMm: 9, asOf: '2026-11-24', source: 'model', ...o });
/** `n` escenarios: `wet` de ellos con `mm` milímetros y el resto secos. */
const members = (n, wet, mm) => [...Array(n - wet).fill(0), ...Array(wet).fill(mm)];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const snapOf = (evaluation, settings = S) => ({ settings, state: st(), today: '2026-11-24', backup: null, evaluation });

// ───────────── Probabilidad de lluvia útil (ensambles) ─────────────

test('ensambles: toma el control y los miembros de cada sistema, ordenados, y descarta días con pocos escenarios', () => {
  const daily = { time: ['2026-11-24', '2026-11-25'] };
  for (let i = 0; i < 25; i++)
    daily[`precipitation_sum_member${String(i + 1).padStart(2, '0')}_ecmwf_ifs025_ensemble`] = [i * 0.33, i < 5 ? 1 : null];
  daily.precipitation_sum_ecmwf_ifs025_ensemble = [7.06, null];
  daily.temperature_2m_max_ecmwf_ifs025_ensemble = [30, 30]; // otra variable: no cuenta
  const rain = rc.parseEnsemble({ daily });
  assert.equal(rain['2026-11-24'].length, 26);
  assert.deepEqual(rain['2026-11-24'].slice(0, 3), [0, 0.3, 0.7]);
  assert.equal(rain['2026-11-24'].at(-1), 7.9);
  assert.equal(rain['2026-11-25'], undefined); // solo 5 escenarios con dato
  assert.throws(() => rc.parseEnsemble({}), /sin datos diarios/);
});

test('ensambles: la consulta lleva la ubicación redondeada (~1 km) y los cuatro sistemas', () => {
  const url = rc.ensembleUrl(-33.7316, -70.7665);
  assert.match(url, /^https:\/\/ensemble-api\.open-meteo\.com\/v1\/ensemble\?latitude=-33\.73&longitude=-70\.77&/);
  assert.match(url, /daily=precipitation_sum&timezone=auto&forecast_days=10&/);
  assert.match(url, /models=ecmwf_ifs025_ensemble,google_weathernext2_ensemble,ecmwf_aifs025_ensemble,ncep_gefs025$/);
});

test('probabilidad de lluvia útil: parte de los escenarios con al menos esos mm; solo de hoy en adelante', () => {
  const w = { rainMembers: [0, 0, 1, 3.9, 4, 6, 10, 12] };
  assert.equal(rc.rainChancePct(w, 4), 50);
  assert.equal(rc.rainChancePct(w, 0.1), 75);
  assert.equal(rc.rainChancePct({}, 4), null);
  assert.equal(rc.rainChancePct(undefined, 4), null);
  const rain = { '2026-11-23': [1], '2026-11-24': [2], '2026-11-25': [3] };
  const days = rc.withEnsemble([wx('2026-11-23'), wx('2026-11-24'), wx('2026-11-25')], rain, '2026-11-24');
  assert.deepEqual(
    days.map((d) => d.rainMembers),
    [undefined, [2], [3]],
  );
  assert.deepEqual(rc.scaleMembers([2, 5, 10], 0.25), [0.5, 1.3, 2.5]);
});

test('pausa por pronóstico con ensambles: no por una llovizna probable, sí si es probable que lluevan 4 mm', () => {
  // Llovizna: los modelos dan 80 % de "lluvia" (> 0,1 mm en alguna hora) y 1,5 mm; solo 10 % de los escenarios llega a 4 mm.
  const drizzle = wx('2026-11-24', { precipitationProbMax: 80, precipitationMm: 1.5, rainMembers: members(100, 10, 5) });
  assert.equal(c.forecastPauses({ ...drizzle, rainMembers: undefined }, 9, 8), true); // la regla de los modelos pausaba
  assert.equal(c.forecastPauses(drizzle, 9, 8), false);
  // Frente: la mediana de los modelos dice 3 mm, pero el 60 % de los escenarios trae 4 mm o más.
  const front = wx('2026-11-24', { precipitationProbMax: 40, precipitationMm: 3, rainMembers: members(100, 60, 8) });
  assert.equal(c.forecastPauses({ ...front, rainMembers: undefined }, 9, 8), false);
  assert.equal(c.forecastPauses(front, 9, 8), true);
});

test('evaluación con ensambles: se riega pese a la llovizna y la pausa explica la probabilidad de 4 mm', () => {
  const at = c.atTime('2026-11-24', c.MORNING);
  const drizzle = c.evaluate(
    st(),
    [wx('2026-11-24', { precipitationProbMax: 80, precipitationMm: 1.5, rainMembers: members(100, 10, 5) })],
    S,
    '2026-11-24',
  );
  assert.equal(drizzle.status, 'irrigate');
  assert.equal(drizzle.rainUsefulProbPct, 10);

  const front = c.evaluate(
    st(),
    [wx('2026-11-24', { precipitationProbMax: 40, precipitationMm: 3, rainMembers: members(100, 60, 8) })],
    S,
    '2026-11-24',
  );
  assert.equal(front.status, 'paused_rain');
  assert.equal(front.rainBlockReason, 'forecast');
  assert.equal(front.rainUsefulProbPct, 60);
  assert.equal(c.morningNotification(front, at).body, 'Déficit de 9 mm, pero hay 60% de prob. de 4 mm o más de lluvia hoy.');
  assert.equal(v.recommendation(snapOf(front)).detail, '60 % de probabilidad de 4 mm o más · 3 mm previstos hoy.');
  const tiles = v.todayTiles(front);
  assert.equal(tiles[1].note, '60% de prob. de 4 mm o más');

  // Sin ensambles, los textos de siempre.
  const old = c.evaluate(st(), [wx('2026-11-24', { precipitationProbMax: 70, precipitationMm: 6 })], S, '2026-11-24');
  assert.equal(old.rainUsefulProbPct, null);
  assert.equal(c.morningNotification(old, at).body, 'Déficit de 9 mm, pero hay 70% de prob. de lluvia hoy.');
});

test('espera la lluvia de mañana con ensambles: solo si ≥ 70 % de los escenarios trae lo que hace falta', () => {
  // 8,5 mm hoy + 2,4 de consumo = 10,9 mañana; para quedar bajo 4 mm (mitad del umbral) faltan (10,9 − 4) / 0,8 = 8,6 mm.
  near(c.coverNeedMm(10.9, 8), 8.625);
  const today = wx('2026-11-24', { et0Mm: 3 });
  const tomorrow = (wet) =>
    wx('2026-11-25', { et0Mm: 3, precipitationMm: 12, precipitationProbMax: 90, rainMembers: members(100, wet, 9) });

  const ev = c.evaluate(st({ deficitMm: 8.5 }), [today, tomorrow(75)], S, '2026-11-24');
  assert.equal(ev.status, 'paused_rain');
  assert.equal(ev.rainBlockReason, 'tomorrow');
  assert.equal(ev.rainTomorrowCoverProbPct, 75);
  assert.match(
    c.morningNotification(ev, c.atTime('2026-11-24', c.MORNING)).body,
    /mañana se esperan 12 mm \(75% de prob\. de que basten para reponerlo\)\. Si no llueve, se riega mañana\.$/,
  );
  assert.equal(
    v.recommendation(snapOf(ev)).detail,
    'Mañana se esperan 12 mm, con 75 % de probabilidad de que basten para reponer el déficit de 8,5 mm. Si no llueve, se riega mañana.',
  );

  // La mediana de los modelos (12 mm al 90 %) bastaría, pero solo el 60 % de los escenarios trae los 8,6 mm: se riega hoy.
  assert.equal(c.evaluate(st({ deficitMm: 8.5 }), [today, tomorrow(60)], S, '2026-11-24').status, 'irrigate');
  const next = c.forecastNextIrrigation(st({ deficitMm: 8.5 }), [today, tomorrow(75)], S, '2026-11-24');
  assert.equal(next.timeline[0].waitForRain, true);
  assert.equal(next.timeline[1].usefulRainPct, 75);
});

test('hoy con estación: los escenarios del día se llevan a lo que falta (la lluvia de la madrugada ya pasó)', () => {
  const hourly = Array(24).fill(0);
  hourly[3] = hourly[4] = hourly[5] = 2; // 6 mm pronosticados entre las 03:00 y las 06:00
  const live = {
    date: '2026-11-24',
    mm: 0,
    sinceMs: Date.parse('2026-11-24T00:00:00-03:00'),
    lastAtMs: Date.parse('2026-11-24T09:00:00-03:00'),
    lastHourMm: 0,
    rainingNow: false,
    hourly: Array(24).fill(0),
    steps: [],
  };
  const day = wx('2026-11-24', {
    precipitationMm: 6,
    precipitationProbMax: 90,
    hourlyRainMm: hourly,
    live,
    rainMembers: members(100, 80, 6),
  });
  const ev = c.evaluate(st(), [day], S, '2026-11-24');
  assert.equal(ev.rainUsefulProbPct, 0); // a las 09:00 ya no queda nada de esa lluvia
  assert.equal(ev.status, 'irrigate');
  // Sin lecturas de hoy, cuenta el día completo: se pausa.
  assert.equal(c.evaluate(st(), [{ ...day, live: undefined }], S, '2026-11-24').status, 'paused_rain');
  // Si la lluvia viene en la tarde, todavía falta toda: se pausa.
  const afternoon = Array(24).fill(0);
  afternoon[15] = afternoon[16] = afternoon[17] = 2;
  const later = c.evaluate(st(), [{ ...day, hourlyRainMm: afternoon }], S, '2026-11-24');
  assert.equal(later.rainUsefulProbPct, 80);
  assert.equal(later.status, 'paused_rain');
});

test('franja de 7 días: el detalle y el ícono de lluvia usan la probabilidad de 4 mm', () => {
  const next = c.forecastNextIrrigation(
    st({ deficitMm: 2 }),
    [wx('2026-11-24'), wx('2026-11-25', { precipitationProbMax: 70, precipitationMm: 0.5, rainMembers: members(100, 20, 5) })],
    S,
    '2026-11-24',
  );
  const strip = v.forecastStrip({ ...snapOf(null), next });
  assert.equal(strip[1].usefulRainPct, 20);
  assert.equal(strip[1].rainy, false); // 70 % de que caiga algo, pero solo 20 % de 4 mm
  assert.match(v.stripDetail(strip[1], 8), /lluvia 0,5 mm \(20% de 4 mm o más\)$/);
});

// ───────────── Sol sobre el pasto ─────────────

test('sombra: el pasto consume menos (ETc × 0,8 o × 0,65) y el riego se espacia', () => {
  assert.equal(c.exposureFactor({}), 1);
  assert.equal(c.exposureFactor({ exposure: 'partial' }), 0.8);
  assert.equal(c.exposureFactor({ exposure: 'shade' }), 0.65);
  near(c.etc(5, '2026-11-24', 0.65), 2.6); // 5 × 0,8 × 0,65

  const w = ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'].map((d) => wx(`2026-11-${d}`));
  const s0 = st({ deficitMm: 0, asOf: '2026-11-20' });
  const shadeSettings = { ...S, exposure: 'shade' };
  const sun = c.evaluate(s0, w, S, '2026-11-24');
  const shade = c.evaluate(s0, w, shadeSettings, '2026-11-24');
  near(sun.deficitMm, 16); // 4 días × 4 mm
  near(shade.deficitMm, 10.4); // 4 días × 2,6 mm
  assert.equal(shade.exposureFactor, 0.65);
  near(shade.etcTodayMm, 2.6);
  assert.match(v.todayTiles(shade)[3].note, /^ETc · Kc 0,8 · sombra ×0,65$/);
  assert.equal(v.todayTiles(sun)[3].note, 'ETc · Kc 0,8');

  const fresh = st({ deficitMm: 0 });
  assert.equal(c.forecastNextIrrigation(fresh, w, S, '2026-11-24').date, '2026-11-26'); // 0 → 4 → 8
  assert.equal(c.forecastNextIrrigation(fresh, w, shadeSettings, '2026-11-24').date, '2026-11-28'); // 0 → 2,6 → … → 10,4

  // La ET0 medida corrige los días ya contados con el mismo factor (no inventa diferencias).
  const history = [{ date: '2026-11-23', etcMm: 2.6, effectiveRainMm: 0 }];
  const r = c.reconcileObservedEt0(st({ deficitMm: 5 }), history, { '2026-11-23': 5 }, 0.65);
  assert.equal(r.changed, false);
  near(c.reconcileObservedEt0(st({ deficitMm: 5 }), history, { '2026-11-23': 6 }, 0.65).state.deficitMm, 5.52);
  // El gráfico estima los días sin historial con el mismo factor.
  near(c.buildChart('2026-11-24', [], w, [], 0.65).at(-1).etcMm, 2.6);
});

// ───────────── Umbral automático ─────────────

test('umbral automático (FAO-56): agua útil × raíces × fracción agotable, corregida por el consumo del día', () => {
  near(sw.totalAvailableWater(15, 15), 22.5); // franco: 15 % × 15 cm
  assert.equal(sw.autoThreshold(15, 15), 9); // se riega al gastar el 40 %
  assert.equal(sw.autoThreshold(15, 15, 5), 9);
  assert.equal(sw.autoThreshold(15, 15, 7), 7.2); // día de calor: p = 0,32
  assert.equal(sw.autoThreshold(15, 15, 3), 10.8); // día fresco: p = 0,48
  assert.equal(sw.autoThreshold(8, 10), 3.2); // arena con pasto nuevo
  assert.equal(sw.autoThreshold(5, 10), 3); // tope inferior
  assert.equal(sw.autoThreshold(20, 30), 14); // tope superior
  assert.equal(sw.depletionFraction(20), 0.2);
  assert.equal(sw.depletionFraction(-10), 0.6);

  assert.equal(sw.baseThreshold({ thresholdMm: 8 }), 8); // manual
  assert.equal(sw.baseThreshold({ thresholdMm: 8, thresholdAuto: true }), 9); // franco, pasto establecido
  assert.equal(sw.baseThreshold({ thresholdMm: 8, thresholdAuto: true, lawnStage: 'young' }), 6); // raíces de 10 cm
  const sandyLoam = { texture: 'sandyLoam', awcPct: 13, source: 'manual' };
  assert.equal(sw.baseThreshold({ thresholdMm: 8, thresholdAuto: true, soil: sandyLoam }), 7.8);
});

test('umbral automático en la evaluación: baja los días de mucho consumo; la siembra sigue con 2 mm', () => {
  const auto = { ...S, thresholdAuto: true };
  // ET0 5 × Kc 0,8 = 4 mm de consumo → p = 0,44 → 9,9 mm
  const ev = c.evaluate(st({ deficitMm: 9.5 }), [wx('2026-11-24')], auto, '2026-11-24');
  assert.equal(ev.thresholdMm, 9.9);
  assert.equal(ev.status, 'ok');
  // ET0 8 → 6,4 mm de consumo → p = 0,344 → 7,7 mm: con 9,5 mm ya toca regar
  const hot = c.evaluate(st({ deficitMm: 9.5 }), [wx('2026-11-24', { et0Mm: 8 })], auto, '2026-11-24');
  assert.equal(hot.thresholdMm, 7.7);
  assert.equal(hot.status, 'irrigate');
  assert.equal(c.thresholdFor(c.startOverseed(st(), '2026-11-24', 'full'), auto, '2026-11-24', 4), 2);
  // Sin evaluación (sin clima), el panel muestra el umbral de los ajustes.
  assert.equal(v.thresholdOf({ ...snapOf(null, auto) }), 9);
});

/** Respuesta de SoilGrids con los valores medios de cada capa (0–5, 5–15 y 15–30 cm) en sus unidades de mapa. */
function soilGrids(values) {
  const layer = (name) => ({
    name,
    unit_measure: { d_factor: 10 },
    depths: [
      [0, 5],
      [5, 15],
      [15, 30],
    ].map(([top, bottom], i) => ({
      range: { top_depth: top, bottom_depth: bottom, unit_depth: 'cm' },
      label: `${top}-${bottom}cm`,
      values: { mean: values ? values[name][i] : null },
    })),
  });
  return { properties: { layers: ['clay', 'sand', 'silt', 'wv0033', 'wv1500'].map(layer) } };
}
/** Suelo cerca de Buin según SoilGrids (franco arenoso). */
const BUIN = {
  clay: [176, 178, 181],
  sand: [567, 563, 565],
  silt: [257, 259, 255],
  wv0033: [297, 300, 305],
  wv1500: [132, 132, 137],
};

test('SoilGrids: promedio de 0–30 cm ponderado por capa, textura y agua útil acotada al rango de FAO-56', () => {
  const sample = sw.parseSoilGrids(soilGrids(BUIN));
  assert.equal(sample.sandPct, 56.5);
  assert.equal(sample.clayPct, 17.9);
  assert.ok(Math.abs(sample.awcPct - 16.75) <= 0.06, `agua útil ${sample.awcPct}`);
  const soil = sw.soilFromSample(sample);
  assert.equal(soil.texture, 'sandyLoam');
  assert.equal(soil.awcPct, 15); // 16,8 % según SoilGrids, sobre el máximo de FAO-56 para franco arenoso
  assert.equal(soil.source, 'soilgrids');
  assert.equal(sw.parseSoilGrids(soilGrids(null)), null); // celda urbana: sin datos
  assert.throws(() => sw.parseSoilGrids({}), /sin capas/);

  assert.equal(sw.textureOf(88, 4), 'sand');
  assert.equal(sw.textureOf(75, 10), 'sand');
  assert.equal(sw.textureOf(60, 15), 'sandyLoam');
  assert.equal(sw.textureOf(40, 20), 'loam');
  assert.equal(sw.textureOf(20, 45), 'clay');
  assert.equal(sw.soilFromSample({ sandPct: 40, clayPct: 20, awcPct: null }).awcPct, 15); // sin retención: el típico
});

/** Respuesta simulada de `fetch`. */
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('detectar el suelo: si el punto del jardín es urbano usa un vecino; la ubicación va redondeada', async () => {
  const orig = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return reply(soilGrids(urls.length === 1 ? null : BUIN));
  };
  try {
    const found = await sw.detectSoil(-33.7316, -70.7665);
    assert.equal(found.nearby, true);
    assert.equal(found.soil.texture, 'sandyLoam');
    assert.equal(urls.length, 2);
    assert.match(urls[0], /^https:\/\/rest\.isric\.org\/soilgrids\/v2\.0\/properties\/query\?lon=-70\.77&lat=-33\.73&/);
    assert.match(urls[1], /lon=-70\.77&lat=-33\.71&/);
    assert.match(urls[0], /property=wv0033&property=wv1500&depth=0-5cm&depth=5-15cm&depth=15-30cm&value=mean$/);

    globalThis.fetch = async () => reply({}, 429);
    await assert.rejects(sw.detectSoil(-33.73, -70.77), /demasiadas consultas/);
    globalThis.fetch = async () => reply(soilGrids(null));
    assert.equal(await sw.detectSoil(-33.73, -70.77), null); // ningún punto con datos
  } finally {
    globalThis.fetch = orig;
  }
});
