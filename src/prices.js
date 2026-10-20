// Текущие цены и поиск монет — CoinGecko. Это единственное обращение
// приложения наружу, и идёт оно прямо с устройства человека: своего сервера
// у приложения нет, и автор не видит ни запросов, ни монет.
//
// Ограничение частоты у CoinGecko считается по адресу устройства, а не на
// всё приложение, поэтому у каждого человека свой запас. Цены всех монет
// приходят одним запросом: 25 монет — один запрос, а не 25.

const API = 'https://api.coingecko.com/api/v3';

// Дольше ждать нет смысла: без цены приложение работает, а человек ждёт.
const TIMEOUT = 5000;

// CoinGecko сам обновляет цены раз в 30–60 секунд, чаще спрашивать незачем.
const FRESH = 60_000;

const cache = new Map(); // код монеты → { price, at }

// Ошибка с busy — CoinGecko на связи, но просит подождать (ответ 429). Это
// не то же самое, что «нет связи»: монету без привязки записываем только
// во втором случае.
async function get(path) {
  // AbortSignal.timeout удобнее, но его нет в iOS до 16-й версии.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(API + path, { signal: controller.signal });
    if (!response.ok) {
      throw Object.assign(new Error(`CoinGecko ответил ${response.status}`), { busy: response.status === 429 });
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Монеты по названию или тикеру, самые крупные первыми. Код монеты (id) —
// то, что хранится в операциях: у одного тикера бывают десятки разных монет.
export async function searchCoins(query) {
  const { coins } = await get(`/search?query=${encodeURIComponent(query)}`);
  return coins.slice(0, 6).map(({ id, symbol, name }) => ({ id, symbol: symbol.toUpperCase(), name }));
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
