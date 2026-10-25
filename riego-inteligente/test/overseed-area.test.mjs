import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/app/core/irrigation-core.ts';

const wx = (date, o = {}) => ({ date, et0Mm: 4, precipitationMm: 0, precipitationProbMax: 0, tempMaxC: 25, windMaxKmh: 10, ...o });
const S = c.DEFAULT_SETTINGS;
const base = { deficitMm: 3, asOf: '2026-01-13', source: 'model' };
const full = c.startOverseed(base, '2026-01-13', 'full');
const patches = c.startOverseed(base, '2026-01-13', 'patches');
const w = [wx('2026-01-13'), wx('2026-01-14'), wx('2026-01-15')];

test('se guarda dónde se sembró; sin elegir (versiones anteriores) son parches', () => {
  assert.equal(full.overseedArea, 'full');
  assert.equal(full.overseedUntil, '2026-01-22');
  assert.equal(c.overseedArea(c.startOverseed(base, '2026-01-13')), 'patches');
  assert.equal(c.overseedArea({ ...base, overseedUntil: '2026-01-20' }), 'patches');
});

test('todo el jardín: mientras germina se riega al llegar a 2 mm (riego corto casi a diario)', () => {
  assert.equal(c.thresholdFor(full, S, '2026-01-13'), 2);
  assert.equal(c.thresholdFor(full, S, '2026-01-23'), S.thresholdMm); // terminó la resiembra
  assert.equal(c.thresholdFor(patches, S, '2026-01-13'), S.thresholdMm);
  const ev = c.evaluate(full, w, S, '2026-01-13');
  assert.equal(ev.status, 'irrigate');
  assert.equal(ev.minutes, 5); // 3 mm a 0,6 mm/min
  assert.equal(ev.overseed, 'full');
  assert.equal(ev.thresholdMm, 2);
  const n = c.morningNotification(ev, c.atTime('2026-01-13', c.MORNING));
  assert.equal(n.title, '🌱 Riego de siembra: 5 min en todo el jardín');
  assert.match(n.body, /mantener húmeda la semilla/);
  assert.equal(n.actions, true);
  // "Próximo riego" también: hoy
  assert.equal(c.forecastNextIrrigation(full, w, S, '2026-01-13').daysAhead, 0);
});

test('parches: el pasto sigue su umbral y el aviso recuerda rociar los parches', () => {
  const ev = c.evaluate(patches, w, S, '2026-01-13');
  assert.equal(ev.status, 'ok');
  assert.equal(ev.overseed, 'patches');
  const n = c.morningNotification(ev, c.atTime('2026-01-13', c.MORNING));
  assert.equal(n.title, '✅ Hoy no hace falta regar');
  assert.match(n.body, /Rocía también los parches sembrados unos 30 segundos/);
  const thirsty = c.evaluate({ ...patches, deficitMm: 9 }, w, S, '2026-01-13');
  assert.match(c.morningNotification(thirsty, c.atTime('2026-01-13', c.MORNING)).body, /Rocía también los parches/);
  // Sin resiembra no se menciona nada
  assert.doesNotMatch(c.morningNotification(c.evaluate(base, w, S, '2026-01-13'), c.atTime('2026-01-13', c.MORNING)).body, /parches/);
});

test('13:00 con calor: riego corto de todo el jardín, o rociar los parches; con lluvia medida hoy, nada', () => {
  const now = new Date(2026, 0, 13, 9, 0);
  const at13 = (state, weather) => c.planNotifications({ state, weather, settings: S, now }).notifications.find((x) => x.id === c.NOTIF_ID_OVERSEED);
  assert.match(at13(full, w).body, /Riega todo el jardín 3 min \(riego corto\)/);
  assert.equal(at13(patches, w).body, c.OVERSEED_MESSAGE);
  const rained = [wx('2026-01-13', { live: { date: '2026-01-13', mm: 3, sinceMs: 0, lastAtMs: 1, lastHourMm: 0, rainingNow: false, hourly: [], steps: [[1, 3]] } }), ...w.slice(1)];
  assert.match(at13(full, rained).body, /la lluvia de hoy mantiene húmeda la semilla/);
  // Con frío no hay aviso de las 13:00 (como antes)
  assert.equal(at13(full, [wx('2026-01-13', { tempMaxC: 15 }), ...w.slice(1)]), undefined);
});
