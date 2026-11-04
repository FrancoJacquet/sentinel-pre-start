import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';

test('defaults: loopback, puerto 4710, Meta apagada', () => {
  const c = loadConfig({});
  assert.deepEqual(c.hosts, ['127.0.0.1']);
  assert.equal(c.port, 4710);
  assert.equal(c.metaApiEnabled, false);
});

test('HUB_HOST con lista separada por comas', () => {
  const c = loadConfig({ HUB_HOST: '127.0.0.1, 192.0.2.10' });
  assert.deepEqual(c.hosts, ['127.0.0.1', '192.0.2.10']);
});

for (const host of ['0.0.0.0', '::', '[::]', '']) {
  test(`bind a todas las interfaces se rechaza: "${host}"`, () => {
    assert.throws(() => loadConfig({ HUB_HOST: `127.0.0.1,${host}` }), /bind/i);
  });
}

const KEY = 'k-secreta-de-prueba-123';
const ON = { META_API_ENABLED: 'true', MODEL_API_KEY: KEY, META_MAX_REQUESTS: '40' };

test('META_API_ENABLED=true con key y tope ⇒ Meta prendida con ese tope', () => {
  const c = loadConfig(ON);
  assert.equal(c.metaApiEnabled, true);
  assert.equal(c.metaMaxRequests, 40);
  assert.equal(c.metaApiKey, KEY);
});

test('Meta apagada: la key y el tope se ignoran, no quedan en la config', () => {
  const c = loadConfig({ ...ON, META_API_ENABLED: 'false' });
  assert.equal(c.metaApiEnabled, false);
  assert.equal(c.metaApiKey, null);
  assert.equal(c.metaMaxRequests, null);
});

// Cada caso se niega a arrancar con un mensaje claro y sin la key.
const refused: [string, NodeJS.ProcessEnv, RegExp][] = [
  ['sin MODEL_API_KEY', { META_API_ENABLED: 'true', META_MAX_REQUESTS: '40' }, /MODEL_API_KEY/],
  ['MODEL_API_KEY vacía', { ...ON, MODEL_API_KEY: '' }, /MODEL_API_KEY/],
  ['MODEL_API_KEY en blanco', { ...ON, MODEL_API_KEY: '   ' }, /MODEL_API_KEY/],
  ['sin META_MAX_REQUESTS', { META_API_ENABLED: 'true', MODEL_API_KEY: KEY }, /META_MAX_REQUESTS/],
  ['META_MAX_REQUESTS vacío', { ...ON, META_MAX_REQUESTS: '' }, /META_MAX_REQUESTS/],
  ['META_MAX_REQUESTS=0', { ...ON, META_MAX_REQUESTS: '0' }, /META_MAX_REQUESTS/],
  ['META_MAX_REQUESTS=201', { ...ON, META_MAX_REQUESTS: '201' }, /META_MAX_REQUESTS/],
  ['META_MAX_REQUESTS=-5', { ...ON, META_MAX_REQUESTS: '-5' }, /META_MAX_REQUESTS/],
  ['META_MAX_REQUESTS=1.5', { ...ON, META_MAX_REQUESTS: '1.5' }, /META_MAX_REQUESTS/],
  ['META_MAX_REQUESTS=abc', { ...ON, META_MAX_REQUESTS: 'abc' }, /META_MAX_REQUESTS/],
  ['META_MAX_REQUESTS=1e2', { ...ON, META_MAX_REQUESTS: '1e2' }, /META_MAX_REQUESTS/],
];
for (const [name, env, re] of refused) {
  test(`META_API_ENABLED=true ${name} ⇒ no arranca, sin imprimir la key`, () => {
    assert.throws(
      () => loadConfig(env),
      (err: Error) => re.test(err.message) && !err.message.includes(KEY) && !err.message.includes(KEY.trim()),
    );
  });
}

test('META_MAX_REQUESTS en los bordes: 1 y 200 valen', () => {
  assert.equal(loadConfig({ ...ON, META_MAX_REQUESTS: '1' }).metaMaxRequests, 1);
  assert.equal(loadConfig({ ...ON, META_MAX_REQUESTS: '200' }).metaMaxRequests, 200);
});

test('META_API_ENABLED con valor raro se rechaza (no se adivina)', () => {
  assert.throws(() => loadConfig({ META_API_ENABLED: 'yes' }), /META_API_ENABLED/);
});

test('Muse Spark apagado por defecto, aunque Meta esté prendida', () => {
  assert.equal(loadConfig({}).metaSparkEnabled, false);
  const c = loadConfig(ON);
  assert.equal(c.metaSparkEnabled, false);
  assert.equal(c.metaSparkMaxRequests, null);
});

const SPARK_ON = { ...ON, META_SPARK_ENABLED: 'true', META_SPARK_MAX_REQUESTS: '10' };

test('META_SPARK_ENABLED=true con Meta, key y tope propio ⇒ Spark prendido con ese tope', () => {
  const c = loadConfig(SPARK_ON);
  assert.equal(c.metaSparkEnabled, true);
  assert.equal(c.metaSparkMaxRequests, 10);
  assert.equal(loadConfig({ ...SPARK_ON, META_SPARK_MAX_REQUESTS: '1' }).metaSparkMaxRequests, 1);
  assert.equal(loadConfig({ ...SPARK_ON, META_SPARK_MAX_REQUESTS: '200' }).metaSparkMaxRequests, 200);
});

const sparkRefused: [string, NodeJS.ProcessEnv, RegExp][] = [
  ['con Meta apagada', { ...SPARK_ON, META_API_ENABLED: 'false' }, /META_API_ENABLED/],
  ['sin META_API_ENABLED', { META_SPARK_ENABLED: 'true', MODEL_API_KEY: KEY, META_SPARK_MAX_REQUESTS: '10' }, /META_API_ENABLED/],
  ['sin MODEL_API_KEY', { ...SPARK_ON, MODEL_API_KEY: '' }, /MODEL_API_KEY/],
  ['sin META_SPARK_MAX_REQUESTS', { ...ON, META_SPARK_ENABLED: 'true' }, /META_SPARK_MAX_REQUESTS/],
  ['META_SPARK_MAX_REQUESTS=0', { ...SPARK_ON, META_SPARK_MAX_REQUESTS: '0' }, /META_SPARK_MAX_REQUESTS/],
  ['META_SPARK_MAX_REQUESTS=201', { ...SPARK_ON, META_SPARK_MAX_REQUESTS: '201' }, /META_SPARK_MAX_REQUESTS/],
  ['META_SPARK_MAX_REQUESTS=2.5', { ...SPARK_ON, META_SPARK_MAX_REQUESTS: '2.5' }, /META_SPARK_MAX_REQUESTS/],
  ['META_SPARK_MAX_REQUESTS=abc', { ...SPARK_ON, META_SPARK_MAX_REQUESTS: 'abc' }, /META_SPARK_MAX_REQUESTS/],
  ['META_SPARK_ENABLED=yes', { ...SPARK_ON, META_SPARK_ENABLED: 'yes' }, /META_SPARK_ENABLED/],
];
for (const [name, env, re] of sparkRefused) {
  test(`META_SPARK_ENABLED=true ${name} ⇒ no arranca, sin imprimir la key`, () => {
    assert.throws(
      () => loadConfig(env),
      (err: Error) => re.test(err.message) && !err.message.includes(KEY),
    );
  });
}
