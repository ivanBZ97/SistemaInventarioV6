import test from 'node:test';
import assert from 'node:assert/strict';
import * as dmc from '../src/app/core/dmc.ts';
import * as c from '../src/app/core/irrigation-core.ts';
import * as lm from '../src/app/core/lawn-mood.ts';

// Zona horaria de Chile, como el teléfono (octubre: UTC−3).
process.env.TZ = 'America/Santiago';

/** Lecturas cada `stepMin` min del acumulado de 24 h de la DMC, que se reinicia a las 12:00 UTC (09:00 en Chile). */
function series(fromUtc, minutes, rainAt, stepMin = 5) {
  const out = [];
  let acc = 0;
  const t0 = Date.parse(fromUtc);
  for (let m = 0; m <= minutes; m += stepMin) {
    const t = new Date(t0 + m * 60_000);
    if (t.getUTCHours() === 12 && t.getUTCMinutes() === 0) acc = 0;
    acc += rainAt(t) ?? 0;
    out.push({ momento: t.toISOString().slice(0, 19).replace('T', ' '), aguaCaida24Horas: `${acc.toFixed(1)} mm` });
  }
  return out;
}
const RF = { field: 'aguaCaida24Horas', kind: 'accumulated' };
const storeOf = (samples, now) => dmc.mergeStore(null, '330160', RF, dmc.rainPoints(samples, RF), now);
const between = (t, from, to) => t.getTime() >= Date.parse(from) && t.getTime() < Date.parse(to);

test('lluvia de hoy hasta la última lectura: 18:45 a las 19:10, por hora y con el reinicio de las 09:00', () => {
  // Desde las 23:00 de ayer hasta las 18:45 de hoy. Llovizna de 05:00 a 06:00 y chubasco de 17:00 a 18:00.
  const rain = (t) =>
    between(t, '2026-10-25T08:00:00Z', '2026-10-25T09:00:00Z') ? 0.2 : between(t, '2026-10-25T20:00:00Z', '2026-10-25T21:00:00Z') ? 0.4 : 0;
  const now = Date.parse('2026-10-25T22:10:00Z'); // 19:10
  const store = storeOf(series('2026-10-25T02:00:00Z', 1185, rain), now);
  const live = dmc.liveRainFromStore(store, '330160', '2026-10-25', now);
  assert.equal(live.mm, 7.2); // 2,4 antes del reinicio + 4,8 después
  assert.equal(new Date(live.lastAtMs).toTimeString().slice(0, 5), '18:45');
  assert.equal(live.sinceMs, new Date(2026, 9, 25, 0, 0).getTime()); // hay lecturas desde la medianoche
  assert.equal(live.hourly[5], 2.4);
  assert.equal(live.hourly[17], 4.8);
  assert.equal(live.hourly.reduce((s, x) => s + x, 0).toFixed(1), '7.2');
  assert.equal(live.lastHourMm, 0.8); // de 17:45 a 18:45 solo cayó el final del chubasco
  assert.equal(live.rainingNow, true);
  // Una hora y media después sin lecturas nuevas ya no se dice que está lloviendo.
  assert.equal(dmc.liveRainFromStore(store, '330160', '2026-10-25', now + 90 * 60_000).rainingNow, false);
  assert.equal(dmc.liveRainFromStore(store, 'otra', '2026-10-25', now), null);
});

test('sin lecturas de antes, la lluvia de hoy se cuenta desde la primera lectura', () => {
  // Primera consulta tras instalar: lecturas desde las 05:45.
  const rain = (t) => (between(t, '2026-10-25T09:00:00Z', '2026-10-25T09:30:00Z') ? 0.2 : 0);
  const now = Date.parse('2026-10-25T20:40:00Z');
  const live = dmc.liveRainFromStore(storeOf(series('2026-10-25T08:45:00Z', 600, rain), now), '330160', '2026-10-25', now);
  assert.equal(new Date(live.sinceMs).toTimeString().slice(0, 5), '05:45');
  assert.equal(live.mm, 1.2);
  assert.equal(live.rainingNow, false);
  // Pasada la medianoche, aún sin lecturas del día nuevo: no se inventa lluvia de hoy.
  const tomorrow = dmc.liveRainFromStore(storeOf(series('2026-10-25T08:45:00Z', 600, rain), now), '330160', '2026-10-26', now);
  assert.equal(tomorrow.sinceMs, null);
  assert.equal(tomorrow.mm, 0);
});

test('se agrega solo al día de hoy', () => {
  const live = { date: '2026-01-13', mm: 3, sinceMs: 0, lastAtMs: 1, lastHourMm: 0, rainingNow: false, hourly: [], steps: [] };
  const days = dmc.withLiveRain([{ date: '2026-01-12' }, { date: '2026-01-13' }], live, '2026-01-13');
  assert.equal(days[0].live, undefined);
  assert.equal(days[1].live.mm, 3);
  assert.equal(dmc.withLiveRain(days, null, '2026-01-13'), days);
});

// ───────────── La lluvia medida en la decisión de riego ─────────────

const wx = (date, o = {}) => ({ date, et0Mm: 4, precipitationMm: 0, precipitationProbMax: 0, tempMaxC: 28, windMaxKmh: 10, ...o });
const S = c.DEFAULT_SETTINGS;
const at = (h, m = 0) => new Date(2026, 0, 13, h, m).getTime();
/** Lluvia medida hoy (13-ene): `steps` = [[hora, mm], …]. */
const liveOf = (steps, o = {}) => {
  const st = steps.map(([h, mm]) => [at(h), mm]);
  return {
    date: '2026-01-13', mm: st.reduce((s, [, mm]) => s + mm, 0), sinceMs: at(0), lastAtMs: at(6, 5), lastHourMm: 0,
    rainingNow: false, hourly: new Array(24).fill(0), steps: st, ...o,
  };
};
const st = (o = {}) => ({ deficitMm: 9, asOf: '2026-01-13', source: 'model', ...o });

test('la lluvia que ya cayó hoy baja el déficit: 9 mm − 80 % de 3 mm = 6,6 mm, hoy no se riega', () => {
  const w = [wx('2026-01-13', { live: liveOf([[2, 3]]) }), wx('2026-01-14')];
  const ev = c.evaluate(st(), w, S, '2026-01-13');
  assert.equal(ev.status, 'ok');
  assert.ok(Math.abs(ev.deficitMm - 6.6) < 1e-9);
  assert.equal(ev.rainMeasuredMm, 3);
  assert.equal(ev.rainForecastMm, 0); // el pronóstico se muestra aparte
  assert.ok(Math.abs(ev.projectedDeficitMm - 10) < 1e-9); // 9 + 3,4 de ETc − 2,4 de lluvia útil
  // "Próximo riego" coincide: hoy no, mañana sí (10 mm).
  const next = c.forecastNextIrrigation(st(), w, S, '2026-01-13');
  assert.equal(next.daysAhead, 1);
  assert.equal(next.timeline[0].irrigate, false);
  assert.ok(Math.abs(next.timeline[0].deficitMm - 6.6) < 1e-9);
  // y mañana el balance cuenta la lluvia de hoy
  assert.ok(Math.abs(c.rollForward(st(), w, '2026-01-14').state.deficitMm - 10) < 1e-9);
});

test('con 4 mm ya medidos se pausa aunque el pronóstico diga 0 %', () => {
  const ev = c.evaluate(st({ deficitMm: 14 }), [wx('2026-01-13', { live: liveOf([[3, 2], [4, 3]]) })], S, '2026-01-13');
  assert.equal(ev.status, 'paused_rain');
  assert.equal(ev.rainBlockReason, 'measured');
  const n = c.morningNotification(ev, c.atTime('2026-01-13', c.MORNING));
  assert.equal(n.title, '🌧️ Riego pausado por lluvia');
  assert.match(n.body, /hoy ya llovieron 5 mm en tu sector/);
});

test('si está lloviendo se pausa, aunque haya caído poco', () => {
  const ev = c.evaluate(st(), [wx('2026-01-13', { live: liveOf([[6, 1]], { lastHourMm: 1, rainingNow: true }) })], S, '2026-01-13');
  assert.equal(ev.status, 'paused_rain');
  assert.equal(ev.rainBlockReason, 'raining');
  assert.equal(ev.rainingNow, true);
  const n = c.morningNotification(ev, c.atTime('2026-01-13', c.MORNING));
  assert.equal(n.title, '🌧️ Riego pausado: está lloviendo');
  assert.match(n.body, /está lloviendo en tu sector \(1 mm hasta ahora\)/);
  assert.equal(c.forecastNextIrrigation(st(), [wx('2026-01-13', { live: liveOf([[6, 1]], { rainingNow: true }) })], S, '2026-01-13').timeline[0].rainBlock, true);
  assert.equal(lm.lawnScene(ev), 'rain');
  assert.ok(lm.lawnMessages('thirsty', 'rain', ev).some((m) => m.includes('Está lloviendo')));
});

test('el pronóstico sigue pausando como antes, con su texto', () => {
  const ev = c.evaluate(st(), [wx('2026-01-13', { precipitationProbMax: 70, live: liveOf([]) })], S, '2026-01-13');
  assert.equal(ev.rainBlockReason, 'forecast');
  assert.equal(c.morningNotification(ev, c.atTime('2026-01-13', c.MORNING)).title, '🌧️ Riego pausado por pronóstico de lluvia');
});

test('tras un riego o ajuste de hoy solo cuenta la lluvia caída después', () => {
  const w = [wx('2026-01-13', { live: liveOf([[2, 3], [5, 3]]) })];
  // Ajuste a las 04:00 a 9 mm: la lluvia de las 02:00 ya estaba considerada, la de las 05:00 no.
  const ev = c.evaluate(st({ resetDate: '2026-01-13', resetAt: at(4) }), w, S, '2026-01-13');
  assert.ok(Math.abs(ev.deficitMm - 6.6) < 1e-9);
  assert.ok(Math.abs(ev.projectedDeficitMm - 10) < 1e-9); // la de las 02:00 tampoco se cuenta para mañana
  // Ajuste de hoy guardado por la versión anterior (sin hora): no se descuenta nada.
  assert.equal(c.evaluate(st({ resetDate: '2026-01-13' }), w, S, '2026-01-13').deficitMm, 9);
  // Ajuste de ayer: cuenta toda la lluvia de hoy.
  assert.ok(Math.abs(c.evaluate(st({ resetDate: '2026-01-12', resetAt: at(4) - 86_400_000 }), w, S, '2026-01-13').deficitMm - 4.2) < 1e-9);
});

test('el aviso de la mañana usa la lluvia de la madrugada', () => {
  const w = [wx('2026-01-13', { live: liveOf([[3, 6]]) }), wx('2026-01-14')];
  const p = c.planNotifications({ state: st({ deficitMm: 13 }), weather: w, settings: S, now: new Date(2026, 0, 13, 5, 0) });
  assert.equal(p.notifications[0].title, '🌧️ Riego pausado por lluvia');
  const ok = c.planNotifications({ state: st({ deficitMm: 9 }), weather: [wx('2026-01-13', { live: liveOf([[3, 3]]) }), wx('2026-01-14')], settings: S, now: new Date(2026, 0, 13, 5, 0) });
  assert.equal(ok.notifications[0].title, '✅ Hoy no hace falta regar');
  assert.match(ok.notifications[0].body, /Hoy ya llovieron 3 mm\./);
});

test('la lluvia medida de otro día no se usa para hoy', () => {
  const live = liveOf([[2, 6]], { date: '2026-01-12' });
  assert.equal(c.evaluate(st(), [wx('2026-01-13', { live })], S, '2026-01-13').rainMeasuredMm, null);
});

// ───────────── Consultas en segundo plano ─────────────

test('en segundo plano consulta cada 30 min si llueve o se pronostica lluvia, y antes del aviso; si no, cada 2 h', () => {
  const morning = { hour: 7, minute: 0 };
  const noon = new Date(2026, 9, 25, 12, 0).getTime();
  const dry = wx('2026-10-25');
  assert.equal(dmc.backgroundStationMaxAgeMs(noon, null, dry, morning), 2 * 3_600_000);
  assert.equal(dmc.backgroundStationMaxAgeMs(noon, null, { ...dry, precipitationProbMax: 40 }, morning), 30 * 60_000);
  assert.equal(dmc.backgroundStationMaxAgeMs(noon, null, { ...dry, precipitationMm: 2 }, morning), 30 * 60_000);
  assert.equal(dmc.backgroundStationMaxAgeMs(new Date(2026, 9, 25, 6, 0).getTime(), null, dry, morning), 30 * 60_000);
  assert.equal(dmc.backgroundStationMaxAgeMs(new Date(2026, 9, 25, 7, 30).getTime(), null, dry, morning), 2 * 3_600_000);
  const wet = { date: '2026-10-25', mm: 2, sinceMs: 0, lastAtMs: noon - 30 * 60_000, lastHourMm: 0, rainingNow: false, hourly: [], steps: [[noon - 2 * 3_600_000, 2]] };
  assert.equal(dmc.backgroundStationMaxAgeMs(noon, wet, dry, morning), 30 * 60_000);
});

test('el resumen diario oficial se pide cada 3 h, no en cada consulta', async () => {
  const orig = globalThis.fetch;
  const auth = { user: 'u@example.com', token: 't0k' };
  let summaries = 0;
  try {
    globalThis.fetch = async (u) => {
      if (String(u).includes('getEmaResumenDiario')) {
        summaries++;
        return { ok: true, status: 200, json: async () => ({ datos: [{ aguaCaidaDiaria: { fecha: '24-10-2026', valor: '0.0' } }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ datos: series('2026-10-25T02:00:00Z', 720, () => 0, 10) }) };
    };
    const t0 = Date.parse('2026-10-25T14:00:00Z');
    let r = await dmc.refreshDmcStore(null, '330160', t0, 0, false, auth);
    r = await dmc.refreshDmcStore(r.store, '330160', t0 + 5 * 60_000, 0, false, auth);
    r = await dmc.refreshDmcStore(r.store, '330160', t0 + 60 * 60_000, 0, false, auth);
    assert.equal(summaries, 1);
    assert.equal(r.store.daily['2026-10-24'], 0); // se conserva
    await dmc.refreshDmcStore(r.store, '330160', t0 + 3 * 3_600_000, 0, false, auth);
    assert.equal(summaries, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

test('el diagnóstico muestra la lluvia de hoy, el atraso y el tamaño de cada consulta', async () => {
  const orig = globalThis.fetch;
  const rain = (t) => (between(t, '2026-10-25T20:00:00Z', '2026-10-25T21:00:00Z') ? 0.4 : 0);
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ datos: series('2026-10-25T09:45:00Z', 720, rain, 1) }) });
    const d = await dmc.diagnoseDmc('330160', null, '2026-10-25', Date.parse('2026-10-25T22:10:00Z'));
    assert.match(d.lines[1], /✓ Datos recientes: 721 lecturas \(≈ \d+ KB\)/);
    // El almacén guarda la última lectura de cada bloque de 10 min: la primera queda a las 06:49.
    assert.ok(d.lines.some((l) => /Lluvia de hoy: 24 mm desde las 06:49 hasta las 18:45 \(25 min de atraso\) · está lloviendo\./.test(l)), d.lines.join('\n'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('con la app abierta, un fallo de la estación se reintenta en la siguiente consulta (no en 1 h)', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; };
    const t0 = Date.parse('2026-10-25T22:00:00Z');
    const failed = { code: '330160', attemptAt: t0, ok: false, pts: [] };
    await dmc.refreshDmcStore(failed, '330160', t0 + 5 * 60_000, 4 * 60_000);
    assert.equal(calls, 1);
    await dmc.refreshDmcStore(failed, '330160', t0 + 30 * 60_000, 2 * 3_600_000); // en segundo plano espera 1 h
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('si la estación no entrega lecturas, el almacén guarda el motivo (sin credenciales) y conserva lo anterior', async () => {
  const orig = globalThis.fetch;
  const auth = { user: 'u@example.com', token: 'SECRETO' };
  try {
    const t0 = Date.parse('2026-10-26T09:39:00Z');
    const prev = { code: '330160', field: 'aguaCaida24Horas', kind: 'accumulated', attemptAt: t0 - 3_600_000, ok: true, pts: [[t0 - 14 * 3_600_000, 0]], summaryAt: t0 };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ datosEstaciones: { datos: [] } }) });
    let r = await dmc.refreshDmcStore(prev, '330160', t0, 4 * 60_000, false, auth);
    assert.equal(r.store.ok, false);
    assert.equal(r.store.error, 'sin lecturas');
    assert.equal(r.store.pts.length, 1);
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    r = await dmc.refreshDmcStore(r.store, '330160', t0 + 5 * 60_000, 4 * 60_000, false, auth);
    assert.equal(r.store.error, 'HTTP 503');
    globalThis.fetch = async () => { throw new Error('Unable to resolve host SECRETO'); };
    r = await dmc.refreshDmcStore(r.store, '330160', t0 + 10 * 60_000, 4 * 60_000, false, auth);
    assert.equal(r.store.error, 'sin conexión');
    // Al volver los datos, el motivo desaparece
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ datos: series('2026-10-25T22:00:00Z', 600, () => 0, 10) }) });
    r = await dmc.refreshDmcStore(r.store, '330160', t0 + 15 * 60_000, 4 * 60_000, false, auth);
    assert.equal(r.store.ok, true);
    assert.equal(r.store.error, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test('si la estación dejó de publicar, el diagnóstico lo dice y prueba las estaciones cercanas', async () => {
  const orig = globalThis.fetch;
  const now = Date.parse('2026-10-26T10:30:00Z'); // lunes 07:30
  const old = series('2026-10-24T18:56:00Z', 4, () => 0, 1); // 5 lecturas del sábado 15:56–16:00, como en tu teléfono
  const fresh = series('2026-10-25T22:30:00Z', 690, () => 0, 10); // Talagante, hasta las 07:00
  try {
    globalThis.fetch = async (u) => {
      const url = String(u);
      if (url.includes('/330160')) return { ok: true, status: 200, json: async () => ({ datos: old }) };
      if (url.includes('/330071')) return { ok: true, status: 200, json: async () => ({ datos: fresh }) };
      if (url.includes('/330113')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const alts = [{ code: '330071', name: 'Talagante', distanceKm: 10.3 }, { code: '330113', name: 'El Paico', distanceKm: 22.5 }];
    const d = await dmc.diagnoseDmc('330160', null, '2026-10-26', now, undefined, undefined, alts);
    const text = d.lines.join('\n');
    assert.match(text, /✓ Datos recientes: 5 lecturas/);
    assert.match(text, /⚠ La lectura más nueva es del 24\/10 16:00 \(hace 40 h\): la DMC no está recibiendo datos de esta estación\./);
    assert.match(text, /Otras estaciones DMC cercanas · Talagante \(10 km\): última lectura 26\/10 07:00 \(hace 30 min\) · El Paico \(23 km\): HTTP 500\./);
    // Con datos al día no se prueban las demás
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ datos: fresh }) });
    const ok = await dmc.diagnoseDmc('330160', null, '2026-10-26', now, undefined, undefined, alts);
    assert.ok(!ok.lines.some((l) => l.includes('Otras estaciones')));
  } finally {
    globalThis.fetch = orig;
  }
});

test('estaciones cercanas ordenadas por distancia', () => {
  const st = [
    { code: 'a', name: 'Lejos', latitude: -33.4, longitude: -70.6, elevationM: 0 },
    { code: 'b', name: 'Cerca', latitude: -33.74, longitude: -70.76, elevationM: 0 },
  ];
  assert.deepEqual(dmc.nearbyDmcStations(st, -33.7313, -70.7663, 1).map((s) => s.code), ['b']);
});
