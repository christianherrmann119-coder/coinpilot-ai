const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const APP_PASSWORD = "coinpilot";

const cache = {};
const rateLimitStore = {};

function cacheGet(key, maxAgeMs) {
const item = cache[key];
if (!item) return null;
if (Date.now() - item.time > maxAgeMs) {
delete cache[key];
return null;
}
return item.data;
}

function cacheSet(key, data) {
cache[key] = { time: Date.now(), data };
}

function checkPassword(req, res, next) {
const password = req.headers["x-app-password"];
if (password !== APP_PASSWORD) {
return res.status(401).json({ error: "Falsches Passwort." });
}
next();
}

function rateLimit(req, res, next) {
const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
const now = Date.now();
const windowMs = 60 * 1000;
const maxRequests = 10;

if (!rateLimitStore[ip]) rateLimitStore[ip] = [];

rateLimitStore[ip] = rateLimitStore[ip].filter(function (time) {
return now - time < windowMs;
});

if (rateLimitStore[ip].length >= maxRequests) {
return res.status(429).json({
error: "Analyse-Limit erreicht. Bitte warte ca. eine Minute."
});
}

rateLimitStore[ip].push(now);
next();
}

function calculateEMA(prices, period) {
if (!prices || prices.length === 0) return "0.00";
const k = 2 / (period + 1);
let ema = prices[0];

for (let i = 1; i < prices.length; i++) {
ema = prices[i] * k + ema * (1 - k);
}

return ema.toFixed(10);
}

function calculateRSI(prices, period = 14) {
if (!prices || prices.length < period + 1) return "50.00";

let gains = 0;
let losses = 0;

for (let i = 1; i <= period; i++) {
const diff = prices[i] - prices[i - 1];
if (diff >= 0) gains += diff;
else losses -= diff;
}

const avgGain = gains / period;
const avgLoss = losses / period || 1;
const rs = avgGain / avgLoss;

return (100 - 100 / (1 + rs)).toFixed(2);
}

function buildRiskLevel(marketCap) {
if (!marketCap) return { label: "Unbekannt", emoji: "⚪", level: 50 };
if (marketCap >= 50000000000) return { label: "Low Risk", emoji: "🟢", level: 25 };
if (marketCap >= 5000000000) return { label: "Medium Risk", emoji: "🟡", level: 50 };
if (marketCap >= 500000000) return { label: "High Risk", emoji: "🟠", level: 75 };
return { label: "Extreme Risk", emoji: "🔴", level: 95 };
}

function buildAdvancedScore(change24h, rsi, price, ema20, ema50, ema200, fearGreed) {
let score = 50;

const rsiNumber = Number(rsi);
const ema20Number = Number(ema20);
const ema50Number = Number(ema50);
const ema200Number = Number(ema200);

if (change24h > 2) score += 10;
if (change24h > 5) score += 10;
if (change24h < -2) score -= 10;
if (change24h < -5) score -= 10;

if (rsiNumber < 30) score += 10;
if (rsiNumber > 70) score -= 10;

if (price > ema20Number) score += 5;
if (price > ema50Number) score += 5;
if (price > ema200Number) score += 5;

if (price < ema20Number) score -= 5;
if (price < ema50Number) score -= 5;
if (price < ema200Number) score -= 5;

if (fearGreed.includes("Greed")) score += 5;
if (fearGreed.includes("Fear")) score -= 5;

if (score > 100) score = 100;
if (score < 0) score = 0;

let label = "Neutral ⚖️";
let signal = "WAIT";
let signalEmoji = "🟡";

if (score >= 70) {
label = "Bullish 🚀";
signal = "WATCH / BULLISH";
signalEmoji = "🟢";
}

if (score <= 35) {
label = "Bearish 🔻";
signal = "CAUTION";
signalEmoji = "🔴";
}

return { score, label, signal, signalEmoji };
}

function normalizeTimeframe(timeframe) {
const tf = String(timeframe || "7");

if (tf === "5m") return { days: "1", label: "5 Minuten", group: "scalp" };
if (tf === "15m") return { days: "1", label: "15 Minuten", group: "scalp" };
if (tf === "1h") return { days: "1", label: "1 Stunde", group: "intraday" };
if (tf === "4h") return { days: "1", label: "4 Stunden", group: "intraday" };
if (tf === "1") return { days: "1", label: "1 Tag", group: "day" };
if (tf === "7") return { days: "7", label: "7 Tage", group: "swing" };
if (tf === "30") return { days: "30", label: "30 Tage", group: "month" };
if (tf === "365") return { days: "365", label: "1 Jahr", group: "year" };

return { days: "7", label: "7 Tage", group: "swing" };
}

function buildTimeframeMultiplier(timeframe) {
const tf = normalizeTimeframe(timeframe).group;

if (tf === "scalp") return { up1: 1.005, up2: 1.012, up3: 1.02, down1: 0.995, down2: 0.988, down3: 0.98, sl: 0.99 };
if (tf === "intraday") return { up1: 1.015, up2: 1.03, up3: 1.05, down1: 0.985, down2: 0.97, down3: 0.95, sl: 0.975 };
if (tf === "day") return { up1: 1.025, up2: 1.05, up3: 1.08, down1: 0.975, down2: 0.95, down3: 0.92, sl: 0.955 };
if (tf === "swing") return { up1: 1.05, up2: 1.12, up3: 1.2, down1: 0.95, down2: 0.9, down3: 0.82, sl: 0.92 };
if (tf === "month") return { up1: 1.12, up2: 1.25, up3: 1.45, down1: 0.9, down2: 0.8, down3: 0.68, sl: 0.82 };
return { up1: 1.25, up2: 1.6, up3: 2.2, down1: 0.8, down2: 0.65, down3: 0.5, sl: 0.7 };
}

async function resolveCoinId(input) {
const query = String(input || "bitcoin").trim().toLowerCase();

const cached = cacheGet("resolve_" + query, 5 * 60 * 1000);
if (cached) return cached;

try {
await axios.get("https://api.coingecko.com/api/v3/coins/" + query);
cacheSet("resolve_" + query, query);
return query;
} catch (e) {}

const search = await axios.get(
"https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(query)
);

const coins = search.data.coins || [];
if (!coins.length) return null;

const exact =
coins.find(function (c) { return c.id.toLowerCase() === query; }) ||
coins.find(function (c) { return c.symbol.toLowerCase() === query; }) ||
coins.find(function (c) { return c.name.toLowerCase() === query; });

const result = exact ? exact.id : coins[0].id;
cacheSet("resolve_" + query, result);
return result;
}

app.get("/", function (req, res) {
res.sendFile(__dirname + "/public/index.html");
});

app.get("/api/search", checkPassword, async function (req, res) {
try {
const query = req.query.q || "";
if (query.length < 2) return res.json({ coins: [] });

const cached = cacheGet("search_" + query, 5 * 60 * 1000);
if (cached) return res.json({ coins: cached });

const search = await axios.get(
"https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(query)
);

const coins = (search.data.coins || []).slice(0, 10).map(function (coin) {
return {
id: coin.id,
name: coin.name,
symbol: coin.symbol,
thumb: coin.thumb,
marketCapRank: coin.market_cap_rank || "?"
};
});

cacheSet("search_" + query, coins);
res.json({ coins });
} catch (error) {
res.status(500).json({ error: "Coin-Suche aktuell nicht erreichbar. Bitte kurz warten." });
}
});

app.get("/api/trending", checkPassword, async function (req, res) {
try {
const cached = cacheGet("trending", 5 * 60 * 1000);
if (cached) return res.json(cached);

const trending = await axios.get("https://api.coingecko.com/api/v3/search/trending");

const baseCoins = (trending.data.coins || []).slice(0, 7).map(function (item) {
return {
id: item.item.id,
name: item.item.name,
symbol: item.item.symbol,
thumb: item.item.thumb,
rank: item.item.market_cap_rank || "?"
};
});

const ids = baseCoins.map(function (coin) { return coin.id; }).join(",");
let marketMap = {};

try {
const markets = await axios.get(
"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=" +
encodeURIComponent(ids) +
"&price_change_percentage=24h"
);

markets.data.forEach(function (coin) {
marketMap[coin.id] = {
price: coin.current_price,
change24h: coin.price_change_percentage_24h || 0,
image: coin.image
};
});
} catch (e) {}

const coins = baseCoins.map(function (coin) {
return {
id: coin.id,
name: coin.name,
symbol: coin.symbol,
thumb: marketMap[coin.id] ? marketMap[coin.id].image : coin.thumb,
rank: coin.rank,
price: marketMap[coin.id] ? marketMap[coin.id].price : null,
change24h: marketMap[coin.id] ? marketMap[coin.id].change24h : null
};
});

const result = { coins };
cacheSet("trending", result);
res.json(result);
} catch (error) {
res.json({ coins: [] });
}
});

app.get("/api/top-gainers", checkPassword, async function (req, res) {
try {
const cached = cacheGet("top_gainers", 3 * 60 * 1000);
if (cached) return res.json(cached);

const markets = await axios.get(
"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h"
);

const coins = markets.data
.filter(function (coin) { return typeof coin.price_change_percentage_24h === "number"; })
.sort(function (a, b) { return b.price_change_percentage_24h - a.price_change_percentage_24h; })
.slice(0, 10)
.map(function (coin) {
return {
id: coin.id,
name: coin.name,
symbol: coin.symbol,
image: coin.image,
price: coin.current_price,
change24h: coin.price_change_percentage_24h,
marketCapRank: coin.market_cap_rank || "?"
};
});

const result = { coins };
cacheSet("top_gainers", result);
res.json(result);
} catch (error) {
res.json({ coins: [] });
}
});

app.get("/api/top-losers", checkPassword, async function (req, res) {
try {
const cached = cacheGet("top_losers", 3 * 60 * 1000);
if (cached) return res.json(cached);

const markets = await axios.get(
"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h"
);

const coins = markets.data
.filter(function (coin) { return typeof coin.price_change_percentage_24h === "number"; })
.sort(function (a, b) { return a.price_change_percentage_24h - b.price_change_percentage_24h; })
.slice(0, 10)
.map(function (coin) {
return {
id: coin.id,
name: coin.name,
symbol: coin.symbol,
image: coin.image,
price: coin.current_price,
change24h: coin.price_change_percentage_24h,
marketCapRank: coin.market_cap_rank || "?"
};
});

const result = { coins };
cacheSet("top_losers", result);
res.json(result);
} catch (error) {
res.json({ coins: [] });
}
});

app.get("/api/watchlist", checkPassword, async function (req, res) {
try {
const ids = req.query.ids || "";
if (!ids) return res.json({ coins: [] });

const cached = cacheGet("watchlist_" + ids, 60 * 1000);
if (cached) return res.json({ coins: cached });

const markets = await axios.get(
"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=" +
encodeURIComponent(ids) +
"&price_change_percentage=24h"
);

const coins = markets.data.map(function (coin) {
return {
id: coin.id,
name: coin.name,
symbol: coin.symbol,
image: coin.image,
price: coin.current_price,
change24h: coin.price_change_percentage_24h || 0,
marketCapRank: coin.market_cap_rank || "?"
};
});

cacheSet("watchlist_" + ids, coins);
res.json({ coins });
} catch (error) {
res.status(500).json({ error: "Watchlist konnte nicht geladen werden." });
}
});

app.get("/api/exchange-fees", checkPassword, function (req, res) {
res.json({
exchanges: [
{ rank: 1, name: "Binance", maker: "0,10%", taker: "0,10%", kyc: "Ja", card: "Ja 💳", futures: "Ja", staking: "Ja", url: "https://www.binance.com/en/fee", note: "Regulärer Spot-Wert; BNB/VIP-Rabatte möglich." },
{ rank: 2, name: "Coinbase Advanced", maker: "bis ca. 0,40%", taker: "bis ca. 0,60%", kyc: "Ja", card: "Ja 💳", futures: "Teilweise", staking: "Ja", url: "https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees", note: "Gebührenstufen abhängig von 30-Tage-Volumen." },
{ rank: 3, name: "Bybit", maker: "ca. 0,10%", taker: "ca. 0,15%", kyc: "Ja", card: "Ja 💳", futures: "Ja", staking: "Ja", url: "https://www.bybit.com/en/help-center/article/Bybit-Spot-Fees-Explained", note: "Produkt- und VIP-Level abhängig." },
{ rank: 4, name: "OKX", maker: "ca. 0,08%", taker: "ca. 0,10%", kyc: "Ja", card: "Ja 💳", futures: "Ja", staking: "Ja", url: "https://www.okx.com/fees", note: "Level- und Volumenabhängig." },
{ rank: 5, name: "KuCoin", maker: "ca. 0,10%", taker: "ca. 0,10%", kyc: "Meist ja", card: "Ja 💳", futures: "Ja", staking: "Ja", url: "https://www.kucoin.com/vip/level", note: "KCS- und VIP-Rabatte möglich." },
{ rank: 6, name: "Kraken Pro", maker: "variabel", taker: "variabel", kyc: "Ja", card: "Nein/bedingt", futures: "Ja", staking: "Ja", url: "https://www.kraken.com/features/fee-schedule", note: "Abhängig von 30-Tage-Volumen und Ordertyp." },
{ rank: 7, name: "Bitget", maker: "ca. 0,10%", taker: "ca. 0,10%", kyc: "Ja", card: "Ja 💳", futures: "Ja", staking: "Ja", url: "https://www.bitget.com/fee", note: "VIP- und Produktabhängig." },
{ rank: 8, name: "Gate.io", maker: "ca. 0,20%", taker: "ca. 0,20%", kyc: "Ja", card: "Ja 💳", futures: "Ja", staking: "Ja", url: "https://www.gate.io/fee", note: "VIP- und Rabattmodelle möglich." },
{ rank: 9, name: "MEXC", maker: "variabel", taker: "variabel", kyc: "Teilweise", card: "Teilweise", futures: "Ja", staking: "Ja", url: "https://www.mexc.com/fee", note: "Stark aktions- und produktabhängig."
},
{
  rank: 10,
  name: "Crypto.com", maker: "variabel", taker: "variabel", kyc: "Ja", card: "Ja 💳", futures: "Ja", staking: "Ja", url: "https://crypto.com/exchange/document/fees-limits", note: "Volumen- und Levelabhängig." 
},
  {
    rank: 11,
    name: "Bitpanda",
    maker: "ca. 0,10%",
    taker: "ca. 0,10%",
    kyc: "Ja",
    card: "Ja 💳",
    cardUrl: "https://www.bitpanda.com/de/card",
    futures: "Nein",
    staking: "Ja",
    url: "https://support.bitpanda.com/hc/en-us/articles/360000902525",
    note: "EU-reguliert, einfache Nutzung, ideal für Anfänger"
  },
  {
  rank: 12,
  name: "BloFin",
  maker: "ca. 0,10%",
  taker: "ca. 0,10%",
  kyc: "Nein ❌",
  card: "Nein ❌",
  futures: "Ja",
  staking: "Teilweise",
  url: "https://www.blofin.com",
  note: "KYC-frei möglich, Sitz: Cayman Islands 🌴"
}
]
});

});

app.post("/api/explain", checkPassword, async function (req, res) {
const term = req.body.term || "Blockchain";
const mode = req.body.mode || "beginner";

try {
const cached = cacheGet("explain_" + term + "_" + mode, 24 * 60 * 60 * 1000);
if (cached) return res.json({ explanation: cached });

const prompt =
mode === "pro"
? "Erkläre den Krypto-/Trading-Begriff professionell, aber verständlich: "
: "Erkläre den Krypto-/Trading-Begriff extrem einfach, mit Emojis und Beispiel: ";

const aiResponse = await axios.post(
"https://api.openai.com/v1/chat/completions",
{
model: "gpt-4o-mini",
messages: [
{ role: "system", content: "Du bist ein Krypto-Education-Coach. Erkläre klar, kurz, einfach und ohne Anlageberatung." },
{ role: "user", content: prompt + term }
],
max_tokens: 350
},
{
headers: {
Authorization: "Bearer " + OPENAI_API_KEY,
"Content-Type": "application/json"
}
}
);

const explanation = aiResponse.data.choices[0].message.content;
cacheSet("explain_" + term + "_" + mode, explanation);

res.json({ explanation });
} catch (error) {
res.json({
explanation:
"🧠 Erklärung aktuell nicht verfügbar. Prüfe bitte deinen OpenAI API-Key oder versuche es später erneut."
});
}
});

app.get("/api/market-overview", checkPassword, async function (req, res) {
try {
const cached = cacheGet("market_overview", 15 * 60 * 1000);
if (cached) return res.json(cached);

let fearGreed = "Keine Daten";
let fearGreedValue = 50;

try {
const fg = await axios.get("https://api.alternative.me/fng/");
fearGreedValue = Number(fg.data.data[0].value);
fearGreed = fg.data.data[0].value_classification + " (" + fg.data.data[0].value + ")";
} catch (e) {}

const global = await axios.get("https://api.coingecko.com/api/v3/global");

const activeCryptos = global.data.data.active_cryptocurrencies || 0;
const markets = global.data.data.markets || 0;
const totalMarketCap = global.data.data.total_market_cap.usd || 0;
const marketCapChange24h = global.data.data.market_cap_change_percentage_24h_usd || 0;
const totalVolume24h = global.data.data.total_volume.usd || 0;
const btcDominance = Number(global.data.data.market_cap_percentage.btc || 0);
const ethDominance = Number(global.data.data.market_cap_percentage.eth || 0);
const altcoinStrength = Math.max(0, Math.min(100, 100 - btcDominance));

let averageCryptoRsi = 50;

try {
const marketsRes = await axios.get(
"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1"
);

const changes = marketsRes.data
.map(function (coin) { return coin.price_change_percentage_24h || 0; })
.filter(function (value) { return typeof value === "number"; });

const avgChange =
changes.reduce(function (sum, value) { return sum + value; }, 0) / (changes.length || 1);

averageCryptoRsi = Math.max(0, Math.min(100, 50 + avgChange * 3));
} catch (e) {}

const result = {
fearGreed,
fearGreedValue,
activeCryptos,
markets,
totalMarketCap,
marketCapChange24h,
totalVolume24h,
btcDominance: btcDominance.toFixed(2),
ethDominance: ethDominance.toFixed(2),
altcoinStrength: altcoinStrength.toFixed(0),
averageCryptoRsi: averageCryptoRsi.toFixed(0)
};

cacheSet("market_overview", result);
res.json(result);
} catch (error) {
res.json({
fearGreed: "Keine Daten",
fearGreedValue: 50,
activeCryptos: 0,
markets: 0,
totalMarketCap: 0,
marketCapChange24h: 0,
totalVolume24h: 0,
btcDominance: "0",
ethDominance: "0",
altcoinStrength: "0",
averageCryptoRsi: "50"
});
}
});

app.post("/api/analyze", checkPassword, rateLimit, async function (req, res) {
const input = req.body.coin || "bitcoin";
const timeframe = req.body.timeframe || "7";
const tf = normalizeTimeframe(timeframe);

try {
const coinId = await resolveCoinId(input);

if (!coinId) {
return res.status(404).json({
error: "Coin nicht gefunden. Tipp: Öffne CoinGecko und kopiere den letzten Teil der URL, z.B. kite-ai."
});
}

const cacheKey = "analyze_" + coinId + "_" + timeframe;
const cached = cacheGet(cacheKey, 2 * 60 * 1000);
if (cached) return res.json(cached);

const marketResponse = await axios.get("https://api.coingecko.com/api/v3/coins/" + coinId);
const data = marketResponse.data;
const market = data.market_data;

const price = market.current_price.usd;
const marketCap = market.market_cap.usd;
const change24h = market.price_change_percentage_24h || 0;
const volume24h = market.total_volume.usd || 0;
const circulating = market.circulating_supply;

let maxSupply = market.max_supply;
if (!maxSupply && coinId === "bitcoin") maxSupply = 21000000;
if (!maxSupply) maxSupply = "Nicht definiert";

const chartResponse = await axios.get(
"https://api.coingecko.com/api/v3/coins/" +
coinId +
"/market_chart?vs_currency=usd&days=" +
tf.days
);

const prices = chartResponse.data.prices.map(function (p) { return p[1]; });

const rsi = calculateRSI(prices);
const ema20 = calculateEMA(prices.slice(-20), 20);
const ema50 = calculateEMA(prices.slice(-50), 50);
const ema200 = calculateEMA(prices.slice(-Math.min(200, prices.length)), 200);
const mult = buildTimeframeMultiplier(timeframe);

const support = (price * mult.down1).toFixed(10);
const resistance = (price * mult.up1).toFixed(10);
const fib382 = (price * 0.382).toFixed(10);
const fib50 = (price * 0.5).toFixed(10);
const fib618 = (price * 0.618).toFixed(10);
const fib1272 = (price * 1.272).toFixed(10);
const fib1618 = (price * 1.618).toFixed(10);
const fib2618 = (price * 2.618).toFixed(10);
const entryZone = (price * 0.98).toFixed(10);
const buyZone = (price * 0.97).toFixed(10);
const stopLoss = (price * mult.sl).toFixed(10);
const breakoutTarget = (price * mult.up2).toFixed(10);
const upsideTarget1 = (price * mult.up1).toFixed(10);
const upsideTarget2 = (price * mult.up2).toFixed(10);
const upsideTarget3 = (price * mult.up3).toFixed(10);
const downsideTarget1 = (price * mult.down1).toFixed(10);
const downsideTarget2 = (price * mult.down2).toFixed(10);
const downsideTarget3 = (price * mult.down3).toFixed(10);
const elliottBull = (price * 1.25).toFixed(10);
const elliottBear = (price * 0.85).toFixed(10);

let fearGreed = "Keine Daten";
let fearGreedValue = 50;

try {
const fgCached = cacheGet("feargreed", 15 * 60 * 1000);
if (fgCached) {
fearGreed = fgCached.fearGreed;
fearGreedValue = fgCached.fearGreedValue;
} else {
const fg = await axios.get("https://api.alternative.me/fng/");
fearGreedValue = Number(fg.data.data[0].value);
fearGreed = fg.data.data[0].value_classification + " (" + fg.data.data[0].value + ")";
cacheSet("feargreed", { fearGreed, fearGreedValue });
}
} catch (e) {}

let momentum = "Neutral";
if (change24h > 3) momentum = "Bullish 🚀";
if (change24h < -3) momentum = "Bearish 🔻";
if (change24h > 10) momentum = "HOT Coin 🔥";
if (change24h < -10) momentum = "Starker Abverkauf ⚠️";

const riskLevel = buildRiskLevel(marketCap);
const marketScore = buildAdvancedScore(change24h, rsi, price, ema20, ema50, ema200, fearGreed);

let analysis = "Keine AI Analyse verfügbar.";
let aiErrorMessage = "";

try {
const aiResponse = await axios.post(
"https://api.openai.com/v1/chat/completions",
{
model: "gpt-4o-mini",
messages: [
{
role: "system",
content:
"Du bist ein professioneller Krypto Analyst. Gib keine Anlageberatung und keine Kaufempfehlung. Formuliere neutral, strukturiert, knapp und mit Emojis."
},
{
role: "user",
content:
"Coin: " + data.name +
"\nZeitraum: " + tf.label +
"\nPreis: " + price +
"\n24h Veränderung: " + change24h + "%" +
"\nRSI: " + rsi +
"\nMomentum: " + momentum +
"\nScore: " + marketScore.score + "/100 " + marketScore.label +
"\nRisiko: " + riskLevel.label +
"\nEntry Zone: " + entryZone +
"\nStop Loss: " + stopLoss +
"\nTP1: " + upsideTarget1 +
"\nTP2: " + upsideTarget2 +
"\nTP3: " + upsideTarget3 +
"\nSupport: " + support +
"\nResistance: " + resistance +
"\nFear & Greed: " + fearGreed +
"\n\nErstelle eine kompakte Analyse mit diesen Abschnitten: 🧠 Trend, 🎯 Trading-Zonen, ⚠️ Risiko, ❌ Fehler vermeiden, 📌 Fazit. Keine Anlageberatung."
}
],
max_tokens: 550
},
{
headers: {
Authorization: "Bearer " + OPENAI_API_KEY,
"Content-Type": "application/json"
}
}
);

analysis = aiResponse.data.choices[0].message.content;
} catch (aiError) {
aiErrorMessage = aiError.response && aiError.response.data
? JSON.stringify(aiError.response.data)
: aiError.message;
console.log("AI Fehler:", aiErrorMessage);
}

const tradingViewSymbol = "BINANCE:" + String(data.symbol || "").toUpperCase() + "USDT";

const responseData = {
coin: data.name,
coinId,
symbol: data.symbol,
image: data.image.small,
price,
marketCap,
volume24h,
change24h,
circulating,
maxSupply,
support,
resistance,
rsi,
ema20,
ema50,
ema200,
fib382,
fib50,
fib618,
fib1272,
fib1618,
fib2618,
entryZone,
buyZone,
stopLoss,
breakoutTarget,
upsideTarget1,
upsideTarget2,
upsideTarget3,
downsideTarget1,
downsideTarget2,
downsideTarget3,
elliottBull,
elliottBear,
momentum,
marketScore,
riskLevel,
fearGreed,
fearGreedValue,
analysis,
aiErrorMessage,
chartData: chartResponse.data,
timeframe,
timeframeLabel: tf.label,
tradingViewSymbol
};

cacheSet(cacheKey, responseData);
res.json(responseData);
} catch (error) {
console.log("Server Fehler:", error.message);

if (error.response && error.response.status === 429) {
return res.status(429).json({
error: "CoinGecko-Limit erreicht. Bitte warte 60 Sekunden und versuche es erneut."
});
}

res.status(500).json({
error: "Fehler beim Laden. Der Coin wurde eventuell nicht gefunden oder CoinGecko ist kurzzeitig nicht erreichbar."
});
}
});

app.listen(3000, function () {
console.log("CoinPilot läuft auf Port 3000");
});
