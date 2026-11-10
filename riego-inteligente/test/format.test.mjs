import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as f from '../src/app/core/format.ts';
import * as d from '../src/app/core/dates.ts';
import * as http from '../src/app/core/http.ts';
import { RUNNER_EVENT, RUNNER_LABEL } from '../src/app/core/runner-protocol.ts';

process.env.TZ = 'America/Santiago';

const NOW = Date.parse('2026-11-09T10:00:00-03:00');
const H = 3_600_000;

test('fechas de calendario local: sumar días, diferencias y nombres en español', () => {
  assert.equal(d.toISODate(new Date(NOW)), '2026-11-09');
  assert.equal(d.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(d.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(d.diffDays('2026-11-09', '2026-11-01'), 8);
  assert.equal(d.atTime('2026-11-09', { hour: 6, minute: 30 }).getTime(), Date.parse('2026-11-09T06:30:00-03:00'));
  assert.equal(d.weekdayEs('2026-11-09'), 'lunes');
  assert.equal(d.longDateEs('2026-11-09'), 'lunes 9 de noviembre');
});

test('números con coma decimal', () => {
  assert.equal(f.decimal(12.54), '12,5');
  assert.equal(f.decimal(8), '8');
  assert.equal(f.decimal(0.926, 2), '0,93');
  assert.equal(f.km(4), '4,0');
  assert.equal(f.capitalize('pasto'), 'Pasto');
});

test('horas y antigüedades en palabras', () => {
  assert.equal(f.clock(NOW), '10:00');
  assert.equal(f.dayMonthClock(NOW - 5 * 24 * H), '04/11 10:00');
  assert.equal(f.shortWhen(NOW - 2 * H, NOW), '08:00');
  assert.equal(f.shortWhen(NOW - 20 * H, NOW), 'ayer 14:00');
  assert.equal(f.shortWhen(NOW - 5 * 24 * H, NOW), '4/11 10:00');
  assert.equal(f.whenOf(NOW + 20.75 * H, NOW), 'mañana a las 06:45');
  assert.equal(f.whenOf(NOW - 20 * H, NOW), 'ayer a las 14:00');
  assert.equal(f.whenOf(NOW - 2 * 24 * H, NOW), 'el sábado 7/11 a las 10:00');
  assert.equal(f.ageText(45 * 60_000), '45 min');
  assert.equal(f.ageText(5 * H), '5 h');
  assert.equal(f.ageText(3 * 24 * H), '3 días');
  assert.equal(f.agoText(-1000), 'hace 0 min');
});

test('una consulta que no responde se abandona al cumplirse el tiempo límite', async () => {
  const orig = globalThis.fetch;
  try {
    let aborted = false;
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    await assert.rejects(
      http.fetchWithTimeout('https://example.invalid', {}, 20),
      (e) => e instanceof http.TimeoutError && /sin respuesta/.test(e.message),
    );
    assert.equal(aborted, true); // además cancela la conexión
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    assert.equal((await http.fetchWithTimeout('https://example.invalid', {}, 20)).status, 200);
  } finally {
    globalThis.fetch = orig;
  }
});

test('la configuración de Capacitor usa la etiqueta y el evento del protocolo del worker', () => {
  const config = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8');
  assert.ok(config.includes(`label: '${RUNNER_LABEL}'`));
  assert.ok(config.includes(`event: '${RUNNER_EVENT.refresh}'`));
});
