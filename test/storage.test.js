import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_BYTES, MAX_CHUNKS, createStore, localBackend, pickBackend, splitByBytes, telegramBackend } from '../src/storage.js';
import { calculate, checkHistory, checkOperation, parseAmount } from '../src/calc.js';

// --- Подделки ---

// Облако Телеграма по документации: колбэки «ошибка первым аргументом»;
// значение до 4096 знаков; ключ 1–128 знаков из A-Z a-z 0-9 _ -; ключей не
// больше 1024; для отсутствующего ключа getItem отдаёт пустую строку. Знаки
// считаются по байтам — строже, чем может быть на самом деле.
function fakeCloud({ failOnSet = () => false, unconfirmedSet = () => false } = {}) {
  const data = new Map();
  let sets = 0;
  const later = (callback) => queueMicrotask(callback);
  const checkKey = (key) => (/^[A-Za-z0-9_-]{1,128}$/.test(key) ? null : `KEY_INVALID ${key}`);
  const api = {
    data,
    get setCalls() { return sets; },
    setItem(key, value, callback) {
      sets += 1;
      const number = sets;
      later(() => {
        const problem = checkKey(key)
          ?? (new TextEncoder().encode(value).length > 4096 ? 'VALUE_INVALID' : null)
          ?? (!data.has(key) && data.size >= 1024 ? 'STORAGE_KEYS_TOO_MANY' : null)
          ?? (failOnSet(number, key) ? 'сбой сети' : null);
        if (problem) return callback(problem);
        // «Записалось, но ответ не дошёл»: значение лежит, а подтверждения нет.
        data.set(key, value);
        callback(null, unconfirmedSet(number, key) ? false : true);
      });
    },
    getItem(key, callback) { later(() => callback(checkKey(key), data.get(key) ?? '')); },
    removeItems(keys, callback) { later(() => { for (const key of keys) data.delete(key); callback(null, true); }); },
    getKeys(callback) { later(() => callback(null, [...data.keys()])); },
  };
  return api;
}

function fakeLocalStorage() {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const buy = (date, portfolio, money, price, extra = {}) => ({ type: 'buy', date, coin: 'solana', symbol: 'SOL', portfolio, money, price, ...extra });
const sell = (date, portfolio, quantity, price) => ({ type: 'sell', date, coin: 'solana', symbol: 'SOL', portfolio, quantity, price });
const transfer = (date, from, to, sent, received) => ({ type: 'transfer', date, coin: 'solana', symbol: 'SOL', from, to, sent, received });

const history = () => [
  buy('2026-01-10', 'Binance', '100', '100'),
  buy('2026-01-20', 'Binance', '300', '150.5'),
  buy('2026-02-01', 'Кошелёк', '50', '125', { received: '0.3999' }),
  transfer('2026-02-15', 'Binance', 'Кошелёк', '1', '0.995'),
  sell('2026-03-01', 'Кошелёк', '0.39', '110'),
  { type: 'buy', date: '2026-03-01', coin: null, symbol: 'ПЕПЕ', portfolio: 'Ledger', money: '10', price: '0.00001' },
];

// Две подкладки с общим хранилищем — чтобы «перезагрузка» читала то же самое.
function sharedBackends() {
  const cloud = fakeCloud();
  const storage = fakeLocalStorage();
  return {
    'облако Телеграма': { make: () => telegramBackend(cloud), raw: cloud },
    'localStorage': { make: () => localBackend(storage), raw: storage },
  };
}

for (const [name, { make }] of Object.entries(sharedBackends())) {
  test(`${name}: перезагрузка возвращает те же операции, порядок и средние до последнего знака`, async () => {
    const operations = history();
    // Две операции одного дня подряд: их порядок влияет на среднюю.
    operations.push(buy('2026-03-01', 'Binance', '70', '100'), sell('2026-03-01', 'Binance', '0.1', '100'));
    const before = calculate(operations);

    await createStore(make()).save({ operations, names: { solana: 'Solana' } });
    const reloaded = await createStore(make()).load(); // новое хранилище, как после перезагрузки страницы
    assert.equal(reloaded.status, 'ok');
    assert.deepEqual(reloaded.state.operations, operations);
    assert.deepEqual(reloaded.state.names, { solana: 'Solana' });
    assert.deepEqual(reloaded.state.operations.slice(-2).map((op) => op.type), ['buy', 'sell']);

    const after = calculate(reloaded.state.operations);
    assert.deepEqual(after.errors, []);
    for (const [coin, position] of before.coins) {
      const same = after.coins.get(coin);
      assert.equal(same.quantity, position.quantity);
      assert.equal(same.cost, position.cost);
      assert.equal(same.average, position.average);
      for (const [portfolio, part] of position.portfolios) {
        assert.equal(same.portfolios.get(portfolio).quantity, part.quantity);
        assert.equal(same.portfolios.get(portfolio).average, part.average);
      }
    }
  });
}

test('пустое хранилище — «пусто», а не ошибка', async () => {
  assert.deepEqual(await createStore(telegramBackend(fakeCloud())).load(), { status: 'empty' });
});

test('режем по байтам, не разрывая знак: кириллица и эмодзи', () => {
  const text = 'Кошелёк 😀 '.repeat(2000);
  const pieces = splitByBytes(text, 4096);
  assert.equal(pieces.join(''), text);
  for (const piece of pieces) assert.ok(new TextEncoder().encode(piece).length <= 4096);
  assert.ok(pieces.length > 1);
  assert.deepEqual(splitByBytes(''), []);
});

test('много операций режутся на части и читаются обратно; ключи подходят Телеграму', async () => {
  const cloud = fakeCloud();
  const store = createStore(telegramBackend(cloud));
  const operations = Array.from({ length: 600 }, (_, i) => buy(`2026-${String(1 + (i % 12)).padStart(2, '0')}-01`, 'Кошелёк №' + (i % 7), String(10 + i), '99.' + String(i % 100).padStart(2, '0')));
  await store.save({ operations, names: {} });
  assert.ok(cloud.data.size > 2, 'должно быть несколько частей');
  const loaded = await createStore(telegramBackend(cloud)).load();
  assert.deepEqual(loaded.state.operations, operations);
});

test('сколько операций влезает: считаем на настоящем объёме', async () => {
  // Типичные операции: покупка с ценой, продажа, перевод.
  const typical = [
    buy('2026-01-10', 'Binance', '200', '146.12'),
    sell('2026-03-01', 'Кошелёк', '0.39', '110.5'),
    transfer('2026-02-15', 'Binance', 'Кошелёк', '1', '0.995'),
  ];
  const average = typical.reduce((sum, op) => sum + new TextEncoder().encode(JSON.stringify(op)).length + 1, 0) / typical.length;
  const perChunk = Math.floor(CHUNK_BYTES / average);
  const total = MAX_CHUNKS * perChunk;
  // Не утверждаем число — проверяем, что запас большой: не меньше пяти тысяч.
  assert.ok(total >= 5000, `в ${MAX_CHUNKS} частей влезает около ${total} операций`);
  console.log(`# операция ≈ ${Math.round(average)} байт, в часть влезает ≈ ${perChunk}, во всё хранилище ≈ ${total}`);

  const cloud = fakeCloud();
  const operations = Array.from({ length: 5000 }, (_, i) => typical[i % 3]);
  await createStore(telegramBackend(cloud)).save({ operations, names: {} });
  assert.ok(cloud.data.size <= 1024);
});

test('слишком много данных — отказ с понятным текстом, прежнее состояние цело', async () => {
  const cloud = fakeCloud();
  const store = createStore(telegramBackend(cloud));
  await store.save({ operations: history(), names: {} });
  const hugeOperation = buy('2026-01-01', 'Б'.repeat(2_200_000), '1', '1');
  await assert.rejects(store.save({ operations: [hugeOperation], names: {} }), /больше, чем помещается/);
  assert.equal((await store.load()).state.operations.length, history().length);
});

// --- Недописанная запись: главное ---

// Облако с уже записанным состоянием; сбои считаются только в новой записи.
async function seededCloud(operations, options) {
  const seed = fakeCloud();
  await createStore(telegramBackend(seed)).save({ operations, names: {} });
  const cloud = fakeCloud(options);
  for (const [key, value] of seed.data) cloud.data.set(key, value);
  return cloud;
}

test('сбой на любом шаге записи не портит прежнее состояние и не делает новое половинным', async () => {
  const small = history();
  // Состояние в несколько частей: иначе сбой «посреди частей» не проверить.
  const large = Array.from({ length: 80 }, (_, i) => buy('2026-01-0' + (1 + (i % 9)), 'Binance', String(10 + i), '100'));
  for (const [label, from] of [['малое', small], ['многочастное', large]]) {
    const to = [...from, buy('2026-05-01', 'Binance', '5', '100')];
    const probe = await seededCloud(from);
    await createStore(telegramBackend(probe)).save({ operations: to, names: {} });
    const steps = probe.setCalls; // столько записей делает одно сохранение
    assert.ok(steps >= 2, label);

    for (let failAt = 1; failAt <= steps; failAt++) {
      const cloud = await seededCloud(from, { failOnSet: (number) => number === failAt });
      await assert.rejects(createStore(telegramBackend(cloud)).save({ operations: to, names: {} }), /сбой сети/);
      const loaded = await createStore(telegramBackend(cloud)).load();
      assert.equal(loaded.status, 'ok', `${label}, сбой на записи ${failAt} из ${steps}: ${loaded.reason}`);
      assert.deepEqual(loaded.state.operations, from, `${label}, сбой на записи ${failAt} из ${steps}: должно остаться прежнее целиком`);
    }
  }
});

test('запись дошла, а подтверждение нет: ошибка, но состояние целое — прежнее или новое', async () => {
  const from = history();
  const to = [...from, buy('2026-04-01', 'Binance', '10', '100')];
  const probe = await seededCloud(from);
  await createStore(telegramBackend(probe)).save({ operations: to, names: {} });
  const steps = probe.setCalls;
  for (let unsureAt = 1; unsureAt <= steps; unsureAt++) {
    const cloud = await seededCloud(from, { unconfirmedSet: (number) => number === unsureAt });
    await assert.rejects(createStore(telegramBackend(cloud)).save({ operations: to, names: {} }), /не подтвердил/);
    const loaded = await createStore(telegramBackend(cloud)).load();
    assert.equal(loaded.status, 'ok', `подтверждения нет на записи ${unsureAt}: ${loaded.reason}`);
    assert.ok([from, to].some((candidate) => JSON.stringify(candidate) === JSON.stringify(loaded.state.operations)), `на записи ${unsureAt}`);
  }
});

test('после удачной записи лишних частей нет; после оборванной — чистятся следующей', async () => {
  const cloud = fakeCloud();
  const big = Array.from({ length: 200 }, (_, i) => buy('2026-01-0' + (1 + (i % 9)), 'Binance', String(10 + i), '100'));
  const store = createStore(telegramBackend(cloud));
  await store.save({ operations: big, names: {} });
  const first = cloud.data.size;
  await store.save({ operations: big, names: {} });
  assert.equal(cloud.data.size, first, 'старые части должны удаляться');

  const breaking = fakeCloud({ failOnSet: (number) => number === 3 });
  const broken = createStore(telegramBackend(breaking));
  await broken.save({ operations: big, names: {} }).catch(() => {});
  assert.deepEqual(await broken.load(), { status: 'empty' }, 'оборванная первая запись ничего не оставила');
});

// --- Чтение: не верим на слово ---

async function savedCloud(operations = history()) {
  const cloud = fakeCloud();
  await createStore(telegramBackend(cloud)).save({ operations, names: {} });
  return cloud;
}
const loadFrom = (cloud) => createStore(telegramBackend(cloud)).load();

test('пропала часть — «не целы», с указанием какая', async () => {
  const big = Array.from({ length: 200 }, (_, i) => buy('2026-01-0' + (1 + (i % 9)), 'Binance', String(10 + i), '100'));
  const cloud = await savedCloud(big);
  const chunk = [...cloud.data.keys()].filter((key) => key.startsWith('c')).sort()[1];
  cloud.data.delete(chunk);
  const result = await loadFrom(cloud);
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /не найдена часть \d+ из \d+/);
});

test('пропала главная запись при оставшихся частях — «не целы»', async () => {
  const cloud = await savedCloud();
  cloud.data.delete('m');
  const result = await loadFrom(cloud);
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /нет главной записи/);
});

test('изменена часть (та же длина) — сумма не сходится', async () => {
  const cloud = await savedCloud();
  const key = [...cloud.data.keys()].find((k) => k.startsWith('c'));
  cloud.data.set(key, cloud.data.get(key).replace('Binance', 'Binanse'));
  const result = await loadFrom(cloud);
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /контрольная сумма/);
});

test('главная запись повреждена или чужой формат — «не целы»', async () => {
  for (const [value, pattern] of [['{не json', /повреждена/], ['{"v":1}', /повреждена/], ['[]', /повреждена/],
    [JSON.stringify({ v: 2, gen: 'a', chunks: 1, ops: 0, sha: 'a'.repeat(64) }), /более новой версией/]]) {
    const cloud = await savedCloud();
    cloud.data.set('m', value);
    const result = await loadFrom(cloud);
    assert.equal(result.status, 'broken', value);
    assert.match(result.reason, pattern);
  }
});

test('число операций не совпало с записанным в главной записи — «не целы»', async () => {
  const cloud = await savedCloud();
  const manifest = JSON.parse(cloud.data.get('m'));
  manifest.ops += 1;
  cloud.data.set('m', JSON.stringify(manifest));
  assert.match((await loadFrom(cloud)).reason, /число операций/);
});

test('хранилище не отвечает при чтении — это «не целы», а не «пусто»', async () => {
  const cloud = fakeCloud();
  cloud.getItem = (key, callback) => queueMicrotask(() => callback('WEBAPP_STORAGE_ERROR'));
  const result = await loadFrom(cloud);
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /не отвечает/);
});

test('пустая строка вместо отсутствующего ключа читается как «нет»', async () => {
  const cloud = fakeCloud();
  assert.equal(await telegramBackend(cloud).get('нет_такого'.replace(/[^\w-]/g, 'x')), null);
});

test('подтверждение записи не true — ошибка', async () => {
  const cloud = fakeCloud({ unconfirmedSet: () => true });
  await assert.rejects(telegramBackend(cloud).set('k', 'v'), /не подтвердил/);
});

test('стирание убирает всё: после него «пусто»', async () => {
  const cloud = await savedCloud();
  const store = createStore(telegramBackend(cloud));
  await store.erase();
  assert.equal(cloud.data.size, 0);
  assert.deepEqual(await store.load(), { status: 'empty' });
});

test('две записи подряд не перемешиваются: победила последняя, состояние целое', async () => {
  const cloud = fakeCloud();
  const store = createStore(telegramBackend(cloud));
  const a = [buy('2026-01-01', 'A', '10', '1')];
  const b = [buy('2026-01-01', 'B', '20', '2'), buy('2026-01-02', 'B', '30', '3')];
  await Promise.all([store.save({ operations: a, names: {} }), store.save({ operations: b, names: {} })]);
  assert.deepEqual((await store.load()).state.operations, b);
});

test('localStorage: свои ключи с приставкой, чужие не трогает', async () => {
  const storage = fakeLocalStorage();
  storage.setItem('чужое', 'не трогать');
  storage.setItem('other-app/x', '1');
  const store = createStore(localBackend(storage));
  await store.save({ operations: history(), names: {} });
  await store.save({ operations: [], names: {} });
  await store.erase();
  assert.deepEqual([...storage.map.keys()].sort(), ['other-app/x', 'чужое']);
});

test('выбор подкладки: внутри Телеграма — облако, снаружи — localStorage', () => {
  const cloud = fakeCloud();
  const storage = fakeLocalStorage();
  const app = { CloudStorage: cloud, isVersionAtLeast: (version) => version === '6.9' };
  assert.equal(pickBackend({ Telegram: { WebApp: app }, localStorage: storage }, true).kind, 'telegram');
  // Скрипт Телеграма подключён, но решение «мы снаружи» принято раньше: localStorage.
  assert.equal(pickBackend({ Telegram: { WebApp: app }, localStorage: storage }, false).kind, 'browser');
  assert.equal(pickBackend({ localStorage: storage }).kind, 'browser');
  assert.equal(pickBackend({}), null);
  const blocked = { setItem() { throw new Error('SecurityError'); }, removeItem() {} };
  assert.equal(pickBackend({ localStorage: blocked }), null);
});

test('внутри Телеграма без облака данные не уходят молча в localStorage', () => {
  const storage = fakeLocalStorage();
  // Версия ниже 6.9: облака нет — не «браузер», а отказ с причиной.
  const old = { CloudStorage: fakeCloud(), isVersionAtLeast: () => false };
  const oldVersion = pickBackend({ Telegram: { WebApp: old }, localStorage: storage }, true);
  assert.equal(oldVersion.kind, 'unsupported');
  assert.equal(oldVersion.backend, undefined);
  assert.match(oldVersion.reason, /6\.9/);
  // Скрипт Телеграма не подключился: выбор бросает, а не подставляет localStorage.
  assert.throws(() => pickBackend({ localStorage: storage }, true), TypeError);
});

test('выбор подкладки не обращается к данным пользователя Телеграма (initData)', () => {
  const app = { CloudStorage: fakeCloud(), isVersionAtLeast: () => true };
  Object.defineProperty(app, 'initData', { get() { throw new Error('initData прочитан'); } });
  Object.defineProperty(app, 'initDataUnsafe', { get() { throw new Error('initDataUnsafe прочитан'); } });
  assert.equal(pickBackend({ Telegram: { WebApp: app }, localStorage: fakeLocalStorage() }, true).kind, 'telegram');
});

test('клиент Телеграма не отвечает: ошибка по сроку, а не вечное ожидание', async () => {
  const silent = { getItem() {}, setItem() {}, removeItems() {}, getKeys() {} }; // колбэк так и не вызывается
  const backend = telegramBackend(silent, 30);
  await assert.rejects(backend.get('m'), /не ответил/);
  await assert.rejects(backend.set('m', 'x'), /не ответил/);
  const result = await createStore(backend).load();
  assert.equal(result.status, 'broken');
  assert.equal(result.retry, true);
});

test('версия ниже 6.9: вызов облака бросает сразу, и это ошибка, а не зависание', async () => {
  const throwing = { getItem() { throw new Error('WebAppMethodUnsupported'); }, getKeys() { throw new Error('WebAppMethodUnsupported'); } };
  const result = await createStore(telegramBackend(throwing)).load();
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /WebAppMethodUnsupported/);
});

// --- Проверка операций (файл и хранилище) ---

test('хорошая история проходит проверку', () => {
  assert.equal(checkHistory(history()), null);
  assert.equal(checkHistory([]), null);
});

test('пустой элемент вместо операции — отказ с номером, а не падение расчёта', () => {
  for (const bad of [null, undefined, 5, 'строка', [], {}]) {
    const result = checkHistory([buy('2026-01-01', 'Binance', '100', '100'), bad]);
    assert.equal(result.index, 1, String(bad));
    assert.ok(result.message.length > 0);
  }
});

test('порча по полям называет, что именно не так', () => {
  const ok = buy('2026-01-01', 'Binance', '100', '100');
  const cases = [
    [{ ...ok, type: 'swap' }, /неизвестный вид/],
    [{ ...ok, date: '2026-13-45' }, /дата/],
    [{ ...ok, date: undefined }, /дата/],
    [{ ...ok, coin: '' }, /код монеты/],
    [{ ...ok, coin: 5 }, /код монеты/],
    [{ ...ok, symbol: '' }, /symbol/],
    [{ ...ok, portfolio: undefined }, /portfolio/],
    [{ ...ok, money: '1,5' }, /money.*не число/],
    [{ ...ok, money: '0' }, /money.*больше нуля/],
    [{ ...ok, money: 100 }, /money.*не число/],
    [{ ...ok, price: undefined }, /price.*не число/],
    [{ ...ok, received: '-1' }, /received.*не число/],
    [{ ...ok, лишнее: 1 }, /лишнее поле/],
    [{ ...ok, quantity: '1' }, /лишнее поле/],
    [sell('2026-01-01', 'Binance', '1', '1'), null],
    [{ ...sell('2026-01-01', 'Binance', '1', '1'), money: '5' }, /либо количество/],
    [{ type: 'sell', date: '2026-01-01', coin: 'solana', symbol: 'SOL', portfolio: 'A' }, /либо количество/],
    [{ type: 'sell', date: '2026-01-01', coin: 'solana', symbol: 'SOL', portfolio: 'A', money: '5' }, /нет цены/],
    [transfer('2026-01-01', 'A', 'A', '1', '1'), /тот же портфель/],
    [transfer('2026-01-01', 'A', 'B', '1', '1.5'), /получено больше/],
    [{ ...transfer('2026-01-01', 'A', 'B', '1', '1'), from: undefined }, /from/],
    [{ ...buy('2026-01-01', 'Binance', '100', '100'), coin: null }, null],
  ];
  for (const [op, pattern] of cases) {
    const problem = checkOperation(op);
    if (pattern === null) assert.equal(problem, '', JSON.stringify(op));
    else assert.match(problem, pattern, JSON.stringify(op));
  }
});

test('история, которая в целом не сходится, называет операцию, на которой ломается', () => {
  const operations = [
    buy('2026-01-01', 'Binance', '100', '100'),
    sell('2026-02-01', 'Binance', '5', '100'), // продано больше, чем куплено
  ];
  const result = checkHistory(operations);
  assert.equal(result.index, 1);
  assert.match(result.message, /нет столько монет/);
  assert.doesNotMatch(result.message, /^Операция от/);
});

test('список не списком — отказ', () => {
  assert.match(checkHistory({}).message, /вместо списка/);
  assert.match(checkHistory(null).message, /вместо списка/);
});

// --- Файл выгрузки ---

import { makeExport, readExport } from '../src/storage.js';

test('выгрузка и загрузка файла возвращают то же состояние: операции, порядок, имена, средние', () => {
  const operations = [...history(), buy('2026-03-01', 'Binance', '70', '100'), sell('2026-03-01', 'Binance', '0.1', '100')];
  const names = { solana: 'Solana' };
  const file = makeExport({ operations, names }, new Date('2026-10-25T10:00:00Z'));
  assert.match(file, /"exportedAt": "2026-10-25T10:00:00.000Z"/);
  assert.equal(file.trim().split('\n').filter((line) => line.startsWith('  {')).length, operations.length, 'одна операция — одна строка');

  const result = readExport(file);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.state.operations, operations);
  assert.deepEqual(result.state.names, names);
  const before = calculate(operations);
  const after = calculate(result.state.operations);
  for (const [coin, position] of before.coins) {
    assert.equal(after.coins.get(coin).average, position.average);
    assert.equal(after.coins.get(coin).quantity, position.quantity);
  }
});

test('пустая выгрузка читается: ни одной операции — не ошибка', () => {
  const result = readExport(makeExport({ operations: [], names: {} }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.operations, []);
});

test('в файле битая операция: файл не принимается, названа запись и причина', () => {
  const operations = history();
  operations[3] = { ...operations[3], sent: '1,5' };
  const result = readExport(makeExport({ operations, names: {} }));
  assert.equal(result.ok, false);
  assert.match(result.message, /запись №4 из 6 \(2026-02-15, SOL\)/);
  assert.match(result.message, /sent.*не число/);
});

test('в файле пустой элемент вместо операции — отказ, а не падение', () => {
  for (const hole of [null, 5, 'строка', [], {}]) {
    const file = JSON.stringify({ app: 'crypto-portfolio-app', version: 1, names: {}, operations: [buy('2026-01-01', 'A', '1', '1'), hole] });
    const result = readExport(file);
    assert.equal(result.ok, false, JSON.stringify(hole));
    assert.match(result.message, /запись №2 из 2/, JSON.stringify(hole));
  }
});

test('файл с операцией, которая ломает историю: названа та, на которой ломается', () => {
  const operations = [buy('2026-01-01', 'A', '100', '100'), sell('2026-02-01', 'A', '5', '100')];
  const result = readExport(makeExport({ operations, names: {} }));
  assert.equal(result.ok, false);
  assert.match(result.message, /запись №2 из 2 \(2026-02-01, SOL\): .*нет столько монет/);
});

test('чужой и повреждённый файл не принимается', () => {
  assert.match(readExport('не json').message, /не читается как JSON/);
  assert.match(readExport('{}').message, /не выгрузка этого приложения/);
  assert.match(readExport('[]').message, /не выгрузка этого приложения/);
  assert.match(readExport('null').message, /не выгрузка этого приложения/);
  const good = makeExport({ operations: history(), names: {} });
  assert.match(readExport(good.replace('"version": 1', '"version": 7')).message, /формат 7/);
  assert.match(readExport(good.replace('"names": {}', '"names": {"solana": 5}')).message, /названия монет/);
  assert.match(readExport(good.replace('"names": {}', '"names": []')).message, /названия монет/);
  assert.match(readExport(good.replace('"operations": [', '"operations": {"a": [')).message, /не читается|вместо списка/);
  assert.match(readExport(' '.repeat(5_000_001)).message, /больше 5 МБ/);
  assert.match(readExport(undefined).message, /больше/);
});

test('файл, правленный руками: лишнее поле у операции и нулевая сумма не проходят', () => {
  const good = makeExport({ operations: [buy('2026-01-01', 'A', '100', '100')], names: {} });
  assert.match(readExport(good.replace('"money":"100"', '"money":"0"')).message, /запись №1.*money.*больше нуля/);
  assert.match(readExport(good.replace('"price":"100"', '"price":"100","комментарий":"x"')).message, /лишнее поле/);
  assert.match(readExport(good.replace('"date":"2026-01-01"', '"date":"2026-02-30"')).message, /дата/);
});

// --- Найденное ревью: потери данных при записи ---

test('внесли операцию, пока идёт запись: сохранённое целое, а не «число операций не совпало»', async () => {
  const cloud = fakeCloud();
  const store = createStore(telegramBackend(cloud));
  const operations = Array.from({ length: 120 }, (_, i) => buy('2026-01-0' + (1 + (i % 9)), 'Binance', String(10 + i), '100'));
  const state = { operations, names: {} };
  const saving = store.save(state);
  // Пока части пишутся по сети, человек вносит ещё операцию в тот же массив.
  operations.push(buy('2026-02-01', 'Binance', '5', '100'));
  await saving;
  const loaded = await createStore(telegramBackend(cloud)).load();
  assert.equal(loaded.status, 'ok', loaded.reason);
  assert.equal(loaded.state.operations.length, 120, 'сохранено то, что было в момент вызова');
  // А следующая запись подхватывает и новую операцию.
  await store.save(state);
  assert.equal((await store.load()).state.operations.length, 121);
});

test('две вкладки пишут одновременно: сохранённое целое — либо одно, либо другое', async () => {
  for (const [sizeA, sizeB] of [[3, 3], [120, 40], [40, 120], [300, 300]]) {
    for (const seeded of [false, true]) {
      const cloud = fakeCloud();
      const mk = (n, who) => Array.from({ length: n }, (_, i) => buy('2026-01-0' + (1 + (i % 9)), who, String(10 + i), '100'));
      const a = mk(sizeA, 'Вкладка-А');
      const b = mk(sizeB, 'Вкладка-Б');
      if (seeded) await createStore(telegramBackend(cloud)).save({ operations: mk(50, 'Раньше'), names: {} });
      await Promise.all([
        createStore(telegramBackend(cloud)).save({ operations: a, names: {} }),
        createStore(telegramBackend(cloud)).save({ operations: b, names: {} }),
      ]);
      const loaded = await createStore(telegramBackend(cloud)).load();
      assert.equal(loaded.status, 'ok', `${sizeA}/${sizeB}${seeded ? ' поверх прежнего' : ''}: ${loaded.reason}`);
      assert.ok([a, b].some((candidate) => JSON.stringify(candidate) === JSON.stringify(loaded.state.operations)));
    }
  }
});

test('чужую запись, которая сейчас идёт, чистка не трогает', async () => {
  const cloud = fakeCloud();
  const backend = telegramBackend(cloud);
  await createStore(backend).save({ operations: history(), names: {} });
  // Другая вкладка успела записать часть своего нового состояния — главной записи у неё ещё нет.
  await backend.set('cother1_0', 'часть чужой записи');
  await createStore(backend).save({ operations: history(), names: {} });
  assert.ok(cloud.data.has('cother1_0'), 'часть чужой незавершённой записи на месте');
});

test('когда ключей стало слишком много, чистка убирает и остатки оборвавшихся записей', async () => {
  const cloud = fakeCloud();
  const backend = telegramBackend(cloud);
  for (let i = 0; i < 710; i++) await backend.set(`corphan_${i}`, 'x');
  await createStore(backend).save({ operations: history(), names: {} });
  assert.equal([...cloud.data.keys()].filter((key) => key.startsWith('corphan_')).length, 0);
  assert.equal((await createStore(backend).load()).status, 'ok');
});

test('сбой чтения: «не целы», но с пометкой «прочитать заново» — стирать не нужно', async () => {
  const cloud = fakeCloud();
  cloud.getItem = (key, callback) => queueMicrotask(() => callback('WEBAPP_STORAGE_ERROR'));
  const result = await loadFrom(cloud);
  assert.equal(result.status, 'broken');
  assert.equal(result.retry, true);
  // А повреждённые данные — без пометки: там читать заново нечего.
  const damaged = await savedCloud();
  damaged.data.set('m', '{не json');
  assert.equal((await loadFrom(damaged)).retry, undefined);
});

test('части без главной записи (оборванная самая первая запись) — понятная причина', async () => {
  const cloud = fakeCloud();
  await telegramBackend(cloud).set('cabc123_0', 'x');
  const result = await loadFrom(cloud);
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /самая первая запись/);
});

test('вид операции с именем из прототипа не роняет проверку', () => {
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const problem = checkOperation({ type, date: '2026-01-01', coin: 'solana', symbol: 'SOL' });
    assert.match(problem, /неизвестный вид операции/, type);
  }
  const file = JSON.stringify({ app: 'crypto-portfolio-app', version: 1, names: {}, operations: [{ type: 'toString', date: '2026-01-01', coin: 'solana', symbol: 'SOL' }] });
  assert.match(readExport(file).message, /запись №1 из 1.*неизвестный вид/);
});

// --- Найденное при проверке чисел ---

test('остатки оборвавшихся записей убираются до новой, а не после: большая история не застревает', async () => {
  const cloud = fakeCloud();
  const backend = telegramBackend(cloud);
  // Прежнее состояние в 300 частей и ещё 450 частей от оборвавшихся записей: 750 + манифест.
  const big = Array.from({ length: 300 * 32 }, (_, i) => buy('2026-01-0' + (1 + (i % 9)), 'Binance', String(10 + (i % 90)), '100'));
  await createStore(backend).save({ operations: big, names: {} });
  const before = cloud.data.size;
  assert.ok(before > 250 && before < 400, `частей: ${before}`);
  for (let i = 0; i < 700; i++) await backend.set(`corphan_${i}`, 'x');
  // Новая запись ещё одной операции: без заблаговременной чистки 300 новых частей не влезли бы в 1024 ключа.
  await createStore(backend).save({ operations: [...big, buy('2026-02-01', 'Binance', '5', '100')], names: {} });
  const loaded = await createStore(backend).load();
  assert.equal(loaded.status, 'ok', loaded.reason);
  assert.equal(loaded.state.operations.length, big.length + 1);
});

test('код монеты со знаком «?» и прочими лишними знаками не принимается', () => {
  for (const coin of ['?SOL', 'sol ana', 'sol/ana', 'со', '', 'a'.repeat(129)]) {
    assert.match(checkOperation({ ...buy('2026-01-01', 'A', '1', '1'), coin }), /код монеты/, coin);
  }
  for (const coin of ['solana', 'wrapped-bitcoin', 'hive_dollar', 'constructor', '__proto__', null]) {
    assert.equal(checkOperation({ ...buy('2026-01-01', 'A', '1', '1'), coin }), '', String(coin));
  }
});

test('покупка на сумму, из которой выходит ноль монет, — ошибка, а не пустая позиция с деньгами', () => {
  const tiny = buy('2026-01-01', 'Binance', '0.000000000000000000000000000001', '100000');
  const { coins, errors } = calculate([tiny]);
  assert.equal(coins.size, 0);
  assert.match(errors[0].message, /выходит меньше/);
});

test('число длиннее, чем бывает, не принимается: ни в файле, ни в форме', () => {
  assert.equal(parseAmount('1'.repeat(31)), null);
  assert.notEqual(parseAmount('1'.repeat(30)), null);
  assert.match(checkOperation(buy('2026-01-01', 'A', '9'.repeat(40), '1')), /не число/);
});

test('код монеты «constructor» или «__proto__» читается и пишется как обычный', async () => {
  for (const coin of ['constructor', '__proto__']) {
    const operations = [{ ...buy('2026-01-01', 'A', '10', '1'), coin, symbol: 'X' }];
    const names = Object.create(null);
    names[coin] = 'Тест';
    const cloud = fakeCloud();
    await createStore(telegramBackend(cloud)).save({ operations, names });
    const loaded = await createStore(telegramBackend(cloud)).load();
    assert.equal(loaded.status, 'ok');
    assert.equal(Object.hasOwn(loaded.state.names, coin), true, `${coin}: название на месте`);
    assert.equal(loaded.state.names[coin], 'Тест');
  }
});
