import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { hex, hmacSha256, sha256, utf8 } from '../src/app/core/sha256.ts';
import * as tuya from '../src/app/core/tuya.ts';

test('SHA-256 y HMAC-SHA256 coinciden con node:crypto (incluye textos largos y con tildes)', () => {
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'b'.repeat(64), 'riego ñandú 💧'.repeat(30)]) {
    assert.equal(hex(sha256(utf8(text))), createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.equal(hex(hmacSha256(utf8('secreto'), utf8(text))), createHmac('sha256', 'secreto').update(text, 'utf8').digest('hex'));
  }
  const longKey = 'k'.repeat(100);
  assert.equal(hex(hmacSha256(utf8(longKey), utf8('x'))), createHmac('sha256', longKey).update('x').digest('hex'));
});

test('firma de Tuya: HMAC(client_id + [token] + t + nonce + stringToSign) en mayúsculas', () => {
  const emptyHash = createHash('sha256').update('').digest('hex');
  const expected = (str) => createHmac('sha256', 'SECRET').update(str).digest('hex').toUpperCase();
  const tokenSign = tuya.tuyaSign({ accessId: 'ID', secret: 'SECRET', t: '1730000000000', method: 'GET', path: '/v1.0/token?grant_type=1' });
  assert.equal(tokenSign, expected(`ID1730000000000GET\n${emptyHash}\n\n/v1.0/token?grant_type=1`));
  const devSign = tuya.tuyaSign({ accessId: 'ID', secret: 'SECRET', t: '1730000000000', method: 'GET', path: '/v1.0/devices/abc', accessToken: 'TOK' });
  assert.equal(devSign, expected(`IDTOK1730000000000GET\n${emptyHash}\n\n/v1.0/devices/abc`));
});

test('lee humedad, temperatura y batería del sensor (y las variantes en décimas)', () => {
  const s = tuya.parseSoilDevice({ name: 'Pasto', online: true, update_time: 1730000000,
    status: [{ code: 'humidity', value: 32 }, { code: 'temp_current', value: 187 }, { code: 'battery_percentage', value: 90 }] });
  assert.deepEqual({ ...s, codes: undefined }, { name: 'Pasto', online: true, updatedAt: 1730000000000, soilPct: 32, tempC: 18.7, battery: 90, codes: undefined });
  assert.equal(tuya.parseSoilDevice({ status: [{ code: 'soil_moisture', value: 355 }] }).soilPct, 35.5);
  assert.equal(tuya.parseSoilDevice({ status: [] }).soilPct, null);
});

test('calibración: húmedo = déficit 0, toca regar = umbral; sin calibrar, null', () => {
  const cal = { wetPct: 40, dryPct: 24 };
  assert.equal(tuya.deficitFromSensor(40, cal, 8), 0);
  assert.equal(tuya.deficitFromSensor(24, cal, 8), 8);
  assert.equal(tuya.deficitFromSensor(32, cal, 8), 4);
  assert.equal(tuya.deficitFromSensor(45, cal, 8), 0); // más húmedo que "lleno"
  assert.equal(tuya.deficitFromSensor(16, cal, 8), 12); // más seco que "toca regar"
  assert.equal(tuya.deficitFromSensor(30, { wetPct: 40 }, 8), null);
  assert.equal(tuya.deficitFromSensor(30, { wetPct: 30, dryPct: 29 }, 8), null); // puntos demasiado juntos
});

const cfg = { region: 'us', accessId: 'ID', accessSecret: 'SECRET', deviceId: 'dev1', enabled: true };
const device = { success: true, result: { name: 'Pasto', online: true, update_time: 1730000000, status: [{ code: 'humidity', value: 30 }] } };

test('lee el sensor: pide token, firma con él y lo reutiliza mientras no vence', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      if (String(url).includes('/token')) return { ok: true, status: 200, json: async () => ({ success: true, result: { access_token: 'TOK', expire_time: 7200 } }) };
      return { ok: true, status: 200, json: async () => device };
    };
    const now = 1730000000000;
    const r = await tuya.readTuyaSoil(cfg, now, null);
    assert.equal(r.status.soilPct, 30);
    assert.equal(calls[0].url, 'https://openapi.tuyaus.com/v1.0/token?grant_type=1');
    assert.equal(calls[1].url, 'https://openapi.tuyaus.com/v1.0/devices/dev1');
    assert.equal(calls[1].headers.access_token, 'TOK');
    assert.equal(calls[1].headers.sign, tuya.tuyaSign({ accessId: 'ID', secret: 'SECRET', t: String(now), method: 'GET', path: '/v1.0/devices/dev1', accessToken: 'TOK' }));
    await tuya.readTuyaSoil(cfg, now + 60_000, r.token);
    assert.equal(calls.filter((c) => c.url.includes('/token')).length, 1); // token reutilizado
  } finally {
    globalThis.fetch = orig;
  }
});

test('si Tuya rechaza el token guardado, pide otro una vez; los errores se explican en palabras simples', async () => {
  const orig = globalThis.fetch;
  let deviceCalls = 0;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/token')) return { ok: true, status: 200, json: async () => ({ success: true, result: { access_token: 'NEW', expire_time: 7200 } }) };
      deviceCalls++;
      return { ok: true, status: 200, json: async () => (deviceCalls === 1 ? { success: false, code: 1010, msg: 'token invalid' } : device) };
    };
    const r = await tuya.readTuyaSoil(cfg, 1730000000000, { accessToken: 'OLD', expiresAt: 1730003600000 });
    assert.equal(r.token.accessToken, 'NEW');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: false, code: 1106, msg: 'permission deny' }) });
    await assert.rejects(tuya.readTuyaSoil(cfg, 1730000000000, { accessToken: 'NEW', expiresAt: 1730003600000 }), (e) => {
      assert.match(tuya.tuyaErrorText(e), /vincula tu cuenta de Smart Life/);
      return true;
    });
  } finally {
    globalThis.fetch = orig;
  }
});
