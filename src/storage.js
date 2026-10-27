// Хранение внесённых операций. Один слой и две подкладки: облачное хранилище
// Телеграма внутри Телеграма и localStorage в обычном браузере. Остальное
// приложение не знает, где именно лежат данные.
//
// Хранятся исходные операции, а не результаты расчёта: в операциях числа уже
// строки, а в результатах BigInt, который в JSON не пишется. Порядок операций
// внутри одного дня влияет на среднюю, поэтому порядок массива — часть данных.
//
// Облачное хранилище Телеграма (Bot API 6.9) принимает значение до 4096
// знаков по ключу из букв, цифр, «_» и «-», ключей не больше 1024, а записать
// несколько ключей разом нельзя. Поэтому данные режутся на части, а чтобы
// недописанная запись не стала состоянием, работает правило «сначала всё
// новое, потом один переключатель»:
//
//   1. новые части пишутся под новыми ключами (старые данные не трогаются);
//   2. пишется главная запись — один ключ m_<поколение>: сколько частей,
//      сколько операций и контрольная сумма всего текста. Это и есть момент,
//      когда новое состояние становится текущим (читается самая новая главная
//      запись). Ключ у каждого сохранения свой, поэтому запись, которая дошла
//      до облака с опозданием, ложится под свой ключ и новую не затирает;
//   3. только потом, прочитав новую главную запись обратно, удаляется всё,
//      что старше неё: части и главные записи прошлых сохранений.
//
// Оборвалась запись на любом шаге — главная запись по-прежнему указывает на
// целое прошлое состояние. А чтение не верит ничему на слово: нет части,
// не сошлась сумма или счёт — данные «не целы», и считать по тому, что
// нашлось, нельзя: неверная средняя хуже отсутствующей.

import { checkHistory } from './calc.js';

// Знаков в значении — до 4096; в документации не сказано, знаки это или
// байты, поэтому считаем байты: так влезает при любом из двух прочтений.
export const CHUNK_BYTES = 4096;

// Ключей не больше 1024, а на время записи рядом лежат две версии данных
// (старая и новая) и главная запись: 2·500 + 1 = 1001.
export const MAX_CHUNKS = 500;

// Главная запись лежит под ключом m_<поколение>. Просто «m» — так её клали
// первые версии: если новых главных записей нет, читается она, а первое же
// сохранение её убирает.
const MANIFEST_PREFIX = 'm_';
const LEGACY_MANIFEST = 'm';
const FORMAT = 1;
const chunkKey = (generation, index) => `c${generation}_${index}`;
const isChunkKey = (key) => /^c[a-z0-9]+_\d+$/.test(key);
const isManifestKey = (key) => /^m_[a-z0-9]+$/.test(key);

// Облако Телеграма отдаёт пустую строку и для отсутствующего ключа, различить
// их нельзя, поэтому пустые значения не пишем и читаем как «нет».
const present = (value) => (typeof value === 'string' && value !== '' ? value : null);

// --- Части ---

function utf8Length(codePoint) {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

// Режет текст на части не длиннее limit байт, не разрывая знак посередине.
export function splitByBytes(text, limit = CHUNK_BYTES) {
  const pieces = [];
  let current = '';
  let size = 0;
  for (const character of text) {
    const bytes = utf8Length(character.codePointAt(0));
    if (size + bytes > limit) {
      pieces.push(current);
      current = '';
      size = 0;
    }
    current += character;
    size += bytes;
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

async function checksum(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Поколение — время создания (9 знаков, миллисекунды в системе счисления 36) и
// 12 случайных знаков. По времени поколения упорядочены: «самое новое» — то,
// что читается, а всё старше него после подтверждённого сохранения убирается.
// Поколения старых версий (12 знаков, без времени) старше любого со временем.
const GENERATION_LENGTH = 21;
const timed = (generation) => typeof generation === 'string' && generation.length === GENERATION_LENGTH;
const rank = (generation) => (timed(generation) ? generation : '');
const timeOf = (generation) => parseInt(generation.slice(0, 9), 36);

// Новое поколение получает время больше, чем у любого поколения, которое мы
// видим в облаке: часы могли шагнуть назад или отставать от часов другого
// устройства, а запись обязана считаться самой новой для всех, кто её увидел.
// Одновременные записи двух устройств, не видящих друг друга, упорядочиваются
// как придётся.
function newGeneration(seen) {
  const time = Math.max(Date.now(), seen + 1);
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return time.toString(36).padStart(9, '0') + [...bytes].map((byte) => byte.toString(36).padStart(2, '0')).join('');
}

// Чьё поколение у ключа; null — ключ не наш. Просто «m» — главная запись
// первых версий, старше любой.
function generationOf(key) {
  if (key === LEGACY_MANIFEST) return '';
  if (isChunkKey(key)) return key.slice(1, key.indexOf('_'));
  if (isManifestKey(key)) return key.slice(MANIFEST_PREFIX.length);
  return null;
}

// Самая новая главная запись среди ключей (новые, со временем в имени).
const newestManifestKey = (keys) => keys.filter((key) => isManifestKey(key) && timed(generationOf(key))).sort().at(-1) ?? null;

// Ключи старше поколения newest: их заменило более новое сохранение, и читать
// их уже никто не станет — даже если такая запись дойдёт до облака позже,
// главной она не станет, потому что есть более новая. Поэтому убирать их можно
// всегда; ключи новее (запись другой вкладки, которая идёт сейчас) не трогаем.
const deadKeys = (keys, newest) => keys.filter((key) => {
  const generation = generationOf(key);
  return generation !== null && rank(generation) < newest;
});

// Ключей в хранилище Телеграма не больше 1024; ближе к этому остатки старых
// записей мешают новой, и их убирают до неё.
const CROWDED = 1000;

// text — уже готовый текст состояния, operations — сколько в нём операций.
// Оба взяты в одно мгновение: пока части пишутся по сети, человек может
// внести ещё одну, и счёт в главной записи не должен отстать от текста.
// Бросает ошибку, если сохранить не вышло, и тогда прежнее сохранённое
// состояние остаётся как было.
async function save(backend, text, operations) {
  const pieces = splitByBytes(text);
  if (pieces.length > MAX_CHUNKS) {
    throw new Error('Данных больше, чем помещается в хранилище: выгрузите их в файл');
  }
  const before = await backend.keys();
  // Если ключей накопилось столько, что новая запись упрётся в лимит, убирать
  // заменённое надо до неё, а не после. Убирается только то, что старше самой
  // новой главной записи; без неё (первое сохранение, прежние данные в старом
  // виде) не трогаем ничего.
  const newest = newestManifestKey(before);
  if (newest !== null && before.length + pieces.length + 2 > CROWDED) {
    await backend.remove(deadKeys(before, generationOf(newest))).catch(() => {});
  }
  const seen = Math.max(0, ...before.map(generationOf).filter(timed).map(timeOf));
  const generation = newGeneration(seen);
  const written = [];
  try {
    for (const [index, piece] of pieces.entries()) {
      await backend.set(chunkKey(generation, index), piece);
      written.push(chunkKey(generation, index));
    }
  } catch (error) {
    // Главная запись ещё не тронута, новые части никому не нужны.
    await backend.remove(written).catch(() => {});
    throw error;
  }

  // Если результат этой записи неизвестен, новые части не удаляем: она могла
  // пройти, и тогда главная запись на них уже указывает. Неизвестным он бывает
  // только после перепроверки и повторов (см. telegramBackend.set): молчание
  // облака исходом не считается. Определённый отказ облака (ошибка или не
  // true) не повторяется и сразу становится ошибкой записи.
  const manifest = { v: FORMAT, gen: generation, chunks: pieces.length, ops: operations, sha: await checksum(text) };
  const manifestText = JSON.stringify(manifest);
  const manifestKey = MANIFEST_PREFIX + generation;
  await backend.set(manifestKey, manifestText);

  // Старое убирается только после того, как новая главная запись прочитана из
  // облака. Не прочиталась — не убираем, подметёт следующее сохранение. Не
  // вышло убрать — не беда: лишние ключи ничему не мешают. Главная запись
  // другой вкладки, если она новее нашей, остаётся вместе со своими частями.
  try {
    if (present(await backend.get(manifestKey)) !== manifestText) return;
    const keys = await backend.keys();
    const top = newestManifestKey(keys);
    const newestNow = top !== null && generationOf(top) > generation ? generationOf(top) : generation;
    await backend.remove(deadKeys(keys, newestNow));
  } catch {
    // см. выше
  }
}

// Возвращает { status: 'empty' } | { status: 'ok', state } | { status: 'broken', reason }.
// У «не целы» из-за того, что хранилище не ответило, есть ещё retry: true —
// данные могут быть в порядке, нужно прочитать заново, а не стирать.
async function load(backend) {
  try {
    const keys = await backend.keys();
    const manifestKey = newestManifestKey(keys) ?? (keys.includes(LEGACY_MANIFEST) ? LEGACY_MANIFEST : null);
    if (manifestKey === null) {
      return keys.some(isChunkKey)
        ? { status: 'broken', reason: 'найдены части данных, но нет главной записи о них (если это самая первая запись, оборванная при закрытии страницы, потеряна только она; если нет — данные повреждены)' }
        : { status: 'empty' };
    }
    const manifestText = present(await backend.get(manifestKey));
    if (manifestText === null) {
      return { status: 'broken', retry: true, reason: 'главная запись исчезла во время чтения (её могла заменить другая вкладка)' };
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      return { status: 'broken', reason: 'главная запись повреждена' };
    }
    const sound = manifest !== null && typeof manifest === 'object'
      && Number.isInteger(manifest.chunks) && manifest.chunks >= 1 && manifest.chunks <= MAX_CHUNKS
      && Number.isInteger(manifest.ops) && manifest.ops >= 0
      && /^[a-z0-9]+$/.test(manifest.gen ?? '') && /^[0-9a-f]{64}$/.test(manifest.sha ?? '')
      && (manifestKey === LEGACY_MANIFEST || manifest.gen === generationOf(manifestKey));
    if (!sound) return { status: 'broken', reason: 'главная запись повреждена' };
    if (manifest.v !== FORMAT) {
      return { status: 'broken', reason: `данные записаны более новой версией приложения (формат ${manifest.v})` };
    }

    const pieces = [];
    for (let index = 0; index < manifest.chunks; index++) {
      const piece = present(await backend.get(chunkKey(manifest.gen, index)));
      if (piece === null) return { status: 'broken', reason: `не найдена часть ${index + 1} из ${manifest.chunks}` };
      pieces.push(piece);
    }
    const text = pieces.join('');
    if (await checksum(text) !== manifest.sha) {
      return { status: 'broken', reason: 'контрольная сумма не сошлась: данные изменены или записаны не до конца' };
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      return { status: 'broken', reason: 'данные не читаются' };
    }
    if (!Array.isArray(state?.operations) || state.operations.length !== manifest.ops) {
      return { status: 'broken', reason: 'число операций не совпало с записанным' };
    }
    return { status: 'ok', state };
  } catch (error) {
    // Не смогли прочитать — не значит, что данных нет. Пустым это не считаем.
    return { status: 'broken', retry: true, reason: `хранилище не отвечает: ${error.message}` };
  }
}

// Всё, что приложение положило в хранилище.
async function erase(backend) {
  const keys = (await backend.keys()).filter((key) => generationOf(key) !== null);
  // Главные записи первыми: оборвётся посередине — останутся части без них,
  // а это уже «не целы», а не «целы».
  const manifests = keys.filter((key) => key === LEGACY_MANIFEST || isManifestKey(key));
  await backend.remove([...manifests, ...keys.filter((key) => !manifests.includes(key))]);
}

// Записи идут строго по очереди: две одновременные не перемешают ключи.
export function createStore(backend) {
  let queue = Promise.resolve();
  // Сохранение, которое стоит в очереди и ещё не началось: новое состояние
  // заменяет его, и пишется одно последнее. Промежуточные записывать незачем,
  // а при медленном облаке они выстроились бы друг за другом.
  let waiting = null;
  const inOrder = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  return {
    load: () => inOrder(() => load(backend)),
    // Состояние снимается сразу, в момент вызова, а не когда дойдёт очередь.
    save: (state) => {
      const text = JSON.stringify(state);
      const operations = state.operations.length;
      if (waiting !== null) {
        waiting.text = text;
        waiting.operations = operations;
        return waiting.result;
      }
      const job = { text, operations };
      waiting = job;
      job.result = inOrder(() => {
        waiting = null;
        return save(backend, job.text, job.operations);
      });
      return job.result;
    },
    erase: () => {
      waiting = null;
      return inOrder(() => erase(backend));
    },
  };
}

// --- Подкладки ---
// Общий вид: get(key) → строка или null; set(key, value); remove(keys);
// keys() → все ключи приложения. Все — через промисы.

// localStorage общий на весь адрес сайта, а на этом адресе (GitHub Pages)
// лежат и другие страницы автора, поэтому ключи с приставкой.
export function localBackend(storage, prefix = 'crypto-portfolio-app/') {
  return {
    get: async (key) => storage.getItem(prefix + key),
    set: async (key, value) => storage.setItem(prefix + key, value),
    remove: async (keys) => { for (const key of keys) storage.removeItem(prefix + key); },
    keys: async () => Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
  };
}

// Облако Телеграма: колбэки «ошибка первым аргументом», как в документации.
// Клиент может не ответить вовсе; без срока ожидания приложение зависло бы на
// чтении. Что измерено на живом облаке (один iPhone): обычные вызовы отвечают за
// 70–340 мс; примерно каждая десятая запись отвечает через 3–7 с (один раз
// через 9 с) или не отвечает совсем, причём часть таких записей всё же ложится.
// Срок 7 с выбран владельцем и не подбирался: после срока исход всё равно
// узнаётся перечитыванием и повтором (см. set), так что срок влияет только на то,
// как долго висит «Сохраняю…», а не на сохранность данных.
const RETRIES = 2;
export function telegramBackend(cloud, timeoutMs = 7000) {
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('Телеграм не ответил'), { silent: true })), timeoutMs);
    cloud[method](...args, (error, result) => {
      clearTimeout(timer);
      if (error) reject(new Error(String(error)));
      else resolve(result);
    });
  });
  const confirmed = (result) => {
    if (result !== true) throw new Error('Телеграм не подтвердил запись');
  };
  return {
    get: async (key) => present(await call('getItem', key)),
    // Молчание не объявляем ни успехом, ни провалом: смотрим, что лежит под
    // ключом. Лежит то, что мы писали, — записано. Нет — пишем ещё раз (тот же
    // ключ и то же значение, повтор ничего не портит), всего не больше двух
    // повторов, и после последнего тоже смотрим. На живом облаке примерно половина записей без ответа не
    // находилась и через десять секунд, а часть находилась: одного
    // перечитывания мало. Ошибку, которую облако прислало само, не повторяем.
    set: async (key, value) => {
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
          confirmed(await call('setItem', key, value));
          return;
        } catch (error) {
          if (!error.silent) throw error;
        }
        try {
          if (present(await call('getItem', key)) === value) return;
        } catch { /* перечитать не вышло — как «не нашли» */ }
      }
      throw new Error('Телеграм не ответил');
    },
    remove: async (keys) => { if (keys.length > 0) confirmed(await call('removeItems', keys)); },
    keys: () => call('getKeys'),
  };
}

// Внутри Телеграма (inTelegram — это решает telegram.js) данные лежат только
// в его облаке: если облака нет, молча писать в localStorage его браузера
// нельзя — потом, когда облако появится, записи «пропали бы». Вне Телеграма —
// localStorage; если и его нет (закрыт настройками браузера) — null.
// Данные пользователя Телеграма (initData) здесь не трогаем.
export function pickBackend(scope, inTelegram = false) {
  if (inTelegram) {
    // Скрипт Телеграма не подключился — бросит, и start() покажет причину.
    const app = scope.Telegram.WebApp;
    if (!app.isVersionAtLeast('6.9')) {
      return { kind: 'unsupported', reason: 'Эта версия Телеграма не умеет хранить данные в облаке (нужна 6.9 или новее) — обновите Телеграм' };
    }
    return { kind: 'telegram', backend: telegramBackend(app.CloudStorage) };
  }
  try {
    const probe = 'crypto-portfolio-app/probe';
    scope.localStorage.setItem(probe, '1');
    scope.localStorage.removeItem(probe);
    return { kind: 'browser', backend: localBackend(scope.localStorage) };
  } catch {
    return null;
  }
}

// --- Файл выгрузки ---
//
// Тот же состав, что в хранилище: исходные операции и названия монет. Одна
// операция — одна строка, чтобы файл можно было читать глазами и сверять.
// Метка и версия нужны, чтобы чужой JSON не приняли за свой.

export const FILE_LIMIT_BYTES = 5_000_000;

export function makeExport(state, when = new Date()) {
  const lines = state.operations.map((operation) => `  ${JSON.stringify(operation)}`);
  return `{\n "app": "crypto-portfolio-app",\n "version": ${FORMAT},\n "exportedAt": ${JSON.stringify(when.toISOString())},\n`
    + ` "names": ${JSON.stringify(state.names ?? {})},\n "operations": [\n${lines.join(',\n')}\n ]\n}\n`;
}

// Разбирает файл выгрузки. Возвращает { ok: true, state } или { ok: false,
// message } — файл принимается целиком или не принимается: половина
// операций дала бы неверные средние. Если в файле плохая операция, в
// сообщении её номер и что с ней не так.
export function readExport(content) {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > FILE_LIMIT_BYTES) {
    return { ok: false, message: `файл больше ${FILE_LIMIT_BYTES / 1_000_000} МБ` };
  }
  let file;
  try {
    file = JSON.parse(content);
  } catch {
    return { ok: false, message: 'это не выгрузка: файл не читается как JSON' };
  }
  if (file === null || typeof file !== 'object' || file.app !== 'crypto-portfolio-app') {
    return { ok: false, message: 'это не выгрузка этого приложения' };
  }
  if (file.version !== FORMAT) {
    return { ok: false, message: `формат ${file.version} этот вариант приложения не читает` };
  }
  const names = file.names ?? {};
  if (names === null || typeof names !== 'object' || Array.isArray(names) || !Object.values(names).every((name) => typeof name === 'string')) {
    return { ok: false, message: 'названия монет (names) записаны не так, как нужно' };
  }
  const problem = checkHistory(file.operations);
  if (problem !== null) {
    if (problem.index === null) return { ok: false, message: problem.message };
    const operation = file.operations[problem.index];
    const label = [typeof operation?.date === 'string' ? operation.date : null, typeof operation?.symbol === 'string' ? operation.symbol : null]
      .filter(Boolean).join(', ');
    return { ok: false, message: `запись №${problem.index + 1} из ${file.operations.length}${label ? ` (${label})` : ''}: ${problem.message}` };
  }
  return { ok: true, state: { operations: file.operations, names } };
}
