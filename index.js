const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD || "coinpilot";

const cache = {};
const rateLimitStore = {};

function cacheGet(key, maxAgeMs) {
const item = cache[key];

if (!item) {
return null;
}

if (Date.now() - item.time > maxAgeMs) {
delete cache[key];
return null;
}

return item.data;
}

function cacheSet(key, data) {
cache[key] = {
time: Date.now(),
data: data
};
}

function checkPassword(req, res, next) {
const password = req.headers["x-app-password"];

if (password !== APP_PASSWORD) {
return res.status(401).json({
error: "Falsches Passwort."
});
}

next();
}

function rateLimit(req, res, next) {
const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
const now = Date.now();
const windowMs = 60 * 1000;
const maxRequests = 8;

if (!rateLimitStore[ip]) {
rateLimitStore[ip] = [];
}

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

return ema.toFixed(2);
}

function calculateRSI(prices, period = 14) {
if (!prices || prices.length < period + 1) return "50.00";

let gains = 0;
let losses = 0;

for (let i = 1; i <= period; i++) {
const diff = prices[i] - prices[i - 1];

if (diff >= 0) {
gains += diff;
} else {
losses -= diff;
}
}

const avgGain = gains / period;
const avgLoss = losses / period || 1;
const rs = avgGain / avgLoss;

return (100 - 100 / (1 + rs)).toFixed(2);
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

if (rsiNumber < 30) score += 12;
if (rsiNumber > 70) score -= 12;

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

if (score >= 65) label = "Bullish 🚀";
if (score <= 35) label = "Bearish 🔻";

return {
score: score,
label: label
};
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

if (!coins.length) {
return null;
}

const exact =
coins.find(function (c) {
return c.id.toLowerCase() === query;
}) ||
coins.find(function (c) {
return c.symbol.toLowerCase() === query;
}) ||
coins.find(function (c) {
return c.name.toLowerCase() === query;
});

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

if (query.length < 2) {
return res.json({ coins: [] });
}

const cached = cacheGet("search_" + query, 5 * 60 * 1000);

if (cached) {
return res.json({ coins: cached });
}

const search = await axios.get(
"https://api.coingecko.com/api/v3/search?query=" +
encodeURIComponent(query)
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

res.json({ coins: coins });
} catch (error) {
res.status(500).json({
error: "Coin-Suche aktuell nicht erreichbar. Bitte kurz warten."
});
}
});

app.get("/api/watchlist", checkPassword, async function (req, res) {
try {
const ids = req.query.ids || "";

if (!ids) {
return res.json({ coins: [] });
}

const cached = cacheGet("watchlist_" + ids, 60 * 1000);

if (cached) {
return res.json({ coins: cached });
}

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
change24h: coin.price_change_percentage_24h || 0
};
});

cacheSet("watchlist_" + ids, coins);

res.json({ coins: coins });
} catch (error) {
res.status(500).json({
error: "Watchlist konnte nicht geladen werden."
});
}
});

app.post("/api/analyze", checkPassword, rateLimit, async function (req, res) {
const input = req.body.coin || "bitcoin";
const days = req.body.days || "7";

try {
const coinId = await resolveCoinId(input);

if (!coinId) {
return res.status(404).json({
error:
"Coin nicht gefunden. Tipp: Öffne CoinGecko und kopiere den letzten Teil der URL, z.B. kite-ai."
});
}

const cacheKey = "analyze_" + coinId + "_" + days;
const cached = cacheGet(cacheKey, 2 * 60 * 1000);

if (cached) {
return res.json(cached);
}

const marketResponse = await axios.get(
"https://api.coingecko.com/api/v3/coins/" + coinId
);

const data = marketResponse.data;
const market = data.market_data;

const price = market.current_price.usd;
const marketCap = market.market_cap.usd;
const change24h = market.price_change_percentage_24h || 0;
const circulating = market.circulating_supply;

let maxSupply = market.max_supply;

if (!maxSupply && coinId === "bitcoin") {
maxSupply = 21000000;
}

if (!maxSupply) {
maxSupply = "Nicht definiert";
}

const chartResponse = await axios.get(
"https://api.coingecko.com/api/v3/coins/" +
coinId +
"/market_chart?vs_currency=usd&days=" +
days
);

const prices = chartResponse.data.prices.map(function (p) {
return p[1];
});

const rsi = calculateRSI(prices);
const ema20 = calculateEMA(prices.slice(-20), 20);
const ema50 = calculateEMA(prices.slice(-50), 50);
const ema200 = calculateEMA(
prices.slice(-Math.min(200, prices.length)),
200
);

const support = (price * 0.95).toFixed(2);
const resistance = (price * 1.05).toFixed(2);

const fib382 = (price * 0.382).toFixed(2);
const fib50 = (price * 0.5).toFixed(2);
const fib618 = (price * 0.618).toFixed(2);

const fib1272 = (price * 1.272).toFixed(2);
const fib1618 = (price * 1.618).toFixed(2);
const fib2618 = (price * 2.618).toFixed(2);

const buyZone = (price * 0.97).toFixed(2);
const breakoutTarget = (price * 1.15).toFixed(2);

const upsideTarget1 = (price * 1.05).toFixed(2);
const upsideTarget2 = (price * 1.12).toFixed(2);
const upsideTarget3 = (price * 1.2).toFixed(2);

const downsideTarget1 = (price * 0.95).toFixed(2);
const downsideTarget2 = (price * 0.9).toFixed(2);
const downsideTarget3 = (price * 0.82).toFixed(2);

const elliottBull = (price * 1.25).toFixed(2);
const elliottBear = (price * 0.85).toFixed(2);

let fearGreed = "Keine Daten";

try {
const fgCached = cacheGet("feargreed", 15 * 60 * 1000);

if (fgCached) {
fearGreed = fgCached;
} else {
const fg = await axios.get("https://api.alternative.me/fng/");
fearGreed =
fg.data.data[0].value_classification +
" (" +
fg.data.data[0].value +
")";
cacheSet("feargreed", fearGreed);
}
} catch (e) {
console.log("Fear & Greed Fehler");
}

let momentum = "Neutral";

if (change24h > 3) momentum = "Bullish 🚀";
if (change24h < -3) momentum = "Bearish 🔻";

const marketScore = buildAdvancedScore(
change24h,
rsi,
price,
ema20,
ema50,
ema200,
fearGreed
);

let analysis = "Keine AI Analyse verfügbar.";

try {
const aiResponse = await axios.post(
"https://api.openai.com/v1/chat/completions",
{
model: "gpt-4o-mini",
messages: [
{
role: "system",
content:
"Du bist ein professioneller Krypto Analyst. Gib keine Anlageberatung und keine Kaufempfehlung. Formuliere neutral, strukturiert und kompakt."
},
{
role: "user",
content:
"Coin: " +
data.name +
"\nCoinGecko ID: " +
coinId +
"\nZeitraum Chart: " +
days +
" Tage" +
"\nPreis: " +
price +
"\n24h Veränderung: " +
change24h +
"%" +
"\nRSI: " +
rsi +
"\nMomentum: " +
momentum +
"\nScore: " +
marketScore.score +
"/100 " +
marketScore.label +
"\nSupport: " +
support +
"\nResistance: " +
resistance +
"\nBuy Zone: " +
buyZone +
"\nBreakout Target: " +
breakoutTarget +
"\nFib 0.618: " +
fib618 +
"\nFib 1.618: " +
fib1618 +
"\nElliott Bull: " +
elliottBull +
"\nElliott Bear: " +
elliottBear +
"\nFear & Greed: " +
fearGreed +
"\n\nErstelle eine kompakte Analyse mit: Trend, Risiko, Support, Resistance, Ziele nach oben, Ziele nach unten und Fazit. Keine Anlageberatung."
}
],
max_tokens: 450
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
console.log("AI Fehler:", aiError.message);
}

const responseData = {
coin: data.name,
coinId: coinId,
symbol: data.symbol,
image: data.image.small,
price: price,
marketCap: marketCap,
change24h: change24h,
circulating: circulating,
maxSupply: maxSupply,
support: support,
resistance: resistance,
rsi: rsi,
ema20: ema20,
ema50: ema50,
ema200: ema200,
fib382: fib382,
fib50: fib50,
fib618: fib618,
fib1272: fib1272,
fib1618: fib1618,
fib2618: fib2618,
buyZone: buyZone,
breakoutTarget: breakoutTarget,
upsideTarget1: upsideTarget1,
upsideTarget2: upsideTarget2,
upsideTarget3: upsideTarget3,
downsideTarget1: downsideTarget1,
downsideTarget2: downsideTarget2,
downsideTarget3: downsideTarget3,
elliottBull: elliottBull,
elliottBear: elliottBear,
momentum: momentum,
marketScore: marketScore,
fearGreed: fearGreed,
analysis: analysis,
chartData: chartResponse.data,
days: days
};

cacheSet(cacheKey, responseData);

res.json(responseData);
} catch (error) {
console.log("Server Fehler:", error.message);

if (error.response && error.response.status === 429) {
return res.status(429).json({
error:
"CoinGecko-Limit erreicht. Bitte warte 60 Sekunden und versuche es erneut."
});
}

res.status(500).json({
error:
"Fehler beim Laden. Der Coin wurde eventuell nicht gefunden oder CoinGecko ist kurzzeitig nicht erreichbar."
});
}
});

app.listen(3000, function () {
console.log("CoinPilot läuft auf Port 3000");
});
