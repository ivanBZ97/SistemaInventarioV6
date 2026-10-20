import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/app/core/irrigation-core.ts';

const wx = (date, o = {}) => ({
  date, et0Mm: 4, precipitationMm: 0, precipitationProbMax: 0, tempMaxC: 28, windMaxKmh: 10, ...o,
});
const state = (o = {}) => ({ deficitMm: 0, asOf: '2026-01-10', source: 'model', ...o });
const S = c.DEFAULT_SETTINGS;

test('Kc por estación (hemisferio sur)', () => {
  assert.equal(c.kcForDate('2026-10-05'), 0.8);
  assert.equal(c.kcForDate('2026-12-01'), 0.85);
  assert.equal(c.kcForDate('2026-02-01'), 0.85);
  assert.equal(c.kcForDate('2026-04-01'), 0.7);
  assert.equal(c.kcForDate('2026-07-01'), 0.55);
});

test('lluvia efectiva: 80 % solo si > 2 mm', () => {
  assert.equal(c.effectiveRain(2), 0);
  assert.equal(c.effectiveRain(1.5), 0);
  assert.equal(c.effectiveRain(10), 8);
});

test('balance diario acumula ETc − lluvia efectiva y nunca baja de 0', () => {
  const w = [wx('2026-01-10'), wx('2026-01-11', { precipitationMm: 30 }), wx('2026-01-12')];
  const r = c.rollForward(state(), w, '2026-01-12');
  // día 10: 4*0.85 = 3.4 ; día 11: 3.4 − 24 → max(0, ...) = 0
  assert.equal(r.state.deficitMm, 0);
  assert.equal(r.days.length, 2);
  const r2 = c.rollForward(state(), [wx('2026-01-10'), wx('2026-01-11')], '2026-01-12');
  assert.ok(Math.abs(r2.state.deficitMm - 6.8) < 1e-9);
});

test('evaluación: riega con déficit ≥ umbral y calcula minutos', () => {
  const w = ['10', '11', '12', '13'].map((d) => wx(`2026-01-${d}`));
  const ev = c.evaluate(state({ deficitMm: 0 }), w, S, '2026-01-13');
  assert.ok(Math.abs(ev.deficitMm - 10.2) < 1e-9);
  assert.equal(ev.status, 'irrigate');
  assert.equal(ev.minutes, 17); // 10.2 / 0.6
  assert.equal(c.minutesFor(9, 0.6), 15);
});

test('bloqueo por lluvia (prob ≥ 50 % o ≥ 4 mm) y aviso de viento', () => {
  const base = ['10', '11', '12', '13'].map((d) => wx(`2026-01-${d}`));
  const prob = [...base.slice(0, 3), wx('2026-01-13', { precipitationProbMax: 50 })];
  assert.equal(c.evaluate(state(), prob, S, '2026-01-13').status, 'paused_rain');
  const mm = [...base.slice(0, 3), wx('2026-01-13', { precipitationMm: 4 })];
  assert.equal(c.evaluate(state(), mm, S, '2026-01-13').status, 'paused_rain');
  const wind = [...base.slice(0, 3), wx('2026-01-13', { windMaxKmh: 26 })];
  assert.equal(c.evaluate(state(), wind, S, '2026-01-13').windWarning, true);
  assert.equal(c.evaluate(state({ deficitMm: 0 }), base.slice(0, 2), S, '2026-01-11').status, 'ok');
});

test('proyección de mañana descuenta la lluvia prevista de hoy', () => {
  const w = [wx('2026-01-12'), wx('2026-01-13', { precipitationMm: 10 })];
  const ev = c.evaluate(state({ asOf: '2026-01-13', deficitMm: 6 }), w, S, '2026-01-13');
  assert.equal(ev.deficitMm, 6);                       // hoy aún no cuenta la lluvia de hoy
  assert.equal(ev.effectiveRainTodayMm, 8);
  assert.ok(Math.abs(ev.projectedDeficitMm - (6 + 3.4 - 8)) < 1e-9);
  const small = c.evaluate(state({ asOf: '2026-01-13', deficitMm: 6 }), [wx('2026-01-13', { precipitationMm: 1.5 })], S, '2026-01-13');
  assert.equal(small.effectiveRainTodayMm, 0);         // < 2 mm no cuenta
});

test('humedad útil: 0 mm → 100 %, 12 mm → 20 %', () => {
  assert.equal(c.humidityPct(0), 100);
  assert.equal(c.humidityPct(12), 20);
  assert.ok(Math.abs(c.deficitFromHumidity(c.humidityPct(7)) - 7) < 1e-9);
});

test('notificación matutina usa los textos pedidos', () => {
  const w = ['10', '11', '12', '13'].map((d) => wx(`2026-01-${d}`));
  const ev = c.evaluate(state(), w, S, '2026-01-13');
  const n = c.morningNotification(ev, c.atTime('2026-01-13', c.MORNING));
  assert.equal(n.title, '💧 Hoy toca regar el pasto (17 min)');
  assert.equal(n.body, 'Déficit acumulado: 10.2 mm | ETc ayer: 3.4 mm | Temp máx hoy: 28°C.');
  assert.equal(n.actions, true);
});

test('nunca se programa riego fuera de 06:30–08:30', () => {
  const late = c.clampToIrrigationWindow(new Date(2026, 0, 13, 22, 0));
  assert.equal(late.getHours(), 8); assert.equal(late.getMinutes(), 30);
  const early = c.clampToIrrigationWindow(new Date(2026, 0, 13, 3, 0));
  assert.equal(early.getHours(), 6); assert.equal(early.getMinutes(), 30);
});

test('planificación: antes de las 06:30 → hoy; después de la ventana → mañana', () => {
  const w = ['10', '11', '12', '13', '14'].map((d) => wx(`2026-01-${d}`));
  const st = state({ asOf: '2026-01-13' });
  const p1 = c.planNotifications({ state: st, weather: w, settings: S, now: new Date(2026, 0, 13, 5, 0) });
  assert.equal(p1.morningFor, '2026-01-13');
  const p2 = c.planNotifications({ state: st, weather: w, settings: S, now: new Date(2026, 0, 13, 15, 0) });
  assert.equal(p2.morningFor, '2026-01-14');
  assert.equal(p2.notifications[0].at.getHours(), 6);
  // catch-up dentro de la ventana si hoy no se programó
  const p3 = c.planNotifications({ state: st, weather: w, settings: S, now: new Date(2026, 0, 13, 7, 0) });
  assert.equal(p3.morningFor, '2026-01-13');
  // posponer silencia el día
  const p4 = c.planNotifications({
    state: { ...st, snoozedDate: '2026-01-13' }, weather: w, settings: S, now: new Date(2026, 0, 13, 5, 0),
  });
  assert.equal(p4.notifications.filter((n) => n.id === c.NOTIF_ID_MORNING).length, 0);
});

test('modo resiembra: 10 días y alerta 13:00 solo si tmax ≥ 20 °C', () => {
  let st = c.startOverseed(state({ asOf: '2026-01-13' }), '2026-01-13');
  assert.equal(st.overseedUntil, '2026-01-22');
  assert.equal(c.overseedDaysLeft(st, '2026-01-13'), 10);
  assert.equal(c.overseedDaysLeft(st, '2026-01-23'), 0);
  const now = new Date(2026, 0, 13, 9, 0);
  const hot = [wx('2026-01-12'), wx('2026-01-13', { tempMaxC: 21 }), wx('2026-01-14')];
  const p = c.planNotifications({ state: st, weather: hot, settings: S, now });
  const n = p.notifications.find((x) => x.id === c.NOTIF_ID_OVERSEED);
  assert.ok(n); assert.equal(n.at.getHours(), 13);
  const cold = [wx('2026-01-12'), wx('2026-01-13', { tempMaxC: 15 }), wx('2026-01-14')];
  assert.ok(!c.planNotifications({ state: st, weather: cold, settings: S, now }).notifications.some((x) => x.id === c.NOTIF_ID_OVERSEED));
});

test('distanceKm: Santiago ↔ Valparaíso ≈ 100 km; mismo punto = 0', () => {
  assert.equal(c.distanceKm(-33.59, -70.7, -33.59, -70.7), 0);
  const d = c.distanceKm(-33.45, -70.66, -33.05, -71.62);
  assert.ok(d > 95 && d < 115, String(d));
});
