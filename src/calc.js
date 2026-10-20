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
function divide(a, b) {
  return (2n * a + b) / (2n * b);
}

// --- Расчёт ---

// Возвращает { coins, errors }.
// coins — Map: монета → { quantity, cost, average, portfolios },
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
    if (!byCoin.has(op.coin)) byCoin.set(op.coin, []);
    byCoin.get(op.coin).push(op);
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

// Дата ГГГГ-ММ-ДД, которая есть в календаре.
function isDate(text) {
  const parsed = new Date(`${text}T00:00:00Z`);
  return typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text)
    && !isNaN(parsed) && parsed.toISOString().slice(0, 10) === text;
}

// Ошибка помнит операцию, чтобы экран мог показать, какая именно строка
// мешает, а не только дату и монету.
function fail(op, text) {
  throw Object.assign(new Error(`Операция от ${op.date} (${op.coin}): ${text}`), { operation: op });
}

function apply(portfolios, op) {
  // Операции приходят и из загруженного файла, где поле может потеряться:
  // без этой проверки появился бы портфель «undefined» со своей средней.
  const names = op.type === 'transfer' ? [op.coin, op.from, op.to] : [op.coin, op.portfolio];
  if (!names.every((name) => typeof name === 'string' && name !== '')) {
    fail(op, 'не указана монета или портфель');
  }

  if (op.type === 'buy') {
    const money = amount(op, 'money');
    const price = amount(op, 'price');
    const p = position(portfolios, op.portfolio);
    // Количество не вводится, а считается: человек помнит «закинул 200
    // долларов», а не «купил 1.3687 SOL».
    p.quantity += divide(money * SCALE, price);
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
function amount(op, field) {
  const text = op[field];
  const match = typeof text === 'string' && /^(\d+)(?:\.(\d{1,30}))?$/.exec(text);
  if (!match) fail(op, `поле ${field} — не число: «${text}»`);
  const value = BigInt(match[1] + (match[2] ?? '').padEnd(30, '0'));
  if (value === 0n) fail(op, `поле ${field} должно быть больше нуля`);
  return value;
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
