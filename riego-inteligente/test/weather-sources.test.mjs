import test from 'node:test';
import assert from 'node:assert/strict';
import { parseForecast } from '../src/app/core/open-meteo.ts';
import * as ag from '../src/app/core/agromet.ts';

const M = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];

test('multi-modelo: promedia modelos y ignora nulls', () => {
  const daily = { time: ['2026-01-10', '2026-01-11'] };
  const set = (name, vals) => M.forEach((m, i) => (daily[`${name}_${m}`] = vals[i]));
  set('et0_fao_evapotranspiration', [[4, 4], [5, 5], [6, null]]);
  set('precipitation_sum', [[0, 6], [0, 0], [0, 3]]);
  set('precipitation_probability_max', [[null, null], [null, null], [null, null]]);
  set('temperature_2m_max', [[20, 20], [22, 22], [24, 24]]);
  set('wind_speed_10m_max', [[10, 10], [10, 10], [10, 10]]);
  const [d0, d1] = parseForecast({ daily });
  assert.equal(d0.et0Mm, 5);
  assert.equal(d1.et0Mm, 4.5); // el null no cuenta
  assert.equal(d0.precipitationMm, 0);
  assert.equal(d1.precipitationMm, 3);
  assert.equal(d1.precipitationProbMax, (100 * 2) / 3); // sin probabilidad: % de modelos con ≥ 1 mm
  assert.equal(d1.tempMaxC, 22);
});

test('sin sufijos (un solo modelo) sigue funcionando', () => {
  const daily = {
    time: ['2026-01-10'], et0_fao_evapotranspiration: [4], precipitation_sum: [2],
    precipitation_probability_max: [40], temperature_2m_max: [25], wind_speed_10m_max: [12],
  };
  const [d] = parseForecast({ daily });
  assert.deepEqual([d.et0Mm, d.precipitationMm, d.precipitationProbMax], [4, 2, 40]);
});

test('Agromet: estaciones más cercanas ordenadas por distancia', () => {
  const st = (id, latitude, longitude) => ({ id, name: id, comuna: '', latitude, longitude, elevationM: null });
  const near = ag.nearestStations([st('lejos', -34.9, -71.2), st('buin', -33.73, -70.75), st('paine', -33.81, -70.74)], -33.75, -70.74, 2);
  assert.deepEqual(near.map((s) => s.id), ['buin', 'paine']);
  assert.ok(near[0].distanceKm < 3);
});

test('Agromet: suma la lluvia por día y tolera formatos', () => {
  const m = ag.sumByDay([
    { tiempo: '2026-01-10 01:00:00', valor: '0,2' },
    { tiempo: '2026-01-10T13:00:00', valor: 1.3 },
    { tiempo: '2026-01-11 00:00:00', valor: 0 },
    { tiempo: 'basura', valor: 5 },
    { tiempo: '2026-01-11 02:00:00', valor: null },
  ]);
  assert.equal(Math.round(m.get('2026-01-10') * 10) / 10, 1.5);
  assert.equal(m.get('2026-01-11'), 0);
  assert.equal(m.size, 2);
});

test('Agromet: la lluvia observada pisa al modelo solo en días pasados con datos', () => {
  const day = (date, p) => ({ date, et0Mm: 4, precipitationMm: p, precipitationProbMax: 0, tempMaxC: 20, windMaxKmh: 5 });
  const out = ag.mergeObservedRain(
    [day('2026-01-09', 5), day('2026-01-10', 5), day('2026-01-11', 7)],
    new Map([['2026-01-10', 0.4], ['2026-01-11', 9]]),
    '2026-01-11',
  );
  assert.deepEqual(out.map((d) => d.precipitationMm), [5, 0.4, 7]); // hoy y días sin muestras no se tocan
});

test('lluvia multi-modelo: mediana, no promedio (un modelo exagerado no inventa lluvia)', () => {
  const daily = { time: ['2026-10-24'] };
  ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'].forEach((m, i) => {
    daily[`precipitation_sum_${m}`] = [[8.2, 0, 0][i]];
    daily[`et0_fao_evapotranspiration_${m}`] = [3.8];
  });
  const [d] = parseForecast({ daily });
  assert.equal(d.precipitationMm, 0); // el promedio habría dado 2,7 mm
});
