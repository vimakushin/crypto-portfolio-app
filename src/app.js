import { calculate, coinKey, formatAmount, formatSignificant, isDate, parseAmount, SCALE } from './calc.js';
import { fetchPrices, searchCoins } from './prices.js';

// Внесённое пока живёт, пока открыта страница: хранилище появится вместе
// с телеграмом, и последний портфель будет запоминаться там же.
const operations = [];
// Портфели и монеты в порядке использования: первый — самый свежий.
// Последний портфель стоит первым и уже выбран — чаще всего покупают туда же.
const portfolios = [];
// Монета — { id, symbol, name }. id — код в CoinGecko; у монеты, внесённой
// без связи, его нет (null), и она хранится под тем тикером, что вписал человек.
const coins = [];
let mode = 'buy';
let selectedCoin = null;
let foundCoins = [];
// Монету без выбора из списка можно записать без привязки в двух случаях:
// поиск именно этого текста не ответил (связи нет) или ответил, что такой
// монеты не знает (новые и мелкие токены попадают в справочник не сразу).
// Ответ «подождите» (busy) — связь есть, а поиск не закончен: не записываем.
let searchFailed = false;
let searchEmpty = false;
let searchBusy = false;
const canRecordUnbound = () => searchFailed || searchEmpty;
// Цена подставлена из CoinGecko, а не вписана человеком.
let priceAuto = false;
// Покупка — портфель, куда купили. Продажа и перевод — откуда; перевод — куда.
let selectedPortfolio = null;
let addingPortfolio = false;
let fromPortfolio = null;
let toPortfolio = null;
let addingTo = false;
// «Всё» и «Половина» вписывают в поле число, округлённое для глаз, а
// записывают точное: иначе после «продать всё» осталась бы пылинка или
// пришёл бы отказ «нет столько монет». Если человек поправил число руками,
// записывается то, что он вписал. Поле → { text, exact }.
const presets = new Map();
// «Получено» при переводе повторяет «отправлено», пока его не тронули.
let movedTouched = false;
// Последняя запись — её можно отменить: { operation }.
let last = null;

const form = document.getElementById('operation');
const input = {
  coin: document.getElementById('coin'),
  money: document.getElementById('money'),
  price: document.getElementById('price'),
  received: document.getElementById('received'),
  portfolio: document.getElementById('portfolio'),
  date: document.getElementById('date'),
  sold: document.getElementById('sold'),
  sent: document.getElementById('sent'),
  moved: document.getElementById('moved'),
  to: document.getElementById('to-new'),
};
const text = (id, value) => { document.getElementById(id).textContent = value; };

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Человек пишет как привык: «146,12», «1 000». Расчёт принимает «146.12».
function normalize(value) {
  return value.replace(/\s/g, '').replace(',', '.');
}

// «binance» и «Binance » — тот же портфель, что уже есть: второй портфель
// с похожим названием тихо разделил бы позицию на две со своими средними.
function portfolioName(value) {
  const name = value.trim().replace(/\s+/g, ' ');
  return portfolios.find((known) => known.toLowerCase() === name.toLowerCase()) ?? name;
}

const isAmount = (value) => (parseAmount(value) ?? 0n) > 0n;
// Количество — восемь знаков после точки, как на биржах; крошку меньше этого
// показываем по значащим цифрам, а не нулём: «0 монет» было бы неправдой.
const show = (units) => (units > 0n && formatAmount(units, 8) === '0' ? formatSignificant(units, 4) : formatAmount(units, 8));
const showPrice = (units) => formatSignificant(units, 6);
// Средняя изменилась на деле, а не на погрешность деления в 30-м знаке:
// настоящая разница — даже комиссия 10⁻⁸ монеты — на много порядков больше.
const changed = (before, after) => (after > before ? after - before : before - after) * 10n ** 15n > before;
const averageChange = (before, after) =>
  `${showPrice(before)} → ${showPrice(after)} $ (${after > before ? '+' : '−'}${percent(after > before ? after - before : before - after, before)})`;
const showDate = (date) => date.split('-').reverse().join('.');

const sameCoin = (a, b) => a.id === b.id && (a.id !== null || a.symbol === b.symbol);
const keyOf = (coin) => coinKey({ coin: coin.id, symbol: coin.symbol });

// --- Что сейчас лежит ---
// Всё берётся из расчёта по внесённым операциям: продать и перевести можно
// только то, что расчёт видит в портфеле.

const position = (coin) => calculate(operations).coins.get(keyOf(coin));
const heldIn = (coin, portfolio) => position(coin)?.portfolios.get(portfolio)?.quantity ?? 0n;
const heldCoins = () => coins.filter((coin) => (position(coin)?.quantity ?? 0n) > 0n);
function heldPortfolios(coin) {
  const found = position(coin);
  return found ? [...found.portfolios].filter(([, p]) => p.quantity > 0n).map(([name]) => name) : [];
}

// Если монета лежит в одном портфеле, он выбран сразу.
function pickFrom() {
  const where = selectedCoin === null ? [] : heldPortfolios(selectedCoin);
  fromPortfolio = where.length === 1 ? where[0] : where.includes(fromPortfolio) ? fromPortfolio : null;
  if (toPortfolio === fromPortfolio) toPortfolio = null;
}

// --- Количество ---

// Количество покупки считает сам расчёт, по той же операции, что будет
// записана: подсказки и то, что попадёт в портфель, не могут разойтись.
// null — расчёт отказался: получено больше, чем куплено.
function quantityOf(money, price, received = '') {
  const op = { type: 'buy', date: today(), coin: '-', portfolio: '-', money, price };
  if (received) op.received = received;
  return calculate([op]).coins.get('-')?.quantity ?? null;
}

function amountOf(field) {
  const preset = presets.get(field);
  return preset && preset.text === field.value ? preset.exact : normalize(field.value);
}

function setPreset(field, units) {
  const shown = show(units);
  presets.set(field, { text: shown, exact: formatAmount(units, 30) });
  field.value = shown;
}

function clearPresets() {
  for (const [field, preset] of presets) if (field.value === preset.text) field.value = '';
  presets.clear();
  if (!movedTouched) input.moved.value = input.sent.value;
}

// «Получено» при переводе: если его не трогали — столько же, сколько отправлено.
const movedValue = () => (movedTouched && input.moved.value.trim() ? normalize(input.moved.value) : amountOf(input.sent));

// Подсказки под полями. Покупка: сколько монет выходит, а если вписано
// полученное — комиссия в монетах и процентах: опечатка вроде 0.1368 вместо
// 1.368 видна сразу как «комиссия 90%». Продажа и перевод: сколько лежит в
// портфеле. Перевод: комиссия сети, если «получено» меньше «отправлено».
function showHints() {
  const symbol = selectedCoin?.symbol ?? (input.coin.value.trim().toUpperCase() || 'монет');
  let quantity = '';
  let fee = '';
  const money = normalize(input.money.value);
  const price = normalize(input.price.value);
  const received = normalize(input.received.value);
  if (mode === 'buy' && isAmount(money) && isAmount(price)) {
    const bought = quantityOf(money, price);
    const got = isAmount(received) ? quantityOf(money, price, received) : undefined;
    if (got === undefined) quantity = `Количество: ${show(bought)} ${symbol}`;
    else if (got === null) fee = `Больше, чем ${show(bought)} ${symbol} по этой цене`;
    else fee = `Комиссия биржи: ${show(bought - got)} ${symbol} (${percent(bought - got, bought)})`;
  }
  text('quantity', quantity);
  text('fee', fee);

  const have = selectedCoin !== null && fromPortfolio !== null
    ? `В ${fromPortfolio}: ${show(heldIn(selectedCoin, fromPortfolio))} ${symbol}` : '';
  text('sold-have', mode === 'sell' ? have : '');
  text('sent-have', mode === 'transfer' ? have : '');

  let networkFee = '';
  const sent = parseAmount(amountOf(input.sent));
  const got = parseAmount(movedValue());
  if (mode === 'transfer' && movedTouched && sent > 0n && got > 0n && got !== sent) {
    networkFee = got > sent ? 'Получено больше, чем отправлено'
      : `Комиссия сети: ${show(sent - got)} ${symbol} (${percent(sent - got, sent)})`;
  }
  text('moved-fee', networkFee);
  // Подставленное «получено» бледнее набранного: видно, что это не ввод человека.
  input.moved.classList.toggle('mirrored', !movedTouched);
}

// По значащим цифрам: рост средней на 0.0004% не должен выглядеть как «0%».
const percent = (part, whole) => `${formatSignificant(part * 100n * SCALE / whole, 4)}%`;

function moveToFront(list, item, same = (a, b) => a === b) {
  const index = list.findIndex((known) => same(known, item));
  if (index !== -1) list.splice(index, 1);
  list.unshift(item);
}

function chip(label, pressed, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.textContent = label;
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

// --- Вид операции ---

const titles = { buy: 'покупку', sell: 'продажу', transfer: 'перевод' };

// Каждая вкладка помнит свой выбор: заглянул в «Продажу» посреди покупки и
// вернулся — монета и портфели на месте. Набранные числа живут в своих полях
// и тоже остаются.
const remembered = { buy: {}, sell: {}, transfer: {} };

function setMode(next) {
  remembered[mode] = { coin: selectedCoin, from: fromPortfolio, to: toPortfolio };
  const previousCoin = selectedCoin;
  mode = next;
  ({ coin: selectedCoin = null, from: fromPortfolio = null, to: toPortfolio = null } = remembered[mode]);
  for (const element of document.querySelectorAll('[data-modes]')) {
    element.hidden = !element.dataset.modes.split(' ').includes(mode);
  }
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  text('submit', `Записать ${titles[mode]}`);
  // Подтверждение прошлой записи под другой вкладкой читается как результат
  // того, что вносишь сейчас, а «Отменить» рядом с ним отменило бы не то.
  say('');
  text('from-label', mode === 'transfer' ? 'Откуда' : 'Портфель');
  input.price.placeholder = mode === 'sell' ? 'По какой цене продали' : 'По какой цене купили';
  for (const element of form.querySelectorAll('.error')) element.textContent = '';
  for (const field of Object.values(input)) field.removeAttribute('aria-invalid');
  sanitize();
  // Цена общая у покупки и продажи. Другая монета — другая цена: ни
  // подставленная, ни вписанная руками на неё не переезжает.
  if (selectedCoin !== previousCoin) {
    input.price.value = '';
    priceAuto = false;
  }
  render();
  if (selectedCoin !== null) fillPrice();
  else text('price-source', '');
}

// Выбор, который больше не верен, сбрасывается: продать и перевести можно
// только то, что лежит, а портфель или монета могли исчезнуть после отмены.
// Без этого запись тихо ушла бы в портфель, которого на экране нет.
function sanitize() {
  if (mode !== 'buy' && selectedCoin !== null && !heldCoins().some((coin) => sameCoin(coin, selectedCoin))) {
    selectedCoin = null;
  }
  if (!portfolios.includes(toPortfolio)) toPortfolio = null;
  if (!portfolios.includes(selectedPortfolio)) selectedPortfolio = portfolios[0] ?? null;
  pickFrom();
  if (mode === 'buy') {
    // Текст в поле без выбранной монеты — снова ищем, иначе человек упрётся
    // в «выберите из списка» без списка.
    if (selectedCoin !== null) input.coin.value = selectedCoin.symbol;
    else if (input.coin.value.trim()) searchLater();
  }
}

// --- Монета ---

// Покупка: монета из поиска или из недавних.
function selectCoin(coin) {
  clearTimeout(searchTimer);
  selectedCoin = coin;
  foundCoins = [];
  input.coin.value = coin.symbol;
  setError('coin', '');
  render();
  fillPrice();
  input.money.focus();
}

// Продажа и перевод: монета из тех, что лежат.
function selectHeld(coin) {
  selectedCoin = coin;
  clearPresets();
  setError('coin', '');
  pickFrom();
  render();
  fillPrice();
  if (fromPortfolio !== null) (mode === 'sell' ? input.sold : input.sent).focus();
}

// Две разные монеты с одним тикером на кнопках подписаны названием, иначе
// их не отличить.
function coinLabel(coin) {
  if (coin.id === null) return `${coin.symbol} (уточнить)`;
  const twins = coins.filter((known) => known.symbol === coin.symbol && known.id !== null);
  return twins.length > 1 ? `${coin.symbol} · ${coin.name}` : coin.symbol;
}

function renderCoins() {
  const pressed = (coin) => selectedCoin !== null && sameCoin(coin, selectedCoin);
  document.getElementById('coins').replaceChildren(...coins.map((coin) =>
    chip(coinLabel(coin), pressed(coin), () => selectCoin(coin))));
  const held = heldCoins();
  document.getElementById('held').replaceChildren(...held.map((coin) =>
    chip(coinLabel(coin), pressed(coin), () => selectHeld(coin))));
  text('held-empty', held.length > 0 ? ''
    : mode === 'sell' ? 'Продавать пока нечего — сначала внесите покупку'
    : 'Переводить пока нечего — сначала внесите покупку');
  // Поиск находит и похожие монеты: на «PEPE2» — PEPE. Если своей в списке
  // нет, человек явно выбирает «записать без цены», иначе пришлось бы
  // записать чужую монету.
  const typed = input.coin.value.trim().toUpperCase();
  const notListed = foundCoins.length > 0 && selectedCoin === null
    ? [chip(`Нет в списке — записать «${typed}» без цены`, false, () => selectCoin({ id: null, symbol: typed, name: '' }))]
    : [];
  document.getElementById('found').replaceChildren(...foundCoins.map((coin) =>
    chip(`${coin.symbol} · ${coin.name}`, false, () => selectCoin(coin))), ...notListed);
  text('coin-name', selectedCoin === null ? ''
    : selectedCoin.id !== null ? selectedCoin.name
    : mode === 'transfer' ? 'Монета без текущей цены'
    : 'Текущей цены по этой монете нет — впишите цену сами. Какая это монета, спросим, когда найдём её в CoinGecko');
  text('coin-offline', searchBusy && selectedCoin === null
    ? 'CoinGecko просит подождать — попробуйте через минуту'
    : searchFailed && selectedCoin === null && input.coin.value.trim()
    ? `Нет связи. Запишем как «${typed}», а какая это монета — спросим, когда связь появится`
    : searchEmpty && selectedCoin === null
    ? `CoinGecko не знает такую монету. Запишем как «${typed}» без текущей цены — когда она появится в справочнике, спросим, какая это`
    : '');
}

// Ищем, когда человек перестал печатать, а не на каждую букву: так
// поиск монеты стоит один-два запроса, а не десяток.
let searchTimer;
function searchLater() {
  clearTimeout(searchTimer);
  const query = input.coin.value.trim();
  if (!query) {
    foundCoins = [];
    renderCoins();
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const found = await searchCoins(query);
      if (input.coin.value.trim() !== query) return;
      foundCoins = found;
      searchEmpty = found.length === 0;
      // Связь есть — самое время спросить про монеты, внесённые без неё.
      // Один раз, а не после каждого поиска: каждое предложение — это запросы.
      // Для монет, которых нет в справочнике, предложений не бывает, и блок
      // пуст всегда — поэтому ещё и не чаще раза в минуту.
      if (coins.some((coin) => coin.id === null) && !document.getElementById('unbound').hasChildNodes()
        && Date.now() - bindingAskedAt > 60_000) offerBinding();
    } catch (error) {
      if (input.coin.value.trim() !== query) return;
      foundCoins = [];
      searchBusy = error.busy === true;
      searchFailed = !searchBusy;
    }
    renderCoins();
  }, 400);
}

// --- Цена ---

// Цену подставляем текущую, человек соглашается или правит. Вписанную
// человеком цену не трогаем; не удалось получить — пусто и честная подпись,
// а не старое число. У перевода цены нет.
async function fillPrice() {
  if (priceAuto) input.price.value = '';
  priceAuto = false;
  const coin = selectedCoin;
  if (mode === 'transfer' || coin.id === null) {
    text('price-source', '');
    showHints();
    return;
  }
  // Цены на прошлые даты у нас нет, а сегодняшняя в старой сделке тихо
  // испортила бы среднюю.
  if (input.date.value !== today()) {
    text('price-source', 'Для прошлой даты впишите цену сделки');
    showHints();
    return;
  }
  text('price-source', 'Получаю текущую цену…');
  try {
    const price = (await fetchPrices([coin.id])).get(coin.id);
    if (selectedCoin !== coin || input.date.value !== today() || mode === 'transfer') return;
    if (price === undefined) {
      text('price-source', 'CoinGecko не знает цену этой монеты — впишите цену сделки');
    } else if (input.price.value === '') {
      input.price.value = price;
      priceAuto = true;
      setError('price', '');
      text('price-source', 'Текущая цена по CoinGecko — поправьте, если в сделке была другая');
    } else {
      text('price-source', '');
    }
  } catch {
    if (selectedCoin === coin) text('price-source', 'Текущую цену получить не удалось — впишите цену сделки');
  }
  showHints();
}

// --- Монеты без привязки к CoinGecko ---

// Внесённые без связи или неизвестные справочнику. Когда поиск по их
// названию что-то находит, просим выбрать, какая это монета. Угадывать по
// тикеру нельзя: у SOL одиннадцать разных монет. Если не нашлось ничего,
// не предлагаем ничего — монета так и живёт без текущей цены.
// Предложения могут запрашиваться несколько раз подряд; рисует только
// последний запуск, иначе поздний ответ показал бы уже привязанную монету.
let bindingRun = 0;
let bindingAskedAt = 0;
async function offerBinding() {
  const run = ++bindingRun;
  bindingAskedAt = Date.now();
  const offers = [];
  for (const coin of coins.filter((known) => known.id === null)) {
    try {
      const found = await searchCoins(coin.symbol);
      if (found.length > 0) offers.push({ coin, found });
    } catch {
      return;
    }
  }
  if (run !== bindingRun) return;
  document.getElementById('unbound').replaceChildren(...offers.map(({ coin, found }) => {
    const item = document.createElement('div');
    item.className = 'notice';
    const title = document.createElement('p');
    title.textContent = `«${coin.symbol}» записана без текущей цены. Если это одна из этих монет — выберите её:`;
    const choices = document.createElement('div');
    choices.className = 'chips';
    choices.replaceChildren(...found.map((match) => chip(`${match.symbol} · ${match.name}`, false, () => bind(coin, match))));
    item.replaceChildren(title, choices);
    return item;
  }));
}

function bind(unbound, coin) {
  if (!coins.includes(unbound)) return;
  for (const op of operations) {
    if (op.coin === null && op.symbol === unbound.symbol) {
      op.coin = coin.id;
      op.symbol = coin.symbol;
    }
  }
  coins.splice(coins.indexOf(unbound), 1);
  if (!coins.some((known) => sameCoin(known, coin))) coins.push(coin);
  if (selectedCoin === unbound) {
    selectedCoin = coin;
    if (mode === 'buy') input.coin.value = coin.symbol;
    fillPrice();
  }
  render();
  offerBinding();
  // Привязка не отнимает отмену последней записи.
  say(`«${unbound.symbol}» привязана: ${coin.symbol} · ${coin.name}`, last?.operation ?? null);
}

// --- Портфели ---

function renderPortfolios() {
  // Покупка. Пока портфелей нет, выбирать не из чего — сразу поле для названия.
  const typing = addingPortfolio || portfolios.length === 0;
  input.portfolio.hidden = !typing;
  const chips = portfolios.map((name) => chip(name, !typing && name === selectedPortfolio, () => {
    selectedPortfolio = name;
    addingPortfolio = false;
    setError('portfolio', '');
    renderPortfolios();
  }));
  if (portfolios.length > 0) {
    chips.push(chip('+ Новый портфель', addingPortfolio, () => {
      addingPortfolio = true;
      renderPortfolios();
      input.portfolio.focus();
    }));
  }
  document.getElementById('portfolios').replaceChildren(...chips);

  // Продажа и перевод: откуда — только портфели, где монета лежит.
  const where = selectedCoin === null ? [] : heldPortfolios(selectedCoin);
  document.getElementById('from').replaceChildren(...where.map((name) => chip(name, name === fromPortfolio, () => {
    if (name !== fromPortfolio) clearPresets();
    fromPortfolio = name;
    if (toPortfolio === name) toPortfolio = null;
    setError('from', '');
    render();
    (mode === 'sell' ? input.sold : input.sent).focus();
  })));

  // Перевод: куда — любой другой портфель или новый.
  const others = portfolios.filter((name) => name !== fromPortfolio);
  const typingTo = addingTo || others.length === 0;
  input.to.hidden = !typingTo;
  const targets = others.map((name) => chip(name, !typingTo && name === toPortfolio, () => {
    toPortfolio = name;
    addingTo = false;
    setError('to', '');
    renderPortfolios();
  }));
  if (others.length > 0) {
    targets.push(chip('+ Новый портфель', addingTo, () => {
      addingTo = true;
      renderPortfolios();
      input.to.focus();
    }));
  }
  document.getElementById('to').replaceChildren(...targets);
}

function render() {
  renderCoins();
  renderPortfolios();
  showHints();
}

// --- Запись ---

function setError(name, message) {
  text(`${name}-error`, message);
  input[name]?.setAttribute('aria-invalid', String(message !== ''));
}

// Подтверждение записи. Отменить можно только последнюю запись — и только
// пока на экране её подтверждение.
function say(message, operation = null) {
  text('status', message);
  last = operation === null ? null : { operation };
  document.getElementById('undo').hidden = last === null;
}

const coinOf = (op) => coins.find((coin) => keyOf(coin) === coinKey(op));

// Каждая операция — покупка, продажа, перевод — собирается из полей своей
// функцией: { problems, operation, describe }. describe(before, after)
// пишет подтверждение по позиции монеты до и после записи.

function readBuy(date) {
  const typed = input.coin.value.trim().toUpperCase();
  // Монету без выбора из списка принимаем только без связи или когда
  // справочник её не знает — и тогда без привязки. Иначе это было бы
  // определение монеты по тикеру.
  const coin = selectedCoin ?? (typed && canRecordUnbound() ? { id: null, symbol: typed, name: '' } : null);
  const money = normalize(input.money.value);
  const price = normalize(input.price.value);
  const received = normalize(input.received.value);
  const portfolio = input.portfolio.hidden ? selectedPortfolio : portfolioName(input.portfolio.value);
  const problems = {
    coin: coin ? '' : typed ? 'Выберите монету из списка под полем' : 'Укажите монету',
    money: isAmount(money) ? '' : 'Нужно число больше нуля, например 200',
    price: isAmount(price) ? '' : 'Нужно число больше нуля, например 146.12',
    received: !received ? ''
      : !isAmount(received) ? 'Нужно число больше нуля — или оставьте пустым'
      : isAmount(money) && isAmount(price) && quantityOf(money, price, received) === null
        ? 'Получено больше, чем потрачено ÷ цена. Проверьте цену и количество' : '',
    portfolio: portfolio ? '' : 'Укажите, где лежит монета',
  };
  if (Object.values(problems).some(Boolean)) return { problems };
  const operation = { type: 'buy', date, coin: coin.id, symbol: coin.symbol, portfolio, money, price };
  if (received) operation.received = received;
  const auto = priceAuto;
  return {
    problems,
    coin,
    operation,
    describe: () => `Записано: ${show(quantityOf(money, price, received))} ${coin.symbol} за ${money} $ по ${price} $` +
      (auto ? ' (текущая по CoinGecko)' : '') + ` — ${portfolio}, ${showDate(date)}` +
      (coin.id === null ? '. Без текущей цены: какая это монета, спросим, когда найдём её в CoinGecko' : ''),
  };
}

function readSell(date) {
  const coin = selectedCoin;
  const sold = amountOf(input.sold);
  const price = normalize(input.price.value);
  const have = coin !== null && fromPortfolio !== null ? heldIn(coin, fromPortfolio) : 0n;
  const problems = {
    coin: coin ? '' : 'Выберите монету',
    from: fromPortfolio ? '' : 'Выберите портфель, откуда продали',
    sold: !isAmount(sold) ? 'Нужно число больше нуля, например 0.5'
      : coin && fromPortfolio && parseAmount(sold) > have ? `В ${fromPortfolio} только ${show(have)} ${coin.symbol}` : '',
    price: isAmount(price) ? '' : 'Нужно число больше нуля, например 146.12',
  };
  if (Object.values(problems).some(Boolean)) return { problems };
  const from = fromPortfolio;
  const auto = priceAuto;
  return {
    problems,
    coin,
    operation: { type: 'sell', date, coin: coin.id, symbol: coin.symbol, portfolio: from, quantity: sold, price },
    describe: (before, after) => {
      const wasAverage = before.portfolios.get(from).average;
      const left = after.portfolios.get(from);
      // По строке на мысль: что сделано, что в этом портфеле, что всего.
      // Объяснение — рядом с числом, а не в конце абзаца: продал, а общая
      // средняя выросла — без объяснения это выглядит как ошибка. Процента
      // здесь нет: рядом со словом «продано» его читают как прибыль.
      const lines = [`Продано ${show(parseAmount(sold))} ${coin.symbol} из ${from} по ${price} $` +
        (auto ? ' (текущая по CoinGecko)' : '') + `, ${showDate(date)}.`];
      lines.push(left.quantity === 0n ? `В ${from} ${coin.symbol} больше нет.`
        : `В ${from} осталось ${show(left.quantity)} ${coin.symbol}, средняя там прежняя: ${showPrice(wasAverage)} $.`);
      if (after.quantity > 0n) {
        // Общая средняя может сдвинуться: изменилось, сколько монет в каком портфеле.
        lines.push(`Всего ${coin.symbol}: ${show(after.quantity)}. Средняя по всем портфелям ` + (changed(before.average, after.average)
          ? `${showPrice(before.average)} → ${showPrice(after.average)} $: монет стало меньше там, где они куплены по ${showPrice(wasAverage)} $, а в других портфелях они куплены по другой цене.`
          : `не изменилась: ${showPrice(after.average)} $.`));
      }
      return lines.join('\n');
    },
  };
}

function readTransfer(date) {
  const coin = selectedCoin;
  const sent = amountOf(input.sent);
  const received = movedValue();
  const to = input.to.hidden ? toPortfolio : portfolioName(input.to.value);
  const have = coin !== null && fromPortfolio !== null ? heldIn(coin, fromPortfolio) : 0n;
  const problems = {
    coin: coin ? '' : 'Выберите монету',
    from: fromPortfolio ? '' : 'Выберите, откуда перевели',
    to: !to ? 'Укажите, куда перевели' : to === fromPortfolio ? 'Это тот же портфель' : '',
    sent: !isAmount(sent) ? 'Нужно число больше нуля, например 0.5'
      : coin && fromPortfolio && parseAmount(sent) > have ? `В ${fromPortfolio} только ${show(have)} ${coin.symbol}` : '',
    moved: !isAmount(received) ? 'Нужно число больше нуля, например 0.495'
      : isAmount(sent) && parseAmount(received) > parseAmount(sent) ? 'Получено больше, чем отправлено' : '',
  };
  if (Object.values(problems).some(Boolean)) return { problems };
  const from = fromPortfolio;
  return {
    problems,
    coin,
    operation: { type: 'transfer', date, coin: coin.id, symbol: coin.symbol, from, to, sent, received },
    describe: (before, after) => {
      const fee = parseAmount(sent) - parseAmount(received);
      // Перевод — не сделка: без комиссии общая средняя та же, с комиссией —
      // выше, потому что те же деньги теперь на меньшем числе монет.
      return [
        `Переведено ${show(parseAmount(sent))} ${coin.symbol}: ${from} → ${to}, ${showDate(date)}` +
          (fee > 0n ? `, получено ${show(parseAmount(received))}` : '') + '.',
        !changed(before.average, after.average)
          ? `Средняя ${coin.symbol} по всем портфелям не изменилась: ${showPrice(after.average)} $.`
          : `Средняя ${coin.symbol} по всем портфелям ${averageChange(before.average, after.average)}: сеть взяла ${show(fee)} ${coin.symbol}, а заплачено за них по-прежнему — те же деньги на меньшем числе монет.`,
      ].join('\n');
    },
  };
}

// Перед записью операцию проверяет расчёт вместе со всеми остальными.
// Внесённая задним числом продажа может оставить без монет более поздний
// перевод — такую запись не принимаем и говорим, что она ломает.
function brokenBy(operation) {
  const key = coinKey(operation);
  const error = calculate([...operations, operation]).errors.find((found) => found.coin === key);
  if (!error) return '';
  if (error.operation !== operation) return `Эта запись ломает более позднюю операцию — ${error.message}`;
  // Текущий остаток форма уже проверила; раз расчёт всё же отказал — значит,
  // на дату записи монет было меньше.
  return /нет столько монет/.test(error.message)
    ? `На ${showDate(operation.date)} в портфеле столько ${operation.symbol} ещё не было`
    : error.message;
}

// Коротко, что это была за запись, — для сообщения об отмене.
function shortName(op) {
  if (op.type === 'buy') return `покупка ${op.symbol} на ${op.money} $ в ${op.portfolio}`;
  if (op.type === 'sell') return `продажа ${show(parseAmount(op.quantity))} ${op.symbol} из ${op.portfolio}`;
  return `перевод ${show(parseAmount(op.sent))} ${op.symbol}: ${op.from} → ${op.to}`;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  // Недонабранную дату поле отдаёт пустой; молча подставить сегодняшнюю
  // значило бы записать не ту дату, что человек вводил.
  const date = input.date.value;
  const read = { buy: readBuy, sell: readSell, transfer: readTransfer }[mode](date);
  const problems = {
    ...read.problems,
    date: !isDate(date) ? 'Укажите дату полностью' : date > today() ? 'Дата ещё не наступила' : '',
  };
  for (const [name, message] of Object.entries(problems)) setError(name, message);
  text('record-error', '');
  const firstProblem = Object.keys(problems).find((name) => problems[name]);
  // Подтверждение прошлой записи с кнопкой «Отменить» остаётся: ошибка в
  // новой записи не повод терять отмену прошлой.
  if (firstProblem) {
    const field = input[firstProblem];
    if (field && !field.hidden) field.focus();
    else document.getElementById(`${firstProblem}-error`).scrollIntoView({ block: 'center' });
    return;
  }
  const broken = brokenBy(read.operation);
  if (broken) {
    text('record-error', broken);
    return;
  }

  const coin = read.coin;
  const before = position(coin);
  operations.push(read.operation);
  moveToFront(coins, coin, sameCoin);
  if (mode === 'buy') {
    moveToFront(portfolios, read.operation.portfolio);
    selectedPortfolio = read.operation.portfolio;
    addingPortfolio = false;
  }
  if (mode === 'transfer' && !portfolios.includes(read.operation.to)) portfolios.push(read.operation.to);
  say(read.describe(before, position(coin)), read.operation);

  // Дата возвращается к сегодняшней: иначе после одной старой записи
  // следующая, сегодняшняя, молча ушла бы задним числом.
  clearPresets();
  for (const field of [input.money, input.price, input.received, input.portfolio, input.sold, input.sent, input.moved, input.to]) {
    field.value = '';
  }
  movedTouched = false;
  addingTo = false;
  toPortfolio = null;
  input.date.value = today();
  priceAuto = false;
  document.activeElement.blur();
  // Монета остаётся выбранной, и цена для следующей записи подставляется
  // заново — за минуту она могла измениться. Если продали всё, монеты
  // больше нет среди тех, что можно продать.
  selectedCoin = mode !== 'buy' && (position(coin)?.quantity ?? 0n) === 0n ? null : coin;
  if (mode === 'buy') input.coin.value = coin.symbol;
  pickFrom();
  render();
  if (selectedCoin !== null) fillPrice();
  else text('price-source', '');
  if (coin.id === null && mode === 'buy') offerBinding();
});

// Отмена последней записи. Безопасна всегда: возвращает к состоянию, которое
// уже было проверено расчётом.
document.getElementById('undo').addEventListener('click', () => {
  const index = operations.indexOf(last?.operation);
  if (index === -1) return;
  const { operation } = last;
  operations.splice(index, 1);
  // Монета без цены, у которой не осталось записей, из списка уходит.
  // Выбранной она тоже перестаёт быть — и здесь, и в запомненных вкладках.
  for (const coin of coins.filter((known) => known.id === null && !operations.some((op) => coinOf(op) === known))) {
    coins.splice(coins.indexOf(coin), 1);
    if (selectedCoin !== null && sameCoin(selectedCoin, coin)) selectedCoin = null;
    for (const choice of Object.values(remembered)) {
      if (choice.coin && sameCoin(choice.coin, coin)) choice.coin = null;
    }
  }
  // И портфель, заведённый этой записью, — тоже.
  const used = new Set(operations.flatMap((op) => [op.portfolio, op.from, op.to]));
  for (const name of portfolios.filter((known) => !used.has(known))) portfolios.splice(portfolios.indexOf(name), 1);
  const previousCoin = selectedCoin;
  sanitize();
  if (selectedCoin !== previousCoin && priceAuto) {
    input.price.value = '';
    priceAuto = false;
    text('price-source', '');
  }
  render();
  say(`Отменено: ${shortName(operation)}, ${showDate(operation.date)}`);
});

// Enter в поле монеты без выбора из списка не уводит дальше: монету нужно
// выбрать, а узнать об этом в конце, после «Записать», — лишний круг.
input.coin.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || selectedCoin !== null || canRecordUnbound() || !input.coin.value.trim()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setError('coin', 'Выберите монету из списка под полем');
});

// Enter на клавиатуре телефона ведёт к следующему полю, а в цене — записывает:
// «получено» нужно редко и не должно стоять на пути обычной записи.
for (const [from, to] of [[input.coin, input.money], [input.money, input.price], [input.sold, input.price]]) {
  from.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    to.focus();
  });
}

for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => { if (button.dataset.mode !== mode) setMode(button.dataset.mode); });
}

// «Всё» и «Половина» — от того, что лежит в выбранном портфеле.
for (const button of document.querySelectorAll('[data-fill]')) {
  button.addEventListener('click', () => {
    const name = button.dataset.fill;
    if (selectedCoin === null || fromPortfolio === null) {
      setError(name, 'Сначала выберите монету и портфель');
      return;
    }
    const have = heldIn(selectedCoin, fromPortfolio);
    setPreset(input[name], button.dataset.part === 'all' ? have : have / 2n);
    setError(name, '');
    if (name === 'sent' && !movedTouched) input.moved.value = input.sent.value;
    showHints();
  });
}

// Подставленную цену удобно заменить целиком: она выделяется при входе в поле.
input.price.addEventListener('focus', () => { if (priceAuto) input.price.select(); });

// Исправляемое поле перестаёт быть красным сразу, а не после следующей записи.
for (const name of ['coin', 'money', 'price', 'received', 'portfolio', 'date', 'sold', 'sent', 'moved', 'to']) {
  input[name].addEventListener('input', () => {
    setError(name, '');
    text('record-error', '');
  });
}
input.coin.addEventListener('input', () => {
  selectedCoin = null;
  // Результаты прежнего текста — неправда про новый, а кнопка «нет в списке»
  // при них позволила бы записать без цены монету, которая в справочнике есть.
  foundCoins = [];
  searchFailed = false;
  searchEmpty = false;
  searchBusy = false;
  // Подставленная цена была ценой прежней монеты — с новой ей не место.
  // Подпись под ценой тоже про прежнюю монету, даже если цена ещё не пришла.
  if (priceAuto) {
    input.price.value = '';
    priceAuto = false;
  }
  text('price-source', '');
  searchLater();
  renderCoins();
  showHints();
});
input.money.addEventListener('input', showHints);
input.price.addEventListener('input', () => {
  priceAuto = false;
  text('price-source', '');
  showHints();
});
input.received.addEventListener('input', showHints);
input.sold.addEventListener('input', showHints);
input.sent.addEventListener('input', () => {
  if (!movedTouched) input.moved.value = input.sent.value;
  showHints();
});
input.moved.addEventListener('input', () => {
  // Стёрли — снова «столько же, сколько отправлено».
  movedTouched = input.moved.value.trim() !== '';
  showHints();
});
input.date.addEventListener('input', () => { if (selectedCoin !== null) fillPrice(); });
window.addEventListener('online', offerBinding);

// Календарь на телефоне не даст выбрать будущий день.
input.date.max = today();
input.date.value = today();
setMode('buy');
