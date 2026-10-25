import test from 'node:test';
import assert from 'node:assert/strict';
import * as dmc from '../src/app/core/dmc.ts';
import { DMC_STATIONS_FALLBACK } from '../src/app/core/dmc-stations.ts';

// Estos tests usan la zona horaria de Chile, como el teléfono.
process.env.TZ = 'America/Santiago';

test('valores con unidad', () => {
  assert.equal(dmc.unitNumber('0.2 mm'), 0.2);
  assert.equal(dmc.unitNumber('12,5 °C'), 12.5);
  assert.equal(dmc.unitNumber(3), 3);
  assert.equal(dmc.unitNumber(null), null);
  assert.equal(dmc.unitNumber('s/d'), null);
});

test('la estación más cercana a tu jardín en Buin es El Milagro (330160)', () => {
  const stations = DMC_STATIONS_FALLBACK.map(([code, name, latitude, longitude, elevationM]) => ({ code, name, latitude, longitude, elevationM }));
  const st = dmc.nearestDmcStation(stations, -33.75, -70.76);
  assert.equal(st.code, '330160');
  assert.equal(st.name, 'El Milagro, Buin');
  assert.ok(st.distanceKm < 1);
});

test('lee las muestras de datosEstaciones.datos (y variantes)', () => {
  const s = [{ momento: '2026-10-24 00:00:00', aguaCaida24Horas: '0.0 mm' }];
  assert.equal(dmc.parseDmcSamples({ datosEstaciones: { datos: s } }).length, 1);
  assert.equal(dmc.parseDmcSamples({ datosEstaciones: [{ estacion: {}, datos: s }] }).length, 1);
  assert.equal(dmc.parseDmcSamples({ otra: 1 }).length, 0);
});

/** Serie horaria UTC del acumulado de 24 h, con reinicio a las 12:00 UTC. */
function hourly(fromUtc, hours, rainAt) {
  const out = [];
  let acc = 0;
  const t0 = Date.parse(fromUtc);
  for (let h = 0; h <= hours; h++) {
    const t = new Date(t0 + h * 3_600_000);
    if (t.getUTCHours() === 12 && t.getUTCMinutes() === 0) acc = 0; // reinicio diario
    acc += rainAt(t) ?? 0;
    out.push({ momento: t.toISOString().slice(0, 19).replace('T', ' '), aguaCaida24Horas: `${acc.toFixed(1)} mm` });
  }
  return out;
}

test('lluvia diaria a partir del acumulado de 24 h (con reinicio a las 12 UTC)', () => {
  // Viernes 23 (hora local): 0,6 mm a las 06:00 local (09 UTC) y 0,6 mm a las 10:00 local (13 UTC, tras el reinicio).
  // Sábado 24: sin lluvia.
  const rain = (t) => {
    const iso = t.toISOString();
    if (iso.startsWith('2026-10-23T09:00')) return 0.6;
    if (iso.startsWith('2026-10-23T13:00')) return 0.6;
    return 0;
  };
  const samples = hourly('2026-10-22T03:00:00Z', 24 * 3, rain); // 22/10 00:00 local → 25/10 00:00 local
  const daily = dmc.dailyRainFromAccumulated(samples);
  assert.equal(daily.get('2026-10-23').mm, 1.2);
  assert.equal(daily.get('2026-10-24').mm, 0);
  assert.ok(daily.get('2026-10-23').coveredHours >= 20);
});

test('los días con la estación caída no se usan', async () => {
  const orig = globalThis.fetch;
  // Solo 6 horas de datos del sábado
  const samples = hourly('2026-10-24T03:00:00Z', 6, () => 0);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ datosEstaciones: { datos: samples } }) });
  try {
    const obs = await dmc.fetchDmcDailyRain('330160', '2026-10-22', '2026-10-24');
    assert.equal(obs.has('2026-10-24'), false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('la lluvia medida reemplaza al modelo solo en días pasados; si la DMC falla, se usa el modelo', async () => {
  const orig = globalThis.fetch;
  const samples = hourly('2026-10-22T03:00:00Z', 24 * 3, () => 0);
  const day = (date, p) => ({ date, et0Mm: 4, precipitationMm: p, precipitationProbMax: 0, tempMaxC: 20, windMaxKmh: 5 });
  const days = [day('2026-10-23', 7), day('2026-10-24', 2.75), day('2026-10-25', 3)];
  const cfg = { code: '330160', name: 'El Milagro, Buin', distanceKm: 0.6 };
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ datosEstaciones: { datos: samples } }) });
    const r = await dmc.applyDmcRain(days, cfg, '2026-10-25');
    assert.deepEqual(r.days.map((d) => d.precipitationMm), [0, 0, 3]);
    assert.match(r.source, /El Milagro/);
    globalThis.fetch = async () => { throw new Error('sin red'); };
    const f = await dmc.applyDmcRain(days, cfg, '2026-10-25');
    assert.deepEqual(f.days.map((d) => d.precipitationMm), [7, 2.75, 3]);
    assert.equal(f.source, null);
  } finally {
    globalThis.fetch = orig;
  }
});
