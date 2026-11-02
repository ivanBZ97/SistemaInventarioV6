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

test('pide el historial a Tuya (un código por consulta, parámetros en orden alfabético) y recorre las páginas', async () => {
  const orig = globalThis.fetch;
  const urls = [];
  try {
    const now = Date.now();
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      const page2 = String(url).includes('last_row_key');
      const code = /codes=([a-z_]+)/.exec(String(url))[1];
      return { ok: true, status: 200, json: async () => ({ success: true, result: {
        has_more: !page2, last_row_key: page2 ? null : 'ROW1',
        logs: [{ code, value: page2 ? '50' : '49', event_time: now - (page2 ? 2 : 1) * 3_600_000 }],
      } }) };
    };
    const cfg = { region: 'us', accessId: 'ID', accessSecret: 'SECRET', deviceId: 'dev1', enabled: false };
    const logs = await tuya.readTuyaReportLogs(cfg, { accessToken: 'TOK', expiresAt: Infinity }, ['humidity', 'temp_current'], now - 86_400_000, now);
    assert.equal(logs.length, 4);
    assert.match(urls[0], /^https:\/\/openapi\.tuyaus\.com\/v2\.0\/cloud\/thing\/dev1\/report-logs\?codes=humidity&end_time=\d+&size=20&start_time=\d+$/);
    assert.match(urls[1], /codes=humidity&end_time=\d+&last_row_key=ROW1&size=20&start_time=/);
    assert.match(urls[2], /codes=temp_current/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('si Tuya rechaza esa forma ("Parameter error"), prueba las otras y recuerda la que funcionó', async () => {
  const orig = globalThis.fetch;
  const urls = [];
  try {
    const now = Date.now();
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (!String(url).includes('/v1.0/devices/')) return { ok: true, status: 200, json: async () => ({ success: false, code: 40000303, msg: 'Parameter error!' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, result: { has_next: false, logs: [{ code: 'humidity', value: '61', event_time: now - 3_600_000 }] } }) };
    };
    const cfg = { region: 'us', accessId: 'ID', accessSecret: 'SECRET', deviceId: 'dev1', enabled: false };
    const tk = { accessToken: 'TOK', expiresAt: Infinity };
    const logs = await tuya.readTuyaReportLogs(cfg, tk, ['humidity'], now - 86_400_000, now);
    assert.equal(logs[0].value, '61');
    assert.match(urls.at(-1), /\/v1\.0\/devices\/dev1\/logs\?codes=humidity&end_time=\d+&size=100&start_time=\d+&type=7$/);
    urls.length = 0;
    await tuya.readTuyaReportLogs(cfg, tk, ['humidity'], now - 86_400_000, now);
    assert.equal(urls.length, 1); // va directo a la que funcionó
  } finally {
    globalThis.fetch = orig;
  }
});

test('la hora del último reporte es el dato medido más nuevo (la humedad puede no cambiar en toda la noche)', () => {
  const st = tuya.parseSoilDevice({}, [
    { code: 'humidity', value: 100, time: 1730000000000 },
    { code: 'temp_current', value: 116, time: 1730030000000 },
    { code: 'alarm_switch', value: true, time: 1730090000000 }, // un ajuste, no una medición
  ]);
  assert.equal(st.updatedAt, 1730030000000);
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
