// Расчёт средней цены входа по списку операций: покупок, продаж и переводов
// между портфелями. Средняя считается на двух уровнях — по монете внутри
// портфеля и общая по монете.
//
// Средняя — средневзвешенная: вложенные деньги, делённые на количество монет.
// Все правила ниже сводятся к тому, что именно происходит с этими двумя
// числами при каждой операции.

// --- Числа ---
//
// Все суммы и количества — целые BigInt в единицах 10⁻³⁰: число 146.12
// хранится как 146.12·10³⁰. Обычные числа JavaScript не годятся: 0.1 в них
// уже неточное, и ошибка копится от операции к операции.
//
// Сложение и вычитание при этом точные, округляет только деление — когда
// количество считается из денег и цены и когда при продаже или переводе
// снимается доля вложенного. Поэтому перевод без комиссии не меняет общую
// среднюю ровно: монеты и деньги только переезжают, и сумма по портфелям
// остаётся той же до последней единицы. Погрешность деления — в 30-м знаке,
// до экрана она не доходит.
//
// Точные дроби обошлись бы без округления вовсе, но их числители и
// знаменатели растут с каждой продажей и переводом: на истории в пару сотен
// операций расчёт занимал секунды, а пересчитывать её приходится часто.
export const SCALE = 10n ** 30n;

// Деление с округлением до ближайшего. Отрицательных чисел в расчёте нет.
export function divide(a, b) {
  return (2n * a + b) / (2n * b);
}

// Число для показа человеку: округлено до ближайшего на digits знаков после
// точки (digits от 1 до 30 — точнее числа не хранятся), нули в конце
// убраны — «0.002», а не «0.00200000».
export function formatAmount(units, digits) {
  const text = divide(units, 10n ** BigInt(30 - digits)).toString().padStart(digits + 1, '0');
  const fraction = text.slice(-digits).replace(/0+$/, '');
  return fraction ? `${text.slice(0, -digits)}.${fraction}` : text.slice(0, -digits);
}

// Число для показа по значащим цифрам. У цены около 1 $ и у дешёвой монеты
// важны не центы, а первые цифры: с двумя знаками после точки рост средней
// с 1 до 1.004 выглядел бы как «1 → 1», а цена 0.000000003 — как 0.
// Шесть значащих: 125.313, 1.00402, 0.000000303.
export function formatSignificant(units, digits) {
  if (units === 0n) return '0';
  const decimals = units >= SCALE
    ? Math.max(1, digits - (units / SCALE).toString().length)
    : Math.min(30, 30 - units.toString().length + digits);
  return formatAmount(units, decimals);
}

// --- Расчёт ---

// Возвращает { coins, errors }.
// coins — Map: монета (см. coinKey) → { quantity, cost, average, portfolios },
// где portfolios — Map: портфель → { quantity, cost, average }.
// Все числа — в единицах SCALE. Общие числа по монете — сумма портфелей,
// поэтому общая средняя всегда равна средневзвешенной по портфелям.
// errors — монеты, которые посчитать не удалось: { coin, operation, message },
// где operation — та самая операция из входного списка, на которой расчёт
// остановился.
//
// Монеты считаются независимо: данные вносятся руками месяцами, и битая
// строка в истории одной монеты не должна оставлять человека с пустым
// экраном. А внутри монеты ошибка останавливает её целиком: пропустить битую
// покупку и посчитать остальное — значит показать неверную среднюю, а
// неверная средняя хуже отсутствующей.
export function calculate(operations) {
  const byCoin = new Map();
  for (const op of operations) {
    const key = coinKey(op);
    if (!byCoin.has(key)) byCoin.set(key, []);
    byCoin.get(key).push(op);
  }

  const coins = new Map();
  const errors = [];
  for (const [coin, list] of byCoin) {
    try {
      coins.set(coin, calculateCoin(list));
    } catch (error) {
      errors.push({ coin, operation: error.operation, message: error.message });
    }
  }
  return { coins, errors };
}

// Монета — это её код в источнике цен (op.coin, например «solana»), а не
// тикер: у тикера SOL одиннадцать разных монет, и по тикеру однажды
// подставилась бы цена чужой. Монета, внесённая без связи, кода не имеет
// (coin: null) и считается под тем названием, что вписал человек (op.symbol),
// отдельно от любой привязанной — даже с тем же тикером. Её ключ — «?SOL»:
// в кодах источника вопросительного знака не бывает, и совпасть они не могут.
export function coinKey(op) {
  return op.coin === null ? `?${op.symbol}` : op.coin;
}

function calculateCoin(operations) {
  // Порядок операций влияет на результат: продажа снимает деньги по средней
  // на свой день. Купил по 100, продал всё, купил по 200 — средняя 200;
  // в другом порядке вышло бы 150. Операции вносят и задним числом, поэтому
  // считаем по дате. В пределах одного дня — в порядке внесения
  // (сортировка в JavaScript устойчивая).
  //
  // Шаблон отсекает «01.01.2026», календарь — «2026-13-45»: такая дата
  // встала бы в порядок операций между настоящими.
  for (const op of operations) {
    if (!isDate(op.date)) fail(op, 'дата не существует или не в формате ГГГГ-ММ-ДД');
  }
  const ordered = [...operations].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const portfolios = new Map();
  for (const op of ordered) apply(portfolios, op);
  return summarize(portfolios);
}

// Дата ГГГГ-ММ-ДД, которая есть в календаре. Ей пользуется и форма, чтобы
// не записать дату, на которой расчёт потом остановится.
export function isDate(text) {
  const parsed = new Date(`${text}T00:00:00Z`);
  return typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text)
    && !isNaN(parsed) && parsed.toISOString().slice(0, 10) === text;
}

// Ошибка помнит операцию, чтобы экран мог показать, какая именно строка
// мешает, а не только дату и монету.
function fail(op, text) {
  throw Object.assign(new Error(`Операция от ${op.date} (${op.symbol || op.coin || 'монета не указана'}): ${text}`), { operation: op });
}

function apply(portfolios, op) {
  // Операции приходят и из загруженного файла, где поле может потеряться:
  // без этой проверки появился бы портфель «undefined» со своей средней.
  const coin = op.coin === null ? op.symbol : op.coin;
  const names = op.type === 'transfer' ? [coin, op.from, op.to] : [coin, op.portfolio];
  if (!names.every((name) => typeof name === 'string' && name !== '')) {
    fail(op, 'не указана монета или портфель');
  }

  if (op.type === 'buy') {
    const money = amount(op, 'money');
    const price = amount(op, 'price');
    const p = position(portfolios, op.portfolio);
    // Количество не вводится, а считается: человек помнит «закинул 200
    // долларов», а не «купил 1.3687 SOL».
    const bought = divide(money * SCALE, price);
    if (bought === 0n) fail(op, 'на эту сумму по этой цене выходит меньше одной миллиардной доли миллиардной доли монеты');
    // Если биржа взяла комиссию монетами, пришло меньше. Тогда человек
    // вписывает, сколько получил, и правило то же, что у комиссии сети при
    // переводе: деньги не теряются, а ложатся на полученные монеты, и средняя
    // чуть выше цены. Получить больше, чем куплено, нельзя: это опечатка в
    // количестве или цене, и она тихо занизила бы среднюю.
    let quantity = bought;
    if (op.received !== undefined) {
      quantity = amount(op, 'received');
      if (quantity > bought) fail(op, 'получено больше, чем деньги ÷ цена');
    }
    p.quantity += quantity;
    p.cost += money;
  } else if (op.type === 'sell') {
    // Продажу вводят либо количеством, либо полученными деньгами и ценой.
    // Цена на среднюю не влияет: она нужна только, чтобы из денег получить
    // количество.
    if ((op.quantity === undefined) === (op.money === undefined)) {
      fail(op, `у продажи нужно указать либо количество, либо деньги`);
    }
    const quantity = op.quantity !== undefined
      ? amount(op, 'quantity')
      : divide(amount(op, 'money') * SCALE, amount(op, 'price'));
    take(position(portfolios, op.portfolio), quantity, op);
  } else if (op.type === 'transfer') {
    if (op.from === op.to) {
      fail(op, `перевод в тот же портфель`);
    }
    const sent = amount(op, 'sent');
    const received = amount(op, 'received');
    if (received > sent) {
      fail(op, `получено больше, чем отправлено`);
    }
    // Перевод — не сделка. Деньги переезжают вместе с монетами по средней
    // отправителя, и все они ложатся на полученные монеты. Комиссия сети
    // (отправлено 1, получено 0.995) денег не съедает: человек заплатил
    // столько же за то, что теперь имеет, поэтому средняя получателя и общая
    // растут. Списать комиссию в убыток и оставить среднюю прежней было бы
    // неверно. Без комиссии общая средняя не меняется вовсе.
    const moved = take(position(portfolios, op.from), sent, op);
    const to = position(portfolios, op.to);
    // Комиссия — разница между отправленным и полученным. Если «отправлено»
    // поправлено до всей позиции (см. DUST), получатель получает столько же
    // поправленное, иначе без комиссии монет стало бы больше, чем было.
    const arrived = moved.quantity - (sent - received);
    if (arrived <= 0n) {
      fail(op, `после комиссии до получателя ничего не дошло`);
    }
    to.quantity += arrived;
    to.cost += moved.cost;
  } else {
    fail(op, `неизвестный вид операции «${op.type}»`);
  }
}

// Количество, посчитанное из денег и цены, округлено в 30-м знаке. Три
// покупки по 100 $ по цене 3 дают чуть меньше 100 монет, а продажа на 300 $
// по той же цене — ровно 100: человек продаёт всё, а расчёт видит «больше,
// чем есть» или оставляет пылинку с бессмысленной средней. Поэтому разница
// меньше 10⁻²⁶ монеты считается «всё». Это на два порядка мельче самой мелкой
// единицы, которая бывает у монет (10⁻²⁴ у NEAR), так что настоящий остаток
// порог не съест. Ошибка округления — не больше половины единицы 30-го знака
// на покупку и дорастает до порога только после 20 000 покупок в позиции.
const DUST = 10n ** 4n;

// Снимает монеты с позиции вместе с их долей вложенных денег по средней
// позиции и возвращает, сколько снято монет и денег. Средняя остатка от
// этого не меняется: (cost − cost·q/Q) / (Q − q) = cost/Q. Если снимается
// всё, доля равна вложенному ровно, без округления, и на пустой позиции не
// остаётся денег.
//
// Так работает продажа: способ «продаются первые купленные» меняет среднюю
// остатка сам собой, и человек не понимал бы почему. Вопрос продукта —
// «почём я набирал позицию», а не «сколько налога я должен».
//
// Средняя портфеля при продаже не меняется, а общая может сдвинуться, если
// монета лежит в нескольких портфелях с разными средними: изменилось, сколько
// монет где лежит. Удержать обе нельзя. Снимать деньги по общей средней было
// бы неверно: с портфеля, где купили по 100, при общей 150 ушло бы 150 за
// монету, и его средняя упала бы ниже любой цены покупки.
function take(p, quantity, op) {
  if (p.quantity === 0n || quantity > p.quantity + DUST) {
    fail(op, `в портфеле нет столько монет`);
  }
  if (p.quantity - quantity <= DUST) quantity = p.quantity;
  const cost = divide(p.cost * quantity, p.quantity);
  p.quantity -= quantity;
  p.cost -= cost;
  return { quantity, cost };
}

function position(portfolios, name) {
  if (!portfolios.has(name)) portfolios.set(name, { quantity: 0n, cost: 0n });
  return portfolios.get(name);
}

// Числа в операциях — строки с точкой: «146.12». Строки, а не числа
// JavaScript, потому что 0.1 в числе JavaScript уже неточное.
// Возвращает число в единицах SCALE или null, если это не число (запятая,
// минус, буквы, больше 30 знаков после точки). Форма разбирает числа этой же
// функцией, чтобы её подсказки не разошлись с расчётом.
export function parseAmount(text) {
  const match = typeof text === 'string' && /^(\d{1,30})(?:\.(\d{1,30}))?$/.exec(text);
  return match ? BigInt(match[1] + (match[2] ?? '').padEnd(30, '0')) : null;
}

function amount(op, field) {
  const value = parseAmount(op[field]);
  if (value === null) fail(op, `поле ${field} — не число: «${op[field]}»`);
  if (value === 0n) fail(op, `поле ${field} должно быть больше нуля`);
  return value;
}

// --- Проверка операций из хранилища и из файла ---
//
// Операции приходят оттуда, где их мог испортить кто угодно: файл правят
// руками, хранилище бывает недописано. Расчёт предполагает, что у операции
// есть монета, а пустой элемент вместо операции роняет его целиком, поэтому
// каждую проверяем до расчёта.

// Какие поля бывают у операции каждого вида: обязательные и необязательные.
const FIELDS = {
  buy: { required: ['portfolio', 'money', 'price'], optional: ['received'] },
  sell: { required: ['portfolio'], optional: ['quantity', 'money', 'price'] },
  transfer: { required: ['from', 'to', 'sent', 'received'], optional: [] },
};
const COMMON = ['type', 'date', 'coin', 'symbol'];
const NAMES = new Set(['portfolio', 'from', 'to', 'symbol']);

// Пустая строка, если операция годится, иначе — что в ней не так.
export function checkOperation(op) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return 'вместо записи там пусто или что-то другое';
  const fields = Object.hasOwn(FIELDS, op.type) ? FIELDS[op.type] : null;
  if (!fields) return `неизвестный вид операции «${op.type}»`;
  const known = new Set([...COMMON, ...fields.required, ...fields.optional]);
  const unknown = Object.keys(op).find((key) => !known.has(key));
  if (unknown !== undefined) return `лишнее поле «${unknown}»`;
  if (!isDate(op.date)) return `дата «${op.date}» не существует или не в формате ГГГГ-ММ-ДД`;
  if (op.coin !== null && (typeof op.coin !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(op.coin))) return 'код монеты записан не так, как бывает у источника цен';
  for (const name of [...COMMON.slice(3), ...fields.required.filter((field) => NAMES.has(field))]) {
    if (typeof op[name] !== 'string' || op[name].trim() === '') return `не указано поле «${name}»`;
  }
  // Какие из числовых полей обязательны, зависит от вида; остальные — если есть.
  const numbers = ['money', 'price', 'received', 'quantity', 'sent']
    .filter((field) => op[field] !== undefined || fields.required.includes(field));
  for (const field of numbers) {
    const value = parseAmount(op[field]);
    if (value === null) return `поле «${field}» — не число: «${op[field]}»`;
    if (value === 0n) return `поле «${field}» должно быть больше нуля`;
  }
  if (op.type === 'sell' && (op.quantity === undefined) === (op.money === undefined)) {
    return 'у продажи нужно указать либо количество, либо деньги';
  }
  if (op.type === 'sell' && op.quantity === undefined && op.price === undefined) return 'у продажи на сумму нет цены';
  if (op.type === 'transfer' && op.from === op.to) return 'перевод в тот же портфель';
  if (op.type === 'transfer' && parseAmount(op.received) > parseAmount(op.sent)) return 'получено больше, чем отправлено';
  return '';
}

// Вся история разом: каждая операция сама по себе и все вместе. Возвращает
// null, если всё хорошо, иначе { index, message } — номер операции (с нуля) и
// что с ней не так. Пустой список — это не ошибка.
export function checkHistory(operations) {
  if (!Array.isArray(operations)) return { index: null, message: 'вместо списка операций что-то другое' };
  for (const [index, op] of operations.entries()) {
    const problem = checkOperation(op);
    if (problem) return { index, message: problem };
  }
  const { errors } = calculate(operations);
  if (errors.length > 0) {
    // Расчёт останавливается на операции, с которой не сходится; при ошибке
    // по дате или без операции index не определён, но сюда они не доходят.
    return { index: operations.indexOf(errors[0].operation), message: errors[0].message.replace(/^Операция от [^:]*: /, '') };
  }
  return null;
}

function summarize(positions) {
  const portfolios = new Map();
  let quantity = 0n;
  let cost = 0n;
  for (const [name, p] of positions) {
    portfolios.set(name, withAverage(p.quantity, p.cost));
    quantity += p.quantity;
    cost += p.cost;
  }
  return { ...withAverage(quantity, cost), portfolios };
}

// У опустевшей позиции средней нет — не ноль, а отсутствие числа.
// Ноль выглядел бы как правдоподобная цена.
function withAverage(quantity, cost) {
  return { quantity, cost, average: quantity === 0n ? null : divide(cost * SCALE, quantity) };
}
