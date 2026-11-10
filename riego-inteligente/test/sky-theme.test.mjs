import test from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../src/app/ui/sky-backdrop/sky-theme.ts';

test('momento del día: amanecer 6:30, día 8:00, atardecer 19:30 y noche 21:00', () => {
  assert.equal(s.dayPhase(3), 'night');
  assert.equal(s.dayPhase(6.49), 'night');
  assert.equal(s.dayPhase(6.5), 'dawn');
  assert.equal(s.dayPhase(8), 'day');
  assert.equal(s.dayPhase(14.2), 'day');
  assert.equal(s.dayPhase(19.5), 'dusk');
  assert.equal(s.dayPhase(21), 'night');
  assert.equal(s.dayPhase(23.9), 'night');
});

test('hora local con fracción', () => {
  assert.equal(s.hourOfDay(new Date(2026, 10, 9, 13, 30).getTime()), 13.5);
});

test('estrellas y sol solo con cielo despejado; las nubes crecen con lluvia', () => {
  assert.equal(s.skyTheme('sun', 23).stars, true);
  assert.equal(s.skyTheme('sun', 12).stars, false);
  assert.equal(s.skyTheme('rain', 23).stars, false);
  assert.equal(s.skyTheme('rain', 12).celestial, false);
  assert.equal(s.skyTheme('wind', 12).celestial, true);
  assert.equal(s.skyTheme('rain', 12).clouds, 3);
  assert.equal(s.skyTheme('cloud', 12).clouds, 2);
});

test('clases CSS: momento del día y clima', () => {
  assert.equal(s.skyClasses(s.skyTheme('sun', 23)), 'phase-night scene-sun stars celestial');
  assert.equal(s.skyClasses(s.skyTheme('rain', 10)), 'phase-day scene-rain');
});
