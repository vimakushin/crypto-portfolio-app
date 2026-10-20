import { calculate, formatAmount, isDate } from './calc.js';

// Внесённое пока живёт, пока открыта страница: хранилище появится вместе
// с телеграмом, и последний портфель будет запоминаться там же.
const operations = [];
// Портфели и монеты в порядке использования: первый — самый свежий.
// Последний портфель стоит первым и уже выбран — чаще всего покупают туда же.
const portfolios = [];
const coins = [];
let selectedPortfolio = null;
let addingPortfolio = false;

const form = document.getElementById('buy');
const input = {
  coin: document.getElementById('coin'),
  money: document.getElementById('money'),
  price: document.getElementById('price'),
  portfolio: document.getElementById('portfolio'),
  date: document.getElementById('date'),
};

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Человек пишет как привык: «146,12», «1 000». Расчёт принимает «146.12».
function normalize(text) {
  return text.replace(/\s/g, '').replace(',', '.');
}

// «binance» и «Binance » — тот же портфель, что уже есть: второй портфель
// с похожим названием тихо разделил бы позицию на две со своими средними.
function portfolioName(text) {
  const name = text.trim().replace(/\s+/g, ' ');
  return portfolios.find((known) => known.toLowerCase() === name.toLowerCase()) ?? name;
}

function isAmount(text) {
  return /^\d+(\.\d{1,30})?$/.test(text) && /[1-9]/.test(text);
}

// Количество считает сам расчёт, по той же операции, что будет записана:
// подсказка под ценой и то, что попадёт в портфель, не могут разойтись.
function quantityOf(money, price) {
  const { coins } = calculate([{ type: 'buy', date: today(), coin: '-', portfolio: '-', money, price }]);
  return coins.get('-').quantity;
}

function showQuantity() {
  const money = normalize(input.money.value);
  const price = normalize(input.price.value);
  const coin = input.coin.value.trim().toUpperCase();
  document.getElementById('quantity').textContent = isAmount(money) && isAmount(price)
    ? `Количество: ${formatAmount(quantityOf(money, price), 8)} ${coin || 'монет'}`
    : '';
}

function moveToFront(list, name) {
  const index = list.indexOf(name);
  if (index !== -1) list.splice(index, 1);
  list.unshift(name);
}

function chip(text, pressed, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.textContent = text;
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

function renderCoins() {
  const current = input.coin.value.trim().toUpperCase();
  document.getElementById('coins').replaceChildren(...coins.map((name) => chip(name, name === current, () => {
    input.coin.value = name;
    setError('coin', '');
    renderCoins();
    showQuantity();
    input.money.focus();
  })));
}

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

function setError(name, text) {
  document.getElementById(`${name}-error`).textContent = text;
  const field = name === 'portfolio' && input.portfolio.hidden ? null : input[name];
  field?.setAttribute('aria-invalid', String(text !== ''));
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const coin = input.coin.value.trim().toUpperCase();
  const money = normalize(input.money.value);
  const price = normalize(input.price.value);
  const portfolio = input.portfolio.hidden ? selectedPortfolio : portfolioName(input.portfolio.value);
  // Недонабранную дату поле отдаёт пустой; молча подставить сегодняшнюю
  // значило бы записать не ту дату, что человек вводил.
  const date = input.date.value;

  const problems = {
    coin: coin ? '' : 'Укажите монету',
    money: isAmount(money) ? '' : 'Нужно число больше нуля, например 200',
    price: isAmount(price) ? '' : 'Нужно число больше нуля, например 146.12',
    portfolio: portfolio ? '' : 'Укажите, где лежит монета',
    date: !isDate(date) ? 'Укажите дату полностью' : date > today() ? 'Дата ещё не наступила' : '',
  };
  for (const [name, text] of Object.entries(problems)) setError(name, text);
  const firstProblem = Object.keys(problems).find((name) => problems[name]);
  if (firstProblem) {
    document.getElementById('status').textContent = '';
    input[firstProblem].focus();
    return;
  }

  operations.push({ type: 'buy', date, coin, portfolio, money, price });
  moveToFront(portfolios, portfolio);
  moveToFront(coins, coin);
  selectedPortfolio = portfolio;
  addingPortfolio = false;

  document.getElementById('status').textContent =
    `Записано: ${formatAmount(quantityOf(money, price), 8)} ${coin} за ${money} $ по ${price} $ — ` +
    `${portfolio}, ${date.split('-').reverse().join('.')}`;

  // Дата возвращается к сегодняшней: иначе после одной старой покупки
  // следующая, сегодняшняя, молча записалась бы задним числом.
  input.coin.value = coin;
  input.money.value = '';
  input.price.value = '';
  input.portfolio.value = '';
  input.date.value = today();
  showQuantity();
  renderCoins();
  renderPortfolios();
  document.activeElement.blur();
});

// Enter на клавиатуре телефона ведёт к следующему полю, а в цене — записывает.
for (const [from, to] of [[input.coin, input.money], [input.money, input.price]]) {
  from.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    to.focus();
  });
}

// Исправляемое поле перестаёт быть красным сразу, а не после следующей записи.
for (const name of ['coin', 'money', 'price', 'portfolio', 'date']) {
  input[name].addEventListener('input', () => setError(name, ''));
}
input.coin.addEventListener('input', () => { renderCoins(); showQuantity(); });
input.money.addEventListener('input', showQuantity);
input.price.addEventListener('input', showQuantity);

// Календарь на телефоне не даст выбрать будущий день.
input.date.max = today();
input.date.value = today();
renderCoins();
renderPortfolios();
