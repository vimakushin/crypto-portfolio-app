import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, formatAmount, multiplyExact, parseAmount, SCALE } from '../src/calc.js';
import { coinDetail, history, overview, removalCheck } from '../src/overview.js';

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
    if (calculate(operations).errors.length > 0) continue;
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

// --- Экран монеты и удаление записи ---

const SOL = 'solana';
const withoutOp = (operations, index) => operations.filter((_, position) => position !== index);

test('экран монеты: монета целиком совпадает со строкой главного экрана, портфели — со своими средними', () => {
  const operations = [
    buy('2026-01-10', 'Binance', '100', '100'),
    buy('2026-01-20', 'Bybit', '300', '150'),
    transfer('2026-02-01', 'Bybit', 'Binance', '1', '1'),
  ];
  const detail = coinDetail(operations, SOL, prices({ solana: '200' }));
  const main = overview(operations, prices({ solana: '200' })).rows[0];
  assert.deepEqual(detail.total, main);
  // Binance: 1 монета по 100 и 1 по 150 (перешла с Bybit): 2 монеты, 250 $; в Bybit осталась 2 монеты по 150 минус 1 переведённая.
  const names = detail.portfolios.map((p) => p.name);
  assert.deepEqual(names.sort(), ['Binance', 'Bybit']);
  const binance = detail.portfolios.find((p) => p.name === 'Binance');
  const bybit = detail.portfolios.find((p) => p.name === 'Bybit');
  assert.equal(binance.quantity, units('2'));
  assert.equal(binance.cost, units('250'));
  assert.equal(binance.average, units('125'));
  assert.equal(bybit.average, units('150'));
  // Вложено по портфелям складывается во вложенное по монете.
  assert.equal(detail.portfolios.reduce((sum, p) => sum + p.cost, 0n), detail.total.cost);
});

test('экран монеты: история только этой монеты, новые сверху; чужая монета не попадает', () => {
  const operations = [
    buy('2026-01-10', 'Binance', '100', '100'),
    buy('2026-01-12', 'Binance', '50', '25', 'bitcoin', 'BTC'),
    buy('2026-01-20', 'Binance', '300', '150'),
  ];
  assert.deepEqual(coinDetail(operations, SOL, null).entries.map(({ index }) => index), [2, 0]);
  assert.equal(coinDetail(operations, 'bitcoin', null).entries.length, 1);
});

test('экран монеты: полностью проданный портфель в список не попадает', () => {
  const operations = [buy('2026-01-10', 'Binance', '100', '100'), buy('2026-01-11', 'Bybit', '100', '100'), sell('2026-01-12', 'Bybit', '1', '120')];
  assert.deepEqual(coinDetail(operations, SOL, null).portfolios.map((p) => p.name), ['Binance']);
});

test('удаление: покупку, на которой держится более поздняя продажа, удалить нельзя, и названа именно продажа', () => {
  const operations = [buy('2026-01-10', 'Binance', '100', '100'), buy('2026-01-15', 'Binance', '100', '100'), sell('2026-01-20', 'Binance', '1.5', '120')];
  const refused = removalCheck(operations, 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.operation, operations[2]);
  assert.match(refused.message, /нет столько монет/);
  // Без первой покупки остаётся 1 монета, а продаётся 1.5: тоже нельзя.
  assert.equal(removalCheck(operations, 0).ok, false);
});

test('удаление: запись, от которой ничего не зависит, удаляется, и пересчёт совпадает с расчётом с нуля', () => {
  const operations = [buy('2026-01-10', 'Binance', '100', '100'), sell('2026-01-20', 'Binance', '0.5', '120'), buy('2026-02-01', 'Binance', '200', '200')];
  assert.deepEqual(removalCheck(operations, 2), { ok: true });
  const after = overview(withoutOp(operations, 2), null);
  const fromScratch = calculate([operations[0], operations[1]]).coins.get(SOL);
  assert.equal(after.rows[0].quantity, fromScratch.quantity);
  assert.equal(after.rows[0].average, fromScratch.average);
  assert.equal(after.rows[0].cost, fromScratch.cost);
});

test('удаление единственной покупки монеты разрешено, монета с главного экрана уходит', () => {
  const operations = [buy('2026-01-10', 'Binance', '100', '100')];
  assert.deepEqual(removalCheck(operations, 0), { ok: true });
  assert.equal(overview(withoutOp(operations, 0), null).rows.length, 0);
});

test('удаление перевода: проверяются оба конца — и откуда ушло, и куда пришло', () => {
  // Перевод Bybit → Binance, потом продажа в Binance того, что пришло.
  const operations = [
    buy('2026-01-10', 'Bybit', '200', '100'),
    transfer('2026-01-15', 'Bybit', 'Binance', '2', '2'),
    sell('2026-01-20', 'Binance', '1.5', '120'),
  ];
  const refused = removalCheck(operations, 1);
  assert.equal(refused.ok, false, 'без перевода в Binance нечего продавать');
  assert.equal(refused.operation, operations[2]);
  // Продажу удалить можно: монеты остаются там, куда пришли.
  assert.equal(removalCheck(operations, 2).ok, true);
  // Покупку, из которой ушёл перевод, удалить нельзя: переводить стало нечего.
  const sourceRefused = removalCheck(operations, 0);
  assert.equal(sourceRefused.ok, false);
  assert.equal(sourceRefused.operation, operations[1]);
});

test('удаление перевода без последствий: средние после удаления совпадают с расчётом с нуля', () => {
  const operations = [
    buy('2026-01-10', 'Binance', '100', '100'),
    buy('2026-01-12', 'Bybit', '150', '150'),
    transfer('2026-01-15', 'Bybit', 'Binance', '0.4', '0.399'),
  ];
  assert.equal(removalCheck(operations, 2).ok, true);
  const rest = withoutOp(operations, 2);
  const detail = coinDetail(rest, SOL, null);
  const scratch = calculate(rest).coins.get(SOL);
  assert.equal(detail.total.average, scratch.average);
  assert.equal(detail.total.cost, scratch.cost);
  for (const p of detail.portfolios) assert.equal(p.average, scratch.portfolios.get(p.name).average);
});

test('удаление не трогает другие монеты: BTC ни от чего не зависит, а SOL зависит от своей покупки', () => {
  const operations = [buy('2026-01-10', 'Binance', '100', '100'), buy('2026-01-10', 'Binance', '50', '25', 'bitcoin', 'BTC'), sell('2026-01-20', 'Binance', '1', '120')];
  assert.equal(removalCheck(operations, 1).ok, true);
  assert.equal(removalCheck(operations, 0).ok, false);
});

test('полностью проданная монета: на экране монеты нет позиции, записи есть', () => {
  const operations = [buy('2026-01-10', 'Binance', '100', '100'), buy('2026-01-11', 'Binance', '100', '100'), sell('2026-01-12', 'Binance', '1', '120')];
  // Удаление второй покупки допустимо (продажа прикрыта первой) и оставляет ноль монет.
  assert.equal(removalCheck(operations, 1).ok, true);
  const detail = coinDetail(withoutOp(operations, 1), SOL, null);
  assert.equal(detail.total, null);
  assert.equal(detail.portfolios.length, 0);
  assert.equal(detail.entries.length, 2);
});

test('отмена внесённой позже записи проходит ту же проверку: покупка задним числом держит продажу, когда первую удалили', () => {
  // Внесены по порядку: покупка 1.01, продажа 10.01, покупка 5.01 (последней). Первую покупку удалили: продажу прикрывает третья.
  const operations = [buy('2026-01-01', 'Binance', '100', '100'), sell('2026-01-10', 'Binance', '1', '120'), buy('2026-01-05', 'Binance', '100', '100')];
  assert.equal(removalCheck(operations, 0).ok, true);
  const afterDeletion = withoutOp(operations, 0);
  // «Отмена последней» = удаление последней записи: теперь оно сломало бы продажу.
  const refused = removalCheck(afterDeletion, afterDeletion.length - 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.operation, afterDeletion[0]);
});

test('покупка и тут же цена, равная цене покупки: остаток арифметики — не разница, а настоящая разница остаётся', () => {
  // Количество при покупке на деньги округляется до 10⁻³⁰, и стоимость по той же цене
  // выходит не ровно равной вложенному: без порога экран показал бы «+0,000…022 $».
  let residues = 0;
  for (const [money, price] of [['100', '3'], ['100', '7'], ['250', '0.3'], ['1000', '97431.17'], ['50', '0.00000123'], ['333.33', '171.42']]) {
    const operations = [buy('2026-01-10', 'Binance', money, price)];
    const { rows, totals } = overview(operations, prices({ solana: price }));
    const raw = rows[0].value - rows[0].cost;
    if (raw !== 0n) residues += 1;
    assert.equal(rows[0].difference, null, `${money} по ${price}: остаток ${raw} не разница`);
    assert.equal(rows[0].percent, null, `${money} по ${price}: процент`);
    assert.equal(totals.difference, null, `${money} по ${price}: итог`);
    assert.equal(totals.percent, null, `${money} по ${price}: процент итога`);
    // Монета на экране монеты и в портфеле — те же числа.
    assert.equal(coinDetail(operations, SOL, prices({ solana: price })).total.difference, null);
    assert.equal(overview(operations, prices({ solana: price }), 'Binance').rows[0].difference, null);
  }
  assert.ok(residues > 0, 'в примерах должен быть настоящий остаток арифметики, иначе тест ничего не проверяет');

  // Малая настоящая разница не пропадает: цена на одну десятитысячную выше при вложенных 1000 $.
  const small = overview([buy('2026-01-10', 'Binance', '1000', '100')], prices({ solana: '100.0001' })).rows[0];
  assert.equal(small.difference, units('0.001'));
  assert.notEqual(small.percent, null);
});

test('покупка по количеству и цене, равной цене покупки: стоимость ровно равна вложенному, остатка нет вовсе', () => {
  for (const [quantity, price] of [['1.3684', '146.12'], ['0.5', '3'], ['33.333333', '0.3']]) {
    const money = formatAmount(multiplyExact(parseAmount(quantity), parseAmount(price)), 30);
    const operations = [{ type: 'buy', date: '2026-01-10', coin: 'solana', symbol: 'SOL', portfolio: 'Binance', money, price, received: quantity }];
    const row = overview(operations, prices({ solana: price })).rows[0];
    assert.equal(row.value - row.cost, 0n, `${quantity} × ${price}: остатка арифметики нет`);
  }
});

