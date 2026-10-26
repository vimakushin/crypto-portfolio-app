import { test, mock } from 'node:test';
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

// Часы подменяются там, где важно время: после отказа модуль минуту молчит, и
// без своих часов этот отказ испортил бы все следующие тесты. Подмена
// снимается в конце — состояние модуля остаётся в «прошлом» и никому не мешает.
// У каждого теста своё время, на сутки позже предыдущего: ожидание после
// отказа из одного теста не должно попасть в будущее следующего.
let epoch = 0;
function withClock(body) {
  return async () => {
    epoch += 86_400_000;
    mock.timers.enable({ apis: ['Date'], now: epoch });
    try {
      await body(mock.timers);
    } finally {
      mock.timers.reset();
    }
  };
}

const coin = (id) => ({ id, symbol: 'sol', name: `Coin ${id}` });

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

test('если сеть отказала, цены нет — ошибка, а не старое число', withClock(async () => {
  fakeFetch(null);
  await assert.rejects(fetchPrices(['test-d']), /429/);
}));

test('«подождите» (429) отличается от «нет связи»', withClock(async (timers) => {
  fakeFetch(null);
  await assert.rejects(searchCoins('sol'), (error) => error.busy === true && error.retryIn === 60_000);
  timers.tick(61_000);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(searchCoins('btc'), (error) => error.busy !== true);
}));

test('поиск отдаёт код монеты и тикер заглавными, не больше шести', withClock(async () => {
  const coins = Array.from({ length: 9 }, (_, i) => ({ id: `coin-${i}`, symbol: 'sol', name: `Coin ${i}` }));
  fakeFetch({ coins });
  const found = await searchCoins('uniq-limit');
  assert.equal(found.length, 6);
  assert.deepEqual(found[0], { id: 'coin-0', symbol: 'SOL', name: 'Coin 0' });
}));

test('один и тот же поиск повторно не уходит: десять минут он помнится', withClock(async (timers) => {
  const asked = fakeFetch({ coins: [coin('remembered')] });
  await searchCoins('Remember Me');
  await searchCoins('remember me');
  await searchCoins('  REMEMBER ME ');
  assert.equal(asked.length, 1, 'регистр и пробелы по краям запрос не меняют');
  timers.tick(9 * 60_000);
  await searchCoins('remember me');
  assert.equal(asked.length, 1, 'девять минут спустя — ещё из памяти');
  timers.tick(2 * 60_000);
  await searchCoins('remember me');
  assert.equal(asked.length, 2, 'через одиннадцать — спрашиваем заново');
}));

test('два одинаковых поиска одновременно — один запрос', withClock(async () => {
  const asked = fakeFetch({ coins: [coin('parallel')] });
  const [first, second] = await Promise.all([searchCoins('parallel query'), searchCoins('parallel query')]);
  assert.equal(asked.length, 1);
  assert.deepEqual(first, second);
}));

test('пустой результат поиска тоже помнится: неизвестную монету не ищут по кругу', withClock(async () => {
  const asked = fakeFetch({ coins: [] });
  assert.deepEqual(await searchCoins('nothing-here'), []);
  assert.deepEqual(await searchCoins('nothing-here'), []);
  assert.equal(asked.length, 1);
}));

test('после отказа 429 минуту ничего не уходит, потом снова можно', withClock(async (timers) => {
  const asked = fakeFetch(null);
  await assert.rejects(searchCoins('first-after-limit'), (error) => error.busy);
  assert.equal(asked.length, 1);

  // Любой запрос — поиск или цена — в эту минуту не доходит до сети и сразу
  // отвечает «подождите», сколько осталось.
  timers.tick(20_000);
  await assert.rejects(searchCoins('another-one'), (error) => error.busy && error.retryIn === 40_000);
  await assert.rejects(fetchPrices(['test-e']), (error) => error.busy);
  assert.equal(asked.length, 1, 'за минуту ожидания сеть не тронута');

  timers.tick(41_000);
  fakeFetch({ coins: [coin('after-wait')] });
  assert.equal((await searchCoins('another-one'))[0].id, 'after-wait');
}));

test('то, что уже найдено, после отказа доступно без сети', withClock(async () => {
  fakeFetch({ coins: [coin('before-limit')] });
  await searchCoins('known-before');
  fakeFetch(null);
  await assert.rejects(searchCoins('unknown-now'), (error) => error.busy);
  assert.equal((await searchCoins('known-before'))[0].id, 'before-limit', 'из памяти — несмотря на отказ');
}));
