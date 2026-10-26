// Текущие цены и поиск монет — CoinGecko. Это единственное обращение
// приложения наружу, и идёт оно прямо с устройства человека: своего сервера
// у приложения нет, и автор не видит ни запросов, ни монет.
//
// Лимит у CoinGecko без ключа очень строгий: по их же странице поддержки
// 5–15 запросов в минуту в зависимости от нагрузки по всему миру, и считается
// он по адресу — общему для всех, кто сидит за одним адресом. Ошибки в лимит
// входят тоже. Поэтому запросов нужно как можно меньше:
//   - цены всех монет приходят одним запросом и помнятся минуту;
//   - результаты поиска помнятся десять минут, и один и тот же запрос не
//     уходит дважды, пока первый в пути;
//   - получив отказ (429), минуту не шлём ничего: каждый новый запрос только
//     продлил бы отказ.

const API = 'https://api.coingecko.com/api/v3';

// Дольше ждать нет смысла: без цены приложение работает, а человек ждёт.
const TIMEOUT = 5000;

// CoinGecko сам обновляет цены раз в 30–60 секунд, чаще спрашивать незачем.
const FRESH = 60_000;

// Что нашёл поиск, почти не меняется.
const SEARCH_FRESH = 10 * 60_000;

// Сколько ждать после отказа. Сервер не сообщает, сколько именно (заголовок
// Retry-After браузер странице не показывает), а лимит минутный.
const BACKOFF = 60_000;

const cache = new Map(); // код монеты → { price, at }
const searched = new Map(); // запрос → { coins, at }
const asking = new Map(); // запрос → запрос в пути
let busyUntil = 0;

// Ошибка с busy — CoinGecko на связи, но просит подождать (ответ 429). Это
// не то же самое, что «нет связи»: монету без привязки записываем только
// во втором случае. retryIn — через сколько миллисекунд можно пробовать снова.
async function get(path) {
  const waiting = busyUntil - Date.now();
  if (waiting > 0) {
    throw Object.assign(new Error('CoinGecko просил подождать'), { busy: true, retryIn: waiting });
  }
  // AbortSignal.timeout удобнее, но его нет в iOS до 16-й версии.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(API + path, { signal: controller.signal });
    if (!response.ok) {
      const busy = response.status === 429;
      if (busy) busyUntil = Date.now() + BACKOFF;
      throw Object.assign(new Error(`CoinGecko ответил ${response.status}`), busy ? { busy, retryIn: BACKOFF } : {});
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Монеты по названию или тикеру, самые крупные первыми. Код монеты (id) —
// то, что хранится в операциях: у одного тикера бывают десятки разных монет.
export async function searchCoins(query) {
  const key = query.trim().toLowerCase();
  const known = searched.get(key);
  if (known && Date.now() - known.at < SEARCH_FRESH) return known.coins;
  if (asking.has(key)) return asking.get(key);
  const request = (async () => {
    const { coins } = await get(`/search?query=${encodeURIComponent(query.trim())}`);
    const found = coins.slice(0, 6).map(({ id, symbol, name }) => ({ id, symbol: symbol.toUpperCase(), name }));
    searched.set(key, { coins: found, at: Date.now() });
    return found;
  })().finally(() => asking.delete(key));
  asking.set(key, request);
  return request;
}

// Map: код монеты → цена в долларах строкой, как её принимает расчёт.
// Монеты, которых CoinGecko не знает, в ответ не попадают. Если сеть не
// ответила, бросает ошибку — устаревшую цену молча не подставляем.
export async function fetchPrices(ids) {
  const now = Date.now();
  const stale = ids.filter((id) => !(cache.get(id)?.at > now - FRESH));
  if (stale.length > 0) {
    const data = await get(`/simple/price?ids=${stale.map(encodeURIComponent).join(',')}&vs_currencies=usd`);
    for (const id of stale) {
      if (typeof data[id]?.usd === 'number') cache.set(id, { price: toDecimal(data[id].usd), at: now });
    }
  }
  return new Map(ids.filter((id) => cache.get(id)?.at > now - FRESH).map((id) => [id, cache.get(id).price]));
}

// Цена приходит числом JSON. String() дал бы «2.9e-7» у дешёвых монет, а
// расчёт принимает только «0.00000029». 15 значащих цифр — столько, сколько
// число JSON хранит точно: получается ровно то, что прислал CoinGecko, без
// хвоста вроде 104.40000000000001.
export function toDecimal(number) {
  return new Intl.NumberFormat('en-US', { useGrouping: false, maximumSignificantDigits: 15 }).format(number);
}
