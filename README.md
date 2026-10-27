# crypto-portfolio-app

Tracks crypto holdings spread across several exchanges and wallets, with the average entry price for each portfolio and for each coin as a whole.

**Open it:** https://vimakushin.github.io/crypto-portfolio-app/

Work in progress. The app can be opened as a Telegram Mini App. The cloud storage was measured on one iPhone, and the protection against its unreliable replies has been tested only against a fake, not against the live cloud, so it is not ready for everyday use in Telegram. The interface is in Russian only. See [Status](#status).

## The interesting part

The hard part is not the interface. It is keeping the weighted average entry price correct when coins move between exchanges and wallets.

A transfer is not a trade. Moving a coin from an exchange to a wallet must not change the coin's overall average price: the money moves with the coins, at the sending portfolio's average cost. The receiving portfolio blends it with what it already holds.

The network fee stays with the coins that arrive. Send 1 coin bought for $146, receive 0.995: the $146 is now spread over 0.995 coins, and the average rises to $146.73. Writing the fee off and keeping the old average would understate what each coin cost. Two things have to hold together: with no fee, the overall average does not change; with a fee, it rises. The tests below check both.

The same rule applies to an exchange fee taken in coins on a purchase: the money stays on the coins actually received.

The rules have tests (`test/calc.test.js`):

- a transfer without a fee leaves the overall average exactly unchanged (the test compares integers, with no tolerance);
- a transfer with a fee raises it to the total invested divided by the coins that remain (to within 10⁻²⁰);
- a sale does not change the average of the portfolio it was sold from (to within 10⁻²⁰). The overall average can still move, because the mix of portfolios has changed; keeping both levels fixed at once is impossible, and the code explains why.

## Design decisions

**The data belongs to the user.** There is no server of its own and no separate account. The only requests that leave the device are for current prices and coin search, sent directly to the CoinGecko public API (CoinGecko sees the coin ids and the search text). Opened inside Telegram, the page also loads Telegram's own script from telegram.org, and the history is saved in Telegram's cloud storage instead of the browser; opened in an ordinary browser, it does not contact telegram.org at all.

**It keeps its CoinGecko requests to a minimum.** As of October 2026, CoinGecko's [support page](https://support.coingecko.com/hc/en-us/articles/4538771776153-What-is-the-rate-limit-for-CoinGecko-API-public-plan) lists the keyless public API at 5 to 15 calls per minute, depending on global load, and its [rate-limit error documentation](https://docs.coingecko.com/docs/common-errors-rate-limit.md) says the limit is counted per IP address and that failed requests count too. These are CoinGecko's figures, not ours; in one test of ours the first 429 came after five calls in a row. So prices for all coins in the list are requested in one call and kept for a minute; search results are kept for ten; a search starts only after the typing pauses and needs at least two characters; and after a 429 the app sends nothing for a minute, then retries the search by itself if the query has not changed. In a scripted test, typing "solana" one character every 0.6 seconds sent six searches with the earlier 0.4-second pause; with the current 0.7-second pause it sends one.

**It uses nothing from Telegram except the cloud storage.** Telegram hands a Mini App the user's name and id (`initData`). The app does not use, keep or send it (Telegram's own script holds it for the tab). To tell whether the page is running inside Telegram before Telegram's script is loaded, the app checks only whether two launch parameter names are present (in the address, or in what Telegram's script saved for the tab) and whether the channel Telegram uses to talk to the page exists. It does not use the values.

**It does not ask for exchange API keys, seed phrases or private keys.** Holdings are entered by hand. Connecting to exchanges is out of scope: it would mean storing users' access keys.

**Amounts are fixed-point integers, not floating-point numbers.** Every amount and quantity is a `BigInt` counted in units of 10⁻³⁰. Addition and subtraction are exact; division rounds at the 30th decimal place. One tolerance exists: a sale or transfer that differs from the whole position by less than 10⁻²⁶ of a coin is treated as the whole position. That is why the transfer test above can require exact equality.

**Coins are identified by their CoinGecko id, never by ticker.** As of October 2026, CoinGecko lists 11 different coins under the ticker SOL and 49 under USDT; filling in a price by ticker could use the wrong coin's price. A coin entered offline, or one CoinGecko does not list, is stored unlinked under the name the user typed and kept apart from every linked coin, even one with the same ticker. When search finds candidates later, the user picks one; the app does not guess.

**Rounding is fine for display, not for a comparison that leads to a conclusion.** An early version of the transfer confirmation said "the average did not change" because it compared the two averages after rounding them to two decimals for display. For a coin priced near $1, a 0.4% network fee raised the average from 1 to 1.004, and the message still said "unchanged". The comparison now uses the unrounded numbers, with a tolerance far below any real change, and display uses significant digits.

**If the calculation fails, nothing is shown for that coin.** A wrong average looks like any other number, and people rarely double-check it. An entry that cannot be applied (selling more than the portfolio holds, a date that does not exist) stops the calculation for that coin only, and the error names the entry that caused it. In the entry form, a backdated entry that would break a later one is refused before it is saved.

**A silent cloud is not an answer.** About one write in ten to Telegram's storage gets a late reply or none, and some of those writes are stored anyway. The app never reads silence as success or as failure. After the 7-second limit it reads the key back: if the value is there, the write is done; if not, it writes again, at most twice more, and reads once more. Each save puts its manifest under its own key (`m_<generation>`), so a write that arrives late lands under its own key and cannot overwrite a newer one; reading takes the newest manifest. Everything older than the newest manifest is deleted, but only after the new manifest has been read back. A new generation is always later than any generation the app can see in the cloud, even if the device's clock is behind. Saves queued behind a slow one collapse into the last one, and the entry is accepted at once; the screen says "Saving…" and reports a failure only when the cloud stays silent through all the attempts or answers with an error. After a failure the screen says the entry is not lost and offers to save again, and an identical entry that the storage has not yet confirmed is refused, so a retry cannot double it. This is tested against a fake cloud that drops writes, withholds their replies and simulates late writes; it has not been run against the live cloud.

**Incomplete data is reported, not calculated.** Entries are stored as the original records, not as results. The storage that Telegram offers takes at most 4096 characters per key and cannot write several keys at once, so the history is split into chunks, and a half-finished write must never become the current state. A save writes the new chunks under new keys first, then one manifest key (chunk count, entry count, SHA-256 of the whole text), and only then deletes the old chunks. If a write breaks off at any step, the manifest still points to the previous complete state. On reading, a missing chunk, a checksum that does not match, or a count that differs from the manifest means the data is incomplete: the app says so, shows no averages, and accepts no new entries that would overwrite what is left. Each of these failure modes has a test, run against a fake of Telegram's storage: a save is cut short at every step, and what is read back is either the old state or the new one, never a mix; a chunk is removed or altered, the manifest is damaged, or the entry count differs from the manifest, and the read reports the data as incomplete. Histories from two devices are not merged. The app remembers which generation it last read or wrote; if the cloud holds a different one when it is about to save, or a newer one appears while it saves, the save is refused instead of being reported as done: the screen says the data changed on another device, lists the entries that were not saved, offers to re-read, and refuses new entries until then. Two devices that save within the same moment can still both be told "saved", and the later generation wins. Generations are ordered by time: a device sees every generation already in the cloud and goes after it, and two devices that do not see each other are ordered by their clocks.

## Status

What works today, in a browser:

- entering purchases, sales and transfers between portfolios, and undoing the last entry;
- saving every change in the browser (local storage) and reading it back on reload, with the same averages;
- exporting everything to a file and loading it back; a file with one bad entry is rejected whole, and the message names the entry;
- the current price filled in from CoinGecko; the date, the last used portfolio and the coin quantity are also filled in or calculated;
- the average entry price per portfolio and per coin, recalculated from the full history of entries. For now it is visible only in the confirmation after a sale (both levels) and after a transfer (the coin's overall average); a purchase confirmation does not show it yet;
- working without a connection: everything except current prices and coin search. A coin entered offline is stored unlinked until it can be matched.

Not done yet:

- saving to Telegram's cloud storage has been measured on one iPhone (iOS 18, Telegram Bot API 9.6) but not tested end to end with the current code. Measured there: an absent key reads as an empty string; a write is confirmed with `true`; values up to 4096 bytes are accepted, and the limit counts bytes, not characters; a write over the limit gets no reply at all; the cloud held no keys other than ours. The whole storage layer passed in two runs. Other platforms have not been checked;
- about one write in ten gets a late reply or none (39 of 400 repeated writes in those two runs: 14 answered after 3.3 to 7.3 seconds, 25 not within 8 seconds; no read failed). A write without a reply has not necessarily failed: of those 25, 14 were stored when the key was read back ten seconds later, and 11 were not (none of 8 in one run, 11 of 17 in the other). Why the two runs differ, and why the failures come at regular intervals, is not known. The app does not depend on the answer (see "A silent cloud is not an answer" above), and that protection has been tested against a fake that drops writes and withholds replies, not against the live cloud;
- there is no main screen with positions and averages;
- entries cannot be edited, only the last one undone;
- the interface is in Russian only;
- how long it takes to enter a purchase on a phone has not been measured.

## Running it

There is no build step and no dependencies. The page uses ES modules, so it has to be served over HTTP rather than opened as a file:

```
python -m http.server 8765 --bind 127.0.0.1
```

Then open http://localhost:8765.

## Tests

```
npm test
```

This runs Node's built-in test runner (tested with Node.js 22). The tests cover the calculation, the price module, the storage layer (against a fake that enforces Telegram's limits) and file import; the network is not used. The page itself is not covered by automated tests.

Prices: [CoinGecko](https://www.coingecko.com).

## License

[MIT](LICENSE)

For how analysis work is run on a different project, crypto-signal-agent, see [How the work is done](https://github.com/vimakushin/vimakushin/blob/main/how-the-work-is-done.md).
