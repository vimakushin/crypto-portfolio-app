# crypto-portfolio-app

Tracks crypto holdings spread across several exchanges and wallets, with the average entry price for each portfolio and for each coin as a whole.

## The interesting part

The hard part is not the interface. It is keeping the weighted average entry price correct when coins move between exchanges and wallets.

A transfer is not a trade. Moving a coin from an exchange to a wallet must not change the coin's overall average price: the money moves with the coins, at the sending portfolio's average cost. The receiving portfolio blends it with what it already holds.

The network fee stays with the coins that arrive. Send 1 coin bought for $146, receive 0.995: the $146 is now spread over 0.995 coins, and the average rises to $146.73. Writing the fee off and keeping the old average would understate what each coin cost. Two things have to hold together: with no fee, the overall average does not change; with a fee, it rises. The tests below check both.

The same rule applies to an exchange fee taken in coins on a purchase: the money stays on the coins actually received.

The rules have tests (`test/calc.test.js`):

- a transfer without a fee leaves the overall average exactly unchanged (the test compares integers, with no tolerance);
- a transfer with a fee raises it to the total invested divided by the coins that remain (to within 10⁻²⁰);
- a sale does not change the average of the portfolio it was sold from (to within 10⁻²⁰). The overall average can still move, because the mix of portfolios has changed; keeping both levels fixed at once is impossible, and the code explains why.

## Decisions behind it

**The data belongs to the user.** There is no server of its own and no separate account. The only outgoing requests are for current prices and coin search, sent directly from the user's device to the CoinGecko public API.

**It does not ask for exchange API keys, seed phrases or private keys.** Holdings are entered by hand. Connecting to exchanges would mean storing its users' access keys, and that was ruled out from the start.

**Amounts are fixed-point integers, not floating-point numbers.** Every amount and quantity is a `BigInt` counted in units of 10⁻³⁰. Addition and subtraction are exact; division rounds at the 30th decimal place. One tolerance exists: a sale or transfer that differs from the whole position by less than 10⁻²⁶ of a coin is treated as the whole position. That is why the transfer test above can require exact equality.

**Coins are identified by their CoinGecko id, never by ticker.** As of October 2026, CoinGecko lists 11 different coins under the ticker SOL and 49 under USDT; filling in a price by ticker could use the wrong coin's price. A coin entered offline, or one CoinGecko does not list, is stored unlinked under the name the user typed and kept apart from every linked coin, even one with the same ticker. When search finds candidates later, the user picks one; the app does not guess.

**Rounding is fine for display, not for a comparison that leads to a conclusion.** An early version of the transfer confirmation said "the average did not change" because it compared the two averages after rounding them to two decimals for display. For a coin priced near $1, a 0.4% network fee raised the average from 1 to 1.004, and the message still said "unchanged". The comparison now uses the unrounded numbers, with a tolerance far below any real change, and display uses significant digits.

**If the calculation fails, nothing is shown for that coin.** A wrong average looks like any other number, and people rarely double-check it. An entry that cannot be applied (selling more than the portfolio holds, a date that does not exist) stops the calculation for that coin only, and the error names the entry that caused it. In the entry form, a backdated entry that would break a later one is refused before it is saved.

## Status

What works today, in a browser:

- entering purchases, sales and transfers between portfolios, and undoing the last entry;
- the current price filled in from CoinGecko; the date, the last used portfolio and the coin quantity are also filled in or calculated;
- the average entry price per portfolio and per coin, recalculated from the full history of entries. For now it is visible only in the confirmation after a sale (both levels) and after a transfer (the coin's overall average); a purchase confirmation does not show it yet;
- working without a connection: everything except current prices and coin search. A coin entered offline is stored unlinked until it can be matched.

Not done yet:

- **entries are not saved**: they are lost when the page is closed or reloaded;
- **it does not run in Telegram yet**, although that is the intended platform; storage will be tied to the user's Telegram account;
- there is no main screen with positions and averages;
- entries cannot be edited, only the last one undone;
- no export to a file and import back;
- the interface is in Russian only.

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

This runs Node's built-in test runner (tested with Node.js 22). The tests cover the calculation and the price module; the network is not used.

Prices: [CoinGecko](https://www.coingecko.com).

## License

[MIT](LICENSE)
