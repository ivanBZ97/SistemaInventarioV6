import test from 'node:test';
import assert from 'node:assert/strict';
import * as fao from '../src/app/core/fao56.ts';
import * as dmc from '../src/app/core/dmc.ts';
import * as core from '../src/app/core/irrigation-core.ts';

process.env.TZ = 'America/Santiago';

test('FAO-56 Ejemplo 18 (Bruselas, 6 de julio): ET0 = 3,9 mm/día', () => {
  const et0 = fao.et0PenmanMonteith({ tmaxC: 21.5, tminC: 12.3, eaKpa: 1.409, rsMJ: 22.07, u2: 2.078 }, 50.8, 100, '2026-07-06');
  assert.ok(Math.abs(et0 - 3.88) < 0.05, String(et0));
  assert.equal(fao.dayOfYear('2026-07-06'), 187);
  assert.ok(Math.abs(fao.WIND_10M_TO_2M - 0.748) < 0.001);
});

test('El Milagro, 19 de octubre (datos de tu captura): ET0 ≈ 3,2–3,3 mm, bajo los ~3,75 del modelo', () => {
  const es = (fao.satVapourPressure(25.7) + fao.satVapourPressure(13.0)) / 2;
  const u2 = (2.9 / 3.6) * fao.WIND_10M_TO_2M;
  const et0 = fao.et0PenmanMonteith({ tmaxC: 25.7, tminC: 13.0, eaKpa: es * 0.608, rsMJ: 16.7, u2 }, -33.754, 460, '2026-10-19');
  assert.ok(et0 > 3.0 && et0 < 3.4, String(et0));
});

test('campos meteorológicos y unidad del viento', () => {
  const s = (wind) => [{ momento: 'x', temperatura: '14.2 °C', humedadRelativa: '80 %', radiacionGlobalInst: '512 Watt/m2', fuerzaDelVientoPromedio10Minutos: wind }];
  assert.equal(dmc.detectMetFields(s('5 kt')).fields.windUnit, 'kt');
  assert.equal(dmc.detectMetFields(s('9 km/h')).fields.windUnit, 'km/h');
  const noUnit = dmc.detectMetFields(s(5)).fields;
  assert.equal(noUnit.windUnit, 'kt');
  assert.equal(noUnit.windUnitAssumed, true);
  const missing = dmc.detectMetFields([{ momento: 'x', temperatura: '1 °C', temperaturaMaxima12Horas: '3 °C' }]);
  assert.equal(missing.fields, null);
  assert.deepEqual(missing.missing, ['humedad relativa', 'radiación global', 'viento']);
});

/** Un día local completo de lecturas por minuto con valores constantes. */
function minuteDay(dateLocal, { t = 20, rh = 50, rad = 300, windKt = 4 } = {}, hours = 24) {
  const [y, m, d] = dateLocal.split('-').map(Number);
  const t0 = new Date(y, m - 1, d, 0, 0, 0).getTime();
  const out = [];
  for (let i = 0; i < hours * 60; i++) {
    const tt = new Date(t0 + i * 60_000);
    out.push({
      momento: tt.toISOString().slice(0, 19).replace('T', ' '),
      temperatura: `${t} °C`, humedadRelativa: `${rh} %`, radiacionGlobalInst: `${rad} Watt/m2`,
      fuerzaDelVientoPromedio10Minutos: `${windKt} kt`, aguaCaida24Horas: '0.0 mm',
    });
  }
  return out;
}

test('ET0 de la estación desde lecturas por minuto = FAO-56 con los valores del día', () => {
  const samples = minuteDay('2026-10-24');
  const f = dmc.detectMetFields(samples).fields;
  const buckets = dmc.metBuckets(samples, f);
  assert.equal(buckets.length, 144); // bloques de 10 min
  const day = dmc.dailyMetFromBuckets(buckets).get('2026-10-24');
  assert.equal(day.coveredHours, 24);
  assert.ok(Math.abs(day.rsMJ - 300 * 0.0864) < 1e-9);
  const meta = { latitude: -33.754, elevationM: 460 };
  const st = dmc.stationEt0(buckets, meta, '2026-10-25');
  const expected = fao.et0PenmanMonteith(
    { tmaxC: 20, tminC: 20, eaKpa: fao.satVapourPressure(20) * 0.5, rsMJ: 25.92, u2: 4 * 0.514444 * fao.WIND_10M_TO_2M },
    -33.754, 460, '2026-10-24',
  );
  assert.equal(st.get('2026-10-24'), Math.round(expected * 10) / 10);
});

test('sin al menos 21 h de lecturas no hay ET0 medida (y nunca para hoy)', () => {
  const partial = minuteDay('2026-10-24', {}, 18);
  const f = dmc.detectMetFields(partial).fields;
  const meta = { latitude: -33.754, elevationM: 460 };
  assert.equal(dmc.stationEt0(dmc.metBuckets(partial, f), meta, '2026-10-25').size, 0);
  const full = minuteDay('2026-10-25');
  assert.equal(dmc.stationEt0(dmc.metBuckets(full, f), meta, '2026-10-25').size, 0);
});

test('al juntar consultas gana el bloque con más lecturas', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const a = [[now - 600_000, 4, 10, 11, 1, 100, 1]];
  const b = [[now - 600_000, 10, 10, 12, 1, 120, 1]];
  assert.equal(dmc.mergeMetBuckets(a, b, now)[0][1], 10);
  assert.equal(dmc.mergeMetBuckets(b, a, now)[0][1], 10);
});

test('corrección del pronóstico: estación ÷ modelo, ≥ 2 días, limitada a ±20 %', () => {
  assert.equal(dmc.et0Correction({ '2026-10-24': [3.2, 3.75] }, '2026-10-25'), null);
  assert.deepEqual(dmc.et0Correction({ '2026-10-23': [3.0, 3.6], '2026-10-24': [3.2, 3.75] }, '2026-10-25'), { ratio: 0.84, days: 2 });
  assert.equal(dmc.et0Correction({ '2026-10-23': [1, 3], '2026-10-24': [1, 3] }, '2026-10-25').ratio, 0.8);
});

test('días pasados usan la ET0 medida; hoy y el futuro, la del modelo corregida', () => {
  const day = (date, et0) => ({ date, et0Mm: et0, precipitationMm: 0, precipitationProbMax: 0, tempMaxC: 20, windMaxKmh: 5 });
  const out = dmc.withStationEt0([day('2026-10-24', 3.75), day('2026-10-25', 4), day('2026-10-26', 5)], new Map([['2026-10-24', 3.2]]), { ratio: 0.85 }, '2026-10-25');
  assert.deepEqual(out.map((d) => d.et0Mm), [3.2, 3.4, 4.25]);
});

test('ET0 medida corrige el consumo de días ya contados (idempotente; no antes de un riego)', () => {
  const st = { deficitMm: 5, asOf: '2026-10-25', source: 'model' };
  const history = [{ date: '2026-10-24', etcMm: 3.0, effectiveRainMm: 0 }]; // modelo 3,75 × 0,8
  const r = core.reconcileObservedEt0(st, history, { '2026-10-24': 3.2 }); // estación 3,2 × 0,8 = 2,56
  assert.ok(Math.abs(r.state.deficitMm - (5 - 0.44)) < 1e-9);
  assert.ok(Math.abs(r.history[0].etcMm - 2.56) < 1e-9);
  assert.equal(core.reconcileObservedEt0(r.state, r.history, { '2026-10-24': 3.2 }).changed, false);
  const afterIrrigation = core.reconcileObservedEt0({ ...st, resetDate: '2026-10-25' }, history, { '2026-10-24': 3.2 });
  assert.equal(afterIrrigation.state.deficitMm, 5);
});

test('el almacén guarda los bloques meteorológicos y reduce la lluvia a bloques de 10 min', async () => {
  const orig = globalThis.fetch;
  const samples = minuteDay('2026-10-24', {}, 12);
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ datos: samples }) });
    const { store } = await dmc.refreshDmcStore(null, '330160', Date.parse('2026-10-24T16:00:00Z'), 3_600_000);
    assert.equal(store.met.length, 72);
    assert.equal(store.pts.length, 72); // 720 lecturas de lluvia → 72 bloques
    assert.equal(store.metFields.windUnit, 'kt');
  } finally {
    globalThis.fetch = orig;
  }
});

test('datos de la estación 330160 para FAO-56', () => {
  const meta = dmc.stationMeta({ code: '330160', name: 'El Milagro, Buin', distanceKm: 2.7 }, -33.73, 451);
  assert.deepEqual(meta, { latitude: -33.75444, elevationM: 460 });
});
