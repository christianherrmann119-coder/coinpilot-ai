const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

app.get("/", (req, res) => {
res.sendFile(__dirname + "/public/index.html");
});

app.post("/api/analyze", async (req, res) => {
const coin = (req.body.coin || "bitcoin").toLowerCase();

try {
const marketResponse = await axios.get(
"https://api.coingecko.com/api/v3/coins/" + coin
);

const data = marketResponse.data;
const market = data.market_data;

const price = market.current_price.usd;
const marketCap = market.market_cap.usd;
const change24h = market.price_change_percentage_24h;
const circulating = market.circulating_supply;

let maxSupply = market.max_supply;

if (!maxSupply && coin === "bitcoin") {
maxSupply = 21000000;
}

if (!maxSupply) {
maxSupply = "Nicht definiert";
}

const chart7d = await axios.get(
"https://api.coingecko.com/api/v3/coins/" +
coin +
"/market_chart?vs_currency=usd&days=7"
);

const prices = chart7d.data.prices.map((p) => p[1]);

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
const fg = await axios.get("https://api.alternative.me/fng/");
fearGreed =
fg.data.data[0].value_classification +
" (" +
fg.data.data[0].value +
")";
} catch (e) {
console.log("Fear & Greed Fehler");
}

let momentum = "Neutral";

if (change24h > 3) {
momentum = "Bullish 🚀";
}

if (change24h < -3) {
momentum = "Bearish 🔻";
}

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
coin +
"\nPreis: " +
price +
"\n24h Veränderung: " +
change24h +
"%" +
"\nRSI: " +
rsi +
"\nMomentum: " +
momentum +
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

res.json({
coin: data.name,
price,
marketCap,
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
buyZone,
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
fearGreed,
analysis,
chart7d: chart7d.data
});
} catch (error) {
console.log("Server Fehler:", error.message);

res.json({
error: "Fehler beim Laden"
});
}
});

app.listen(3000, () => {
console.log("CoinPilot läuft auf Port 3000");
});
