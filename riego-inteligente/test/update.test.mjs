import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease, updateAvailable } from '../src/app/core/update.ts';

const sha = (c) => c.repeat(40);

test('lee el commit y el número de build del release', () => {
  const r = parseRelease({ name: 'Riego Inteligente · build 23', body: `build 23 · ${sha('a')}`, target_commitish: sha('a'), published_at: '2026-10-27T01:00:00Z' });
  assert.deepEqual(r, { sha: sha('a'), run: 23, publishedAt: '2026-10-27T01:00:00Z' });
  // releases anteriores: solo "APK debug compilado desde <sha>"
  assert.deepEqual(parseRelease({ body: `APK debug compilado desde ${sha('b')}`, target_commitish: sha('b') }), { sha: sha('b'), run: null, publishedAt: null });
  assert.equal(parseRelease(null), null);
  assert.equal(parseRelease({}), null);
});

test('avisa solo si el publicado es más nuevo que este APK', () => {
  const build = { sha: sha('a'), run: 22 };
  assert.equal(updateAvailable({ sha: sha('b'), run: 23, publishedAt: null }, build), true);
  assert.equal(updateAvailable({ sha: sha('a'), run: 22, publishedAt: null }, build), false); // es este mismo
  assert.equal(updateAvailable({ sha: sha('c'), run: 21, publishedAt: null }, build), false); // más viejo
  assert.equal(updateAvailable({ sha: sha('b'), run: null, publishedAt: null }, build), true); // distinto, sin número
  assert.equal(updateAvailable({ sha: sha('b'), run: 30, publishedAt: null }, { sha: 'dev', run: 0 }), false); // desarrollo
  assert.equal(updateAvailable(null, build), false);
});
