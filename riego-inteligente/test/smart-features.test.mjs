import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/app/core/irrigation-core.ts';
import * as dmc from '../src/app/core/dmc.ts';

process.env.TZ = 'America/Santiago';

const wx = (date, o = {}) => ({ date, et0Mm: 3, precipitationMm: 0, precipitationProbMax: 0, tempMaxC: 22, windMaxKmh: 10, ...o });
const S = c.DEFAULT_SETTINGS;
const st = (o = {}) => ({ deficitMm: 8.5, asOf: '2026-10-27', source: 'model', ...o });

// ───────────── Espera la lluvia de mañana ─────────────

test('si mañana llueve fuerte y seguro, hoy no se riega (8,5 mm de déficit; mañana 12 mm al 80 %)', () => {
  const w = [wx('2026-10-27'), wx('2026-10-28', { precipitationMm: 12, precipitationProbMax: 80 }), wx('2026-10-29'), wx('2026-10-30')];
  const ev = c.evaluate(st(), w, S, '2026-10-27');
  assert.equal(ev.status, 'paused_rain');
  assert.equal(ev.rainBlockReason, 'tomorrow');
  assert.equal(ev.rainTomorrowMm, 12);
  const n = c.morningNotification(ev, c.atTime('2026-10-27', c.MORNING));
  assert.equal(n.title, '🌧️ Hoy no riegues: mañana llueve');
  assert.match(n.body, /mañana se esperan 12 mm \(80% de prob\.\), suficientes para reponerlo/);
  // "Próximo riego" coincide: hoy no (espera la lluvia), mañana tampoco (llueve) y después el suelo queda húmedo.
  const next = c.forecastNextIrrigation(st(), w, S, '2026-10-27');
  assert.equal(next.timeline[0].waitForRain, true);
  assert.equal(next.timeline[0].irrigate, false);
  assert.ok(next.daysAhead >= 3);
});

test('no se espera la lluvia si es poco probable, poca, o el pasto no aguanta un día más', () => {
  const day0 = wx('2026-10-27');
  const status = (tomorrow, state = st()) => c.evaluate(state, [day0, wx('2026-10-28', tomorrow)], S, '2026-10-27').status;
  assert.equal(status({ precipitationMm: 12, precipitationProbMax: 60 }), 'irrigate'); // 60 % < 70 %: se riega
  assert.equal(c.evaluate(st(), [day0, wx('2026-10-28', { precipitationMm: 12, precipitationProbMax: 60 })], S, '2026-10-27').rainBlockReason, null);
  assert.equal(status({ precipitationMm: 8, precipitationProbMax: 90 }), 'irrigate'); // 80 % de 8 mm = 6,4 < 8,5
  assert.equal(status({ precipitationMm: 20, precipitationProbMax: 90 }, st({ deficitMm: 9.5 })), 'irrigate'); // 9,5 + 2,4 > 8 + 3
  // Siembra de todo el jardín: la semilla no puede esperar
  const seed = c.startOverseed(st(), '2026-10-27', 'full');
  assert.equal(status({ precipitationMm: 20, precipitationProbMax: 90 }, seed), 'irrigate');
});

// ───────────── Estación de respaldo ─────────────

/** Acumulado de 24 h de la DMC (se reinicia a las 12:00 UTC). */
function series(fromUtc, minutes, rainAt, stepMin = 10) {
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
const cfg = { code: '330160', name: 'El Milagro, Buin', distanceKm: 2.6, latitude: -33.75444, longitude: -70.76444, elevationM: 460 };
const base = { cfg, lat: -33.7313, lon: -70.7663, elevationM: 470, modelDays: [], today: '2026-10-27', maxAgeMs: 4 * 60_000, primaryPrev: null, backupPrev: null };

test('la de respaldo es la siguiente más cercana dentro de 25 km', () => {
  assert.equal(dmc.backupStationFor('330160', -33.7313, -70.7663).code, '330071'); // Talagante, 10 km
  assert.equal(dmc.backupStationFor('330160', -33.7, -76.5), null); // en el mar: ninguna a menos de 25 km
});

test('si la elegida no publica hace más de 3 h, la lluvia de hoy y de los días que falten viene de la de respaldo', async () => {
  const orig = globalThis.fetch;
  const urls = [];
  const now = Date.parse('2026-10-27T12:40:00Z'); // 09:40
  // El Milagro: 5 lecturas del sábado. Talagante: desde el domingo 23:00 hasta las 09:15, con 2 mm hoy a las 06:00.
  const milagro = series('2026-10-24T18:56:00Z', 4, () => 0, 1);
  const talagante = series('2026-10-26T02:00:00Z', 2055, (t) => (t.toISOString().startsWith('2026-10-27T09:0') ? 1 : 0));
  try {
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      const datos = String(u).includes('/330071') ? talagante : milagro;
      return { ok: true, status: 200, json: async () => ({ datos }) };
    };
    const sd = await dmc.loadStationData({ ...base, now });
    assert.deepEqual(sd.backup, { code: '330071', name: 'Talagante', distanceKm: 10.3 });
    assert.equal(sd.live.mm, 1); // 06:00–06:10: una lectura con 1 mm (bloques de 10 min)
    assert.ok(sd.rain.has('2026-10-26')); // el lunes completo, de Talagante
    assert.equal(sd.status.ok, true); // El Milagro responde… con datos viejos
    assert.equal(sd.backupStore.code, '330071');
    assert.ok(urls.some((u) => u.includes('/330071')));
  } finally {
    globalThis.fetch = orig;
  }
});

test('con la elegida al día no se consulta la de respaldo', async () => {
  const orig = globalThis.fetch;
  const urls = [];
  const now = Date.parse('2026-10-27T12:40:00Z');
  try {
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      return { ok: true, status: 200, json: async () => ({ datos: series('2026-10-27T00:00:00Z', 735, () => 0) }) };
    };
    const sd = await dmc.loadStationData({ ...base, now });
    assert.equal(sd.backup, null);
    assert.equal(sd.backupStore, null);
    assert.ok(!urls.some((u) => u.includes('/330071')));
  } finally {
    globalThis.fetch = orig;
  }
});

test('solo se guarda el almacén si hubo consulta nueva o cambiaron los pares de ET0', () => {
  const a = { code: '330160', attemptAt: 1, ok: true, pts: [] };
  assert.equal(dmc.storeChanged(a, a), false);
  assert.equal(dmc.storeChanged({ ...a, attemptAt: 2 }, a), true);
  assert.equal(dmc.storeChanged({ ...a, et0Pairs: { '2026-10-26': [3, 3.5] } }, a), true);
  assert.equal(dmc.storeChanged(null, a), false);
  assert.equal(dmc.storeChanged(a, null), true);
});

// ───────────── Agua usada ─────────────

test('litros: 1 mm en 1 m² es 1 litro; sin superficie no se calcula', () => {
  assert.equal(c.litersFor(9, 30), 270);
  assert.equal(c.litersFor(9, undefined), null);
  assert.equal(c.litersFor(9, 0), null);
});

test('resumen de 30 días: riegos, agua, lluvia útil y consumo', () => {
  const history = [
    { date: '2026-09-20', etcMm: 9, effectiveRainMm: 9 }, // fuera del periodo
    { date: '2026-10-20', etcMm: 3, effectiveRainMm: 0 },
    { date: '2026-10-21', etcMm: 3.5, effectiveRainMm: 4 },
  ];
  const irrigations = [
    { date: '2026-09-25', at: '', mm: 8, source: 'manual' },
    { date: '2026-10-22', at: '', mm: 8.5, source: 'notification' },
    { date: '2026-10-27', at: '', mm: 9, source: 'manual' },
  ];
  const m = c.monthSummary('2026-10-27', history, irrigations, 40);
  assert.deepEqual(m, { days: 2, irrigations: 2, irrigationMm: 17.5, rainMm: 4, etcMm: 6.5, liters: 700 });
});

test('cuando la elegida vuelve a publicar, los días que le faltaron siguen con la lluvia de la de respaldo (sin consultarla)', async () => {
  const orig = globalThis.fetch;
  const urls = [];
  const now = Date.parse('2026-10-27T12:40:00Z'); // 09:40
  // El Milagro volvió hoy a las 06:00: el lunes 26 le falta. Talagante (guardado) tiene el lunes completo con 6 mm.
  const backupPrev = dmc.mergeStore(null, '330071', { field: 'aguaCaida24Horas', kind: 'accumulated' },
    dmc.rainPoints(series('2026-10-26T02:00:00Z', 1500, (t) => (t.toISOString().startsWith('2026-10-26T18:0') ? 6 : 0)), { field: 'aguaCaida24Horas', kind: 'accumulated' }), now - 3_600_000);
  try {
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      return { ok: true, status: 200, json: async () => ({ datos: series('2026-10-27T09:00:00Z', 215, () => 0) }) };
    };
    const sd = await dmc.loadStationData({ ...base, now, backupPrev });
    assert.equal(sd.backup, null); // la elegida está al día
    assert.equal(sd.rain.get('2026-10-26'), 6); // el día de la caída, de Talagante…
    assert.equal(sd.rainFilledFrom?.name, 'Talagante'); // …y se informa de dónde vino
    assert.equal(sd.live.sinceMs !== null, true);
    assert.ok(!urls.some((u) => u.includes('/330071'))); // no se consultó la de respaldo
    assert.equal(dmc.storeChanged(sd.backupStore, backupPrev), false); // ni se reescribe
  } finally {
    globalThis.fetch = orig;
  }
});

test('esperar la lluvia tiene límite: si no llega, al día siguiente el pronóstico ya no basta para seguir sin regar', () => {
  // Umbral 10: hoy 10,5 + 2,5 de consumo = 13 (justo el límite de 10 + 3) → se espera la lluvia de mañana.
  const s10 = { ...S, thresholdMm: 10 };
  const w = [wx('2026-10-27', { et0Mm: 3.125 }), wx('2026-10-28', { precipitationMm: 12, precipitationProbMax: 80, et0Mm: 3.125 }), wx('2026-10-29', { precipitationMm: 12, precipitationProbMax: 80 })];
  assert.equal(c.evaluate(st({ deficitMm: 10.5 }), w, s10, '2026-10-27').rainBlockReason, 'tomorrow');
  // Mañana (13 mm) el pronóstico todavía pausa: 13 no supera 10 + 3.
  assert.equal(c.evaluate(st({ deficitMm: 13, asOf: '2026-10-28' }), w, s10, '2026-10-28').status, 'paused_rain');
  // Si no llovió, pasado mañana el pasto está a 15,5 mm: aunque el pronóstico insista, se riega.
  const ev = c.evaluate(st({ deficitMm: 15.5, asOf: '2026-10-29' }), w, s10, '2026-10-29');
  assert.equal(ev.status, 'irrigate');
  assert.equal(c.forecastPauses(w[2], 15.5, 10), false);
  assert.equal(c.forecastPauses(w[2], 12, 10), true);
});

test('sin consultar (fetch: false): la lluvia de hoy guardada usa el respaldo solo si es el vigente y está al día', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no debería consultar'); };
  try {
    const now = Date.parse('2026-10-27T12:40:00Z');
    const rf = { field: 'aguaCaida24Horas', kind: 'accumulated' };
    const store = (code, from, minutes, rain) => dmc.mergeStore(null, code, rf, dmc.rainPoints(series(from, minutes, rain), rf), now);
    const oldPrimary = store('330160', '2026-10-24T08:00:00Z', 600, () => 0);
    const wetBackup = store('330071', '2026-10-27T03:00:00Z', 560, (t) => (t.toISOString().startsWith('2026-10-27T11:') ? 0.2 : 0));
    const live = async (o) => (await dmc.loadStationData({ ...base, now, maxAgeMs: 0, fetch: false, primaryPrev: oldPrimary, backupPrev: wetBackup, ...o })).live;
    assert.ok((await live({})).mm > 0);
    // Un respaldo de otra estación (p. ej. tras mudarse) no se usa
    assert.equal((await live({ backupPrev: { ...wetBackup, code: '330113' } })).sinceMs, null);
    // Un respaldo viejo tampoco
    assert.equal((await live({ now: now + 6 * 3_600_000 })).sinceMs, null);
    // Si lo guardado es de otra estación (se cambió de estación), la elegida cuenta como sin datos: se usa el respaldo
    assert.ok((await live({ primaryPrev: { ...oldPrimary, code: '330999' } })).mm > 0);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('avisos sin sonido los días que no toca regar (si se pidió); los de riego siguen sonando', () => {
  const now = new Date(2026, 9, 27, 5, 0);
  const w = [wx('2026-10-27'), wx('2026-10-28'), wx('2026-10-29')];
  const quiet = { ...S, quietOkAlerts: true };
  const ok = c.planNotifications({ state: st({ deficitMm: 2 }), weather: w, settings: quiet, now }).notifications[0];
  assert.equal(ok.title, '✅ Hoy no hace falta regar');
  assert.equal(ok.channelId, 'riego-info');
  const water = c.planNotifications({ state: st({ deficitMm: 9.5 }), weather: w, settings: quiet, now }).notifications[0];
  assert.equal(water.channelId, 'riego-matutino');
  assert.equal(c.planNotifications({ state: st({ deficitMm: 2 }), weather: w, settings: S, now }).notifications[0].channelId, 'riego-matutino');
});

test('con el pasto muy seco, una lluvia casi segura y abundante hoy igual pausa; una dudosa no', () => {
  // Umbral 8, déficit 11,5 (más de 8 + 3): hoy 95 % y 20 mm → 11,5 + 2,4 − 16 ≤ 4: no se riega antes del aguacero.
  const heavy = wx('2026-10-27', { precipitationMm: 20, precipitationProbMax: 95 });
  assert.equal(c.evaluate(st({ deficitMm: 11.5 }), [heavy], S, '2026-10-27').status, 'paused_rain');
  // 60 % y 6 mm: no alcanza para seguir esperando con el pasto tan seco.
  const doubtful = wx('2026-10-27', { precipitationMm: 6, precipitationProbMax: 60 });
  assert.equal(c.evaluate(st({ deficitMm: 11.5 }), [doubtful], S, '2026-10-27').status, 'irrigate');
  // Con el pasto apenas sobre el umbral, el pronóstico dudoso sí pausa (regla de siempre).
  assert.equal(c.evaluate(st({ deficitMm: 9 }), [doubtful], S, '2026-10-27').status, 'paused_rain');
});

// ───────────── Lluvia de hoy: medida + lo que falta según el pronóstico por hora ─────────────

import { parseForecast } from '../src/app/core/open-meteo.ts';

test('pronóstico por hora: cada valor es la lluvia de la hora anterior (mediana de los modelos)', () => {
  const time = ['2026-10-26T00:00', '2026-10-26T14:00', '2026-10-26T15:00', '2026-10-27T00:00'];
  const days = parseForecast({
    daily: { time: ['2026-10-26'], precipitation_sum_ecmwf_ifs025: [3], precipitation_sum_gfs_seamless: [3], precipitation_sum_icon_seamless: [9] },
    hourly: {
      time,
      precipitation_ecmwf_ifs025: [0.5, 1, 2, 0.4],
      precipitation_gfs_seamless: [0.5, 1, 1, 0.4],
      precipitation_icon_seamless: [9, 9, 9, 9],
    },
  });
  const h = days[0].hourlyRainMm;
  assert.equal(h[13], 1); // 14:00 → de 13 a 14
  assert.equal(h[14], 2); // mediana de 2, 1, 9
  assert.equal(h[23], 0.4); // 00:00 del 27 → de 23 a 24 del 26
  assert.equal(h[0], 0); // 00:00 del 26 es del día 25
});

test('lluvia fantasma: pronóstico de 8,6 mm por la tarde, la estación midió 0 hasta las 22:15 → hoy cuenta ~0', () => {
  const hourly = new Array(24).fill(0);
  for (let h = 14; h < 20; h++) hourly[h] = 8.6 / 6;
  const at = (h, m = 0) => new Date(2026, 9, 26, h, m).getTime();
  const live = { date: '2026-10-26', mm: 0, sinceMs: at(0), lastAtMs: at(22, 15), lastHourMm: 0, rainingNow: false, hourly: [], steps: [] };
  const today = wx('2026-10-26', { precipitationMm: 8.6, precipitationProbMax: 86, hourlyRainMm: hourly, live });
  assert.equal(c.dayRain(today), 0);
  const ev = c.evaluate(st({ deficitMm: 9, asOf: '2026-10-26' }), [today, wx('2026-10-27')], S, '2026-10-26');
  assert.equal(ev.rainForecastLeftMm, 0);
  assert.equal(ev.status, 'irrigate'); // ya no la frena una lluvia que no cayó
  assert.ok(ev.projectedDeficitMm > 9); // y mañana el déficit sube en vez de "0 mm"
  // A las 06:00, con la lluvia aún por venir, sí se espera
  const morning = { ...today, live: { ...live, lastAtMs: at(6) } };
  assert.ok(Math.abs(c.dayRain(morning) - 8.6) < 0.05);
  assert.equal(c.evaluate(st({ deficitMm: 9, asOf: '2026-10-26' }), [morning, wx('2026-10-27')], S, '2026-10-26').status, 'paused_rain');
  // Lecturas recién desde las 06:49: la lluvia pronosticada de madrugada (sin medir) sí cuenta
  const early = hourly.slice(); early[3] = 2;
  const late = { ...today, hourlyRainMm: early, live: { ...live, sinceMs: at(6, 49) } };
  assert.equal(c.dayRain(late), 2);
});
