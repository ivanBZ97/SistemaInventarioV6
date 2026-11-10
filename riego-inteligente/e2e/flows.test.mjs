// Pruebas de extremo a extremo: la app compilada (www/) en un navegador real, con el reloj fijo, datos sembrados y
// la red simulada. Cubren los recorridos principales de las tres pantallas. Uso: `npm run e2e`.
import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { NOW, TODAY, day, mockNetwork, seed } from './fixtures.mjs';

const ROOT = fileURLToPath(new URL('../www', import.meta.url));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' };

let server;
let browser;
let origin;

before(async () => {
  assert.ok(existsSync(join(ROOT, 'index.html')), 'falta www/: ejecuta `npm run build` antes');
  server = createServer((req, res) => {
    let file = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** Abre una pantalla de la app con los datos sembrados. Falla si la página lanza errores. */
async function open(path, { height = 1000, data = seed() } = {}) {
  const context = await browser.newContext({
    viewport: { width: 400, height },
    timezoneId: 'America/Santiago',
    locale: 'es-CL',
    reducedMotion: 'reduce',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install({ time: new Date(NOW) });
  await mockNetwork(page);
  // Solo la primera carga siembra los datos: al navegar dentro de la app se conserva lo que ella guardó.
  await page.addInitScript((stored) => {
    if (sessionStorage.getItem('seeded')) return;
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(`CapacitorStorage.${key}`, JSON.stringify(value));
    sessionStorage.setItem('seeded', '1');
  }, data);
  await page.goto(`${origin}/#${path}`);
  const app = {
    page,
    data,
    /** Deja pasar el tiempo de la app (consultas, animaciones) y espera a que termine de dibujar. */
    settle: async () => {
      await page.clock.runFor(2500);
      await page.waitForTimeout(600);
    },
    /** Valor guardado por la app bajo una clave. */
    stored: (key) => page.evaluate((k) => JSON.parse(localStorage.getItem(`CapacitorStorage.${k}`) ?? 'null'), key),
    close: async () => {
      await context.close();
      assert.deepEqual(errors, [], 'la página lanzó errores');
    },
  };
  await app.settle();
  return app;
}

test('panel: muestra el estado del pasto, la recomendación y la lluvia medida', async () => {
  const app = await open('/dashboard', { height: 3400 });
  const text = await app.page.locator('ion-content').first().innerText();
  assert.match(text, /57\s*%/); // 6,4 mm de déficit menos la lluvia de hoy
  assert.match(text, /No es necesario regar/);
  assert.match(text, /Hoy ya llovieron 0,6 mm en El Milagro/);
  assert.match(text, /Sensor: 92 % \(hace 20 min\) · solo informativo/);
  assert.match(text, /Lluvia en tu sector[\s\S]*Hasta las 09:30 \(hace 30 min\)/);
  assert.match(text, /Próximo riego\s+Mañana/);
  assert.match(text, /Últimos 30 días[\s\S]*Riegos\s+3/);
  await app.close();
});

test('panel: registrar un riego repone el déficit y se puede deshacer', async () => {
  const app = await open('/dashboard');
  const { page, data } = app;
  await page.getByText('Registrar riego').click();
  await app.settle();
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  await app.settle();
  assert.equal((await app.stored('state')).deficitMm, 0);
  assert.equal((await app.stored('irrigations')).length, data.irrigations.length + 1);

  await page.locator('ion-toast').getByRole('button', { name: 'Deshacer' }).click();
  await app.settle();
  assert.equal((await app.stored('state')).deficitMm, data.state.deficitMm);
  assert.equal((await app.stored('irrigations')).length, data.irrigations.length);
  await app.close();
});

test('panel: el modo Resiembra pregunta dónde se sembró y dura 10 días', async () => {
  const app = await open('/dashboard', { height: 3400 });
  await app.page.locator('ion-toggle[aria-label="Modo Resiembra"]').click();
  await app.settle();
  await app.page.getByRole('button', { name: 'Activar' }).click();
  await app.settle();
  const state = await app.stored('state');
  assert.equal(state.overseedArea, 'patches');
  assert.equal(state.overseedUntil, day(9));
  await app.close();
});

test('ajustes: guardar sin tocar nada conserva todo; la hora del aviso se guarda', async () => {
  const app = await open('/settings', { height: 5200 });
  const { page, data } = app;
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await app.settle();
  assert.deepEqual(await app.stored('settings'), data.settings);

  await page.getByRole('radio', { name: '07:30' }).click();
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await app.settle();
  assert.equal((await app.stored('settings')).morningTime, '07:30');
  await app.close();
});

test('ajustes: la calculadora del balde propone la tasa y una latitud vacía no se guarda', async () => {
  const app = await open('/settings', { height: 5200 });
  const { page, data } = app;
  await page.getByText('Riego a mano: calcular').click();
  await page.locator('ion-input[label="Se llenó en"] input').fill('54');
  await app.settle();
  assert.match(
    await page.locator('app-irrigation-section').innerText(),
    /22,2 L\/min en 24 m² = 0,93 mm\/min\. Un riego de 8 mm serían unos 9 min/,
  );
  await page.getByText('Usar 0,93 mm/min').click();
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await app.settle();
  assert.equal((await app.stored('settings')).sprinklerRateMmMin, 0.93);

  await page.locator('ion-input[label="Latitud"] input').fill('');
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await app.settle();
  assert.equal((await app.stored('settings')).latitude, data.settings.latitude);
  await app.close();
});

test('ajustes: probar el sensor, calibrarlo (se guarda al tiro) y usarlo en el balance', async () => {
  const app = await open('/settings', { height: 5200 });
  const { page } = app;
  await page.getByText('Probar sensor').click();
  await app.settle();
  const report = await page.locator('app-sensor-section .report').innerText();
  assert.match(report, /SRW-PM01: humedad del suelo 92 % · 25,4 °C · batería 100 %/);
  assert.match(report, /Con tu calibración equivale a 1,3 mm de déficit/);

  await page.getByText('Ahora está recién regado').click();
  await app.settle();
  assert.equal((await app.stored('settings')).soilSensor.wetPct, 92);

  await page.locator('app-sensor-section ion-toggle').click();
  await app.settle();
  assert.equal((await app.stored('settings')).soilSensor.enabled, true);
  const state = await app.stored('state');
  assert.equal(state.source, 'sensor');
  assert.equal(state.deficitMm, 0); // 92 % es ahora el punto "húmedo"
  assert.equal(state.asOf, TODAY);
  await app.close();
});

test('historial del sensor: periodos, gráfico con calibración y copia en CSV', async () => {
  const app = await open('/sensor', { height: 1700 });
  const { page } = app;
  const week = await page.locator('ion-content').innerText();
  assert.match(week, /Ahora\s+92 %/);
  assert.match(week, /húmedo 100 %[\s\S]*toca regar 52 %/);
  assert.match(week, /Por día · 7 días/);

  await page.getByRole('radio', { name: '24 h' }).click();
  await app.settle();
  assert.match(await page.locator('ion-content').innerText(), /Por día · 24 h/);

  await page.getByText('Copiar CSV').click();
  await app.settle();
  const csv = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(csv, /^fecha_hora;humedad_suelo_pct;temperatura_c;bateria_pct\n/);
  await app.close();
});
