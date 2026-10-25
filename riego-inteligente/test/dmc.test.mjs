import test from 'node:test';
import assert from 'node:assert/strict';
import * as dmc from '../src/app/core/dmc.ts';
import { DMC_STATIONS_FALLBACK } from '../src/app/core/dmc-stations.ts';

// Zona horaria de Chile, como el teléfono.
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
  const st = dmc.nearestDmcStation(stations, -33.7313, -70.7663);
  assert.equal(st.code, '330160');
  assert.ok(st.distanceKm > 2 && st.distanceKm < 3); // como mostró tu teléfono: 2,6 km
});

test('lee las lecturas en cualquier nivel (datos / datosEstaciones.datos)', () => {
  const s = [{ momento: '2026-10-24 00:00:00', aguaCaida24Horas: '0.0 mm' }];
  assert.equal(dmc.parseDmcSamples({ datos: s }).length, 1);
  assert.equal(dmc.parseDmcSamples({ datosEstaciones: { datos: s } }).length, 1);
  assert.equal(dmc.parseDmcSamples({ otra: 1 }).length, 0);
});

test('detecta el campo de lluvia', () => {
  assert.deepEqual(dmc.detectRainField([{ momento: 'x', aguaCaida24Horas: '0 mm' }]), { field: 'aguaCaida24Horas', kind: 'accumulated' });
  assert.deepEqual(dmc.detectRainField([{ momento: 'x', aguaCaidaDelMinuto: '0 mm' }]), { field: 'aguaCaidaDelMinuto', kind: 'increment' });
  assert.equal(dmc.detectRainField([{ momento: 'x', temperatura: '9 °C' }]), null);
});

/** Lecturas cada `stepMin` minutos del acumulado de 24 h, con reinicio a las 12:00 UTC. */
function series(fromUtc, hours, rainAt, stepMin = 60) {
  const out = [];
  let acc = 0;
  const t0 = Date.parse(fromUtc);
  for (let m = 0; m <= hours * 60; m += stepMin) {
    const t = new Date(t0 + m * 60_000);
    if (t.getUTCHours() === 12 && t.getUTCMinutes() === 0) acc = 0;
    acc += rainAt(t) ?? 0;
    out.push({ momento: t.toISOString().slice(0, 19).replace('T', ' '), aguaCaida24Horas: `${acc.toFixed(1)} mm` });
  }
  return out;
}
const RF = { field: 'aguaCaida24Horas', kind: 'accumulated' };

test('lluvia diaria desde el acumulado (con reinicio a las 12 UTC)', () => {
  const rain = (t) => (['2026-10-23T09:00', '2026-10-23T13:00'].some((p) => t.toISOString().startsWith(p)) ? 0.6 : 0);
  const daily = dmc.dailyRainFromAccumulated(series('2026-10-22T03:00:00Z', 72, rain));
  assert.equal(daily.get('2026-10-23').mm, 1.2);
  assert.equal(daily.get('2026-10-24').mm, 0);
  assert.ok(daily.get('2026-10-23').coveredHours >= 23);
});

test('un hueco de horas sin lecturas no cuenta como cobertura', () => {
  const all = dmc.rainPoints(series('2026-10-24T03:00:00Z', 24, () => 0), RF);
  const holed = all.filter(([t]) => { const h = new Date(t).getHours(); return h < 6 || h > 17; }); // falta de 06 a 17 h
  const d = dmc.dailyRainFromPoints(holed, 'accumulated').get('2026-10-24');
  assert.ok(d.coveredHours < 14);
});

test('el almacén junta consultas de 24 h y arma días completos', async () => {
  const orig = globalThis.fetch;
  const urls = [];
  try {
    // 1ª consulta: sábado 24 a las 08:00 → trae desde el viernes 08:00
    let samples = series('2026-10-23T11:00:00Z', 24, () => 0, 10);
    globalThis.fetch = async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ datos: samples }) }; };
    let r = await dmc.refreshDmcStore(null, '330160', Date.parse('2026-10-24T11:00:00Z'), 3_600_000);
    assert.equal(dmc.observedFromStore(r.store, '330160', '2026-10-25').has('2026-10-24'), false); // sábado aún incompleto
    // 2ª consulta: domingo 25 a las 07:00 → trae desde el sábado 07:00
    samples = series('2026-10-24T10:00:00Z', 24, () => 0, 10);
    r = await dmc.refreshDmcStore(r.store, '330160', Date.parse('2026-10-25T10:00:00Z'), 3_600_000);
    const obs = dmc.observedFromStore(r.store, '330160', '2026-10-25');
    assert.equal(obs.get('2026-10-24'), 0); // sábado completo con las dos consultas
    assert.match(urls[0], /\/datosRecientesEma\/330160$/); // sin año/mes (esa variante exige token)
  } finally {
    globalThis.fetch = orig;
  }
});

test('si la DMC falla no se reintenta cada 15 min, y se conservan las lecturas', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
    const t0 = Date.parse('2026-10-25T13:00:00Z');
    const prev = { code: '330160', field: 'aguaCaida24Horas', kind: 'accumulated', attemptAt: t0 - 7 * 3_600_000, ok: true, pts: [[t0 - 3_600_000, 0]] };
    let r = await dmc.refreshDmcStore(prev, '330160', t0, 6 * 3_600_000);
    assert.equal(r.store.ok, false);
    assert.equal(r.store.pts.length, 1);
    r = await dmc.refreshDmcStore(r.store, '330160', t0 + 15 * 60_000, 6 * 3_600_000);
    assert.equal(calls, 1); // no volvió a consultar
  } finally {
    globalThis.fetch = orig;
  }
});

test('la lluvia medida reemplaza al modelo solo en días pasados', () => {
  const day = (date, p) => ({ date, et0Mm: 4, precipitationMm: p, precipitationProbMax: 0, tempMaxC: 20, windMaxKmh: 5 });
  const cfg = { code: '330160', name: 'El Milagro, Buin', distanceKm: 2.6 };
  const r = dmc.withDmcRain([day('2026-10-24', 2.75), day('2026-10-25', 3)], new Map([['2026-10-24', 0], ['2026-10-25', 9]]), cfg, '2026-10-25');
  assert.deepEqual(r.days.map((d) => d.precipitationMm), [0, 3]);
  assert.equal(r.source, 'El Milagro, Buin (2,6 km) · DMC');
  assert.equal(dmc.withDmcRain([day('2026-10-24', 2.75)], new Map(), cfg, '2026-10-25').source, null);
});

test('el diagnóstico explica un 404 y un éxito', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    let d = await dmc.diagnoseDmc('330160', null, '2026-10-25', Date.parse('2026-10-25T13:00:00Z'));
    assert.equal(d.ok, false);
    assert.match(d.lines[0], /acceso público/);
    assert.match(d.lines[1], /HTTP 404/);
    const samples = series('2026-10-24T13:00:00Z', 24, (t) => (t.getUTCHours() === 20 && t.getUTCMinutes() === 0 ? 0.4 : 0), 10);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ datos: samples }) });
    d = await dmc.diagnoseDmc('330160', null, '2026-10-25', Date.parse('2026-10-25T13:00:00Z'));
    assert.equal(d.ok, true);
    assert.match(d.lines[1], /✓ Datos recientes: 145 lecturas/);
    assert.match(d.lines[2], /0,4 mm/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('"Probar" consulta aunque la consulta automática haya fallado hace poco', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
    const t0 = Date.parse('2026-10-25T13:00:00Z');
    const justFailed = { code: '330160', attemptAt: t0 - 60_000, ok: false, pts: [] };
    const d = await dmc.diagnoseDmc('330160', justFailed, '2026-10-25', t0);
    assert.ok(calls >= 1);
    assert.match(d.lines[1], /HTTP 404/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('con usuario y token se usa el servicio oficial, y el diagnóstico nunca muestra las credenciales', async () => {
  const auth = { user: 'ivan@example.com', token: 'tok-SECRETO-123' };
  assert.equal(dmc.recentUrl('330160'), 'https://climatologia.meteochile.gob.cl/application/productos/datosRecientesEma/330160');
  assert.equal(
    dmc.recentUrl('330160', auth),
    'https://climatologia.meteochile.gob.cl/application/servicios/getDatosRecientesEma/330160?usuario=ivan%40example.com&token=tok-SECRETO-123',
  );
  const orig = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      if (String(u).includes('wischile')) return { ok: true, status: 200, json: async () => ({ collections: [{ id: 'urn:a' }, { id: 'urn:b' }] }) };
      // servidor que devuelve un error que repite el usuario y el token
      return { ok: true, status: 200, json: async () => ({ mensaje: 'token no válido para ivan@example.com / tok-SECRETO-123' }) };
    };
    const d = await dmc.diagnoseDmc('330160', null, '2026-10-25', Date.parse('2026-10-25T13:00:00Z'), auth);
    const text = d.lines.join('\n');
    assert.match(text, /servicio oficial con usuario y token/);
    assert.match(text, /token no válido para \*\*\*/);
    assert.match(text, /WIS2 DMC \(público\): OK · 2 colecciones: urn:a, urn:b/);
    assert.ok(!text.includes('tok-SECRETO-123') && !text.includes('ivan@example.com'));
    assert.ok(urls[0].includes('/servicios/getDatosRecientesEma/330160?usuario='));
    assert.ok(urls.some((u) => u.includes('/servicios/getEmaResumenDiario/330160?usuario=')));
  } finally {
    globalThis.fetch = orig;
  }
});
