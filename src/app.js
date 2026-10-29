import { calculate, checkHistory, coinKey, formatAmount, formatSignificant, isDate, parseAmount, SCALE } from './calc.js';
import { coinDetail, history, overview, removalCheck } from './overview.js';
import { fetchPrices, searchCoins } from './prices.js';
import { createStore, makeExport, pickBackend, readExport, readPasted } from './storage.js';
import { insideTelegram, loadTelegram, telegramReady } from './telegram.js';

// Внесённые операции. Сохраняются после каждого изменения (см. «Хранение»
// в конце файла); списки портфелей и монет ниже из них восстанавливаются.
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
  text('from-label', mode === 'transfer' ? 'Откуда' : 'Портфель — биржа или кошелёк');
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

// Другая монета — другая цена: ни подставленная, ни вписанная руками на неё
// не переезжает. Иначе чужая цена попала бы в учёт под видом цены этой монеты,
// а поле, занятое чужим числом, ещё и не дало бы подставить настоящую.
function dropPrice() {
  input.price.value = '';
  priceAuto = false;
  input.price.classList.remove('mirrored');
}

// Покупка: монета из поиска или из недавних.
function selectCoin(coin) {
  clearTimeout(searchTimer);
  if (selectedCoin !== null && !sameCoin(selectedCoin, coin)) dropPrice();
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
  if (selectedCoin !== null && !sameCoin(selectedCoin, coin)) dropPrice();
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
    ? 'CoinGecko просит подождать. Поиск повторится сам примерно через минуту'
    : searchFailed && selectedCoin === null && input.coin.value.trim()
    ? `Нет связи. Запишем как «${typed}», а какая это монета — спросим, когда связь появится`
    : searchEmpty && selectedCoin === null
    ? `CoinGecko не знает такую монету. Запишем как «${typed}» без текущей цены — когда она появится в справочнике, спросим, какая это`
    : '');
}

// Ищем, когда человек перестал печатать, а не на каждую букву. У CoinGecko
// без ключа 5–15 запросов в минуту, и при наборе по знаку в 0,6 секунды
// «solana» без этого стоило шесть запросов. Меньше двух знаков не ищем:
// поиск по одной букве ничего полезного не даёт. Отказ (429) не конец:
// подождав минуту, поиск повторяется сам, если человек всё ещё на этом слове.
let searchTimer;
function searchLater(delay = 700) {
  clearTimeout(searchTimer);
  const query = input.coin.value.trim();
  if (query.length < 2) {
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
      searchBusy = false;
      searchFailed = false;
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
      if (searchBusy) searchLater(error.retryIn ?? 60_000);
    }
    renderCoins();
  }, delay);
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
  text('price-source', 'Получаю цену…');
  try {
    const price = (await fetchPrices([coin.id])).get(coin.id);
    if (selectedCoin !== coin || input.date.value !== today() || mode === 'transfer') return;
    if (price === undefined) {
      text('price-source', 'Цены этой монеты нет — впишите цену сделки');
    } else if (input.price.value === '') {
      input.price.value = price;
      priceAuto = true;
      input.price.classList.add('mirrored');
      setError('price', '');
      text('price-source', 'Текущая цена. Исправьте, если была другая');
    } else {
      text('price-source', '');
    }
  } catch (error) {
    if (selectedCoin === coin) text('price-source', error.busy ? 'CoinGecko просит подождать — впишите цену' : 'Цену получить не удалось — впишите свою');
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
  persist();
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
  if (message) byId('status').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        // «По всем портфелям» — только когда монета лежит больше чем в одном: иначе «по всем чего».
        const holders = [...after.portfolios.values()].filter((p) => p.quantity > 0n).length;
        lines.push(`Всего ${coin.symbol}: ${show(after.quantity)}. Средняя ${holders > 1 ? 'по всем портфелям ' : ''}` + (changed(before.average, after.average)
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

// Запись целиком, без даты: что куплено, сколько, за сколько, где. Продажу
// из файла могли внести деньгами, а не количеством (см. checkOperation).
function opText(op) {
  if (op.type === 'buy') {
    return `покупка ${show(quantityOf(op.money, op.price, op.received ?? ''))} ${op.symbol} за ${op.money} $ по ${op.price} $ в ${op.portfolio}`;
  }
  if (op.type === 'sell') {
    const what = op.quantity !== undefined ? show(parseAmount(op.quantity)) : `на ${op.money} $`;
    return `продажа ${what} ${op.symbol} из ${op.portfolio} по ${op.price} $`;
  }
  return `перевод ${show(parseAmount(op.sent))} ${op.symbol}: ${op.from} → ${op.to}, получено ${show(parseAmount(op.received))}`;
}

// То же с датой — для списка несохранённого: после «Перечитать» записи нет
// нигде, и внести её заново можно только по этому тексту.
const fullName = (op) => `${opText(op)}, ${showDate(op.date)}`;

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
  if (staleCloud) {
    text('record-error', STALE_REFUSAL);
    return;
  }
  const broken = brokenBy(read.operation);
  if (broken) {
    text('record-error', broken);
    return;
  }
  // Такая же запись, которую хранилище ещё не подтвердило, — почти наверняка
  // повторный ввод той же самой: она могла и не сохраниться, и сохраниться, а
  // вторая такая же исказила бы среднюю.
  if (store !== null && operations.slice(confirmedCount).some((op) => JSON.stringify(op) === JSON.stringify(read.operation))) {
    text('record-error', 'Такая же запись уже внесена и ещё не сохранилась. Вносить её заново не нужно, иначе она задвоится: дождитесь «Сохранено»; если сохранение не удастся, появится кнопка «Сохранить ещё раз».');
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
  persist();

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

// После отмены или удаления записи: монета без цены, у которой не осталось
// записей, из списка уходит. Выбранной она тоже перестаёт быть — и здесь, и в
// запомненных вкладках. И портфель, заведённый только этой записью, — тоже.
function forgetUnused() {
  for (const coin of coins.filter((known) => known.id === null && !operations.some((op) => coinOf(op) === known))) {
    coins.splice(coins.indexOf(coin), 1);
    if (selectedCoin !== null && sameCoin(selectedCoin, coin)) selectedCoin = null;
    for (const choice of Object.values(remembered)) {
      if (choice.coin && sameCoin(choice.coin, coin)) choice.coin = null;
    }
  }
  const used = new Set(operations.flatMap((op) => [op.portfolio, op.from, op.to]));
  for (const name of portfolios.filter((known) => !used.has(known))) portfolios.splice(portfolios.indexOf(name), 1);
  const previousCoin = selectedCoin;
  sanitize();
  if (selectedCoin !== previousCoin) {
    dropPrice();
    text('price-source', '');
  }
}

// Отмена последней записи. Раньше возвращала к уже проверенному состоянию, но
// после удаления записей на экране монеты это не так: внесённая задним числом
// запись могла прикрывать продажу, оставшуюся без монет, когда удалили покупку.
// Поэтому отмена проходит ту же проверку, что и удаление.
document.getElementById('undo').addEventListener('click', () => {
  const index = operations.indexOf(last?.operation);
  if (index === -1) return;
  const { operation } = last;
  const check = removalCheck(operations, index);
  if (!check.ok) {
    say(`Отменить нельзя: на этой записи держится другая — ${fullName(check.operation)} (${check.message}). Сначала удалите её на экране монеты.`, operation);
    return;
  }
  operations.splice(index, 1);
  // Отменённая запись могла входить в подтверждённые; без этого внесённая вместо
  // неё исправленная записалась бы в «подтверждённые» и защита от повторного
  // ввода её не увидела бы.
  confirmedCount = Math.min(confirmedCount, operations.length);
  forgetUnused();
  render();
  say(`Отменено: ${shortName(operation)}, ${showDate(operation.date)}`);
  persist();
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

// Enter в цене записывает покупку. Но если портфеля ещё нет и его надо
// назвать, запись не пройдёт; пусть Enter сразу ведёт к его полю.
input.price.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || mode !== 'buy' || input.portfolio.hidden || input.portfolio.value.trim()) return;
  event.preventDefault();
  input.portfolio.focus();
});

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
  const hadCoin = selectedCoin !== null;
  selectedCoin = null;
  // Результаты прежнего текста — неправда про новый, а кнопка «нет в списке»
  // при них позволила бы записать без цены монету, которая в справочнике есть.
  foundCoins = [];
  searchFailed = false;
  searchEmpty = false;
  searchBusy = false;
  // Цена была ценой прежней монеты — с новой ей не место. Подпись под ценой
  // тоже про прежнюю монету, даже если цена ещё не пришла.
  if (hadCoin) dropPrice();
  text('price-source', '');
  searchLater();
  renderCoins();
  showHints();
});
input.money.addEventListener('input', showHints);
input.price.addEventListener('input', () => {
  priceAuto = false;
  input.price.classList.remove('mirrored');
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

// --- Главный экран ---
//
// Сверху итог, под ним разбивка по монетам; портфели — переключатель. Числа
// считает overview.js, здесь только показ. Что бы ни случилось с ценами,
// количество, вложенное и средние показываются: от курса зависит одна
// стоимость, и если её нет, об этом сказано прямо, а не подставлен ноль.

// Выбранный портфель; null — все вместе.
let viewPortfolio = null;
// Цены идут отдельно от записей: без сети всё остальное считается.
let priceState = { status: 'idle', prices: null, at: null, reason: '' };
let priceRun = 0;

const el = (tag, className, content = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
};

// Доллары: два знака, тысячи через неразрывный пробел; малое — значащими
// цифрами, чтобы 0.004 $ не превратилось в «0».
const grouped = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
function dollars(units) {
  let digits = formatAmount(units, 2);
  if (units > 0n && digits === '0') digits = formatSignificant(units, 2);
  const [whole, fraction] = digits.split('.');
  return grouped(whole) + (fraction ? `.${fraction.padEnd(2, '0')}` : '');
}
// Средняя цена: значащие цифры, как везде, но тысячи разделены, как у сумм рядом.
const averageText = (units) => {
  const [whole, fraction] = showPrice(units).split('.');
  return grouped(whole) + (fraction ? `.${fraction}` : '');
};
const signed = (units) => (units === 0n ? '0 $' : `${units > 0n ? '+' : '−'}${dollars(units < 0n ? -units : units)} $`);
function signedPercent(units) {
  const size = units < 0n ? -units : units;
  let digits = formatAmount(size, 1);
  if (size > 0n && digits === '0') digits = formatSignificant(size, 2);
  return `${units > 0n ? '+' : units < 0n ? '−' : ''}${digits}%`;
}
const tone = (units) => (units > 0n ? 'gain' : units < 0n ? 'loss' : '');

async function loadPrices() {
  const run = ++priceRun;
  const ids = overview(operations, null).rows.map((row) => row.key).filter((key) => !key.startsWith('?'));
  if (ids.length === 0) {
    priceState = { status: 'idle', prices: null, at: null, reason: '' };
    return renderOverview();
  }
  priceState = { status: 'loading', prices: null, at: null, reason: '' };
  renderOverview();
  try {
    const prices = await fetchPrices(ids);
    if (run === priceRun) priceState = { status: 'ok', prices, at: new Date(), reason: '' };
  } catch (error) {
    if (run === priceRun) priceState = { status: 'failed', prices: null, at: null, reason: error.busy ? 'CoinGecko просит подождать минуту' : 'нет связи с CoinGecko' };
  }
  if (run === priceRun) renderOverview();
}

// Почему у монеты нет стоимости — одной фразой.
function noValueReason(row) {
  if (row.why === 'unbound') return 'нет: монета не привязана к CoinGecko (привязка — при внесении)';
  if (priceState.status !== 'ok') return '—';
  return 'нет: CoinGecko не прислал цену';
}

function rowItem(row) {
  const head = el('div', 'row-head');
  head.append(el('strong', '', row.symbol), el('span', 'qty', show(row.quantity)));
  head.append(row.value === null
    ? el('span', 'row-diff qty', row.why === 'unbound' ? 'без цены' : 'нет цены')
    : el('span', `row-diff ${tone(row.difference)}`, `${signed(row.difference)} (${signedPercent(row.percent)})`));
  const detail = el('div', 'row-detail', `${viewPortfolio === null ? (portfolios.length > 1 ? 'средняя по всем' : 'средняя') : `средняя в ${viewPortfolio}`} ${averageText(row.average)} $ · вложено ${dollars(row.cost)} $ · сейчас ${row.value === null ? noValueReason(row) : `${dollars(row.value)} $`}`);
  head.append(el('span', 'chevron', '›'));
  const item = el('li', 'row');
  item.append(head, detail);
  // Нажатие открывает экран монеты: её портфели, история и удаление записи.
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.addEventListener('click', () => openCoin(row.key));
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openCoin(row.key);
  });
  return item;
}

function renderTabs() {
  const tabs = byId('portfolio-tabs');
  if (viewPortfolio !== null && !portfolios.includes(viewPortfolio)) viewPortfolio = null;
  tabs.hidden = portfolios.length < 2;
  const choose = (name) => () => { viewPortfolio = name; renderOverview(); };
  tabs.replaceChildren(chip('Все', viewPortfolio === null, choose(null)), ...portfolios.map((name) => chip(name, viewPortfolio === name, choose(name))));
}

function renderOverview() {
  if (view === 'coin') return renderCoin();
  if (byId('overview').hidden) return;
  renderTabs();
  const { rows, totals, excluded, failed } = overview(operations, priceState.prices, viewPortfolio);

  byId('sum-cost').textContent = totals.cost === null ? '—' : `${dollars(totals.cost)} $`;
  byId('sum-value').textContent = totals.value === null ? '—' : `${dollars(totals.value)} $`;
  const difference = byId('sum-difference');
  difference.className = `difference ${totals.difference === null ? '' : tone(totals.difference)}`;
  // Без позиций разницы нет: «0 $» рядом с «Сейчас ничего нет» только запутал бы.
  difference.replaceChildren(...(totals.difference === null || rows.length === 0 ? [] : [
    el('small', '', 'Разница '),
    document.createTextNode(`${signed(totals.difference)} `),
    ...(totals.percent === null ? [] : [el('small', '', `${signedPercent(totals.percent)} к вложенному`)]),
  ]));

  // Чего в итоге нет — сразу под числами, а не сноской внизу: частичный итог
  // без названия исключённого был бы ложью, названный — нет.
  const reasons = { 'no-price': 'нет цены', unbound: 'не привязана к CoinGecko', failed: 'не удалось посчитать' };
  text('sum-exclusion', excluded.length === 0 ? ''
    : `Итог без: ${excluded.map((e) => `${e.symbol}${e.cost === null ? '' : ` (вложено ${dollars(e.cost)} $)`} — ${reasons[e.why]}`).join('; ')}.`);
  // Стоимости нет вовсе, ни у одной монеты — причина одна на всех.
  text('sum-note', rows.length === 0 || totals.value !== null ? ''
    : priceState.status === 'loading' ? 'Цены загружаются…'
    : priceState.status === 'failed' ? `Текущей стоимости нет: ${priceState.reason}. Количество, вложенное и средние посчитаны.`
    : 'Стоимости нет ни у одной монеты: у каждой ниже написана причина.');

  byId('rows').replaceChildren(...rows.map(rowItem));
  byId('rows-hint').hidden = rows.length === 0;
  text('main-message', mainMessage);
  byId('rows-empty').hidden = rows.length > 0 || failed.length > 0;

  byId('failed').replaceChildren(...failed.map((f) => {
    const box = el('div', 'notice alert');
    const message = el('p', '');
    message.append(el('strong', '', `${f.symbol} не посчитана: `), document.createTextNode(`${f.message}. В итог она не входит.`));
    const find = el('button', 'chip', 'Открыть монету и найти запись');
    find.type = 'button';
    find.addEventListener('click', () => openCoin(f.key));
    box.append(message, find);
    return box;
  }));

  const bad = new Map(failed.map((f) => [f.operation, f.message]));
  const entries = history(operations, viewPortfolio);
  byId('history-title').textContent = `История операций (${entries.length})`;
  byId('history-list').replaceChildren(...entries.map(({ op }) => {
    const item = el('li', bad.has(op) ? 'op bad' : 'op');
    item.append(el('time', '', showDate(op.date)), el('span', '', opText(op)));
    if (bad.has(op)) item.append(el('p', 'why', `На этой записи расчёт остановился: ${bad.get(op)}`));
    return item;
  }));

  // Почему цен нет, сказано у итога; здесь только когда они получены.
  const time = priceState.at?.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  text('price-note', priceState.status === 'ok' ? `Цены на ${time}` : '');
  byId('prices-again').hidden = priceState.status !== 'failed';
}

// Три экрана: главный (итог, разбивка, история), внесение и «Данные» (копия
// и возврат; нужен раз в месяц, поэтому за неприметной ссылкой). Блок «исход
// сохранения» живёт на всех: отказ или «устарело» нельзя оставлять там, где
// его не увидят.
let view = 'main';
// Откуда открыли «Данные»: назад ведёт туда же.
let cameFrom = 'main';

// Шапка экрана внесения зависит от того, есть ли записи. Назад — только когда
// есть куда: на первом запуске портфеля ещё нет, и «К портфелю» вело бы на
// пустой экран; из «Данных» — просто назад. Пока записей нет, вместо «Новая
// запись» стоит название приложения с одной строкой о том, что это и с чего
// начать, и подсказка для нового устройства; с первой записью они уходят:
// дальше человек знает, где он.
function refreshHeader() {
  const first = view === 'entry' && operations.length === 0;
  byId('back').hidden = view === 'main' || first;
  byId('back').textContent = view === 'data' ? '← Назад' : '← К портфелю';
  byId('intro').hidden = !first;
  byId('empty-hint').hidden = !first;
  if (view === 'entry') byId('title').textContent = first ? 'Учёт криптовалют' : screenTitles.entry;
}
const screenTitles = { main: 'Портфель', entry: 'Новая запись', data: 'Данные' };
const coinTitle = () => {
  const op = operations.find((candidate) => coinKey(candidate) === viewCoin);
  const known = coins.find((coin) => keyOf(coin) === viewCoin);
  return op === undefined ? '' : known?.name && known.name !== op.symbol ? `${op.symbol} · ${known.name}` : op.symbol;
};

function showView(name) {
  if (name !== 'main') mainMessage = '';
  if (name === 'data' && view !== 'data') cameFrom = view;
  view = name;
  byId('overview').hidden = name !== 'main';
  byId('coin-screen').hidden = name !== 'coin';
  byId('add-bar').hidden = name !== 'main';
  byId('open-data').hidden = name !== 'main';
  byId('modes').hidden = name !== 'entry';
  form.hidden = name !== 'entry';
  byId('data').hidden = name !== 'data';
  byId('title').textContent = name === 'coin' ? coinTitle() : screenTitles[name];
  refreshHeader();
  if (name === 'main') byId('main-save').append(byId('save-block'));
  else if (name === 'coin') byId('coin-save').append(byId('save-block'));
  else if (name === 'data') byId('data-save').append(byId('save-block'));
  else byId('unbound').before(byId('save-block'));
  // loadPrices сразу перерисовывает экран, отдельный вызов не нужен.
  if (name === 'main') loadPrices();
  if (name === 'coin') renderCoin();
}

// --- Экран монеты ---
//
// Монета целиком, по портфелям и её история; у каждой записи — «Удалить».
// Удаление не молчит и не каскадирует: если без записи другая станет
// невозможной, говорим какая, и отказываем (см. removalCheck). Исправления
// записи нет: ошибочную удаляют и вносят заново.
let viewCoin = null;
// Что сказать на главном экране после удаления: если у монеты не осталось записей,
// экран монеты закрывается, и сказать там уже негде.
let mainMessage = '';
// Запись, у которой спросили подтверждение; и запись, которую удалить нельзя, с причиной.
let pendingDelete = null;
let refusal = null;

function openCoin(key) {
  viewCoin = key;
  pendingDelete = null;
  refusal = null;
  text('coin-message', '');
  showView('coin');
  window.scrollTo(0, 0);
}

function askDelete(operation) {
  pendingDelete = null;
  refusal = null;
  text('coin-message', '');
  if (staleCloud) {
    text('coin-message', STALE_REFUSAL);
    return renderCoin();
  }
  const check = removalCheck(operations, operations.indexOf(operation));
  if (check.ok) pendingDelete = operation;
  else refusal = { operation, blocker: check.operation, text: `Нельзя удалить: на этой записи держится другая — ${fullName(check.operation)} (${check.message}). Чтобы удалить эту, сначала удалите ту.` };
  renderCoin();
}

function deleteOperation(operation) {
  // Пока висел вопрос, сохранение могло вернуть «данные изменились на другом устройстве».
  if (staleCloud) {
    pendingDelete = null;
    text('coin-message', STALE_REFUSAL);
    return renderCoin();
  }
  const index = operations.indexOf(operation);
  const before = coinDetail(operations, viewCoin, priceState.prices).total;
  operations.splice(index, 1);
  // Подтверждённых записей стало на одну меньше, если удалённая была среди них;
  // а в хранилище она до подтверждения удаления остаётся — об этом скажет
  // сообщение, если сохранить не удастся. Незаписанную удалить значит просто
  // не записывать: в хранилище её не было.
  if (index < confirmedCount) {
    confirmedCount -= 1;
    unsavedDeletions.push(fullName(operation));
  }
  if (last?.operation === operation) say('');
  pendingDelete = null;
  forgetUnused();
  render();
  persist();
  const after = coinDetail(operations, viewCoin, priceState.prices);
  const done = `Удалено: ${fullName(operation)}.`;
  if (after.entries.length === 0) {
    mainMessage = `${done} ${operation.symbol} больше нет в портфеле.`;
    return renderCoin();
  }
  const change = before !== null && after.total !== null
    ? ` Средняя по монете: ${averageText(before.average)}\u00a0$ → ${averageText(after.total.average)}\u00a0$, вложено ${dollars(before.cost)}\u00a0$ → ${dollars(after.total.cost)}\u00a0$.`
    : '';
  text('coin-message', `${done} Всё пересчитано заново по оставшимся записям.${change}`);
  byId('coin-message').scrollIntoView({ block: 'nearest' });
  renderCoin();
}

function renderCoin() {
  const detail = coinDetail(operations, viewCoin, priceState.prices);
  // Удалили последнюю запись монеты — монеты больше нет, возвращаемся.
  if (detail.entries.length === 0) return showView('main');
  byId('title').textContent = coinTitle();
  const { total, portfolios: where, failed } = detail;
  const symbol = detail.entries[0].op.symbol;

  byId('coin-cost').textContent = total === null ? '—' : `${dollars(total.cost)} $`;
  byId('coin-value').textContent = total === null || total.value === null ? '—' : `${dollars(total.value)} $`;
  // «Общая» и «в портфеле» — разные средние: подписано, какая из них какая.
  text('coin-line', total === null ? (failed === null ? 'Сейчас этой монеты нет: всё продано.' : '')
    : `${show(total.quantity)} ${symbol} · ${where.length > 1 ? 'средняя по всем портфелям' : 'средняя'} ${averageText(total.average)} $`);
  const difference = byId('coin-difference');
  difference.className = `difference ${total === null || total.difference === null ? '' : tone(total.difference)}`;
  difference.replaceChildren(...(total === null || total.difference === null ? [] : [
    el('small', '', 'Разница '),
    document.createTextNode(`${signed(total.difference)} `),
    ...(total.percent === null ? [] : [el('small', '', `${signedPercent(total.percent)} к вложенному`)]),
  ]));
  text('coin-note', total === null || total.value !== null ? ''
    : total.why === 'unbound' ? 'Текущей стоимости нет: монета не привязана к CoinGecko (привязка — при внесении).'
    : priceState.status === 'loading' ? 'Цены загружаются…'
    : priceState.status === 'failed' ? `Текущей стоимости нет: ${priceState.reason}.`
    : 'Текущей стоимости нет: CoinGecko не прислал цену.');

  byId('coin-failed').replaceChildren(...(failed === null ? [] : [(() => {
    const box = el('div', 'notice alert');
    box.append(el('p', '', `${symbol} не посчитана: ${failed.message}. В итог она не входит. Запись, на которой расчёт остановился, отмечена ниже: её можно удалить.`));
    return box;
  })()]));

  byId('coin-portfolios-title').hidden = where.length === 0;
  // С одним портфелем обе средние совпадают и подписи нет: объяснять нечего.
  byId('coin-averages-hint').hidden = where.length < 2;
  byId('coin-portfolios').replaceChildren(...where.map((p) => {
    const head = el('div', 'row-head');
    head.append(el('strong', '', p.name), el('span', 'qty', `${show(p.quantity)} ${symbol}`));
    const item = el('li', 'row');
    item.append(head, el('div', 'row-detail', `средняя только в этом портфеле ${averageText(p.average)} $ · вложено ${dollars(p.cost)} $`));
    return item;
  }));

  byId('coin-history').replaceChildren(...detail.entries.map(({ op }) => {
    const bad = failed !== null && failed.operation === op;
    const item = el('li', `op coin-op${bad ? ' bad' : ''}${pendingDelete === op ? ' asking' : ''}${refusal?.blocker === op ? ' blocker' : ''}`);
    const remove = el('button', 'chip', 'Удалить');
    remove.type = 'button';
    remove.addEventListener('click', () => askDelete(op));
    item.append(el('time', '', showDate(op.date)), el('span', 'text', opText(op)), remove);
    if (bad) item.append(el('p', 'why', `На этой записи расчёт остановился: ${failed.message}`));
    if (pendingDelete === op) {
      const confirm = el('div', 'confirm');
      confirm.append(el('p', '', `Удалить запись: ${fullName(op)}? Вернуть её потом нельзя. Средние и итоги пересчитаются по оставшимся записям.`));
      const yes = el('button', 'chip danger', 'Да, удалить');
      yes.type = 'button';
      yes.addEventListener('click', () => deleteOperation(op));
      const no = el('button', 'chip', 'Не удалять');
      no.type = 'button';
      no.addEventListener('click', () => { pendingDelete = null; renderCoin(); });
      confirm.append(yes, no);
      item.append(confirm);
    }
    if (refusal?.operation === op) item.append(el('p', 'refusal', refusal.text));
    return item;
  }));
}

// --- Хранение ---
//
// Где лежат данные, приложение не знает: об этом заботится слой storage.js
// (облако Телеграма внутри Телеграма, иначе localStorage). Здесь только:
// прочитать при старте, сохранить после каждого изменения, выгрузить и
// загрузить файл.

// Выбираются в start(): внутри Телеграма сначала подключается его скрипт.
let chosen = null;
let store = null;
// Почему сохранять нельзя, когда хранилища нет (store === null).
let unavailableReason = '';
const where = () => (chosen?.kind === 'telegram' ? 'в облаке Телеграма' : 'в этом браузере');
const byId = (id) => document.getElementById(id);
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one
  : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const records = (n) => `${n} ${plural(n, 'запись', 'записи', 'записей')}`;

// Названия монет нужны только для показа, но без них после перезагрузки
// кнопки подписаны одним тикером.
function snapshot() {
  // Без прототипа: код монеты «__proto__» иначе тихо пропал бы при записи.
  const names = Object.create(null);
  for (const op of operations) {
    if (op.coin !== null) names[op.coin] = coins.find((coin) => coin.id === op.coin)?.name || op.symbol;
  }
  return { operations, names };
}

// Списки портфелей и монет — производные от операций: первым стоит
// последний использованный.
function restore(state) {
  operations.splice(0, operations.length, ...state.operations);
  portfolios.length = 0;
  coins.length = 0;
  for (const op of operations) {
    moveToFront(coins, op.coin === null
      ? { id: null, symbol: op.symbol, name: '' }
      : { id: op.coin, symbol: op.symbol, name: (state.names && Object.hasOwn(state.names, op.coin) ? state.names[op.coin] : null) || op.symbol }, sameCoin);
    if (op.type === 'buy') moveToFront(portfolios, op.portfolio);
    else for (const name of [op.portfolio, op.from, op.to]) if (name && !portfolios.includes(name)) portfolios.push(name);
  }
  selectedPortfolio = [...operations].reverse().find((op) => op.type === 'buy')?.portfolio ?? portfolios[0] ?? null;
}

// Всё, что человек успел выбрать и набрать, относилось к прежним данным.
function resetView() {
  selectedCoin = null;
  foundCoins = [];
  fromPortfolio = null;
  toPortfolio = null;
  addingPortfolio = false;
  addingTo = false;
  movedTouched = false;
  priceAuto = false;
  for (const key of Object.keys(remembered)) remembered[key] = {};
  clearPresets();
  for (const field of Object.values(input)) field.value = '';
  input.date.value = today();
  setMode(mode);
}

// Сколько записей из списка подтверждено хранилищем. Остальные — на странице,
// но в хранилище их может не быть (а может быть: запись, не получившая ответа,
// иногда всё же ложится). Нужно, чтобы человек не внёс такую запись второй раз.
let confirmedCount = 0;
// Другое устройство сохранилось позже, и здесь показано устаревшее. Пока человек
// не перечитал, новые записи не принимаются: сохранить их значило бы затереть чужое.
let staleCloud = false;
const STALE_REFUSAL = 'Данные на другом устройстве изменились. Сначала нажмите «Перечитать» под кнопкой, иначе то, что вы измените здесь, затрёт их.';

// Какие записи не сохранены, — чтобы человеку не пришлось вспоминать.
function unsavedList() {
  const names = operations.slice(confirmedCount).map(fullName);
  return names.length === 0 ? '' : `: ${names.join('; ')}`;
}

// Удалённые записи, которых хранилище ещё не подтвердило: пока сохранение не
// удалось, они там на месте и вернутся, если закрыть страницу.
const unsavedDeletions = [];
const deletionNote = () => unsavedDeletions.length === 0 ? ''
  : `Удаление не сохранено: ${unsavedDeletions.join('; ')} — в сохранённом эта запись осталась на месте и вернётся, если закрыть страницу.`;

function showSaveState(kind, detail = '') {
  const element = byId('save-state');
  const failed = kind === 'failed' || kind === 'unavailable' || kind === 'stale';
  if (kind === 'saved') {
    confirmedCount = operations.length;
    unsavedDeletions.length = 0;
  }
  staleCloud = kind === 'stale';
  // «Записано: …» с кнопкой отмены рядом с «Это не сохранено» говорило бы две
  // противоположные вещи об одной записи; что не сохранено — перечислено ниже.
  if (staleCloud) say('');
  byId('save-again').hidden = kind !== 'failed';
  byId('reread').hidden = kind !== 'stale';
  element.className = failed ? 'error' : 'hint';
  element.textContent = {
    saving: 'Сохраняю…',
    saved: `Сохранено ${where()} · ${records(operations.length)}`,
    // Внесение и удаление говорят разное: внесённая запись есть только здесь,
    // удалённая — ещё в сохранённом. Каждое названо своими словами.
    failed: `Не удалось сохранить: ${detail}. ${[operations.length > confirmedCount ? 'Запись не потеряна: она есть на этой странице, вносить её заново не нужно.' : '', deletionNote()].filter(Boolean).join(' ')} Нажмите «Сохранить ещё раз» и не закрывайте страницу, пока не появится «Сохранено». Копию можно сохранить ниже.`,
    stale: `Данные изменились на другом устройстве, а здесь показано устаревшее состояние. Это не сохранено${unsavedList()}. ${deletionNote()} Нажмите «Перечитать», чтобы увидеть актуальные данные: страница загрузится заново, и всё несохранённое, а также недописанное в полях пропадёт, поэтому перепишите записи отсюда и внесите их заново. Если нужна копия того, что здесь, сначала сохраните её копию ниже.`,
    unavailable: `${unavailableReason}: записи пропадут при закрытии страницы. Выгрузите их копией ниже.`,
  }[kind];
}

function refreshDataPanel() {
  // «Где лежат и сколько» — в строке сохранения вверху; здесь только когда сохранять некуда.
  byId('data-info').textContent = store === null ? `Данные не сохраняются. Сейчас на странице ${records(operations.length)}.` : '';
  // Что «сохранено» на деле значит: на другом устройстве этого нет, а очистка
  // браузера всё уберёт — единственная копия, которую человек держит сам, это файл.
  // Записи из обычного браузера в облако сами не переезжают: это разные
  // хранилища. Человеку только подсказываем, как их перенести, — ничего не
  // подхватывается и не сливается молча.
  byId('data-where').textContent = chosen === null ? ''
    : chosen.kind === 'telegram'
      ? `Данные привязаны к вашему аккаунту Телеграма.${operations.length === 0 ? ' Здесь пока пусто. Если вы вели записи в другом месте (например, в браузере), сохраните там копию в файл, откройте файл, скопируйте всё его содержимое и вставьте в поле ниже.' : ''} Копия данных нужна на случай, если что-то пойдёт не так.`
      : 'Только на этом устройстве, в этом браузере. На другом их не будет, очистка браузера их сотрёт. Копия в файле — ваша страховка.';
  refreshHeader();
  byId('export').disabled = operations.length === 0;
  byId('copy').disabled = operations.length === 0;
  if (operations.length === 0 && !byId('data-note').textContent) byId('data-note').textContent = insideTelegram(window) ? '' : 'В файл пока нечего сохранять: записей нет.';
}

// Сохранение не задерживает ввод: записи идут по очереди в фоне, а исход
// виден под кнопкой. Не сохранилось — это сказано прямо, запись при этом
// остаётся на странице.
let saveRun = 0;
function persist() {
  refreshDataPanel();
  if (store === null) return showSaveState('unavailable');
  const attempt = ++saveRun;
  showSaveState('saving');
  store.save(snapshot()).then(
    () => { if (attempt === saveRun) showSaveState('saved'); },
    (error) => { if (attempt === saveRun) showSaveState(error.stale ? 'stale' : 'failed', error.message); },
  );
}

byId('save-again').addEventListener('click', persist);

// Прочитанное проверяется так же, как загруженный файл: хранилище могли
// изменить, а расчёт на испорченных данных дал бы неверные числа.
function problemWith(state) {
  const names = state.names ?? {};
  if (names === null || typeof names !== 'object' || !Object.values(names).every((name) => typeof name === 'string')) {
    return 'названия монет записаны не так, как нужно';
  }
  const problem = checkHistory(state.operations);
  return problem === null ? '' : `запись №${(problem.index ?? -1) + 1}: ${problem.message}`;
}

// Данные не целы: ничего не считаем и ничего не принимаем — новая запись
// затёрла бы то, что от них осталось. Выход: загрузить файл или стереть.
function lockDown(reason, retry = false) {
  telegramReady(window);
  byId('storage-broken-reason').textContent = reason;
  byId('storage-broken').hidden = false;
  byId('title').textContent = retry ? 'Новая запись' : 'Данные';
  byId('loading').hidden = true;
  // Хранилище не ответило — данные могут быть целы, их надо прочитать заново,
  // а не стирать. Стирание предлагаем, только когда ясно, что они повреждены.
  // И пока не прочитали, загрузка файла была бы заменой вслепую: она затёрла
  // бы то, что лежит в хранилище целым, — поэтому раздела «Данные» тут нет.
  byId('retry-box').hidden = !retry;
  byId('reset-box').hidden = retry;
  byId('broken-text').hidden = retry;
  byId('data').hidden = retry;
  placeTransfer();
  byId('storage-broken-title').textContent = retry ? 'Не удалось прочитать сохранённое:' : 'Сохранённые данные не целы:';
  refreshDataPanel();
  // Записей не ноль, а неизвестно сколько: «0 записей» здесь было бы неправдой.
  byId('data-info').textContent = 'Сохранённое не прочитано, выгружать нечего.';
  byId('export').disabled = true;
  byId('copy').disabled = true;
}

function unlock() {
  telegramReady(window);
  byId('storage-broken').hidden = true;
  byId('loading').hidden = true;
  placeTransfer();
  // Без записей показывать на главном экране нечего: сразу форма.
  showView(operations.length > 0 ? 'main' : 'entry');
}

// Внутри Телеграма подключаем его скрипт и берём облако; снаружи — localStorage.
async function connect() {
  if (!insideTelegram(window)) return pickBackend(window, false);
  await loadTelegram(window, document);
  return pickBackend(window, true);
}

async function start() {
  input.date.max = today();
  input.date.value = today();
  // Обычное чтение из облака занимает десятые доли секунды; если прошла секунда
  // (в четыре раза дольше самой долгой типичной записи), экран не должен стоять
  // молча. Если подпись уже скрыта, ничего не меняется.
  setTimeout(() => { if (!byId('loading').hidden) byId('loading').textContent = 'Облако отвечает медленно…'; }, 1000);
  let picked;
  try {
    picked = await connect();
  } catch (error) {
    // Данные могут лежать в облаке целыми; молча писать в другое место нельзя.
    return lockDown(`не удалось подключиться к Телеграму: ${error.message}`, true);
  }
  if (picked === null) unavailableReason = 'В этом браузере нельзя сохранять данные';
  else if (picked.kind === 'unsupported') unavailableReason = picked.reason;
  else {
    chosen = picked;
    store = createStore(picked.backend);
  }
  if (store === null) {
    showSaveState('unavailable');
  } else {
    // Пока данные читаются, форма закрыта: запись поверх непрочитанного
    // затёрла бы его.
    const loaded = await store.load();
    if (loaded.status === 'broken') return lockDown(loaded.reason, loaded.retry === true);
    if (loaded.status === 'ok') {
      const problem = problemWith(loaded.state);
      if (problem) return lockDown(`сохранённые данные не проходят проверку (${problem})`);
      restore(loaded.state);
      showSaveState('saved');
    }
  }
  setMode('buy');
  unlock();
  refreshDataPanel();
  if (coins.some((coin) => coin.id === null)) offerBinding();
}

// Выгрузка в файл — то, что лежит на странице сейчас, в том же виде, что в
// хранилище.
byId('export').addEventListener('click', () => {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([makeExport(snapshot())], { type: 'application/json' }));
  link.href = url;
  link.download = `crypto-portfolio-${today()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  byId('data-note').textContent = `Копия: ${link.download} (${records(operations.length)}), в ${time}. Если файл не скачался, копии нет.`;
});

// Внутри Телеграма файл не скачивается: окно приложения просто открывает его
// содержимое. Родное скачивание (downloadFile, Bot API 8.0+) требует HTTPS-ссылку
// на файл на сервере и особые заголовки ответа, а своего сервера у проекта нет.
// Поэтому там данные копируются текстом одним нажатием и принимаются обратно
// вставкой. Чтение буфера у самого Телеграма (readTextFromClipboard) доступно
// только приложениям, запущенным из меню вложений, и нам не годится: вставляет
// человек сам, в поле. Вне Телеграма остаются файлы.
function placeTransfer() {
  const asText = insideTelegram(window);
  for (const [id, hide] of [['export', asText], ['import-label', asText], ['copy', !asText], ['paste-box', !asText]]) byId(id).hidden = hide;
}

byId('copy').addEventListener('click', async () => {
  const content = makeExport(snapshot());
  const box = byId('copy-text');
  box.value = content;
  let copied = false;
  try {
    await navigator.clipboard.writeText(content);
    copied = true;
  } catch {
    // Нет права на буфер: старый способ, он работает по нажатию, но поле для
    // него должно быть видно и выделено.
    box.hidden = false;
    box.select();
    try { copied = document.execCommand('copy'); } catch { /* скажем прямо ниже */ }
  }
  box.hidden = copied;
  if (!copied) box.select();
  const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  byId('data-note').textContent = copied
    ? `Данные (${records(operations.length)}) в буфере обмена, в ${time}. Это ещё не копия: откройте в Телеграме чат «Избранное» и вставьте их туда, пока не скопировали ничего другого.`
    : 'Само не скопировалось. Нажмите в поле сразу под этой надписью, выделите всё и скопируйте. Это ещё не копия: откройте в Телеграме чат «Избранное» и вставьте скопированное туда.';
});
byId('copy-text').addEventListener('focus', (event) => event.target.select());

// Загрузка: данные целиком проверяются, показывается, что в них, и только по
// второму нажатию заменяют текущие. Файл и вставленный текст проходят через
// одну и ту же проверку (readExport).
let pendingImport = null;
const importError = (message) => { byId('import-error').textContent = message; };

function resetImport() {
  pendingImport = null;
  byId('import-confirm').hidden = true;
  form.inert = false;
  importError('');
}

function offerImport(content, source, read = readExport) {
  const result = read(content);
  if (!result.ok) return importError(`${source.name} не принят: ${result.message}. Ваши данные не тронуты.`);
  pendingImport = result.state;
  const dates = result.state.operations.map((op) => op.date).sort();
  byId('import-summary').textContent = `В ${source.in} ${records(dates.length)}`
    + (dates.length ? ` — с ${showDate(dates[0])} по ${showDate(dates.at(-1))}` : '')
    + `. Ваши нынешние ${records(operations.length)} будут удалены и заменены ими — насовсем. Если сомневаетесь, сначала сохраните копию нынешних.`;
  byId('import-confirm').hidden = false;
  // Пока вопрос открыт, новая запись была бы затёрта заменой.
  form.inert = true;
}

byId('paste-load').addEventListener('click', () => {
  resetImport();
  const content = byId('paste').value;
  if (!content.trim()) return importError('Сначала вставьте в поле скопированные данные');
  offerImport(content, { name: 'Текст', in: 'тексте' }, readPasted);
});

byId('import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  resetImport();
  if (!file) return;
  let content;
  try {
    content = await file.text();
  } catch {
    return importError('Файл не удалось прочитать');
  }
  offerImport(content, { name: 'Файл', in: 'файле' });
});

byId('import-cancel').addEventListener('click', () => {
  pendingImport = null;
  byId('import-confirm').hidden = true;
  form.inert = false;
});

byId('import-apply').addEventListener('click', async () => {
  if (pendingImport === null) return;
  const state = pendingImport;
  // Сначала сохраняем: не вышло — страница остаётся как была. Пока идёт
  // запись, форма закрыта: операция, внесённая за это время, была бы затёрта.
  if (store !== null) {
    form.inert = true;
    try {
      await store.save(state);
    } catch (error) {
      return importError(`Не удалось сохранить загруженное: ${error.message}. Данные на странице не изменены.`);
    } finally {
      form.inert = false;
    }
  }
  resetImport();
  byId('paste').value = '';
  byId('paste').blur();
  byId('copy-text').hidden = true;
  restore(state);
  const wasLocked = !byId('storage-broken').hidden;
  unlock();
  // Данные были не целы — теперь целы, и человек идёт к портфелю; иначе остаётся
  // там, где нажимал, потому что подтверждение «Загружено» стоит на этом экране.
  if (!wasLocked) showView('data');
  resetView();
  refreshDataPanel();
  if (store !== null) showSaveState('saved');
  say(`Загружено: ${records(state.operations.length)}`);
  byId('data-note').textContent = `Загружено: ${records(state.operations.length)}. Прежние данные заменены.`;
  if (coins.some((coin) => coin.id === null)) offerBinding();
});

// Стереть всё сохранённое — только когда данные не целы и другого выхода
// нет. Два нажатия: первое только спрашивает.
let resetArmed = false;
byId('retry').addEventListener('click', () => location.reload());
byId('reread').addEventListener('click', () => location.reload());

// Форма открывается на покупке, а не там, где её оставили: после продажи
// каждое следующее внесение начиналось бы не с того.
byId('add').addEventListener('click', () => {
  if (mode !== 'buy') setMode('buy');
  showView('entry');
  window.scrollTo(0, 0);
});
byId('back').addEventListener('click', () => { showView(view === 'data' ? cameFrom : 'main'); window.scrollTo(0, 0); });
for (const id of ['open-data', 'restore-link']) byId(id).addEventListener('click', () => { showView('data'); window.scrollTo(0, 0); });
byId('prices-again').addEventListener('click', loadPrices);

byId('reset').addEventListener('click', async () => {
  const button = byId('reset');
  if (!resetArmed) {
    resetArmed = true;
    button.textContent = 'Точно стереть? Нажмите ещё раз';
    // Двойной тап — это один «нажал», а не два решения.
    button.disabled = true;
    setTimeout(() => { button.disabled = false; }, 1200);
    setTimeout(() => { resetArmed = false; button.textContent = 'Стереть сохранённое и начать заново'; }, 6000);
    return;
  }
  resetArmed = false;
  button.textContent = 'Стереть сохранённое и начать заново';
  try {
    await store.erase();
  } catch (error) {
    byId('storage-broken-reason').textContent += `. Стереть не удалось: ${error.message}`;
    return;
  }
  restore({ operations: [], names: {} });
  unlock();
  resetView();
  refreshDataPanel();
  showSaveState('saved');
});

// Что бы ни случилось при чтении, человек увидит причину, а не вечное «Читаю…».
await start().catch((error) => lockDown(`приложение не смогло прочитать данные: ${error.message}`, true));
