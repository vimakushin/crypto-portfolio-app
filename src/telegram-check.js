// Проверка облака Телеграма на живом. Код приложения опирается на четыре
// вещи, которых нет в документации и которые нельзя проверить без самого
// Телеграма; эта страница проверяет их на настоящем облаке и показывает
// факты, а не вывод «всё хорошо».
//
// Свои данные приложения она не трогает: все её ключи начинаются с «chk».

import { createStore, splitByBytes, telegramBackend } from './storage.js';
import { insideTelegram, loadTelegram, telegramReady } from './telegram.js';

const lines = [];
const log = (text = '') => {
  lines.push(text);
  document.getElementById('log').textContent = lines.join('\n');
};
const failures = [];

// Каждая проверка пишет «ожидалось — получилось» и вердикт.
function verdict(number, title, ok, detail) {
  log(`${ok ? 'ПОДТВЕРДИЛОСЬ' : 'НЕ ПОДТВЕРДИЛОСЬ'}  ${number}. ${title}`);
  log(`    ${detail}`);
  if (!ok) failures.push(number);
}

// Вызов облака без нашей обёртки: нужны сырые ответы, как их видит клиент.
function rawCall(cloud, method, ...args) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 15000);
    try {
      cloud[method](...args, (error, result) => {
        clearTimeout(timer);
        resolve({ error, result });
      });
    } catch (thrown) {
      clearTimeout(timer);
      resolve({ thrown: String(thrown) });
    }
  });
}

const describe = (call) => (call.timeout ? 'нет ответа за 15 секунд'
  : call.thrown ? `исключение: ${call.thrown}`
  : call.error ? `ошибка: ${JSON.stringify(call.error)}`
  : `ответ ${JSON.stringify(call.result)} (${call.result === null ? 'null' : typeof call.result})`);
const succeeded = (call) => !call.timeout && !call.thrown && !call.error;

const ours = (key) => key === 'm' || /^c[a-z0-9]+_\d+$/.test(key);

// Приставка ключей этой страницы. Дефис в ней нарочно: ключ приложения
// (c + буквы и цифры + «_» + номер) с такой приставки начаться не может, и
// оборванная проверка не оставит ничего, что приложение приняло бы за обломки
// своих данных.
const PREFIX = 'x-chk-';

// Слой хранения видит облако через ключи с приставкой «chk»: настоящие
// данные приложения (ключи «m», «c…») ему не видны и не затрагиваются.
function prefixed(backend) {
  return {
    get: (key) => backend.get(`${PREFIX}${key}`),
    set: (key, value) => backend.set(`${PREFIX}${key}`, value),
    remove: (keys) => backend.remove(keys.map((key) => `${PREFIX}${key}`)),
    keys: async () => (await backend.keys()).filter((key) => key.startsWith(PREFIX)).map((key) => key.slice(PREFIX.length)),
  };
}

// Какие признаки Телеграма страница видит: только имена параметров, без значений.
// Самый важный вопрос прогона — узнаёт ли приложение Телеграм, — и если нет,
// по этим строкам видно, чего не хватило.
function signs() {
  const hash = location.hash.replace(/^#/, '');
  const question = hash.indexOf('?');
  const names = [...new URLSearchParams(question >= 0 ? hash.slice(question + 1) : hash).keys()];
  let remembered;
  try {
    const stored = JSON.parse(sessionStorage.getItem('__telegram__initParams') ?? 'null');
    remembered = stored ? Object.keys(stored).join(', ') : 'нет';
  } catch {
    remembered = 'не читается';
  }
  return [
    `имена параметров в адресе: ${names.join(', ') || 'нет'}`,
    `запомнено скриптом Телеграма: ${remembered}`,
    `канал связи: TelegramWebviewProxy ${window.TelegramWebviewProxy !== undefined}, window.external.notify ${Boolean(window.external && 'notify' in window.external)}, iframe ${window.parent !== window}`,
  ];
}

const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];

async function run() {
  if (!insideTelegram(window)) {
    document.getElementById('verdict').textContent = 'Приложение не узнало Телеграм';
    log('Страница считает, что открыта не внутри Телеграма. Если вы открыли её из бота, то ошибается определение — пришлите этот текст, по признакам ниже видно, чего не хватило. Если вы открыли её в обычном браузере, так и должно быть: адрес страницы нужно указать боту у BotFather (например, как адрес кнопки меню) и открыть из бота.');
    log();
    log('ПРИЗНАКИ');
    for (const line of signs()) log(`    ${line}`);
    return false;
  }
  await loadTelegram(window, document);
  const app = window.Telegram.WebApp;
  const cloud = app.CloudStorage;

  log('СРЕДА');
  log(`    Телеграм: версия Bot API ${app.version}, платформа ${app.platform}`);
  log(`    версия 6.9 или новее: ${app.isVersionAtLeast('6.9')}`);
  log(`    окно: ${window.innerWidth}×${window.innerHeight}, масштаб ${window.devicePixelRatio}`);
  log(`    язык: ${navigator.language}, дата в этом языке: ${new Date(2026, 9, 25).toLocaleDateString()}`);
  log(`    браузер: ${navigator.userAgent}`);
  for (const line of signs()) log(`    ${line}`);
  log();

  if (!app.isVersionAtLeast('6.9')) {
    verdict(0, 'Телеграм умеет облачное хранилище', false, 'версия ниже 6.9: облака нет, приложение скажет об этом человеку');
    return true;
  }

  // Что в облаке уже есть, до наших записей.
  const before = await rawCall(cloud, 'getKeys');
  const keysKnown = succeeded(before) && Array.isArray(before.result);
  const keysBefore = keysKnown ? before.result : [];
  // Остатки прошлого запуска этой страницы.
  const leftovers = keysBefore.filter((key) => key.startsWith(PREFIX));
  if (leftovers.length > 0) await rawCall(cloud, 'removeItems', leftovers);

  // 1. Отсутствующий ключ.
  const missing = await rawCall(cloud, 'getItem', `${PREFIX}missing`);
  const harmless = succeeded(missing) && (missing.result === '' || missing.result === null || missing.result === undefined);
  verdict(1, 'для отсутствующего ключа приходит пустая строка (или null)', harmless,
    `getItem(несуществующий ключ) → ${describe(missing)}. Код приложения читает «пусто», null и undefined одинаково как «ключа нет»; любое другое значение было бы расхождением.`);

  // 2. Подтверждение записи.
  const stored = await rawCall(cloud, 'setItem', `${PREFIX}probe`, 'проверка');
  verdict(2, 'setItem отвечает true', succeeded(stored) && stored.result === true,
    `setItem → ${describe(stored)}. Приложение считает запись удавшейся только при ровно true; иначе каждая запись показывалась бы как «не удалось сохранить».`);
  const readBack = await rawCall(cloud, 'getItem', `${PREFIX}probe`);
  verdict('2а', 'записанное читается обратно без изменений', succeeded(readBack) && readBack.result === 'проверка',
    `getItem → ${describe(readBack)}`);
  const removed = await rawCall(cloud, 'removeItems', [`${PREFIX}probe`]);
  verdict('2б', 'removeItems отвечает true', succeeded(removed) && removed.result === true,
    `removeItems → ${describe(removed)}. Приложение так же требует true при удалении старых частей.`);

  // 3. Предел значения.
  const ascii = await rawCall(cloud, 'setItem', `${PREFIX}limit`, 'a'.repeat(4096));
  verdict(3, 'значение в 4096 знаков принимается', succeeded(ascii) && ascii.result === true, `4096 латинских → ${describe(ascii)}`);
  const over = await rawCall(cloud, 'setItem', `${PREFIX}limit`, 'a'.repeat(4097));
  verdict('3а', 'значение в 4097 знаков отклоняется (предел действует)', !succeeded(over) || over.result !== true, `4097 латинских → ${describe(over)}`);
  const cyrillicFull = await rawCall(cloud, 'setItem', `${PREFIX}limit`, 'ж'.repeat(4096));
  log(`    СВЕДЕНИЕ: 4096 русских букв (8192 байта) → ${describe(cyrillicFull)}`);
  const cyrillicAnswered = !cyrillicFull.timeout && !cyrillicFull.thrown;
  log(`    ${!cyrillicAnswered ? 'Определить не удалось: Телеграм не ответил.'
    : succeeded(cyrillicFull) && cyrillicFull.result === true ? 'Телеграм считает ЗНАКИ: предел в 4096 знаков.'
    : 'Телеграм считает БАЙТЫ: предел в 4096 байт.'} Приложение режет по байтам, поэтому влезает при любом из двух.`);
  const cyrillicBytes = await rawCall(cloud, 'setItem', `${PREFIX}limit`, 'ж'.repeat(2048));
  verdict('3б', 'часть ровно в 4096 байт (русские буквы) принимается', succeeded(cyrillicBytes) && cyrillicBytes.result === true, `2048 русских букв → ${describe(cyrillicBytes)}`);
  const emoji = await rawCall(cloud, 'setItem', `${PREFIX}limit`, '😀'.repeat(1024));
  verdict('3в', 'часть ровно в 4096 байт (эмодзи) принимается', succeeded(emoji) && emoji.result === true, `1024 эмодзи → ${describe(emoji)}`);
  await rawCall(cloud, 'removeItems', [`${PREFIX}limit`]);

  // 4. Чужие ключи в облаке.
  const foreign = keysBefore.filter((key) => !ours(key) && !key.startsWith(PREFIX));
  verdict(4, 'в облаке нет чужих ключей, съедающих лимит в 1024', keysKnown && foreign.length === 0,
    keysKnown
      ? `ключей до проверки: ${keysBefore.length}; из них не наших: ${foreign.length}${foreign.length ? ` (${foreign.slice(0, 10).join(', ')})` : ''}.`
      : `список ключей получить не удалось (getKeys → ${describe(before)}), проверить нечего`);

  // 5. Весь слой хранения на живом облаке, под приставкой chk.
  const store = createStore(prefixed(telegramBackend(cloud)));
  const operations = Array.from({ length: 150 }, (_, index) => ({
    type: 'buy', date: `2026-01-${String(1 + (index % 28)).padStart(2, '0')}`, coin: 'solana', symbol: 'SOL',
    portfolio: index % 2 ? 'Кошелёк' : 'Binance', money: String(10 + index), price: '100.5',
  }));
  let layer = '';
  try {
    const t0 = performance.now();
    await store.save({ operations, names: { solana: 'Solana' } });
    const saved = performance.now() - t0;
    const loaded = await store.load();
    const sameState = loaded.status === 'ok' && JSON.stringify(loaded.state.operations) === JSON.stringify(operations);
    await store.save({ operations: operations.slice(0, 100), names: {} });
    const keysAfter = (await rawCall(cloud, 'getKeys')).result.filter((key) => key.startsWith(PREFIX));
    // Остаться должны части второго состояния и главная запись, и ничего от первого.
    const expectedKeys = splitByBytes(JSON.stringify({ operations: operations.slice(0, 100), names: {} })).length + 1;
    const second = await store.load();
    const cleaned = second.status === 'ok' && second.state.operations.length === 100;
    await store.erase();
    const left = (await rawCall(cloud, 'getKeys')).result.filter((key) => key.startsWith(PREFIX));
    layer = `первая запись ${Math.round(saved)} мс; ключей после второй записи: ${keysAfter.length}; после стирания: ${left.length}`;
    verdict(5, 'слой хранения целиком работает на живом облаке (запись, чтение, перезапись, чистка, стирание)',
      sameState && cleaned && keysAfter.length === expectedKeys && left.length === 0,
      `прочитанное совпало: ${sameState}; вторая запись прочиталась: ${cleaned}; ключей после второй записи ${keysAfter.length} (ожидалось ${expectedKeys}); ${layer}`);
  } catch (error) {
    verdict(5, 'слой хранения целиком работает на живом облаке', false, `ошибка: ${error.message}`);
  }

  // 6. Скорость: сколько секунд занимает сохранение, пока человек ждёт «Сохраняю…».
  const readTimes = [];
  const writeTimes = [];
  for (let index = 0; index < 5; index++) {
    let t = performance.now();
    await rawCall(cloud, 'setItem', `${PREFIX}speed`, String(index));
    writeTimes.push(performance.now() - t);
    t = performance.now();
    await rawCall(cloud, 'getItem', `${PREFIX}speed`);
    readTimes.push(performance.now() - t);
  }
  await rawCall(cloud, 'removeItems', [`${PREFIX}speed`]);
  log();
  log('СКОРОСТЬ (одна операция облака, миллисекунды)');
  log(`    запись: медиана ${Math.round(median(writeTimes))}, самая долгая ${Math.round(Math.max(...writeTimes))}`);
  log(`    чтение: медиана ${Math.round(median(readTimes))}, самая долгая ${Math.round(Math.max(...readTimes))}`);
  log('    (одна запись приложения — это части плюс главная запись плюс чистка, обычно 3–5 вызовов подряд)');
  return true;
}

async function cleanUp() {
  const cloud = window.Telegram?.WebApp?.CloudStorage;
  if (!cloud) return;
  const keys = await rawCall(cloud, 'getKeys');
  const mine = Array.isArray(keys.result) ? keys.result.filter((key) => key.startsWith(PREFIX)) : [];
  if (mine.length > 0) await rawCall(cloud, 'removeItems', mine);
}

try {
  // Итог пишется только если проверки действительно шли; иначе остаётся то, что написала run().
  if (await run()) {
    document.getElementById('verdict').textContent = failures.length === 0 ? 'Всё подтвердилось' : `Не подтвердилось: ${failures.join(', ')}`;
  }
} catch (error) {
  log(`ОШИБКА СТРАНИЦЫ: ${error.message}`);
  document.getElementById('verdict').textContent = 'Проверка не завершилась';
}
await cleanUp().catch(() => {});
telegramReady(window);

const copy = document.getElementById('copy');
copy.hidden = false;
copy.addEventListener('click', async () => {
  const text = `${document.getElementById('verdict').textContent}\n\n${lines.join('\n')}`;
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById('copied').textContent = 'Скопировано';
  } catch {
    document.getElementById('copied').textContent = 'Не удалось скопировать: выделите текст и скопируйте вручную';
  }
});
