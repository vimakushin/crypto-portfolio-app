// Проверка облака Телеграма на живом. Код приложения опирается на вещи, которых
// нет в документации и которые нельзя проверить без самого Телеграма; эта
// страница проверяет их на настоящем облаке и показывает факты, а не вывод
// «всё хорошо».
//
// Порядок важен: сначала всё, что должно получиться, потом слой хранения
// целиком, и только в самом конце заведомо избыточные записи, на которые
// Телеграм не отвечает вовсе. Повисший вызов не должен влиять на проверки,
// которые идут после него, — а мешает ли он на самом деле, показывает
// последний блок.
//
// Свои данные приложения страница не трогает: все её ключи начинаются с «x-chk-».

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

// Срок ожидания каждого вызова облака. Исправный вызов занимает десятки
// миллисекунд, так что восьми секунд хватает с большим запасом, а страница не
// стоит минутами на каждом повисшем вызове. Не дождались — это «не удалось»,
// а не успех и не вечное ожидание.
const CALL_LIMIT = 8000;
const bytes = (text) => new TextEncoder().encode(text).length;

// Вызов облака без нашей обёртки: нужны сырые ответы, как их видит клиент.
function rawCall(cloud, method, ...args) {
  return new Promise((resolve) => {
    const started = performance.now();
    const timer = setTimeout(() => resolve({ timeout: true }), CALL_LIMIT);
    try {
      cloud[method](...args, (error, result) => {
        clearTimeout(timer);
        resolve({ error, result, ms: performance.now() - started });
      });
    } catch (thrown) {
      clearTimeout(timer);
      resolve({ thrown: String(thrown) });
    }
  });
}

const describe = (call) => (call.timeout ? `нет ответа за ${CALL_LIMIT / 1000} секунд (ни ошибки, ни подтверждения)`
  : call.thrown ? `исключение: ${call.thrown}`
  : call.error ? `ошибка: ${JSON.stringify(call.error)}`
  : `ответ ${JSON.stringify(call.result)} (${call.result === null ? 'null' : typeof call.result}), ${Math.round(call.ms)} мс`);
const succeeded = (call) => !call.timeout && !call.thrown && !call.error;
const accepted = (call) => succeeded(call) && call.result === true;

const ours = (key) => key === 'm' || /^c[a-z0-9]+_\d+$/.test(key);

// Приставка ключей этой страницы. Дефис в ней нарочно: ключ приложения
// (c + буквы и цифры + «_» + номер) с такой приставки начаться не может, и
// оборванная проверка не оставит ничего, что приложение приняло бы за обломки
// своих данных.
const PREFIX = 'x-chk-';

// Слой хранения видит облако через ключи с этой приставкой: настоящие данные
// приложения (ключи «m», «c…») ему не видны и не затрагиваются.
function prefixed(backend) {
  return {
    get: (key) => backend.get(`${PREFIX}${key}`),
    set: (key, value) => backend.set(`${PREFIX}${key}`, value),
    remove: (keys) => backend.remove(keys.map((key) => `${PREFIX}${key}`)),
    keys: async () => (await backend.keys()).filter((key) => key.startsWith(PREFIX)).map((key) => key.slice(PREFIX.length)),
  };
}

// Облако, записывающее каждый вызов слоя: что вызвали, сколько байт, чем
// кончилось и за сколько. Если слой споткнулся, по этой записи видно, на каком
// именно вызове — без догадок.
function traced(cloud, trace) {
  const wrap = (method) => (...args) => {
    const callback = args.pop();
    const entry = {
      method,
      what: method === 'setItem' ? `${args[0].slice(PREFIX.length)}, ${bytes(args[1])} байт, кавычек ${(args[1].match(/"/g) ?? []).length}`
        : method === 'removeItems' ? `${args[0].length} ключ(ей)`
        : method === 'getItem' ? args[0].slice(PREFIX.length)
        : '',
      started: performance.now(),
      done: false,
    };
    trace.push(entry);
    return cloud[method](...args, (error, result) => {
      entry.done = true;
      entry.ms = performance.now() - entry.started;
      entry.outcome = error ? `ошибка ${JSON.stringify(error)}` : `ответ ${String(JSON.stringify(result)).slice(0, 30)}`;
      callback(error, result);
    });
  };
  return { getItem: wrap('getItem'), setItem: wrap('setItem'), removeItems: wrap('removeItems'), getKeys: wrap('getKeys') };
}

function printTrace(trace) {
  log('    ВЫЗОВЫ СЛОЯ (по порядку; последний без ответа — то место, где повисло):');
  for (const [index, entry] of trace.entries()) {
    log(`      ${index + 1}. ${entry.method} ${entry.what} → ${entry.done ? `${entry.outcome}, ${Math.round(entry.ms)} мс` : 'НЕТ ОТВЕТА'}`);
  }
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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Если слой хранения споткнулся — подбираем, на чём именно: куски настоящего
// JSON разного размера, кавычки, переводы строк, удаление нескольких ключей.
async function diagnose(cloud, text) {
  log();
  log('    ПОДБОР: что именно не проходит (каждая проба — одна запись; «нет ответа» — повисла)');
  const probe = async (label, value) => {
    const call = await rawCall(cloud, 'setItem', `${PREFIX}probe`, value);
    log(`      ${label}: ${bytes(value)} байт → ${accepted(call) ? `принято, ${Math.round(call.ms)} мс` : describe(call)}`);
    return accepted(call);
  };
  for (const size of [1000, 2000, 3000, 3500, 4000, 4096]) {
    await probe(`кусок настоящего JSON (как в слое), размер до ${size}`, splitByBytes(text, size)[0]);
  }
  await probe('только кавычки', '"'.repeat(4096));
  await probe('только кавычки, половина', '"'.repeat(2048));
  await probe('только переводы строки', '\n'.repeat(4096));
  await probe('только обратные косые черты', '\\'.repeat(2048));
  await probe('русская буква и кавычка', 'ж"'.repeat(1365));
  // Несколько ключей разом (так слой убирает старые части).
  await rawCall(cloud, 'setItem', `${PREFIX}r1`, '1');
  await rawCall(cloud, 'setItem', `${PREFIX}r2`, '2');
  await rawCall(cloud, 'setItem', `${PREFIX}r3`, '3');
  const several = await rawCall(cloud, 'removeItems', [`${PREFIX}r1`, `${PREFIX}r2`, `${PREFIX}r3`]);
  log(`      удаление трёх ключей разом → ${describe(several)}`);
  await rawCall(cloud, 'removeItems', [`${PREFIX}probe`]);
}

async function run() {
  if (!insideTelegram(window)) {
    document.getElementById('verdict').textContent = 'Приложение не узнало Телеграм';
    log('Страница считает, что открыта не внутри Телеграма. Если вы открыли её из бота, то ошибается определение — пришлите этот текст, по признакам ниже видно, чего не хватило. Если вы открыли её в обычном браузере, так и должно быть: адрес страницы нужно указать боту у BotFather (например, как адрес кнопки меню) и открыть из бота.');
    log();
    log('ПРИЗНАКИ');
    for (const line of signs()) log(`    ${line}`);
    return false;
  }
  const scriptStarted = performance.now();
  await loadTelegram(window, document);
  const scriptMs = performance.now() - scriptStarted;
  const app = window.Telegram.WebApp;
  const cloud = app.CloudStorage;

  log('СРЕДА');
  log(`    Телеграм: версия Bot API ${app.version}, платформа ${app.platform}`);
  log(`    версия 6.9 или новее: ${app.isVersionAtLeast('6.9')}`);
  log(`    окно: ${window.innerWidth}×${window.innerHeight}, масштаб ${window.devicePixelRatio}`);
  log(`    язык: ${navigator.language}, дата в этом языке: ${new Date(2026, 9, 25).toLocaleDateString()}`);
  log(`    браузер: ${navigator.userAgent}`);
  for (const line of signs()) log(`    ${line}`);
  log(`    скрипт Телеграма загрузился за ${Math.round(scriptMs)} мс`);
  log(`    срок ожидания каждого вызова облака в этой проверке: ${CALL_LIMIT / 1000} с`);
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
  verdict(2, 'setItem отвечает true', accepted(stored),
    `setItem → ${describe(stored)}. Приложение считает запись удавшейся только при ровно true; иначе каждая запись показывалась бы как «не удалось сохранить».`);
  const readBack = await rawCall(cloud, 'getItem', `${PREFIX}probe`);
  verdict('2а', 'записанное читается обратно без изменений', succeeded(readBack) && readBack.result === 'проверка',
    `getItem → ${describe(readBack)}`);
  const removed = await rawCall(cloud, 'removeItems', [`${PREFIX}probe`]);
  verdict('2б', 'removeItems отвечает true', accepted(removed),
    `removeItems → ${describe(removed)}. Приложение так же требует true при удалении старых частей.`);

  // 3. Предел значения: то, что должно проходить.
  const ascii = await rawCall(cloud, 'setItem', `${PREFIX}limit`, 'a'.repeat(4096));
  verdict(3, 'значение в 4096 байт (латинские буквы) принимается', accepted(ascii), `4096 латинских → ${describe(ascii)}`);
  const cyrillicBytes = await rawCall(cloud, 'setItem', `${PREFIX}limit`, 'ж'.repeat(2048));
  verdict('3б', 'значение ровно в 4096 байт (2048 русских букв) принимается', accepted(cyrillicBytes), `2048 русских букв → ${describe(cyrillicBytes)}`);
  const emoji = await rawCall(cloud, 'setItem', `${PREFIX}limit`, '😀'.repeat(1024));
  verdict('3в', 'значение ровно в 4096 байт (1024 эмодзи) принимается', accepted(emoji), `1024 эмодзи → ${describe(emoji)}`);
  const bigBack = await rawCall(cloud, 'getItem', `${PREFIX}limit`);
  verdict('3г', 'значение в 4096 байт читается обратно целиком', succeeded(bigBack) && bigBack.result === '😀'.repeat(1024), `getItem → ${succeeded(bigBack) ? `длина ${String(bigBack.result).length}, ${Math.round(bigBack.ms)} мс` : describe(bigBack)}`);
  await rawCall(cloud, 'removeItems', [`${PREFIX}limit`]);

  // 4. Чужие ключи в облаке.
  const foreign = keysBefore.filter((key) => !ours(key) && !key.startsWith(PREFIX));
  verdict(4, 'в облаке нет чужих ключей, съедающих лимит в 1024', keysKnown && foreign.length === 0,
    keysKnown
      ? `ключей до проверки: ${keysBefore.length}; из них не наших: ${foreign.length}${foreign.length ? ` (${foreign.slice(0, 10).join(', ')})` : ''}.`
      : `список ключей получить не удалось (getKeys → ${describe(before)}), проверить нечего`);

  // 5. Весь слой хранения на живом облаке, под приставкой x-chk-.
  const trace = [];
  const store = createStore(prefixed(telegramBackend(traced(cloud, trace), CALL_LIMIT)));
  const operations = Array.from({ length: 150 }, (_, index) => ({
    type: 'buy', date: `2026-01-${String(1 + (index % 28)).padStart(2, '0')}`, coin: 'solana', symbol: 'SOL',
    portfolio: index % 2 ? 'Кошелёк' : 'Binance', money: String(10 + index), price: '100.5',
  }));
  const realText = JSON.stringify({ operations, names: { solana: 'Solana' } });
  let layerOk = false;
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
    layerOk = sameState && cleaned && keysAfter.length === expectedKeys && left.length === 0;
    verdict(5, 'слой хранения целиком работает на живом облаке (запись, чтение, перезапись, чистка, стирание)', layerOk,
      `прочитанное совпало: ${sameState}; вторая запись прочиталась: ${cleaned}; ключей после второй записи ${keysAfter.length} (ожидалось ${expectedKeys}); первая запись ${Math.round(saved)} мс; после стирания ключей: ${left.length}`);
  } catch (error) {
    verdict(5, 'слой хранения целиком работает на живом облаке', false, `ошибка: ${error.message}`);
  }
  // Сколько времени занимают вызовы слоя — по ним выбирается срок ожидания в приложении.
  const answered = trace.filter((entry) => entry.done).map((entry) => entry.ms);
  log(`    вызовов слоя: ${trace.length}, ответили: ${answered.length}${answered.length ? `, медиана ${Math.round(median(answered))} мс, самый долгий ${Math.round(Math.max(...answered))} мс` : ''}`);
  if (!layerOk) {
    printTrace(trace);
    await diagnose(cloud, realText);
  }
  // Что бы ни случилось, слой после себя убирает; на всякий случай — ещё раз.
  const strays = ((await rawCall(cloud, 'getKeys')).result ?? []).filter((key) => key.startsWith(PREFIX));
  if (strays.length > 0) await rawCall(cloud, 'removeItems', strays);

  // 6. Скорость: сколько занимает сохранение, пока человек ждёт «Сохраняю…».
  const readTimes = [];
  const writeTimes = [];
  for (let index = 0; index < 5; index++) {
    const write = await rawCall(cloud, 'setItem', `${PREFIX}speed`, String(index));
    if (write.ms !== undefined) writeTimes.push(write.ms);
    const read = await rawCall(cloud, 'getItem', `${PREFIX}speed`);
    if (read.ms !== undefined) readTimes.push(read.ms);
  }
  await rawCall(cloud, 'removeItems', [`${PREFIX}speed`]);
  log();
  log('СКОРОСТЬ (одна операция облака, миллисекунды)');
  if (writeTimes.length && readTimes.length) {
    log(`    запись: медиана ${Math.round(median(writeTimes))}, самая долгая ${Math.round(Math.max(...writeTimes))}`);
    log(`    чтение: медиана ${Math.round(median(readTimes))}, самая долгая ${Math.round(Math.max(...readTimes))}`);
  } else {
    log('    замерить не удалось: вызовы не отвечали');
  }
  log('    (одна запись приложения — это части плюс главная запись плюс чистка, обычно 3–5 вызовов подряд)');

  // 7. В самом конце — записи сверх предела. Телеграм на них не отвечает ни
  // ошибкой, ни подтверждением (так было в первом прогоне); здесь выясняется,
  // мешает ли повисший вызов тем, что идут после него, и приходит ли на него
  // когда-нибудь запоздалый ответ.
  log();
  log('ЗАПИСИ СВЕРХ ПРЕДЕЛА И ВОССТАНОВЛЕНИЕ КАНАЛА (последний блок)');
  const normal = async (label) => {
    const call = await rawCall(cloud, 'getItem', `${PREFIX}alive`);
    log(`    ${label}: ${describe(call)}`);
    return succeeded(call);
  };
  const late = [];
  const overflow = (label, value) => {
    const started = performance.now();
    cloud.setItem(`${PREFIX}over`, value, (error, result) => {
      late.push(`запоздалый ответ на «${label}» через ${Math.round((performance.now() - started) / 1000)} с: ${error ? `ошибка ${JSON.stringify(error)}` : `ответ ${JSON.stringify(result)}`}`);
    });
  };

  const overAscii = 'a'.repeat(4097);
  const overCyrillic = 'ж'.repeat(4096);
  log(`    записываем ${bytes(overAscii)} байт (4097 латинских) и НЕ ждём ответа…`);
  overflow('4097 латинских', overAscii);
  const whilePending = await normal('обычный вызов, пока повисший ещё висит');
  await pause(CALL_LIMIT + 500);
  const afterLimit = await normal(`обычный вызов через ${CALL_LIMIT / 1000} с после повисшего`);
  log(`    записываем ${bytes(overCyrillic)} байт (4096 русских букв) и НЕ ждём ответа…`);
  overflow('4096 русских букв', overCyrillic);
  const afterSecond = await normal('обычный вызов сразу после второго повисшего');
  await pause(20000);
  const afterTwenty = await normal('обычный вызов через 20 секунд');
  log(late.length ? `    ${late.join('\n    ')}` : '    запоздалых ответов на повисшие вызовы за это время не пришло');
  const alive = whilePending && afterLimit && afterSecond && afterTwenty;
  verdict('7', 'после повисшего вызова облако продолжает отвечать', alive,
    alive ? 'все обычные вызовы до, во время и после повисших ответили: канал не забивается'
      : 'один из обычных вызовов не ответил: повисший вызов мешает последующим (см. строки выше)');
  const overStored = await rawCall(cloud, 'getItem', `${PREFIX}over`);
  log(`    после этого значение под ключом записи сверх предела: ${succeeded(overStored) ? JSON.stringify(String(overStored.result).slice(0, 20)) : describe(overStored)} (пусто — запись не прошла)`);
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
