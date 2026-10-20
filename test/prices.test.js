import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrices, searchCoins, toDecimal } from '../src/prices.js';

// Настоящая сеть в тестах не участвует: fetch подменяется и записывает,
// что у него спросили.
function fakeFetch(answer) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    const body = typeof answer === 'function' ? answer(url) : answer;
    return { ok: body !== null, status: body === null ? 429 : 200, json: async () => body };
  };
  return asked;
}

test('цена из ответа превращается в число, которое принимает расчёт', () => {
  assert.equal(toDecimal(104.4), '104.4');
  assert.equal(toDecimal(81632), '81632');
  assert.equal(toDecimal(2.9e-7), '0.00000029');
  assert.equal(toDecimal(1e-12), '0.000000000001');
  assert.equal(toDecimal(0.1 + 0.2), '0.3');
  assert.equal(toDecimal(123456789.123456), '123456789.123456');
});

test('цены нескольких монет — одним запросом, повторно в пределах минуты — без запроса', async () => {
  const asked = fakeFetch({ 'test-a': { usd: 104.4 }, 'test-b': { usd: 2.9e-7 } });
  const prices = await fetchPrices(['test-a', 'test-b']);
  assert.deepEqual([...prices], [['test-a', '104.4'], ['test-b', '0.00000029']]);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /ids=test-a,test-b&vs_currencies=usd/);

  await fetchPrices(['test-b', 'test-a']);
  assert.equal(asked.length, 1);
});

test('монета, которой нет в ответе, просто отсутствует в результате', async () => {
  fakeFetch({ 'test-c': { usd: 5 } });
  const prices = await fetchPrices(['test-c', 'test-unknown']);
  assert.deepEqual([...prices], [['test-c', '5']]);
});

test('если сеть отказала, цены нет — ошибка, а не старое число', async () => {
  fakeFetch(null);
  await assert.rejects(fetchPrices(['test-d']), /429/);
});

test('«подождите» (429) отличается от «нет связи»', async () => {
  fakeFetch(null);
  await assert.rejects(searchCoins('sol'), (error) => error.busy === true);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(searchCoins('sol'), (error) => error.busy !== true);
});

test('поиск отдаёт код монеты и тикер заглавными, не больше шести', async () => {
  const coins = Array.from({ length: 9 }, (_, i) => ({ id: `coin-${i}`, symbol: 'sol', name: `Coin ${i}` }));
  fakeFetch({ coins });
  const found = await searchCoins('sol');
  assert.equal(found.length, 6);
  assert.deepEqual(found[0], { id: 'coin-0', symbol: 'SOL', name: 'Coin 0' });
});
