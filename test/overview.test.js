import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, parseAmount, SCALE } from '../src/calc.js';
import { history, overview } from '../src/overview.js';

const units = (text) => parseAmount(text);
const buy = (date, portfolio, money, price, coin = 'solana', symbol = 'SOL') => ({ type: 'buy', date, coin, symbol, portfolio, money, price });
const sell = (date, portfolio, quantity, price, coin = 'solana', symbol = 'SOL') => ({ type: 'sell', date, coin, symbol, portfolio, quantity, price });
const transfer = (date, from, to, sent, received) => ({ type: 'transfer', date, coin: 'solana', symbol: 'SOL', from, to, sent, received });
const prices = (object) => new Map(Object.entries(object));

// 1 SOL по 100 $ и 2 SOL по 150 $: 3 монеты, вложено 400 $.
const base = () => [buy('2026-01-10', 'Binance', '100', '100'), buy('2026-01-20', 'Binance', '300', '150')];

test('итоги: вложено 400, при цене 200 стоит 600, разница +200 (+50%)', () => {
  const { rows, totals } = overview(base(), prices({ solana: '200' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, units('3'));
  assert.equal(rows[0].cost, units('400'));
  assert.equal(rows[0].value, units('600'));
  assert.equal(rows[0].difference, units('200'));
  assert.equal(rows[0].percent, units('50'));
  assert.deepEqual(totals, { cost: units('400'), value: units('600'), difference: units('200'), percent: units('50') });
});

test('убыток: цена 100 при вложенных 400 в трёх монетах — разница −100 (−25%)', () => {
  const { totals } = overview(base(), prices({ solana: '100' }));
  assert.equal(totals.value, units('300'));
  assert.equal(totals.difference, -units('100'));
  assert.equal(totals.percent, -units('25'));
});

test('цен нет: вложено и количество на месте, стоимость и разница — не ноль, а отсутствие', () => {
  const { rows, totals } = overview(base(), null);
  assert.equal(totals.cost, units('400'));
  assert.equal(totals.value, null);
  assert.equal(totals.difference, null);
  assert.equal(totals.percent, null);
  assert.equal(rows[0].quantity, units('3'));
  assert.equal(rows[0].why, 'no-price');
  assert.equal(rows[0].value, null);
});

test('цена одной монеты из двух не пришла: итог по монете с ценой, а монета без цены названа с её вложенным', () => {
  const operations = [...base(), buy('2026-02-01', 'Binance', '50', '25', 'bitcoin', 'BTC')];
  const { rows, totals, excluded } = overview(operations, prices({ solana: '200' }));
  // «Вложено» и «стоит» — по одному и тому же набору монет, иначе разница не сходится с числами рядом.
  assert.deepEqual(totals, { cost: units('400'), value: units('600'), difference: units('200'), percent: units('50') });
  assert.deepEqual(excluded, [{ symbol: 'BTC', cost: units('50'), why: 'no-price' }]);
  assert.equal(rows.find((row) => row.symbol === 'BTC').why, 'no-price');
  assert.equal(rows.find((row) => row.symbol === 'BTC').value, null);
});

test('монета без привязки: цены нет, даже если у такого же тикера в справочнике она есть', () => {
  const operations = [buy('2026-01-10', 'Binance', '100', '100', null, 'SOL')];
  const { rows, totals } = overview(operations, prices({ solana: '200', SOL: '200' }));
  assert.equal(rows[0].why, 'unbound');
  assert.equal(rows[0].value, null);
  assert.equal(totals.value, null);
});

test('крошечный остаток остаётся в списке с настоящим количеством, а не пропадает', () => {
  const operations = [buy('2026-01-10', 'Binance', '4', '1000000000')];
  const { rows } = overview(operations, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, units('0.000000004'));
  assert.equal(rows[0].average, units('1000000000'));
});

test('проданное целиком не показывается, остальное считается', () => {
  const operations = [...base(), sell('2026-02-01', 'Binance', '3', '300'), buy('2026-02-02', 'Ledger', '10', '10', 'bitcoin', 'BTC')];
  const { rows, totals } = overview(operations, prices({ bitcoin: '20' }));
  assert.deepEqual(rows.map((row) => row.symbol), ['BTC']);
  assert.equal(totals.cost, units('10'));
  assert.equal(totals.value, units('20'));
});

test('монета, которую расчёт не смог посчитать, названа отдельно, с операцией; итог — по остальным и назван без неё', () => {
  const broken = sell('2026-02-01', 'Binance', '5', '100', 'bitcoin', 'BTC');
  const operations = [...base(), buy('2026-01-05', 'Binance', '50', '25', 'bitcoin', 'BTC'), broken];
  const { rows, totals, excluded, failed } = overview(operations, prices({ solana: '200', bitcoin: '30' }));
  assert.deepEqual(rows.map((row) => row.symbol), ['SOL']);
  assert.deepEqual(totals, { cost: units('400'), value: units('600'), difference: units('200'), percent: units('50') });
  assert.deepEqual(excluded, [{ symbol: 'BTC', cost: null, why: 'failed' }], 'вложенное в непосчитанную монету неизвестно');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].symbol, 'BTC');
  assert.equal(failed[0].operation, broken, 'именно та операция, на которой расчёт споткнулся');
  assert.match(failed[0].message, /нет столько монет/);
});

test('портфель: свои числа, и его монеты вместе дают общие', () => {
  const operations = [
    buy('2026-01-10', 'Binance', '100', '100'),
    buy('2026-01-11', 'Кошелёк', '100', '200'),
    transfer('2026-01-12', 'Binance', 'Кошелёк', '0.5', '0.5'),
  ];
  const all = overview(operations, prices({ solana: '300' }));
  const binance = overview(operations, prices({ solana: '300' }), 'Binance');
  const wallet = overview(operations, prices({ solana: '300' }), 'Кошелёк');
  assert.equal(binance.rows[0].quantity, units('0.5'));
  assert.equal(binance.rows[0].cost, units('50'));
  assert.equal(wallet.rows[0].quantity, units('1'));
  assert.equal(wallet.rows[0].cost, units('150'));
  assert.equal(binance.totals.cost + wallet.totals.cost, all.totals.cost);
  assert.equal(binance.totals.value + wallet.totals.value, all.totals.value);
  assert.equal(all.totals.value, units('450'));
});

test('ошибка монеты показывается в портфеле, которого она касается, и не показывается в чужом', () => {
  const operations = [
    buy('2026-01-10', 'Binance', '100', '100'),
    buy('2026-01-10', 'Ledger', '50', '25', 'bitcoin', 'BTC'),
    sell('2026-02-01', 'Ledger', '9', '10', 'bitcoin', 'BTC'),
  ];
  assert.equal(overview(operations, null, 'Ledger').failed.length, 1);
  assert.equal(overview(operations, null, 'Binance').failed.length, 0);
  assert.equal(overview(operations, null).failed.length, 1);
});

test('на случайных историях итог вложенного совпадает с расчётом, а портфели складываются в общее', () => {
  let seed = 12345;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const where = ['A', 'B', 'C'];
  let checked = 0;
  for (let round = 0; round < 40; round++) {
    const operations = [];
    for (let i = 0; i < 30; i++) {
      const date = `2026-01-${String(1 + i).padStart(2, '0')}`;
      const p = where[random(3)];
      const roll = random(4);
      if (roll < 2 || i < 3) operations.push(buy(date, p, String(10 + random(500)), String(1 + random(300))));
      else if (roll === 2) operations.push(sell(date, p, '0.001', String(1 + random(300))));
      else operations.push(transfer(date, p, where[(where.indexOf(p) + 1) % 3], '0.001', '0.001'));
    }
    const { coins } = calculate(operations);
    const live = [...coins.values()].reduce((total, position) => total + position.cost, 0n);
    const all = overview(operations, prices({ solana: '77' }));
    if (all.failed.length > 0) continue;
    checked += 1;
    assert.equal(all.totals.cost, live, `раунд ${round}: вложено`);
    const perPortfolio = where.map((p) => overview(operations, prices({ solana: '77' }), p));
    assert.equal(perPortfolio.reduce((total, v) => total + v.totals.cost, 0n), all.totals.cost, `раунд ${round}: портфели`);
    assert.equal(perPortfolio.reduce((total, v) => total + (v.totals.value ?? 0n), 0n), all.totals.value, `раунд ${round}: стоимость портфелей`);
  }
  assert.ok(checked >= 10, `проверено историй: ${checked}`);
});

test('история: новые даты первыми, внутри дня позже внесённые первыми, для портфеля — только его', () => {
  const operations = [
    buy('2026-01-10', 'Binance', '1', '1'),
    buy('2026-01-12', 'Ledger', '2', '1'),
    buy('2026-01-10', 'Ledger', '3', '1'),
    buy('2026-01-12', 'Binance', '4', '1'),
  ];
  assert.deepEqual(history(operations).map(({ index }) => index), [3, 1, 2, 0]);
  assert.deepEqual(history(operations, 'Ledger').map(({ index }) => index), [1, 2]);
});

test('проценты в единицах SCALE: 50% — это 50, а не другое число', () => {
  const { totals } = overview(base(), prices({ solana: '200' }));
  assert.equal(totals.percent / SCALE, 50n);
});

test('ничего нет: пустая история, всё продано, пустой портфель — честные нули без процента, а не падение', () => {
  const sold = [buy('2026-01-10', 'Binance', '100', '100'), sell('2026-01-11', 'Binance', '1', '120')];
  const zero = { cost: 0n, value: 0n, difference: 0n, percent: null };
  for (const [label, operations, only] of [['пусто', [], null], ['всё продано', sold, null], ['портфель без позиций', base(), 'Ledger']]) {
    const result = overview(operations, prices({ solana: '200' }), only);
    assert.deepEqual(result.rows, [], label);
    assert.deepEqual(result.totals, zero, label);
    assert.deepEqual(result.failed, [], label);
  }
});

test('вложенное округлилось до нуля при переводе мельчайшей доли: процент не считается, а не делит на ноль', () => {
  const operations = [
    buy('2026-01-10', 'A', '0.000000000001', '0.000001'),
    transfer('2026-01-11', 'A', 'B', '0.000000000000000000000000000001', '0.000000000000000000000000000001'),
  ];
  const { rows, totals } = overview(operations, prices({ solana: '1' }), 'B');
  assert.equal(rows[0].cost, 0n);
  assert.equal(rows[0].percent, null);
  assert.equal(totals.percent, null);
});

test('единственная монета не посчиталась: итога нет, а не «0 $»', () => {
  const operations = [buy('2026-01-05', 'Binance', '50', '25', 'bitcoin', 'BTC'), sell('2026-02-01', 'Binance', '5', '100', 'bitcoin', 'BTC')];
  const { rows, totals, excluded } = overview(operations, null);
  assert.deepEqual(rows, []);
  assert.deepEqual(totals, { cost: null, value: null, difference: null, percent: null });
  assert.deepEqual(excluded, [{ symbol: 'BTC', cost: null, why: 'failed' }]);
});

test('цен нет ни у одной монеты: вложено по всем есть, «без них» не говорим — итога стоимости нет вовсе', () => {
  const operations = [...base(), buy('2026-02-01', 'Binance', '50', '25', 'bitcoin', 'BTC')];
  const { totals, excluded } = overview(operations, null);
  assert.deepEqual(totals, { cost: units('450'), value: null, difference: null, percent: null });
  assert.deepEqual(excluded, []);
});

test('монета без привязки рядом с монетой с ценой: итог по привязанной, непривязанная названа с причиной', () => {
  const operations = [...base(), buy('2026-02-01', 'Ledger', '10', '0.00001', null, 'ПЕПЕ')];
  const { totals, excluded } = overview(operations, prices({ solana: '200' }));
  assert.equal(totals.value, units('600'));
  assert.equal(totals.cost, units('400'));
  assert.deepEqual(excluded, [{ symbol: 'ПЕПЕ', cost: units('10'), why: 'unbound' }]);
});
