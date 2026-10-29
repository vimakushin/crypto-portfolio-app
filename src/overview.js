// Числа главного экрана: что у человека есть, сколько вложено, сколько это
// стоит сейчас и какая разница. Деньги считаются здесь, а не в app.js, чтобы
// тесты могли сверить каждое число экрана с расчётом.
//
// Всё в единицах SCALE (см. calc.js). Нигде не подставляем ноль или прежнее
// число вместо отсутствующего: нет цены — value и difference равны null, и
// экран обязан сказать, почему.

import { calculate, coinKey, divide, SCALE, parseAmount } from './calc.js';

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0n);

// Разница в процентах от вложенного; null, если вложенного нет (пустой
// список, а при переводе мельчайшей доли вложенное тоже округляется до нуля).
// divide рассчитан на неотрицательные числа (на отрицательных округляет не к
// ближайшему), поэтому убыток делится по модулю.
const percentOf = (difference, cost) => {
  if (cost === 0n) return null;
  const part = divide((difference < 0n ? -difference : difference) * 100n * SCALE, cost);
  return difference < 0n ? -part : part;
};

// Разница стоимости и вложенного, если она настоящая, иначе null: «разницы нет».
// Количество монет при покупке на деньги округляется до 10⁻³⁰, и стоимость по
// цене покупки выходит не ровно равной вложенному, а с остатком арифметики —
// 10⁻²⁶ $ и меньше; человек видел бы «+0,000000000000000000000000022 $» сразу
// после внесения, пока не пришла свежая цена. У денег есть наименьшая единица
// (цент), и величина куда меньше неё деньгами не является. Порог — относительный,
// как в changed() в app.js: 10⁻¹⁵ от вложенного. Остаток округления не больше
// цены в единицах точности, то есть порядка 10⁻³⁰ от вложенного на каждую
// монету количества, а настоящая разница в одну десятитысячную цента на тысячу
// долларов — 10⁻¹⁰: между ними много порядков, и ни одна настоящая разница под
// порог не попадает. Значения до округления для показа не сравниваются: порог
// стоит на самой арифметике, а не на показанных знаках.
const realDifference = (difference, cost) => ((difference < 0n ? -difference : difference) * 10n ** 15n > cost ? difference : null);

const touches = (op, portfolio) => op.portfolio === portfolio || op.from === portfolio || op.to === portfolio;

function rowOf(key, symbol, p, prices) {
  const row = { key, symbol, quantity: p.quantity, average: p.average, cost: p.cost, value: null, difference: null, percent: null, why: null };
  // Монета без привязки (ключ «?SOL») цены не имеет: по тикеру цену не берём.
  if (key.startsWith('?')) return { ...row, why: 'unbound' };
  const price = parseAmount(prices?.get(key));
  if (price === null || price === 0n) return { ...row, why: 'no-price' };
  const value = divide(p.quantity * price, SCALE);
  const difference = realDifference(value - p.cost, p.cost);
  return { ...row, value, difference, percent: difference === null ? null : percentOf(difference, p.cost) };
}

// prices — Map: код монеты → цена строкой, или null, если цен нет вовсе.
// only — название портфеля или null для всех. Возвращает:
//   rows   — что есть сейчас, крупнейшие вложения первыми;
//   totals — { cost, value, difference, percent } по монетам, у которых есть
//            цена, и вложенное тоже только в них: иначе «вложено» и «стоит»
//            считались бы по разным наборам монет. Если цены нет ни у одной,
//            value, difference и percent равны null, а cost — по всем.
//            Пустой список — честный ноль, а не отсутствие;
//   excluded — то, чего в итоге нет, с причиной и вложенным: [{ symbol, cost,
//            why }], why — 'no-price' или 'unbound'. Экран обязан назвать их
//            рядом с самим числом: молчаливый частичный итог был бы ложью,
//            названный — нет.
//   Монет, которые расчёт не посчитал, здесь нет: история с такой ошибкой в
//   приложение не попадает (см. правило о checkHistory в CLAUDE.md).
export function overview(operations, prices, only = null) {
  const { coins } = calculate(operations);
  const symbols = new Map(operations.map((op) => [coinKey(op), op.symbol]));

  const rows = [];
  for (const [key, position] of coins) {
    const p = only === null ? position : position.portfolios.get(only);
    // Полностью проданное не показываем; крошечный остаток — показываем, он есть.
    if (p && p.quantity > 0n) rows.push(rowOf(key, symbols.get(key), p, prices));
  }
  rows.sort((a, b) => (a.cost === b.cost ? a.symbol.localeCompare(b.symbol) : a.cost > b.cost ? -1 : 1));

  const valued = rows.filter((row) => row.value !== null);
  const excluded = [
    // Когда цены нет ни у одной монеты, «без них» не говорим: итога стоимости нет вовсе.
    ...(valued.length > 0 ? rows.filter((row) => row.value === null).map((row) => ({ symbol: row.symbol, cost: row.cost, why: row.why })) : []),
  ];
  const empty = { cost: 0n, value: 0n, difference: 0n, percent: null };
  const counted = valued.length > 0 ? valued : rows;
  const cost = sum(counted, 'cost');
  const value = valued.length > 0 ? sum(valued, 'value') : null;
  const difference = value === null ? null : realDifference(value - cost, cost);
  const totals = rows.length === 0 ? empty
    : { cost, value, difference, percent: difference === null ? null : percentOf(difference, cost) };

  return { rows, totals, excluded };
}

// Операции для просмотра истории: новые даты первыми, внутри дня — позже
// внесённые первыми. Для портфеля — только те, что его касаются.
export function history(operations, only = null) {
  return operations
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => only === null || touches(op, only))
    .sort((a, b) => (a.op.date === b.op.date ? b.index - a.index : a.op.date < b.op.date ? 1 : -1));
}

// Экран одной монеты: она целиком, по портфелям и её история. total — та же
// строка, что на главном экране (null, если монета продана целиком);
// portfolios — только те, где монета есть сейчас, с собственной средней.
export function coinDetail(operations, key, prices) {
  const { rows } = overview(operations, prices);
  const position = calculate(operations).coins.get(key);
  const portfolios = [...(position?.portfolios ?? [])]
    .filter(([, p]) => p.quantity > 0n)
    .map(([name, p]) => ({ name, quantity: p.quantity, average: p.average, cost: p.cost }))
    .sort((a, b) => (a.cost === b.cost ? a.name.localeCompare(b.name) : a.cost > b.cost ? -1 : 1));
  return {
    total: rows.find((row) => row.key === key) ?? null,
    portfolios,
    entries: history(operations).filter(({ op }) => coinKey(op) === key),
  };
}

// Можно ли удалить запись. Удаление покупки оставляет без монет более позднюю
// продажу или перевод, удаление перевода — продажу в портфеле, куда монеты
// пришли: расчёт монеты по всей истории показывает и тот, и другой конец. Если
// после удаления появляется запись, на которой расчёт останавливается, удалять
// нельзя, и ответ называет эту запись. История до удаления посчитана без
// ошибок всегда (CLAUDE.md, правило о checkHistory), поэтому любая ошибка
// после удаления — новая.
export function removalCheck(operations, index) {
  const key = coinKey(operations[index]);
  const rest = operations.filter((_, position) => position !== index);
  const broken = calculate(rest).errors.find((error) => error.coin === key);
  if (!broken) return { ok: true };
  return { ok: false, operation: broken.operation, message: broken.message.replace(/^Операция от [^:]*: /, '') };
}
