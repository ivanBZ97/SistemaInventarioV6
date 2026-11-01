import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../src/app/core/sensor-history.ts';
import * as tuya from '../src/app/core/tuya.ts';

process.env.TZ = 'America/Santiago';

const T = Date.parse('2026-11-01T16:39:00-03:00');
const s = (t, soil, tempC = null, battery = null) => ({ t, soil, tempC, battery });

test('una muestra por reporte: la misma lectura consultada dos veces no se duplica y se completa', () => {
  const a = h.mergeSamples([s(T, 49)], [s(T, 49, 21.2, 81), s(T - 3_600_000, 52)], T);
  assert.deepEqual(a, [s(T - 3_600_000, 52), s(T, 49, 21.2, 81)]);
  const b = h.mergeSamples(a, [s(T, 49)], T);
  assert.equal(b.length, 2);
  assert.equal(b[1].tempC, 21.2); // no se pierde lo que ya traía
});

test('se descarta lo más viejo que el periodo guardado y lo inválido', () => {
  const old = s(T - 20 * 86_400_000, 60);
  assert.equal(h.mergeSamples([old], [s(T, 49)], T, 14).length, 1);
  assert.equal(h.mergeSamples([old], [s(T, 49)], T).length, 2);
  assert.equal(h.mergeSamples([], [s(NaN, 49), s(T, NaN)], T).length, 0);
});

test('resumen diario: mínimo, máximo, promedio y temperatura máxima, lo más nuevo primero', () => {
  const day1 = Date.parse('2026-10-31T10:00:00-03:00');
  const d = h.dailySensorSummary([s(day1, 60, 18), s(day1 + 3_600_000, 56, 22.5), s(T, 49, 21.2)]);
  assert.equal(d[0].date, '2026-11-01');
  assert.deepEqual({ ...d[1] }, { date: '2026-10-31', min: 56, max: 60, avg: 58, last: 56, tempMax: 22.5, count: 2 });
});

test('CSV con hora local y separado por punto y coma', () => {
  const csv = h.sensorCsv([s(T, 49, 21.2, 81), s(T + 3_600_000, 48)]).split('\n');
  assert.equal(csv[0], 'fecha_hora;humedad_suelo_pct;temperatura_c;bateria_pct');
  assert.equal(csv[1], '2026-11-01 16:39;49;21.2;81');
  assert.equal(csv[2], '2026-11-01 17:39;48;;');
});

test('registros de la nube de Tuya → muestras (humedad con la temperatura del mismo despertar)', () => {
  const logs = [
    { code: 'humidity', value: '49', event_time: T },
    { code: 'temp_current', value: '212', event_time: T + 2_000 },
    { code: 'humidity', value: 52, event_time: T - 3_600_000 },
    { code: 'temp_current', value: '180', event_time: T - 3 * 3_600_000 }, // muy lejos: no se empareja
    { code: 'humidity', value: 'x', event_time: T - 60_000 },
  ];
  const out = h.samplesFromLogs(logs, 'humidity', 'temp_current', { soil: tuya.normSoil, temp: tuya.normTemp });
  assert.deepEqual(out, [s(T, 49, 21.2), s(T - 3_600_000, 52, null)]);
});

test('pide el historial a Tuya con los parámetros en orden alfabético y recorre las páginas', async () => {
  const orig = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      const page2 = String(url).includes('last_row_key');
      return { ok: true, status: 200, json: async () => ({ success: true, result: {
        has_more: !page2, last_row_key: page2 ? null : 'ROW1',
        logs: [{ code: 'humidity', value: page2 ? '50' : '49', event_time: page2 ? T - 1000 : T }],
      } }) };
    };
    const cfg = { region: 'us', accessId: 'ID', accessSecret: 'SECRET', deviceId: 'dev1', enabled: false };
    const logs = await tuya.readTuyaReportLogs(cfg, { accessToken: 'TOK', expiresAt: Infinity }, ['humidity', 'temp_current'], 1000, 2000);
    assert.equal(logs.length, 2);
    assert.equal(urls[0], 'https://openapi.tuyaus.com/v2.0/cloud/thing/dev1/report-logs?codes=humidity,temp_current&end_time=2000&size=100&start_time=1000');
    assert.match(urls[1], /end_time=2000&last_row_key=ROW1&size=100/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('la lectura del sensor informa qué códigos usa este modelo', () => {
  const st = tuya.parseSoilDevice({ status: [{ code: 'soil_moisture', value: 355 }, { code: 'temp_current', value: 212 }] });
  assert.equal(st.soilCode, 'soil_moisture');
  assert.equal(st.tempCode, 'temp_current');
});

test('el mismo reporte con horas apenas distintas (en vivo y desde la nube) queda una sola vez', () => {
  const a = h.mergeSamples([s(T, 49, 21.2, 81)], [s(T + 1_500, 49, 21.2, null), s(T + 30 * 60_000, 49)], T + 3_600_000);
  assert.deepEqual(a, [s(T, 49, 21.2, 81), s(T + 30 * 60_000, 49)]);
});
