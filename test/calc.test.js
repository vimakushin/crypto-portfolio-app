import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, formatAmount, formatSignificant, multiplyExact, parseAmount, SCALE } from '../src/calc.js';

// Ожидаемые значения посчитаны вручную и записаны дробями: near(x, 400, 3)
// значит «x равно 400/3». Расчёт округляет деление в 30-м знаке, поэтому
// здесь допуск 10⁻²⁰ — на двадцать порядков меньше того, что видно на экране.
// Свойства, которые обязаны выполняться ровно (перевод без комиссии,
// сохранность денег), сравниваются точно, без допуска.
function near(actual, n, d = 1) {
  const diff = actual * BigInt(d) - BigInt(n) * SCALE;
  const tolerance = BigInt(d) * 10n ** 10n;
  assert.ok(diff <= tolerance && -diff <= tolerance, `${actual} ≠ ${n}/${d} (в единицах 10⁻³⁰)`);
}
const exact = (text) => BigInt(text) * SCALE;

const buy = (date, portfolio, money, price) => ({ type: 'buy', date, coin: 'SOL', portfolio, money, price });
const sell = (date, portfolio, rest) => ({ type: 'sell', date, coin: 'SOL', portfolio, ...rest });
const transfer = (date, from, to, sent, received) => ({ type: 'transfer', date, coin: 'SOL', from, to, sent, received });

// Binance: 100$ по 100 + 300$ по 150 = 3 SOL за 400$. Кошелёк: 50$ по 125 = 0.4 SOL.
const base = [
  buy('2026-01-10', 'Binance', '100', '100'),
  buy('2026-01-20', 'Binance', '300', '150'),
  buy('2026-02-01', 'Кошелёк', '50', '125'),
];

const sol = (operations) => calculate(operations).coins.get('SOL');

// Проверяет, что расчёт остановился ровно на одной монете с такой ошибкой.
function fails(operations, message) {
  const { errors } = calculate(operations);
  assert.equal(errors.length, 1, `ожидалась одна ошибка, а их ${errors.length}`);
  assert.match(errors[0].message, message);
}
const pf = (operations, name) => sol(operations).portfolios.get(name);

test('покупки: средние на обоих уровнях сходятся с ручным счётом', () => {
  const total = sol(base);
  near(pf(base, 'Binance').quantity, 3);
  near(pf(base, 'Binance').average, 400, 3);
  near(pf(base, 'Кошелёк').average, 125);
  near(total.quantity, 34, 10);
  assert.equal(total.cost, exact(450));
  near(total.average, 2250, 17); // 450 / 3.4
});

test('покупка на сумму, не делящуюся на цену: средняя равна цене', () => {
  const result = sol([buy('2026-01-01', 'Binance', '200', '146.12')]);
  near(result.quantity, 20000, 14612);
  near(result.average, 14612, 100);
});

test('составленный набор из всех трёх операций сходится с ручным счётом', () => {
  const operations = [
    ...base,
    transfer('2026-02-15', 'Binance', 'Кошелёк', '1', '0.99'),
    sell('2026-03-01', 'Кошелёк', { quantity: '0.39' }),
  ];
  // Перевод: с Binance ушли 1 SOL и 400/3 $. Binance: 2 SOL, 800/3 $.
  // Кошелёк: 0.4 + 0.99 = 1.39 SOL, 50 + 400/3 = 550/3 $, средняя 550/4.17.
  // Продажа 0.39 из кошелька: остался 1 SOL, средняя прежняя 550/4.17.
  // Итого: 3 SOL, 800/3 + 550/4.17 = 55400/139 $, средняя 55400/417.
  near(pf(operations, 'Binance').average, 400, 3);
  near(pf(operations, 'Кошелёк').quantity, 1);
  near(pf(operations, 'Кошелёк').average, 55000, 417);
  near(sol(operations).quantity, 3);
  near(sol(operations).average, 55400, 417);
});

test('общая средняя равна средневзвешенной по портфелям', () => {
  const operations = [...base, transfer('2026-02-15', 'Binance', 'Кошелёк', '1', '0.99')];
  // 800/3 $ на 2 SOL и 550/3 $ на 1.39 SOL → 450 $ на 3.39 SOL.
  near(pf(operations, 'Binance').cost, 800, 3);
  near(pf(operations, 'Кошелёк').cost, 550, 3);
  assert.equal(sol(operations).cost, exact(450));
  assert.equal(sol(operations).quantity, exact(339) / 100n);
});

test('перевод без комиссии не меняет общую среднюю ровно, среднюю отправителя — тоже', () => {
  const operations = [...base, transfer('2026-02-15', 'Binance', 'Кошелёк', '1', '1')];
  assert.equal(sol(operations).average, sol(base).average);
  near(pf(operations, 'Binance').average, 400, 3);
  // Получатель смешал: 50 + 400/3 = 550/3 $ на 1.4 SOL.
  near(pf(operations, 'Кошелёк').average, 2750, 21);
});

test('перевод с комиссией: 146 $ на 1 SOL → на 0.995 SOL, средняя 146.73', () => {
  const operations = [
    buy('2026-01-01', 'Binance', '146', '146'),
    transfer('2026-01-02', 'Binance', 'Кошелёк', '1', '0.995'),
  ];
  const average = pf(operations, 'Кошелёк').average;
  near(average, 146000, 995);
  // Как это увидит человек: средняя, округлённая до центов.
  assert.equal((Number(average / 10n ** 26n) / 1e4).toFixed(2), '146.73');
  near(sol(operations).average, 146000, 995);
  assert.equal(sol(operations).cost, exact(146)); // деньги не потерялись
  assert.equal(pf(operations, 'Binance').average, null);
});

test('перевод с комиссией поднимает общую среднюю ровно до вложено / оставшиеся монеты', () => {
  const before = sol(base).average;
  const operations = [...base, transfer('2026-02-15', 'Binance', 'Кошелёк', '1', '0.99')];
  const after = sol(operations).average;
  near(after, 45000, 339); // 450 $ на 3.4 − 0.01 = 3.39 SOL
  assert.ok(after > before, 'средняя должна вырасти');
  near(pf(operations, 'Binance').average, 400, 3);
});

test('продажа не меняет среднюю портфеля — ни количеством, ни деньгами', () => {
  const byQuantity = [...base, sell('2026-03-01', 'Binance', { quantity: '1' })];
  near(pf(byQuantity, 'Binance').quantity, 2);
  near(pf(byQuantity, 'Binance').average, 400, 3);
  near(pf(byQuantity, 'Кошелёк').average, 125);

  // 300 $ по 150 — это 2 SOL.
  const byMoney = [...base, sell('2026-03-01', 'Binance', { money: '300', price: '150' })];
  near(pf(byMoney, 'Binance').quantity, 1);
  near(pf(byMoney, 'Binance').average, 400, 3);
});

test('продажа количеством с записанной ценой: цена на среднюю не влияет', () => {
  // Форма хранит и цену продажи — для человека; расчёт её не использует.
  const operations = [...base, sell('2026-03-01', 'Binance', { quantity: '1', price: '999' })];
  near(pf(operations, 'Binance').quantity, 2);
  near(pf(operations, 'Binance').average, 400, 3);
});

test('разбор числа: то же правило, что у расчёта', () => {
  assert.equal(parseAmount('146.12'), exact(14612) / 100n);
  assert.equal(parseAmount('0'), 0n);
  assert.equal(parseAmount('1,5'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('1.' + '1'.repeat(31)), null);
});

test('продажа не меняет общую среднюю, когда монета лежит в одном портфеле', () => {
  const operations = [
    buy('2026-01-10', 'Binance', '100', '100'),
    buy('2026-01-20', 'Binance', '300', '150'),
    sell('2026-03-01', 'Binance', { quantity: '1.7' }),
  ];
  near(sol(operations).average, 400, 3);
});

test('продажа из одного портфеля сдвигает общую среднюю к средней остальных портфелей', () => {
  // Средние портфелей не меняются, но доля Binance в позиции уменьшилась.
  // Осталось 2 SOL по 400/3 и 0.4 SOL по 125: 950/3 $ на 2.4 SOL.
  const operations = [...base, sell('2026-03-01', 'Binance', { quantity: '1' })];
  near(sol(operations).average, 2375, 18);
});

test('продажа всего остатка: количество и вложено — ровно ноль, средней нет', () => {
  const operations = [...base, sell('2026-03-01', 'Binance', { quantity: '3' })];
  const b = pf(operations, 'Binance');
  assert.equal(b.quantity, 0n);
  assert.equal(b.cost, 0n);
  assert.equal(b.average, null);
  near(sol(operations).average, 125);
});

test('продажа всего на ту же сумму, что покупали, не даёт ни ошибки, ни пылинки', () => {
  // Количество каждой покупки округлено в 30-м знаке, и сумма покупок может
  // разойтись с количеством продажи на несколько единиц в обе стороны.
  for (const price of ['3', '7', '0.3', '146.12', '0.00000089']) {
    const operations = [
      buy('2026-01-01', 'Binance', '100', price),
      buy('2026-01-02', 'Binance', '100', price),
      buy('2026-01-03', 'Binance', '100', price),
      sell('2026-01-04', 'Binance', { money: '300', price }),
    ];
    const b = pf(operations, 'Binance');
    assert.equal(b.quantity, 0n, `цена ${price}`);
    assert.equal(b.cost, 0n, `цена ${price}`);
    assert.equal(b.average, null, `цена ${price}`);
  }
});

test('перевод «всего», купленного на деньги: монет не прибавляется и не теряется', () => {
  // Сумма трёх покупок по цене 3 расходится с «100» в 30-м знаке.
  // Человек отправляет «100» без комиссии — общее количество и средняя те же.
  const operations = [
    buy('2026-01-01', 'Binance', '100', '3'),
    buy('2026-01-02', 'Binance', '100', '3'),
    buy('2026-01-03', 'Binance', '100', '3'),
  ];
  const before = sol(operations);
  const after = sol([...operations, transfer('2026-01-04', 'Binance', 'Кошелёк', '100', '100')]);
  assert.equal(after.quantity, before.quantity);
  assert.equal(after.average, before.average);
  assert.equal(after.portfolios.get('Binance').quantity, 0n);

  // То же с комиссией 0.1: монет стало ровно на 0.1 меньше, деньги все на месте.
  const withFee = sol([...operations, transfer('2026-01-04', 'Binance', 'Кошелёк', '100', '99.9')]);
  assert.equal(withFee.quantity, before.quantity - SCALE / 10n);
  assert.equal(withFee.cost, exact(300));
});

test('граница пыли: лишние 10⁻²⁶ монеты — это «всё», лишние 2·10⁻²⁶ — ошибка', () => {
  const tail = (digit) => `3.${digit.padStart(26, '0')}`;
  const all = [...base, sell('2026-03-01', 'Binance', { quantity: tail('1') })];
  assert.equal(pf(all, 'Binance').quantity, 0n);
  assert.equal(pf(all, 'Binance').cost, 0n);
  fails([...base, sell('2026-03-01', 'Binance', { quantity: tail('2') })], /нет столько монет/);
  // Остаток в одну единицу NEAR (10⁻²⁴) настоящий, его порог не трогает.
  const near24 = [...base, sell('2026-03-01', 'Binance', { quantity: '2.999999999999999999999999' })];
  assert.equal(pf(near24, 'Binance').quantity, 10n ** 6n);
});

test('перевод всего остатка: отправитель пуст, общая средняя прежняя', () => {
  const operations = [...base, transfer('2026-03-01', 'Binance', 'Кошелёк', '3', '3')];
  assert.equal(pf(operations, 'Binance').average, null);
  assert.equal(pf(operations, 'Binance').cost, 0n);
  assert.equal(sol(operations).average, sol(base).average);
});

test('операции, внесённые задним числом, считаются по дате', () => {
  // По дате: купил по 100, продал всё, купил по 200 → средняя 200.
  const operations = [
    buy('2026-03-01', 'Binance', '200', '200'),
    sell('2026-02-01', 'Binance', { quantity: '1' }),
    buy('2026-01-01', 'Binance', '100', '100'),
  ];
  near(sol(operations).average, 200);
});

test('в пределах одного дня операции считаются в порядке внесения', () => {
  const day = '2026-01-01';
  const sellFirst = [buy(day, 'Binance', '100', '100'), sell(day, 'Binance', { quantity: '1' }), buy(day, 'Binance', '200', '200')];
  const sellLast = [buy(day, 'Binance', '100', '100'), buy(day, 'Binance', '200', '200'), sell(day, 'Binance', { quantity: '1' })];
  near(sol(sellFirst).average, 200);
  near(sol(sellLast).average, 150);
});

test('разные монеты считаются отдельно', () => {
  const result = calculate([
    ...base,
    { type: 'buy', date: '2026-01-05', coin: 'BTC', portfolio: 'Binance', money: '1000', price: '50000' },
  ]);
  near(result.coins.get('BTC').average, 50000);
  near(result.coins.get('SOL').average, 2250, 17);
});

test('битая операция одной монеты не мешает остальным и указывает на себя', () => {
  const broken = sell('2026-03-01', 'Binance', { quantity: '99' });
  const result = calculate([
    { type: 'buy', date: '2026-01-05', coin: 'BTC', portfolio: 'Binance', money: '1000', price: '50000' },
    ...base,
    broken,
    { type: 'buy', date: '2026-01-06', coin: 'ETH', portfolio: 'Кошелёк', money: '300', price: '3000' },
  ]);
  near(result.coins.get('BTC').average, 50000);
  near(result.coins.get('ETH').average, 3000);
  // SOL не показывается вовсе: средняя без битой строки была бы неверной.
  assert.equal(result.coins.has('SOL'), false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].coin, 'SOL');
  assert.equal(result.errors[0].operation, broken);
  assert.match(result.errors[0].message, /2026-03-01.*нет столько монет/);
});

test('монета без привязки не сливается с привязанной, даже с тем же тикером', () => {
  const bound = { ...buy('2026-01-01', 'Binance', '100', '100'), coin: 'solana', symbol: 'SOL' };
  const unbound1 = { ...buy('2026-01-02', 'Binance', '300', '150'), coin: null, symbol: 'SOL' };
  const unbound2 = { ...buy('2026-01-03', 'Binance', '50', '125'), coin: null, symbol: 'SOL' };
  const result = calculate([bound, unbound1, unbound2]);
  near(result.coins.get('solana').average, 100);
  assert.equal(result.coins.get('solana').quantity, exact(1));
  // Две покупки без связи — одна монета «как её назвал человек»: 350 $ на 2.4.
  near(result.coins.get('?SOL').average, 3500, 24);
  assert.equal(result.coins.size, 2);
});

test('монета без привязки и без названия — ошибка, а не безымянная позиция', () => {
  fails([{ ...buy('2026-01-01', 'Binance', '100', '100'), coin: null, symbol: '' }], /не указана монета/);
  fails([{ ...buy('2026-01-01', 'Binance', '100', '100'), coin: null }], /не указана монета/);
});

test('пустой список операций — пустой результат без ошибок', () => {
  assert.deepEqual(calculate([]), { coins: new Map(), errors: [] });
});

test('очень дешёвая и очень дорогая монета считаются точно', () => {
  const cheap = sol([
    buy('2026-01-01', 'A', '10', '0.00000123'),
    buy('2026-01-02', 'A', '7.77', '0.00000089'),
  ]);
  // Монет: 10/0.00000123 + 7.77/0.00000089 = 184571·10⁶ / 10947.
  // Средняя: 17.77 / это = 1777·10947 / (184571·10⁸).
  near(cheap.average, 19452819, 18457100000000);

  const expensive = sol([
    buy('2026-01-01', 'A', '50000', '100000'),
    buy('2026-01-02', 'A', '0.01', '125000.5'),
  ]);
  // Монет: 0.5 + 0.01/125000.5 = 0.5 + 1/12500050 = 3125013/6250025.
  near(expensive.quantity, 3125013, 6250025);
  assert.equal(expensive.cost, exact(5000001) / 100n);
});

test('длинная цепочка переводов без комиссии: общая средняя не сдвигается ни на сколько', () => {
  const operations = [
    buy('2026-01-01', 'Binance', '1000', '137.77'),
    buy('2026-01-01', 'Кошелёк', '333.33', '91.3'),
    buy('2026-01-01', 'Ledger', '500', '104.07'),
  ];
  const expected = sol(operations).average;
  const ring = ['Binance', 'Кошелёк', 'Ledger'];
  for (let i = 0; i < 150; i++) {
    const sent = (0.01 + (i % 7) * 0.0031).toFixed(4);
    operations.push(transfer('2026-02-01', ring[i % 3], ring[(i + 1) % 3], sent, sent));
  }
  assert.equal(sol(operations).average, expected);
});

test('история из тысячи разных операций считается быстро', () => {
  // Точные дроби на такой истории считались секунды. Проверяем, что
  // расчёт не вернулся к росту чисел от операции к операции.
  const operations = [];
  for (let i = 0; i < 1000; i++) {
    const date = `2026-${String(1 + (i % 12)).padStart(2, '0')}-01`;
    if (i % 4 === 0) operations.push(buy(date, 'A', String(50 + i), (120 + (i * 7.31) % 40).toFixed(2)));
    if (i % 4 === 1) operations.push(buy(date, 'B', '30', (130 + (i * 3.17) % 30).toFixed(2)));
    if (i % 4 === 2) operations.push(sell(date, 'A', { money: '1.5', price: (125 + (i % 9)).toFixed(2) }));
    if (i % 4 === 3) operations.push(transfer(date, 'A', 'B', '0.1', '0.0997'));
  }
  const started = performance.now();
  assert.deepEqual(calculate(operations).errors, []);
  assert.ok(performance.now() - started < 1000, 'расчёт занял больше секунды');
});

test('комиссия биржи при покупке: деньги остаются на полученных монетах', () => {
  // Купил на 200 $ по 146.12, биржа взяла комиссию монетами — пришло 1.3674.
  // Средняя: 200 / 1.3674, выше цены покупки.
  const operations = [{ ...buy('2026-01-01', 'Binance', '200', '146.12'), received: '1.3674' }];
  assert.equal(sol(operations).quantity, exact(13674) / 10000n);
  assert.equal(sol(operations).cost, exact(200));
  near(sol(operations).average, 2000000, 13674);
  assert.ok(sol(operations).average > exact(14612) / 100n);
});

test('комиссия биржи: «получено» ровно по расчёту — то же, что без него', () => {
  const plain = sol([buy('2026-01-01', 'Binance', '300', '150')]);
  const same = sol([{ ...buy('2026-01-01', 'Binance', '300', '150'), received: '2' }]);
  assert.equal(same.quantity, plain.quantity);
  assert.equal(same.average, plain.average);
});

test('комиссия биржи дальше ведёт себя как обычная средняя', () => {
  // 300 $ по 150, получено 1.98: средняя 300/1.98. Потом 50 $ по 125 без
  // комиссии в кошелёк, перевод 1 без комиссии и продажа 0.5.
  const operations = [
    { ...buy('2026-01-10', 'Binance', '300', '150'), received: '1.98' },
    buy('2026-02-01', 'Кошелёк', '50', '125'),
    transfer('2026-02-15', 'Binance', 'Кошелёк', '1', '1'),
    sell('2026-03-01', 'Binance', { quantity: '0.5' }),
  ];
  // Binance: 0.48 SOL по 300/1.98. Кошелёк: 1.4 SOL, 50 + 300/1.98 $.
  near(pf(operations, 'Binance').average, 30000, 198);
  near(pf(operations, 'Binance').quantity, 48, 100);
  near(pf(operations, 'Кошелёк').cost, 50 * 198 + 30000, 198);
  near(pf(operations, 'Кошелёк').average, (50 * 198 + 30000) * 10, 198 * 14);
});

test('комиссия биржи: получить больше купленного нельзя', () => {
  fails([{ ...buy('2026-01-01', 'Binance', '300', '150'), received: '2.0000001' }], /получено больше/);
  fails([{ ...buy('2026-01-01', 'Binance', '300', '150'), received: '0' }], /больше нуля/);
  fails([{ ...buy('2026-01-01', 'Binance', '300', '150'), received: '1,98' }], /не число/);
});

test('показ числа: округление до ближайшего и без лишних нулей', () => {
  const units = (text) => {
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole + fraction.padEnd(30, '0'));
  };
  assert.equal(formatAmount(units('1.368738023542294'), 8), '1.36873802');
  assert.equal(formatAmount(units('1.368738025'), 8), '1.36873803'); // ровно половина — вверх
  assert.equal(formatAmount(units('0.002'), 8), '0.002');
  assert.equal(formatAmount(units('0.000000004'), 8), '0');
  assert.equal(formatAmount(units('0.000000005'), 8), '0.00000001');
  assert.equal(formatAmount(units('0.99999999999'), 8), '1');
  assert.equal(formatAmount(units('8130081.300813008130081'), 8), '8130081.30081301');
  assert.equal(formatAmount(units('146'), 2), '146');
  assert.equal(formatAmount(0n, 8), '0');
  // Средняя из примера с комиссией: 146 / 0.995.
  assert.equal(formatAmount(pf([
    buy('2026-01-01', 'Binance', '146', '146'),
    transfer('2026-01-02', 'Binance', 'Кошелёк', '1', '0.995'),
  ], 'Кошелёк').average, 2), '146.73');
});

test('показ по значащим цифрам: цена около 1 и дешёвая монета не теряют разницу', () => {
  const units = (text) => parseAmount(text);
  assert.equal(formatSignificant(units('125.3132832080200501'), 6), '125.313');
  assert.equal(formatSignificant(units('1.004016064257'), 6), '1.00402');
  assert.equal(formatSignificant(units('1'), 6), '1');
  assert.equal(formatSignificant(units('0.000000303030303'), 6), '0.00000030303'); // 0.000000303030, ноль в конце убран
  assert.equal(formatSignificant(units('0.000000004'), 6), '0.000000004');
  assert.equal(formatSignificant(units('81632.4567'), 6), '81632.5');
  assert.equal(formatSignificant(units('1234567.89'), 6), '1234567.9');
  assert.equal(formatSignificant(units('0.9999999999'), 6), '1');
  assert.equal(formatSignificant(0n, 6), '0');
});

test('невозможные операции дают ошибку, а не число', () => {
  fails([...base, sell('2026-03-01', 'Binance', { quantity: '3.0000001' })], /нет столько монет/);
  fails([...base, sell('2026-03-01', 'Ledger', { quantity: '0.1' })], /нет столько монет/);
  fails([...base, sell('2026-03-01', 'Ledger', { quantity: '0.000000000000000000000000000001' })], /нет столько монет/);
  fails([...base, transfer('2026-03-01', 'Кошелёк', 'Binance', '0.5', '0.5')], /нет столько монет/);
  fails([...base, transfer('2026-03-01', 'Binance', 'Кошелёк', '1', '1.01')], /получено больше/);
  fails([...base, transfer('2026-03-01', 'Binance', 'Binance', '1', '1')], /тот же портфель/);
  fails([...base, transfer('2026-03-01', 'Binance', 'Кошелёк', '1', '0')], /больше нуля/);
  fails([...base, transfer('2026-03-01', 'Binance', 'Кошелёк', '3.00000000000000000000000001', '0.000000000000000000000000005')], /ничего не дошло/);
  fails([{ ...buy('2026-01-01', 'Binance', '100', '100'), portfolio: undefined }], /не указана монета или портфель/);
  fails([{ ...buy('2026-01-01', 'Binance', '100', '100'), coin: '' }], /не указана монета или портфель/);
  fails([...base, { ...transfer('2026-03-01', 'Binance', 'Кошелёк', '1', '1'), to: undefined }], /не указана монета или портфель/);
  fails([buy('2026-13-45', 'Binance', '100', '100')], /не существует/);
  fails([buy('2026-02-30', 'Binance', '100', '100')], /не существует/);
  fails([...base, sell('2026-03-01', 'Binance', { quantity: '1', money: '100', price: '100' })], /либо количество, либо деньги/);
  fails([...base, sell('2026-03-01', 'Binance', {})], /либо количество, либо деньги/);
  fails([buy('2026-01-01', 'Binance', '1,5', '100')], /не число/);
  fails([buy('2026-01-01', 'Binance', '-5', '100')], /не число/);
  fails([buy('2026-01-01', 'Binance', 100, '100')], /не число/);
  fails([buy('2026-01-01', 'Binance', '100', '0')], /больше нуля/);
  fails([buy('01.01.2026', 'Binance', '100', '100')], /ГГГГ-ММ-ДД/);
  fails([{ ...buy('2026-01-01', 'Binance', '100', '100'), type: 'swap' }], /неизвестный вид/);
});

// --- Покупка по количеству: деньги = количество × цена ---

test('количество × цена считается точно: без остатка, количество и вложенное ровно те, что введены', () => {
  const cases = [['1.3684', '146.12'], ['0.5', '3'], ['33.333333', '0.3'], ['0.00012345', '97431.17'], ['1000000', '0.00000123'], ['7', '1']];
  for (const [quantity, price] of cases) {
    const money = multiplyExact(parseAmount(quantity), parseAmount(price));
    assert.notEqual(money, null, `${quantity} × ${price}`);
    // Тот же путь, что у формы: деньги, цена и «получено» = количество.
    const op = { type: 'buy', date: '2026-01-10', coin: 'solana', symbol: 'SOL', portfolio: 'Binance', money: formatAmount(money, 30), price, received: quantity };
    const position = calculate([op]).coins.get('solana');
    assert.deepEqual(calculate([op]).errors, [], `${quantity} × ${price}: расчёт принял`);
    assert.equal(position.quantity, parseAmount(quantity), `${quantity} × ${price}: количество`);
    assert.equal(position.cost, money, `${quantity} × ${price}: вложено`);
    assert.equal(position.average, parseAmount(price), `${quantity} × ${price}: средняя равна цене покупки, без остатка`);
    // И расчёт «по деньгам» из тех же денег даёт то же количество: оба способа сходятся.
    const byMoney = calculate([{ ...op, received: undefined }]).coins.get('solana');
    assert.equal(byMoney.quantity, position.quantity, `${quantity} × ${price}: оба способа`);
  }
});

test('произведение, не помещающееся в 30 знаков, не округляется молча: null', () => {
  assert.equal(multiplyExact(parseAmount('0.000000000000000000000000000001'), parseAmount('0.5')), null);
  assert.equal(multiplyExact(parseAmount('0.000000000000000000000000000001'), parseAmount('2')), parseAmount('0.000000000000000000000000000002'));
});

test('деньги поправлены вверх (заплатили больше): вложено ровно вписанное, количество — введённое, средняя выше цены', () => {
  const op = { type: 'buy', date: '2026-01-10', coin: 'solana', symbol: 'SOL', portfolio: 'Binance', money: '210', price: '100', received: '2' };
  const position = calculate([op]).coins.get('solana');
  assert.equal(position.quantity, parseAmount('2'));
  assert.equal(position.cost, parseAmount('210'));
  assert.equal(position.average, parseAmount('105'));
});

test('деньги поправлены вниз (меньше количества × цена): расчёт отказывает, а не берёт на веру', () => {
  const op = { type: 'buy', date: '2026-01-10', coin: 'solana', symbol: 'SOL', portfolio: 'Binance', money: '190', price: '100', received: '2' };
  assert.equal(calculate([op]).errors.length, 1);
});

