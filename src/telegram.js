// Телеграм подключается только когда страница открыта внутри него: из обычного
// браузера приложение не должно обращаться к telegram.org.
//
// Определить это нужно до загрузки его скрипта, и официальная документация
// способа не называет. Поэтому берём то, чем пользуется сам скрипт
// (telegram-web-app.js, он публичный): Телеграм передаёт параметры запуска в
// хеше адреса, а скрипт запоминает их в sessionStorage, потому что при
// перезагрузке внутри Телеграма хеш может потеряться. И чтобы это не
// сработало на чужой ссылке с таким хешем, нужен ещё канал связи с клиентом —
// без него скрипту некуда слать вызовы.
//
// Смотрим только на ИМЕНА параметров версии и платформы. Данные пользователя
// (tgWebAppData: имя, идентификатор) мы не читаем, не храним и никуда не
// отправляем — единственное, что берём у Телеграма, это облачное хранилище.

const SCRIPT = 'https://telegram.org/js/telegram-web-app.js';

function hasLaunchParams(scope) {
  // Как и у скрипта Телеграма: после «?» — если в хеше есть путь («#путь?…»).
  const names = (text) => {
    const hash = text.replace(/^#/, '');
    const question = hash.indexOf('?');
    return new URLSearchParams(question >= 0 ? hash.slice(question + 1) : hash);
  };
  const fromHash = names(scope.location?.hash ?? '');
  if (fromHash.has('tgWebAppVersion') || fromHash.has('tgWebAppPlatform')) return true;
  try {
    const stored = JSON.parse(scope.sessionStorage.getItem('__telegram__initParams') ?? 'null');
    return stored !== null && typeof stored === 'object' && ('tgWebAppVersion' in stored || 'tgWebAppPlatform' in stored);
  } catch {
    return false;
  }
}

// Те же три канала, что у скрипта Телеграма: приложения (Android, iOS,
// компьютер), старый канал Windows и страница внутри iframe (веб-версия).
function hasTelegramChannel(scope) {
  return scope.TelegramWebviewProxy !== undefined
    || (scope.external !== undefined && scope.external !== null && 'notify' in scope.external)
    || (scope.parent !== undefined && scope.parent !== scope);
}

export function insideTelegram(scope) {
  return hasLaunchParams(scope) && hasTelegramChannel(scope);
}

// Подключает скрипт Телеграма и ждёт, пока появится Telegram.WebApp.
export function loadTelegram(scope, doc, timeoutMs = 8000) {
  if (scope.Telegram?.WebApp) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    const timer = setTimeout(() => reject(new Error('скрипт Телеграма не загрузился за отведённое время')), timeoutMs);
    script.src = SCRIPT;
    script.onload = () => {
      clearTimeout(timer);
      if (scope.Telegram?.WebApp) resolve();
      else reject(new Error('скрипт Телеграма загрузился, но не подключился'));
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('скрипт Телеграма не загрузился'));
    };
    doc.head.append(script);
  });
}

// Сообщает клиенту, что страница готова: пока этого нет, Телеграм держит
// заставку загрузки поверх неё.
export function telegramReady(scope) {
  try {
    scope.Telegram?.WebApp?.ready();
  } catch {
    // Заставка уйдёт сама; из-за неё приложение не должно ломаться.
  }
}
