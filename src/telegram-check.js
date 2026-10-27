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
// Сквозной номер вызова облака за всё время работы страницы (и прямых, и слоя): по нему видно, не сбиваются ли отказы к концу.
let made = 0;

// Вызов облака без нашей обёртки: нужны сырые ответы, как их видит клиент.
function rawCall(cloud, method, ...args) {
  made++;
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
    made++;
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
// Удаление порциями: за один вызов сотни ключей удалять не пробовали.
async function removeAll(cloud, keys) {
  for (let from = 0; from < keys.length; from += 50) await rawCall(cloud, 'removeItems', keys.slice(from, from + 50));
}
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

// Номер сборки страницы: Телеграм на телефоне может показать старую копию из кэша,
// и по этой строке в присланном тексте видно, какая версия на самом деле работала.
const BUILD = 'повторы-8';

// Один и тот же кусок слоя пишется много раз подряд под разными ключами, и отдельно
// — короткие значения с обратными косыми. Если зависания случайны, они будут и у
// одинаковых значений; если зависает только содержимое, то каждый раз одно и то же.
// Записи одного значения подряд под новыми ключами; у каждой аномальной (нет ответа
// или ответ позже секунды) смотрим, когда и лежит ли значение.
//
// Контроль: нечётные записи «с опросом» — пока нет ответа, ключ читается каждые
// 0,4 с. Чётные «без опроса» — до самых поздних проверок их ничто не трогает. Это
// нужно потому, что в пятом прогоне, где чтение шло рядом с записью, зависших
// стало вдвое больше, а медленных втрое меньше, чем в четвёртом, где чтений не
// было: возможно, чтение мешает записи. У обеих групп одинаково проверяется,
// лежит ли значение через 10 с и через 60 с после начала записи.
//   ПРЕДСКАЗАНИЕ владельца (записано до прогона): мост роняет запрос, клиент
//   переотправляет его раз в ~2 с, значение появится около 2, 4, 6 с. Альтернатива:
//   значение лежит сразу, теряется подтверждение. Третье: «не дошло» в одном
//   прогоне значило «посмотрели слишком рано» — тогда на 60 с значение лежит везде.
async function pacing(cloud, chunk, total = 300, gap = 0, label = '') {
  const lines = [];
  const pending = [];
  const groups = {
    'с опросом': { writes: 0, hung: 0, slow: 0, at10: 0, at60: 0 },
    'без опроса': { writes: 0, hung: 0, slow: 0, at10: 0, at60: 0 },
  };
  const present = async (key) => { const read = await rawCall(cloud, 'getItem', key); return succeeded(read) ? read.result === chunk : null; };
  const word = (found) => (found === null ? 'чтение не ответило' : found ? 'лежит' : 'пусто');
  for (let index = 0; index < total; index++) {
    if (gap > 0) await pause(gap);
    const key = `${PREFIX}${label}pace${index}`;
    const watched = index % 2 === 1;
    const group = groups[watched ? 'с опросом' : 'без опроса'];
    group.writes++;
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);
    let quick = false;
    const writing = rawCall(cloud, 'setItem', key, chunk).then((call) => { quick = accepted(call) && call.ms <= 1000; return call; });
    // Появилось значение между чтением, начатым на lastMiss мс, и чтением, начатым на firstHit мс.
    // Опрос идёт, пока запись не ответила быстро, но не дольше 60 с: до 8 с каждые 0,4 с, потом каждые 2 с.
    const watcher = watched ? (async () => {
      await pause(600);
      let lastMiss = null;
      while (!quick && since() < 60000) {
        const readStarted = since();
        if (await present(key)) return { lastMiss, firstHit: readStarted };
        lastMiss = readStarted;
        await pause(readStarted < 8000 ? 400 : 2000);
      }
      return null;
    })() : null;
    const call = await writing;
    const number = made;
    if (accepted(call) && call.ms <= 1000) continue;
    const hung = !accepted(call);
    if (hung) group.hung++; else group.slow++;
    // Опрос и поздние проверки идут в фоне и не задерживают следующие записи.
    pending.push((async () => {
      const found = watcher ? await watcher : null;
      const polled = !watched ? 'опроса не было'
        : found ? (found.lastMiss === null ? `при первом чтении (${found.firstHit} мс) значение уже лежало` : `значение появилось между ${found.lastMiss} и ${found.firstHit} мс`)
        : 'за 60 с опроса значение не появилось';
      const wait = (ms) => pause(Math.max(0, ms - (performance.now() - started)));
      await wait(10000);
      const at10 = await present(key);
      await wait(60000);
      const at60 = await present(key);
      if (at10) group.at10++;
      if (at60) group.at60++;
      lines.push({ index, text: `запись ${index + 1}-я (вызов №${number}, ${watched ? 'с опросом' : 'без опроса'}): ${hung ? `НЕТ ОТВЕТА за ${CALL_LIMIT / 1000} с` : `МЕДЛЕННО, ответ на ${Math.round(call.ms)} мс`}; ${polled}; на 10 с ${word(at10)}, на 60 с ${word(at60)}` });
    })());
  }
  await Promise.all(pending);
  log(`      ${total} записей куска слоя (4096 байт)${gap > 0 ? ` с паузой ${gap / 1000} с перед каждой` : ' подряд'}:`);
  for (const [name, g] of Object.entries(groups)) {
    log(`        ${name}: записей ${g.writes}; без ответа ${g.hung}, медленных ${g.slow}; из аномальных лежит на 10 с — ${g.at10}, на 60 с — ${g.at60}`);
  }
  for (const line of lines.sort((a, b) => a.index - b.index)) log(`        ${line.text}`);
}

async function repeats(cloud, text) {
  log();
  log('    ПОВТОРЫ: одно и то же значение несколько раз подряд (принято/нет ответа)');
  const chunk = splitByBytes(text, 4096)[0];
  const outcomes = async (label, value, times) => {
    const results = [];
    let hung = 0;
    let slow = 0;
    for (let index = 0; index < times; index++) {
      const key = `${PREFIX}rep${index}`;
      const call = await rawCall(cloud, 'setItem', key, value);
      const number = made;
      if (accepted(call)) {
        if (call.ms > 1000) slow++;
        results.push(`№${number}:${Math.round(call.ms)}`);
      } else {
        // Повисшая запись: легла она всё-таки или нет — от этого зависит, чего стоит перечитывание после срока.
        hung++;
        await pause(2000);
        const back = await rawCall(cloud, 'getItem', key);
        results.push(`№${number}:НЕТ(${succeeded(back) && back.result === value ? 'значение лежит' : 'пусто'})`);
      }
    }
    log(`      ${label} (${bytes(value)} байт) ×${times}: не ответили ${hung}, дольше секунды ${slow}`);
    log(`        (№ — номер вызова за сеанс; мс или НЕТ): ${results.join(' ')}`);
  };
  await pacing(cloud, chunk);
  for (const count of [1, 10, 100, 500, 2048]) await outcomes(`обратных косых: ${count}`, '\\'.repeat(count), 3);
  await removeAll(cloud, Array.from({ length: 300 }, (_, index) => `${PREFIX}pace${index}`));
}

// Пять частей слоя по очереди и пять разом, раунды вперемешку. Если облако
// переваривает параллельные вызовы, раунд «разом» занимает время одного вызова.
async function parallelism(cloud, text) {
  log();
  log('    ПАРАЛЛЕЛЬНО ИЛИ ПО ОЧЕРЕДИ: пять частей по 4096 байт, 20 раундов каждого способа вперемешку, каждый раунд под новыми ключами');
  const pieces = splitByBytes(text, 4096).slice(0, 5);
  const stats = { 'по очереди': [], 'разом': [] };
  for (let round = 0; round < 20; round++) {
    for (const mode of ['по очереди', 'разом']) {
      const started = performance.now();
      let calls;
      if (mode === 'разом') {
        calls = await Promise.all(pieces.map((piece, index) => rawCall(cloud, 'setItem', `${PREFIX}par${round}a${index}`, piece)));
      } else {
        calls = [];
        for (const [index, piece] of pieces.entries()) calls.push(await rawCall(cloud, 'setItem', `${PREFIX}par${round}b${index}`, piece));
      }
      stats[mode].push({ ms: performance.now() - started, hung: calls.filter((call) => !accepted(call)).length });
    }
  }
  for (const [mode, rounds] of Object.entries(stats)) {
    const clean = rounds.filter((round) => round.hung === 0).map((round) => round.ms);
    const hungParts = rounds.reduce((sum, round) => sum + round.hung, 0);
    log(`      ${mode}: частей не ответили ${hungParts} из ${rounds.length * 5}; раундов без сбоев ${clean.length} из ${rounds.length}${clean.length ? `, из них медиана ${Math.round(median(clean))} мс, самый долгий ${Math.round(Math.max(...clean))} мс` : ''}`);
  }
  const parKeys = (await rawCall(cloud, 'getKeys')).result?.filter((key) => key.startsWith(`${PREFIX}par`)) ?? [];
  for (let from = 0; from < parKeys.length; from += 50) await rawCall(cloud, 'removeItems', parKeys.slice(from, from + 50));
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
  log(`    сборка страницы проверки: ${BUILD}`);
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
  await removeAll(cloud, leftovers);

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
  await repeats(cloud, realText);
  await parallelism(cloud, realText);
  // Что бы ни случилось, слой после себя убирает; на всякий случай — ещё раз.
  const strays = ((await rawCall(cloud, 'getKeys')).result ?? []).filter((key) => key.startsWith(PREFIX));
  await removeAll(cloud, strays);

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
  await removeAll(cloud, mine);
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
