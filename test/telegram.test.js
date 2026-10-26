import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideTelegram, loadTelegram, telegramReady } from '../src/telegram.js';

const storage = (stored) => ({ getItem: () => (stored === undefined ? null : JSON.stringify(stored)) });
const scope = (extra = {}) => ({ location: { hash: '' }, parent: undefined, ...extra });

test('внутри Телеграма: параметры запуска в хеше и канал связи с клиентом', () => {
  const hash = '#tgWebAppData=user%3D1&tgWebAppVersion=8.0&tgWebAppPlatform=android&tgWebAppThemeParams=%7B%7D';
  // Приложения: канал TelegramWebviewProxy.
  assert.equal(insideTelegram(scope({ location: { hash }, TelegramWebviewProxy: {} })), true);
  // Старый канал Windows.
  assert.equal(insideTelegram(scope({ location: { hash }, external: { notify() {} } })), true);
  // Веб-версия: страница в iframe.
  assert.equal(insideTelegram({ location: { hash }, parent: {} }), true);
});

test('адрес мини-приложения с путём в хеше («#путь?параметры») понимается, как у скрипта Телеграма', () => {
  const proxy = { TelegramWebviewProxy: {} };
  assert.equal(insideTelegram(scope({ ...proxy, location: { hash: '#screen/main?tgWebAppVersion=8.0&tgWebAppPlatform=ios' } })), true);
  assert.equal(insideTelegram(scope({ ...proxy, location: { hash: '#screen/main' } })), false);
});

test('перезагрузка внутри Телеграма: хеш потерян, но скрипт Телеграма запомнил параметры', () => {
  const proxy = { TelegramWebviewProxy: {} };
  assert.equal(insideTelegram(scope({ ...proxy, sessionStorage: storage({ tgWebAppVersion: '8.0' }) })), true);
  assert.equal(insideTelegram(scope({ ...proxy, sessionStorage: storage({ tgWebAppPlatform: 'ios' }) })), true);
  assert.equal(insideTelegram(scope({ ...proxy, sessionStorage: storage({}) })), false);
});

test('обычный браузер: Телеграм не определяется и скрипт не нужен', () => {
  assert.equal(insideTelegram(scope()), false);
  assert.equal(insideTelegram(scope({ location: { hash: '#about' } })), false);
  assert.equal(insideTelegram(scope({ sessionStorage: storage(undefined) })), false);
  // Хранилище сессии недоступно или в нём не JSON — это «нет», а не падение.
  assert.equal(insideTelegram(scope({ sessionStorage: { getItem() { throw new Error('SecurityError'); } } })), false);
  assert.equal(insideTelegram(scope({ sessionStorage: { getItem: () => '{не json' } })), false);
});

test('чужая ссылка с таким хешем без канала связи — не Телеграм', () => {
  assert.equal(insideTelegram(scope({ location: { hash: '#tgWebAppVersion=8.0&tgWebAppPlatform=web' } })), false);
  // Страница сама верхняя (не в iframe) и канала нет.
  const top = { location: { hash: '#tgWebAppVersion=8.0' } };
  top.parent = top;
  assert.equal(insideTelegram(top), false);
});

test('данные пользователя (tgWebAppData) не читаются: одного их наличия мало', () => {
  assert.equal(insideTelegram(scope({ location: { hash: '#tgWebAppData=user%3D1' }, TelegramWebviewProxy: {} })), false);
});

function fakeDocument(behaviour) {
  const appended = [];
  return {
    appended,
    createElement: () => ({}),
    head: { append(script) { appended.push(script); setTimeout(() => behaviour(script), 0); } },
  };
}

test('скрипт Телеграма подключается по адресу telegram.org и ждёт Telegram.WebApp', async () => {
  const window = {};
  const doc = fakeDocument((script) => { window.Telegram = { WebApp: {} }; script.onload(); });
  await loadTelegram(window, doc);
  assert.equal(doc.appended[0].src, 'https://telegram.org/js/telegram-web-app.js');
});

test('скрипт уже есть — второй раз не грузится', async () => {
  const doc = fakeDocument(() => assert.fail('не должно грузиться'));
  await loadTelegram({ Telegram: { WebApp: {} } }, doc);
  assert.equal(doc.appended.length, 0);
});

test('скрипт не загрузился, не подключился или завис — ошибка, а не молчание', async () => {
  await assert.rejects(loadTelegram({}, fakeDocument((script) => script.onerror())), /не загрузился/);
  await assert.rejects(loadTelegram({}, fakeDocument((script) => script.onload())), /не подключился/);
  await assert.rejects(loadTelegram({}, fakeDocument(() => {}), 30), /за отведённое время/);
});

test('ready() сообщает клиенту о готовности; его сбой приложение не ломает', () => {
  let called = 0;
  telegramReady({ Telegram: { WebApp: { ready: () => { called += 1; } } } });
  assert.equal(called, 1);
  telegramReady({ Telegram: { WebApp: { ready() { throw new Error('нет'); } } } });
  telegramReady({});
});
