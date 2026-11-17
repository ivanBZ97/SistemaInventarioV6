import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/app/ui/lawn-hero/pet-motion.ts';

test('siete hojas, cada una con su ritmo: no se mecen todas a la vez', () => {
  const blades = m.layoutBlades('happy');
  assert.equal(blades.length, 7);
  assert.ok(new Set(blades.map((b) => b.delay)).size >= 5, 'desfases distintos');
  assert.ok(new Set(blades.map((b) => b.dur)).size >= 3, 'duraciones distintas');
  assert.ok(blades.every((b) => b.delay <= 0 && b.dur >= 2.4 && b.dur <= 4.2));
  // Las hojas altas se mecen más que las bajas.
  const byK = [...blades].sort((a, b) => a.k - b.k);
  assert.ok(byK.at(-1).k > byK[0].k);
});

test('la caída de las hojas sigue al ánimo: tiesas, a medias o caídas hacia los lados', () => {
  const rot = (mood) => m.layoutBlades(mood).map((b) => Math.round(Math.abs(b.rot)));
  assert.deepEqual(rot('happy'), [0, 0, 0, 0, 0, 0, 0]);
  assert.ok(rot('thirsty')[0] > 0 && rot('wilted')[0] > rot('thirsty')[0]);
  const wilted = m.layoutBlades('wilted');
  assert.ok(wilted[0].rot < 0 && wilted[6].rot > 0); // cada lado cae hacia afuera
});

test('al tocarlo suelta un efecto según el ánimo y no se repite en el mismo lugar', () => {
  assert.equal(m.puffFor('thirsty', 3), '💧');
  assert.equal(m.puffFor('happy', 0), '💚');
  assert.ok(['💚', '✨'].includes(m.puffFor('happy', 7)));
  const xs = [1, 2, 3, 4, 5].map(m.puffX);
  assert.equal(new Set(xs).size, 5);
  assert.ok(xs.every((x) => x > m.BODY.cx - 60 && x < m.BODY.cx + 60));
});
