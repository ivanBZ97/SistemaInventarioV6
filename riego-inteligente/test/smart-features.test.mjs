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
