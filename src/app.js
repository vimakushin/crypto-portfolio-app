import { calculate, formatAmount, isDate, SCALE } from './calc.js';
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
let selectedPortfolio = null;
let addingPortfolio = false;

const form = document.getElementById('buy');
const input = {
  coin: document.getElementById('coin'),
  money: document.getElementById('money'),
  price: document.getElementById('price'),
  received: document.getElementById('received'),
  portfolio: document.getElementById('portfolio'),
  date: document.getElementById('date'),
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

function isAmount(value) {
  return /^\d+(\.\d{1,30})?$/.test(value) && /[1-9]/.test(value);
}

const sameCoin = (a, b) => a.id === b.id && (a.id !== null || a.symbol === b.symbol);

// Количество считает сам расчёт, по той же операции, что будет записана:
// подсказки и то, что попадёт в портфель, не могут разойтись. null — расчёт
// отказался: получено больше, чем куплено.
function quantityOf(money, price, received = '') {
  const op = { type: 'buy', date: today(), coin: '-', portfolio: '-', money, price };
  if (received) op.received = received;
  return calculate([op]).coins.get('-')?.quantity ?? null;
}

// Под ценой — сколько монет выходит. Если вписано полученное, вместо этого
// под ним комиссия в монетах и процентах: опечатка вроде 0.1368 вместо 1.368
// видна сразу как «комиссия 90%».
function showQuantity() {
  const money = normalize(input.money.value);
  const price = normalize(input.price.value);
  const received = normalize(input.received.value);
  const symbol = selectedCoin?.symbol ?? (input.coin.value.trim().toUpperCase() || 'монет');
  let quantity = '';
  let fee = '';
  if (isAmount(money) && isAmount(price)) {
    const bought = quantityOf(money, price);
    const got = isAmount(received) ? quantityOf(money, price, received) : undefined;
    if (got === undefined) quantity = `Количество: ${formatAmount(bought, 8)} ${symbol}`;
    else if (got === null) fee = `Больше, чем ${formatAmount(bought, 8)} ${symbol} по этой цене`;
    else fee = `Комиссия биржи: ${formatAmount(bought - got, 8)} ${symbol} (${formatAmount((bought - got) * 100n * SCALE / bought, 2)}%)`;
  }
  text('quantity', quantity);
  text('fee', fee);
}

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

// --- Монета ---

function selectCoin(coin) {
  clearTimeout(searchTimer);
  selectedCoin = coin;
  foundCoins = [];
  input.coin.value = coin.symbol;
  setError('coin', '');
  renderCoins();
  fillPrice();
  input.money.focus();
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
    : selectedCoin.id === null ? 'Текущей цены по этой монете нет — впишите цену сами. Какая это монета, спросим, когда найдём её в CoinGecko'
    : selectedCoin.name);
  text('coin-offline', searchBusy && selectedCoin === null
    ? 'CoinGecko просит подождать — попробуйте через минуту'
    : searchFailed && selectedCoin === null && input.coin.value.trim()
    ? `Нет связи. Запишем как «${input.coin.value.trim().toUpperCase()}», а какая это монета — спросим, когда связь появится`
    : searchEmpty && selectedCoin === null
    ? `CoinGecko не знает такую монету. Запишем как «${input.coin.value.trim().toUpperCase()}» без текущей цены — когда она появится в справочнике, спросим, какая это`
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
// а не старое число.
async function fillPrice() {
  if (priceAuto) input.price.value = '';
  priceAuto = false;
  const coin = selectedCoin;
  if (coin.id === null) {
    text('price-source', '');
    showQuantity();
    return;
  }
  // Цены на прошлые даты у нас нет, а сегодняшняя в старой сделке тихо
  // испортила бы среднюю.
  if (input.date.value !== today()) {
    text('price-source', 'Для прошлой даты впишите цену сделки');
    showQuantity();
    return;
  }
  text('price-source', 'Получаю текущую цену…');
  try {
    const price = (await fetchPrices([coin.id])).get(coin.id);
    if (selectedCoin !== coin || input.date.value !== today()) return;
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
  showQuantity();
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
  renderCoins();
  if (selectedCoin === unbound) {
    selectedCoin = coin;
    input.coin.value = coin.symbol;
    renderCoins();
    fillPrice();
  }
  offerBinding();
  text('status', `«${unbound.symbol}» привязана: ${coin.symbol} · ${coin.name}`);
}

// --- Портфель ---

function renderPortfolios() {
  // Пока портфелей нет, выбирать не из чего — сразу поле для названия.
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
}

// --- Запись ---

function setError(name, message) {
  text(`${name}-error`, message);
  const field = name === 'portfolio' && input.portfolio.hidden ? null : input[name];
  field?.setAttribute('aria-invalid', String(message !== ''));
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const typed = input.coin.value.trim().toUpperCase();
  // Монету без выбора из списка принимаем только без связи или когда
  // справочник её не знает — и тогда без привязки. Иначе это было бы
  // определение монеты по тикеру.
  const coin = selectedCoin ?? (typed && canRecordUnbound() ? { id: null, symbol: typed, name: '' } : null);
  const money = normalize(input.money.value);
  const price = normalize(input.price.value);
  const received = normalize(input.received.value);
  const portfolio = input.portfolio.hidden ? selectedPortfolio : portfolioName(input.portfolio.value);
  // Недонабранную дату поле отдаёт пустой; молча подставить сегодняшнюю
  // значило бы записать не ту дату, что человек вводил.
  const date = input.date.value;

  const problems = {
    coin: coin ? '' : typed ? 'Выберите монету из списка под полем' : 'Укажите монету',
    money: isAmount(money) ? '' : 'Нужно число больше нуля, например 200',
    price: isAmount(price) ? '' : 'Нужно число больше нуля, например 146.12',
    received: !received ? ''
      : !isAmount(received) ? 'Нужно число больше нуля — или оставьте пустым'
      : isAmount(money) && isAmount(price) && quantityOf(money, price, received) === null
        ? 'Получено больше, чем потрачено ÷ цена. Проверьте цену и количество' : '',
    portfolio: portfolio ? '' : 'Укажите, где лежит монета',
    date: !isDate(date) ? 'Укажите дату полностью' : date > today() ? 'Дата ещё не наступила' : '',
  };
  for (const [name, message] of Object.entries(problems)) setError(name, message);
  const firstProblem = Object.keys(problems).find((name) => problems[name]);
  if (firstProblem) {
    text('status', '');
    input[firstProblem].focus();
    return;
  }

  const operation = { type: 'buy', date, coin: coin.id, symbol: coin.symbol, portfolio, money, price };
  if (received) operation.received = received;
  operations.push(operation);
  moveToFront(portfolios, portfolio);
  moveToFront(coins, coin, sameCoin);
  selectedPortfolio = portfolio;
  addingPortfolio = false;

  text('status',
    `Записано: ${formatAmount(quantityOf(money, price, received), 8)} ${coin.symbol} за ${money} $ по ${price} $` +
    (priceAuto ? ' (текущая по CoinGecko)' : '') + ' — ' +
    `${portfolio}, ${date.split('-').reverse().join('.')}` +
    (coin.id === null ? '. Без текущей цены: какая это монета, спросим, когда найдём её в CoinGecko' : ''));

  // Дата возвращается к сегодняшней: иначе после одной старой покупки
  // следующая, сегодняшняя, молча записалась бы задним числом.
  input.money.value = '';
  input.price.value = '';
  input.received.value = '';
  input.portfolio.value = '';
  input.date.value = today();
  priceAuto = false;
  renderPortfolios();
  document.activeElement.blur();
  // Монета остаётся выбранной, и цена для следующей покупки подставляется
  // заново — за минуту она могла измениться.
  selectedCoin = coin;
  input.coin.value = coin.symbol;
  renderCoins();
  showQuantity();
  fillPrice();
  if (coin.id === null) offerBinding();
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
// «получено» нужно редко и не должно стоять на пути обычной покупки.
for (const [from, to] of [[input.coin, input.money], [input.money, input.price]]) {
  from.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    to.focus();
  });
}

// Подставленную цену удобно заменить целиком: она выделяется при входе в поле.
input.price.addEventListener('focus', () => { if (priceAuto) input.price.select(); });

// Исправляемое поле перестаёт быть красным сразу, а не после следующей записи.
for (const name of ['coin', 'money', 'price', 'received', 'portfolio', 'date']) {
  input[name].addEventListener('input', () => setError(name, ''));
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
  showQuantity();
});
input.money.addEventListener('input', showQuantity);
input.price.addEventListener('input', () => {
  priceAuto = false;
  text('price-source', '');
  showQuantity();
});
input.received.addEventListener('input', showQuantity);
input.date.addEventListener('input', () => { if (selectedCoin !== null) fillPrice(); });
window.addEventListener('online', offerBinding);

// Календарь на телефоне не даст выбрать будущий день.
input.date.max = today();
input.date.value = today();
renderCoins();
renderPortfolios();
