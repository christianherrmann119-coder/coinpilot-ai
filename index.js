const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD || "coinpilot";

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

async function axiosGetCached(url, maxAgeMs) {
const cached = cacheGet("url_" + url, maxAgeMs);
if (cached) return cached;
const response = await axios.get(url, { timeout: 12000 });
cacheSet("url_" + url, response.data);
return response.data;
}

function mapYahooSymbol(symbol) {
const map = {
SPX: "^GSPC",
NDX: "^NDX",
DJI: "^DJI",
DAX: "^GDAXI",
NI225: "^N225",
NASDAQ: "^IXIC",
RUSSELL2000: "^RUT",
FTSE100: "^FTSE",
EUROSTOXX50: "^STOXX50E",
HSI: "^HSI",
XAUUSD: "GC=F",
XAGUSD: "SI=F",
XPTUSD: "PL=F",
XPDUSD: "PA=F"
};
return map[String(symbol || "").toUpperCase()] || symbol;
}

async function fetchYahooChart(symbol, range, interval) {
const yahooSymbol = mapYahooSymbol(symbol);
const safeRange = range || "1y";
const safeInterval = interval || (safeRange === "1d" ? "5m" : "1d");
const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(yahooSymbol) + "?range=" + encodeURIComponent(safeRange) + "&interval=" + encodeURIComponent(safeInterval);
const data = await axiosGetCached(url, 10 * 60 * 1000);
const result = data.chart && data.chart.result && data.chart.result[0] ? data.chart.result[0] : null;
if (!result) throw new Error("Yahoo chart data missing");
const timestamps = result.timestamp || [];
const quote = result.indicators && result.indicators.quote && result.indicators.quote[0] ? result.indicators.quote[0] : {};
const closes = quote.close || [];
const prices = timestamps.map(function (ts, index) { return [ts * 1000, closes[index]]; }).filter(function (row) { return typeof row[1] === "number" && Number.isFinite(row[1]); });
const meta = result.meta || {};
return {
symbol: symbol,
yahooSymbol: yahooSymbol,
name: meta.longName || meta.shortName || symbol,
currency: meta.currency || "USD",
price: meta.regularMarketPrice || (prices.length ? prices[prices.length - 1][1] : null),
previousClose: meta.chartPreviousClose || meta.previousClose || null,
prices: prices
};
}

async function fetchYahooQuote(symbol) {
const chart = await fetchYahooChart(symbol, "5d", "1d");
const price = Number(chart.price || 0);
const previousClose = Number(chart.previousClose || (chart.prices.length > 1 ? chart.prices[chart.prices.length - 2][1] : price));
const changeAbs = price - previousClose;
const changePct = previousClose ? (changeAbs / previousClose) * 100 : 0;
return {
symbol: chart.symbol,
yahooSymbol: chart.yahooSymbol,
name: chart.name,
currency: chart.currency,
price: price,
changeAbs: changeAbs,
changePct: changePct
};
}

async function hydrateAssetsWithQuotes(list) {
const result = await Promise.all((list || []).map(async function (asset) {
try {
const quote = await fetchYahooQuote(asset.yahooSymbol || asset.symbol);
return Object.assign({}, asset, {
livePrice: quote.price,
liveChangeAbs: quote.changeAbs,
liveChangePct: quote.changePct,
currency: quote.currency,
dataStatus: "live"
});
} catch (e) {
return Object.assign({}, asset, {
livePrice: null,
liveChangeAbs: null,
liveChangePct: null,
currency: asset.currency || "USD",
dataStatus: "fallback"
});
}
}));
return result;
}

function checkPassword(req, res, next) {
const password = req.headers["x-app-password"];
if (password !== APP_PASSWORD) return res.status(401).json({ error: "Falsches Passwort." });
next();
}

function rateLimit(req, res, next) {
const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
const now = Date.now();
const windowMs = 60 * 1000;
const maxRequests = 15;
if (!rateLimitStore[ip]) rateLimitStore[ip] = [];
rateLimitStore[ip] = rateLimitStore[ip].filter((time) => now - time < windowMs);
if (rateLimitStore[ip].length >= maxRequests) {
return res.status(429).json({ error: "Analyse-Limit erreicht. Bitte warte ca. eine Minute." });
}
rateLimitStore[ip].push(now);
next();
}

function safeNumber(value, fallback = 0) {
const n = Number(value);
return Number.isFinite(n) ? n : fallback;
}

function calculateEMA(prices, period) {
if (!prices || prices.length === 0) return "0.00";
const k = 2 / (period + 1);
let ema = prices[0];
for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
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
if (!marketCap) return { label: "Unbekannt", emoji: "\u26aa", level: 50 };
if (marketCap >= 50000000000) return { label: "Low Risk", emoji: "\u{1F7E2}", level: 25 };
if (marketCap >= 5000000000) return { label: "Medium Risk", emoji: "\u{1F7E1}", level: 50 };
if (marketCap >= 500000000) return { label: "High Risk", emoji: "\u{1F7E0}", level: 75 };
return { label: "Extreme Risk", emoji: "\u{1F534}", level: 95 };
}

function buildAdvancedScore(change24h, rsi, price, ema20, ema50, ema200, fearGreedValue) {
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
if (fearGreedValue >= 55) score += 5;
if (fearGreedValue <= 45) score -= 5;
score = Math.max(0, Math.min(100, score));
let label = "Neutral \u2696\ufe0f";
let signal = "WAIT";
let signalEmoji = "\u{1F7E1}";
if (score >= 70) {
label = "Bullish \u{1F680}";
signal = "WATCH / BULLISH";
signalEmoji = "\u{1F7E2}";
}
if (score <= 35) {
label = "Bearish \u{1F53B}";
signal = "CAUTION";
signalEmoji = "\u{1F534}";
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

async function getFearGreed() {
const cached = cacheGet("feargreed", 5 * 60 * 1000);
if (cached) return cached;
try {
const fg = await axios.get("https://api.alternative.me/fng/");
const value = Number(fg.data.data[0].value);
const result = {
fearGreed: fg.data.data[0].value_classification + " (" + value + ")",
fearGreedValue: value
};
cacheSet("feargreed", result);
return result;
} catch (e) {
return { fearGreed: "Keine Daten", fearGreedValue: 50 };
}
}

async function getGlobalMarket() {
const global = await axios.get("https://api.coingecko.com/api/v3/global");
const data = global.data.data;
return {
activeCryptos: data.active_cryptocurrencies || 0,
markets: data.markets || 0,
totalMarketCap: data.total_market_cap.usd || 0,
marketCapChange24h: data.market_cap_change_percentage_24h_usd || 0,
totalVolume24h: data.total_volume.usd || 0,
btcDominance: Number(data.market_cap_percentage.btc || 0),
ethDominance: Number(data.market_cap_percentage.eth || 0)
};
}

function extractProjectInfo(data) {
const categories = data.categories || [];
const links = data.links || {};
const homepage = links.homepage && links.homepage[0] ? links.homepage[0] : "";
const blockchainSites = links.blockchain_site ? links.blockchain_site.filter(Boolean).slice(0, 4) : [];
const symbol = String(data.symbol || "").toLowerCase();
const name = data.name || "Dieses Projekt";
let wallets = ["Ledger / Hardware Wallet je nach Netzwerk", "MetaMask falls EVM-kompatibel", "Trust Wallet je nach Asset"];
if (symbol === "btc") wallets = ["Ledger", "Trezor", "Trust Wallet"];
if (symbol === "eth") wallets = ["Ledger", "MetaMask", "Trust Wallet"];

const englishDescription = data.description && data.description.en
? data.description.en.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 900)
: "Keine ausf\xfchrliche Projektbeschreibung verf\xfcgbar.";

const germanEducationSummary =
name + " ist ein Krypto-Projekt, das anhand von Kategorien, Netzwerkdaten, offizieller Website, Handelsvolumen und Projektinformationen eingeordnet wird. " +
"Die genaue Bewertung sollte immer \xfcber offizielle Quellen, Dokumentation, Explorer, Team-Informationen, Tokenomics und Community gepr\xfcft werden. " +
"Diese Kurzbeschreibung ist eine neutrale Bildungs-Zusammenfassung und keine Anlageberatung.";

const twitter = links.twitter_screen_name ? "https://x.com/" + links.twitter_screen_name : "";
const telegram = links.telegram_channel_identifier ? "https://t.me/" + links.telegram_channel_identifier : "";
const reddit = links.subreddit_url || "";
const forum = links.official_forum_url && links.official_forum_url[0] ? links.official_forum_url[0] : "";

return {
description: englishDescription,
descriptionDe: germanEducationSummary,
categories,
homepage,
blockchainSites,
wallets,
genesisDate: data.genesis_date || "Nicht verf\xfcgbar",
hashingAlgorithm: data.hashing_algorithm || "Nicht verf\xfcgbar",
twitter,
telegram,
reddit,
forum,
coinGeckoUrl: "https://www.coingecko.com/en/coins/" + data.id,
coinMarketCapUrl: "https://coinmarketcap.com/search/?q=" + encodeURIComponent(data.symbol || data.name || "")
};
}

function buildTokenomicsSummary(data, market) {
const currentPrice = market.current_price && market.current_price.usd ? market.current_price.usd : 0;
const marketCap = market.market_cap && market.market_cap.usd ? market.market_cap.usd : 0;
const fdv = market.fully_diluted_valuation && market.fully_diluted_valuation.usd ? market.fully_diluted_valuation.usd : 0;
const volume24h = market.total_volume && market.total_volume.usd ? market.total_volume.usd : 0;
const circulatingSupply = market.circulating_supply || 0;
const totalSupply = market.total_supply || 0;
const maxSupply = market.max_supply || null;
const ath = market.ath && market.ath.usd ? market.ath.usd : 0;
const atl = market.atl && market.atl.usd ? market.atl.usd : 0;
const supplyProgress = maxSupply && circulatingSupply ? (circulatingSupply / maxSupply) * 100 : null;
const fdvRatio = marketCap && fdv ? fdv / marketCap : null;

const notes = [];
if (supplyProgress !== null && supplyProgress < 50) notes.push('Nur ein Teil der maximalen Menge ist im Umlauf. Unlocks/Inflation sollten genauer geprÃ¼ft werden.');
if (fdvRatio !== null && fdvRatio > 3) notes.push('FDV ist deutlich hÃ¶her als aktuelle Market Cap. Das kann auf kÃ¼nftige VerwÃ¤sserung hinweisen.');
if (volume24h && marketCap && volume24h / marketCap < 0.005) notes.push('24h Volumen ist im VerhÃ¤ltnis zur Market Cap eher niedrig. LiquiditÃ¤t prÃ¼fen.');
if (!maxSupply) notes.push('Max Supply ist nicht klar definiert oder nicht verfÃ¼gbar. Das ist nicht automatisch schlecht, sollte aber verstanden werden.');
if (!notes.length) notes.push('Die verfÃ¼gbaren Tokenomics-Daten wirken auf den ersten Blick nachvollziehbar. Trotzdem bleiben Unlocks, Team-Anteile und Verteilung wichtig.');

return {
currentPrice,
marketCap,
fdv,
volume24h,
circulatingSupply,
totalSupply,
maxSupply: maxSupply || 'Nicht definiert',
ath,
atl,
supplyProgress: supplyProgress === null ? 'Nicht verfÃ¼gbar' : supplyProgress.toFixed(2) + '%',
fdvRatio: fdvRatio === null ? 'Nicht verfÃ¼gbar' : fdvRatio.toFixed(2) + 'x',
notes
};
}

function buildScamAnalyzer(data, market, marketCap, volume24h, ageScoreFallback) {
let score = 100;
const checks = [];
const links = data.links || {};
const homepage = links.homepage && links.homepage[0] ? links.homepage[0] : "";
const websiteOk = Boolean(homepage);
const categories = data.categories || [];
const hasExplorer = links.blockchain_site && links.blockchain_site.filter(Boolean).length > 0;
const hasTwitter = Boolean(links.twitter_screen_name);
const hasTelegram = Boolean(links.telegram_channel_identifier);
const hasReddit = Boolean(links.subreddit_url);
const hasMaxSupply = Boolean(market.max_supply) || String(data.symbol || "").toLowerCase() === "eth";
const volumeRatio = marketCap ? volume24h / marketCap : 0;

function push(label, status, value, impact, detail, meaning, url) {
checks.push({ label, status, value, detail, meaning, url: url || "" });
score -= impact;
}

push("Offizielle Website", websiteOk ? "ok" : "warning", websiteOk ? "vorhanden" : "nicht gefunden", websiteOk ? 0 : 12, websiteOk ? "Eine offizielle Website ist vorhanden. Pr\xfcfe dort Team, Dokumentation, Roadmap, Impressum/Company und Social Links." : "Keine klare Website gefunden. Das ist ein Warnsignal, weil Nutzer schwer pr\xfcfen k\xf6nnen, wer hinter dem Projekt steht.", "Eine saubere Website ist kein Sicherheitsbeweis, aber sie ist die Basis f\xfcr weitere Recherche. Fehlende Website erh\xf6ht das Risiko.", homepage);
push("Explorer / Blockchain-Daten", hasExplorer ? "ok" : "warning", hasExplorer ? "Explorer vorhanden" : "kein Explorer-Link", hasExplorer ? 0 : 10, hasExplorer ? "Explorer-Links sind vorhanden. Dort k\xf6nnen Transaktionen, Contract-Daten und Wallet-Bewegungen gepr\xfcft werden." : "Ohne Explorer-Link ist On-Chain-Pr\xfcfung schwieriger.", "Explorer helfen dabei zu pr\xfcfen, ob Transaktionen, Contract-Adressen und Token-Bewegungen nachvollziehbar sind.", (links.blockchain_site && links.blockchain_site.filter(Boolean)[0]) || "");
push("Market Cap", marketCap >= 50000000 ? "ok" : "warning", marketCap ? "$" + Math.round(marketCap).toLocaleString("de-DE") : "nicht verf\xfcgbar", marketCap >= 50000000 ? 0 : 12, marketCap >= 50000000 ? "Die Market Cap wirkt nicht extrem klein. Gr\xf6\xdfere Projekte sind oft liquider, aber nicht automatisch sicher." : "Sehr kleine Market Cap kann hohe Schwankungen, geringe Liquidit\xe4t und Manipulationsrisiko bedeuten.", "Market Cap zeigt die Gr\xf6\xdfe eines Projekts. Kleinere Projekte k\xf6nnen st\xe4rker steigen, aber auch schneller crashen.", "https://www.coingecko.com/en/coins/" + data.id);
push("Liquidit\xe4t / 24h Volumen", volumeRatio >= 0.005 ? "ok" : "warning", (volumeRatio * 100).toFixed(2) + "% der Market Cap", volumeRatio >= 0.005 ? 0 : 12, volumeRatio >= 0.005 ? "Das Handelsvolumen wirkt im Verh\xe4ltnis zur Market Cap brauchbar." : "Das Handelsvolumen wirkt niedrig. Ein- und Ausstiege k\xf6nnten schwieriger sein.", "Volumen zeigt, ob genug Marktaktivit\xe4t vorhanden ist. Niedriges Volumen erh\xf6ht Slippage- und Manipulationsrisiko.", "https://www.coingecko.com/en/coins/" + data.id);
push("Supply-Daten", hasMaxSupply ? "ok" : "neutral", hasMaxSupply ? "vorhanden" : "teilweise offen", hasMaxSupply ? 0 : 5, hasMaxSupply ? "Supply-Daten sind vorhanden oder projektbedingt erkl\xe4rbar." : "Max Supply ist nicht klar definiert. Das ist nicht automatisch schlecht, sollte aber gepr\xfcft werden.", "Tokenomics sind wichtig: Umlaufmenge, Max Supply, Inflation und Unlocks beeinflussen das Risiko.", "https://www.coingecko.com/en/coins/" + data.id);
push("Projekt-Reife / Startdatum", ageScoreFallback >= 40 ? "ok" : "neutral", data.genesis_date || "nicht verf\xfcgbar", ageScoreFallback >= 40 ? 0 : 7, ageScoreFallback >= 40 ? "Das Projekt ist anhand verf\xfcgbarer Daten besser einzuordnen." : "Startdatum ist nicht klar verf\xfcgbar. Bei jungen oder schwer einzuordnenden Projekten ist mehr Recherche n\xf6tig.", "\xc4ltere Projekte sind nicht automatisch sicher, aber es gibt meist mehr Historie, Daten und Community-Spuren.");
push("Social Proof", hasTwitter || hasTelegram || hasReddit ? "ok" : "warning", [hasTwitter ? "X" : "", hasTelegram ? "Telegram" : "", hasReddit ? "Reddit" : ""].filter(Boolean).join(" / ") || "keine klaren Links", hasTwitter || hasTelegram || hasReddit ? 0 : 8, hasTwitter || hasTelegram || hasReddit ? "Mindestens ein Community-/Social-Link ist verf\xfcgbar. Pr\xfcfe echte Aktivit\xe4t statt nur Follower-Zahlen." : "Keine klaren Social-Links gefunden. Das erschwert die Community-Pr\xfcfung.", "Social Links helfen, Aktivit\xe4t, Transparenz und Community-Qualit\xe4t einzusch\xe4tzen. Fake-Hype bleibt trotzdem m\xf6glich.", hasTwitter ? ("https://x.com/" + links.twitter_screen_name) : (hasTelegram ? ("https://t.me/" + links.telegram_channel_identifier) : (links.subreddit_url || "")));
push("Branche / Kategorien", categories.length ? "ok" : "neutral", categories.length ? categories.slice(0, 4).join(", ") : "nicht verf\xfcgbar", categories.length ? 0 : 5, categories.length ? "Kategorien helfen, das Projekt einem Sektor zuzuordnen." : "Keine klare Kategorie gefunden. Use Case schwerer einzuordnen.", "Kategorien zeigen, ob ein Projekt z.B. DeFi, AI, Gaming, Infrastruktur, Meme oder Layer 1 ist.", "https://www.coingecko.com/en/coins/" + data.id);
push("Team / Gr\xfcnder", "neutral", "manuell pr\xfcfen", 5, "Team- und Gr\xfcnderinformationen sind nicht immer standardisiert \xfcber CoinGecko verf\xfcgbar. Bitte Website, Docs, LinkedIn/X und Presse pr\xfcfen.", "Doxxed Team, nachvollziehbare Historie und klare Kommunikation reduzieren Risiko, garantieren aber keine Sicherheit.", homepage);
push("Audit / Contract-Sicherheit", "neutral", "manuell pr\xfcfen", 5, "Audit-Daten werden hier noch nicht live von TokenSniffer/GoPlus geladen. Pr\xfcfe Audit, Contract-Verifizierung und Admin-Rechte separat.", "Audits k\xf6nnen Risiken reduzieren, aber nicht vollst\xe4ndig ausschlie\xdfen. Unverifizierte Contracts sind riskanter.", "https://tokensniffer.com/search?q=" + encodeURIComponent(data.symbol || data.id));
push("Holder-Verteilung / Wallets", "neutral", "sp\xe4ter On-Chain-Check", 5, "Top-Holder-Verteilung wird aktuell noch nicht live gepr\xfcft. Bei kleinen Tokens kann eine hohe Konzentration ein starkes Warnsignal sein.", "Wenn wenige Wallets sehr viel Supply halten, k\xf6nnen starke Verk\xe4ufe den Preis massiv beeinflussen.", (links.blockchain_site && links.blockchain_site.filter(Boolean)[0]) || "");

score = Math.max(0, Math.min(100, Math.round(score)));
let label = "Eher unauff\xe4llig";
if (score < 70) label = "Erh\xf6hte Vorsicht";
if (score < 45) label = "Hohes Risiko";

return { score, label, checks, website: homepage, disclaimer: "Risikofilter f\xfcr Bildung und Recherche. Kein Scam-Urteil, keine Garantie und keine Anlageberatung." };
}

function buildCycleState(price, ema50, ema200, rsi, fearGreedValue, btcDominance, marketCapChange24h, athPrice) {
let score = 50;
const athDrop = athPrice ? ((price / athPrice - 1) * 100) : 0;
if (price > ema50) score += 8;
if (price > ema200) score += 12;
if (price < ema50) score -= 8;
if (price < ema200) score -= 12;
if (Number(rsi) > 60) score += 6;
if (Number(rsi) < 40) score -= 6;
if (fearGreedValue > 65) score += 8;
if (fearGreedValue < 35) score -= 8;
if (marketCapChange24h > 1) score += 4;
if (marketCapChange24h < -1) score -= 4;
if (athPrice && athDrop <= -20) score -= 10;
if (athPrice && athDrop <= -35) score -= 12;
if (athPrice && athDrop <= -55) score -= 10;
score = Math.max(0, Math.min(100, Math.round(score)));
let phase = "Akkumulation / \xdcbergang";
let marker = 2;
let text = "Der Markt k\xf6nnte sich in einer Akkumulations- oder \xdcbergangsphase befinden. Das bedeutet: Es gibt Erholungen, aber noch keinen eindeutig best\xe4tigten Bullrun. Geduld, Risiko-Kontrolle und Bildung bleiben wichtig.";
if (score >= 75 && (!athPrice || athDrop > -15)) {
phase = "Bullrun / starke Marktphase";
marker = 4;
text = "Viele Signale wirken positiv und der Abstand zum Hoch ist nicht extrem gro\xdf. Trotzdem steigt bei Euphorie das Risiko f\xfcr starke R\xfccksetzer.";
} else if (score >= 60) {
phase = athPrice && athDrop <= -25 ? "Akkumulation / Erholungsphase" : "Fr\xfche Bullenphase";
marker = athPrice && athDrop <= -25 ? 2 : 3;
text = athPrice && athDrop <= -25 ? "Die Struktur zeigt Erholung, aber der Abstand zum All-Time-High ist noch gro\xdf. Das wirkt eher wie Akkumulation oder kurzfristige Erholung als ein best\xe4tigter Bullrun." : "Der Markt verbessert sich. R\xfccksetzer bleiben normal und Best\xe4tigung ist wichtiger als FOMO.";
} else if (score <= 25) {
phase = "Kapitulation / tiefer B\xe4renmarkt";
marker = 0;
text = "Der Markt wirkt sehr schwach. Solche Phasen k\xf6nnen langfristige Chancen bringen, sind aber psychologisch und technisch besonders riskant.";
} else if (score <= 40) {
phase = "B\xe4renmarkt / Risiko-Phase";
marker = 1;
text = "Der Markt wirkt defensiv. Kurzfristige Erholungen sind m\xf6glich, aber Kapitalerhalt, Geduld und klare Regeln sind besonders wichtig.";
}
return { score, phase, marker, text, athDrop: athPrice ? athDrop.toFixed(2) : "", btcDominance: Number(btcDominance || 0).toFixed(2) };
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
const search = await axios.get("https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(query));
const coins = search.data.coins || [];
if (!coins.length) return null;
const exact = coins.find((c) => c.id.toLowerCase() === query) || coins.find((c) => c.symbol.toLowerCase() === query) || coins.find((c) => c.name.toLowerCase() === query);
const result = exact ? exact.id : coins[0].id;
cacheSet("resolve_" + query, result);
return result;
}


function buildStaticMarketOverview() {
return {
stocks: [
{ symbol: "AAPL", name: "Apple", sector: "Technology", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NASDAQ-AAPL/" },
{ symbol: "MSFT", name: "Microsoft", sector: "Technology / Cloud", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NASDAQ-MSFT/" },
{ symbol: "NVDA", name: "Nvidia", sector: "AI / Semiconductors", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NASDAQ-NVDA/" },
{ symbol: "AMZN", name: "Amazon", sector: "E-Commerce / Cloud", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NASDAQ-AMZN/" },
{ symbol: "GOOGL", name: "Alphabet", sector: "Search / AI / Ads", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NASDAQ-GOOGL/" },
{ symbol: "META", name: "Meta Platforms", sector: "Social / AI", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NASDAQ-META/" },
{ symbol: "BRK-B", name: "Berkshire Hathaway", sector: "Holding / Insurance", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NYSE-BRK.B/" },
{ symbol: "TSLA", name: "Tesla", sector: "EV / Energy", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NASDAQ-TSLA/" },
{ symbol: "AVGO", name: "Broadcom", sector: "Semiconductors", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NASDAQ-AVGO/" },
{ symbol: "LLY", name: "Eli Lilly", sector: "Healthcare", category: "Top Market Cap", link: "https://www.tradingview.com/symbols/NYSE-LLY/" }
],
stockPerformanceUniverse: ["NVDA", "AAPL", "MSFT", "AMZN", "META", "TSLA", "AVGO", "NFLX", "COST", "AMD", "ADBE", "ASML", "GOOGL", "ORCL", "CRM"],
etfs: [
{ symbol: "SPY", name: "SPDR S&P 500 ETF", focus: "US Large Caps", category: "Core USA", link: "https://www.tradingview.com/symbols/AMEX-SPY/" },
{ symbol: "IVV", name: "iShares Core S&P 500 ETF", focus: "US Large Caps", category: "Core USA", link: "https://www.tradingview.com/symbols/AMEX-IVV/" },
{ symbol: "VOO", name: "Vanguard S&P 500 ETF", focus: "US Large Caps", category: "Core USA", link: "https://www.tradingview.com/symbols/AMEX-VOO/" },
{ symbol: "VTI", name: "Vanguard Total Stock Market ETF", focus: "US Total Market", category: "Broad Market", link: "https://www.tradingview.com/symbols/AMEX-VTI/" },
{ symbol: "QQQ", name: "Invesco QQQ", focus: "Nasdaq 100", category: "Growth / Tech", link: "https://www.tradingview.com/symbols/NASDAQ-QQQ/" },
{ symbol: "VEA", name: "Vanguard FTSE Developed Markets ETF", focus: "Developed Markets", category: "International", link: "https://www.tradingview.com/symbols/AMEX-VEA/" },
{ symbol: "VWO", name: "Vanguard FTSE Emerging Markets ETF", focus: "Emerging Markets", category: "International", link: "https://www.tradingview.com/symbols/AMEX-VWO/" },
{ symbol: "GLD", name: "SPDR Gold Shares", focus: "Gold", category: "Commodity ETF", link: "https://www.tradingview.com/symbols/AMEX-GLD/" },
{ symbol: "IBIT", name: "iShares Bitcoin Trust", focus: "Spot Bitcoin", category: "Crypto ETF", link: "https://www.tradingview.com/symbols/NASDAQ-IBIT/" },
{ symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", focus: "Long US Bonds", category: "Bonds", link: "https://www.tradingview.com/symbols/NASDAQ-TLT/" }
],
etfPerformanceUniverse: ["QQQ", "SPY", "IVV", "VOO", "VTI", "SMH", "XLK", "VGT", "GLD", "SLV", "IBIT", "IWM", "DIA", "EEM", "TLT"],
indices: [
{ symbol: "SPX", yahooSymbol: "^GSPC", name: "S&P 500", region: "USA", link: "https://www.tradingview.com/symbols/SPX/" },
{ symbol: "NASDAQ", yahooSymbol: "^IXIC", name: "Nasdaq Composite", region: "USA", link: "https://www.tradingview.com/symbols/NASDAQ-IXIC/" },
{ symbol: "NDX", yahooSymbol: "^NDX", name: "Nasdaq 100", region: "USA", link: "https://www.tradingview.com/symbols/NASDAQ-NDX/" },
{ symbol: "DJI", yahooSymbol: "^DJI", name: "Dow Jones", region: "USA", link: "https://www.tradingview.com/symbols/DJ-DJI/" },
{ symbol: "DAX", yahooSymbol: "^GDAXI", name: "DAX", region: "Germany", link: "https://www.tradingview.com/symbols/XETR-DAX/" },
{ symbol: "NI225", yahooSymbol: "^N225", name: "Nikkei 225", region: "Japan", link: "https://www.tradingview.com/symbols/TVC-NI225/" },
{ symbol: "FTSE100", yahooSymbol: "^FTSE", name: "FTSE 100", region: "UK", link: "https://www.tradingview.com/symbols/TVC-UKX/" },
{ symbol: "EUROSTOXX50", yahooSymbol: "^STOXX50E", name: "Euro Stoxx 50", region: "Europe", link: "https://www.tradingview.com/symbols/TVC-SX5E/" },
{ symbol: "RUSSELL2000", yahooSymbol: "^RUT", name: "Russell 2000", region: "USA", link: "https://www.tradingview.com/symbols/TVC-RUT/" },
{ symbol: "HSI", yahooSymbol: "^HSI", name: "Hang Seng", region: "Hong Kong", link: "https://www.tradingview.com/symbols/TVC-HSI/" }
],
metals: [
{ symbol: "XAUUSD", yahooSymbol: "GC=F", name: "Gold Futures", unit: "USD/oz", link: "https://www.tradingview.com/symbols/OANDA-XAUUSD/" },
{ symbol: "XAGUSD", yahooSymbol: "SI=F", name: "Silver Futures", unit: "USD/oz", link: "https://www.tradingview.com/symbols/OANDA-XAGUSD/" },
{ symbol: "XPTUSD", yahooSymbol: "PL=F", name: "Platinum Futures", unit: "USD/oz", link: "https://www.tradingview.com/symbols/OANDA-XPTUSD/" },
{ symbol: "XPDUSD", yahooSymbol: "PA=F", name: "Palladium Futures", unit: "USD/oz", link: "https://www.tradingview.com/symbols/OANDA-XPDUSD/" },
{ symbol: "GLD", name: "Gold ETF", unit: "ETF", link: "https://www.tradingview.com/symbols/AMEX-GLD/" },
{ symbol: "SLV", name: "Silver ETF", unit: "ETF", link: "https://www.tradingview.com/symbols/AMEX-SLV/" }
]
};
}

function buildGenericMarketEducation(type) {
const map = {
stocks: {
title: "Aktien",
text: "Aktien sind Unternehmensanteile. Wichtig sind Umsatz, Gewinn, Cashflow, Bewertung, Branche, Burggraben und langfristige WettbewerbsfÃ¤higkeit. Diese Ansicht ist als Education- und Analysebereich vorbereitet und ersetzt keine Anlageberatung."
},
etfs: {
title: "ETFs",
text: "ETFs bÃ¼ndeln viele Wertpapiere in einem Produkt. Wichtig sind Index, TER/Kosten, Fondsvolumen, Replikation, AusschÃ¼ttung/Thesaurierung, Tracking Difference und Anbieter."
},
indices: {
title: "Indizes",
text: "Indizes zeigen die Entwicklung ganzer MÃ¤rkte oder Sektoren. Sie helfen, Makro-Trends, Risikoappetit und globale Marktphasen besser einzuordnen."
},
metals: {
title: "Edelmetalle",
text: "Edelmetalle wie Gold und Silber werden oft als Absicherung, Inflationsschutz oder Krisenasset betrachtet. Wichtig sind Realzinsen, Dollar, Zentralbanken, Nachfrage und Risikoappetit."
}
};
return map[type] || map.stocks;
}

function buildMarketRangeMap(period) {
const p = String(period || "5y");
if (p === "1y") return { range: "1y", interval: "1d" };
if (p === "5y") return { range: "5y", interval: "1wk" };
if (p === "10y") return { range: "10y", interval: "1mo" };
if (p === "20y") return { range: "20y", interval: "1mo" };
if (p === "30y") return { range: "max", interval: "1mo" };
if (p === "40y") return { range: "max", interval: "1mo" };
if (p === "50y") return { range: "max", interval: "1mo" };
return { range: "5y", interval: "1wk" };
}

async function calculatePerformanceForSymbol(symbol, period) {
const cfg = buildMarketRangeMap(period);
const chart = await fetchYahooChart(symbol, cfg.range, cfg.interval);
const prices = chart.prices || [];
if (prices.length < 2) throw new Error("Not enough chart data");
const first = Number(prices[0][1]);
const last = Number(prices[prices.length - 1][1]);
const performancePct = first ? ((last / first) - 1) * 100 : 0;
return { symbol: symbol, name: chart.name, price: last, currency: chart.currency, performancePct: performancePct, prices: prices };
}

async function buildPerformanceList(type, period) {
const overview = buildStaticMarketOverview();
let symbols = [];
if (type === "stocks") symbols = overview.stockPerformanceUniverse;
else if (type === "etfs") symbols = overview.etfPerformanceUniverse;
else if (type === "indices") symbols = overview.indices.map(function (x) { return x.yahooSymbol || x.symbol; });
else if (type === "metals") symbols = overview.metals.map(function (x) { return x.yahooSymbol || x.symbol; });
else symbols = overview.stockPerformanceUniverse;

const results = await Promise.all(symbols.map(async function (symbol) {
try { return await calculatePerformanceForSymbol(symbol, period); }
catch (e) { return null; }
}));

return results.filter(Boolean).sort(function (a, b) { return b.performancePct - a.performancePct; }).slice(0, 10);
}

app.get("/api/multi-market-overview", checkPassword, async function (req, res) {
try {
const cached = cacheGet("multi_market_overview_v9", 10 * 60 * 1000);
if (cached) return res.json(cached);
const overview = buildStaticMarketOverview();
const result = {
stocks: await hydrateAssetsWithQuotes(overview.stocks),
etfs: await hydrateAssetsWithQuotes(overview.etfs),
indices: await hydrateAssetsWithQuotes(overview.indices),
metals: await hydrateAssetsWithQuotes(overview.metals),
education: {
stocks: buildGenericMarketEducation("stocks"),
etfs: buildGenericMarketEducation("etfs"),
indices: buildGenericMarketEducation("indices"),
metals: buildGenericMarketEducation("metals")
},
note: "Live-Kurse werden Ã¼ber Ã¶ffentliche Yahoo-Finance-Chartdaten geladen, wenn verfÃ¼gbar. Bei AusfÃ¤llen werden vorbereitete Basisdaten angezeigt. Keine Anlageberatung."
};
cacheSet("multi_market_overview_v9", result);
res.json(result);
} catch (e) {
const overview = buildStaticMarketOverview();
res.json(Object.assign({}, overview, { note: "Live-Daten aktuell nicht erreichbar. Basislisten werden angezeigt." }));
}
});

app.get("/api/market-performance", checkPassword, async function (req, res) {
const type = req.query.type || "stocks";
const period = req.query.period || "5y";
try {
const cacheKey = "market_perf_" + type + "_" + period;
const cached = cacheGet(cacheKey, 30 * 60 * 1000);
if (cached) return res.json(cached);
const items = await buildPerformanceList(type, period);
const result = { type: type, period: period, items: items, source: "Yahoo Finance Chart API (public endpoint)" };
cacheSet(cacheKey, result);
res.json(result);
} catch (e) {
res.json({ type: type, period: period, items: [], error: "Performance-Daten aktuell nicht erreichbar." });
}
});

app.get("/api/market-asset-chart", checkPassword, async function (req, res) {
const symbol = req.query.symbol || "AAPL";
const range = req.query.range || "5y";
const interval = req.query.interval || (range === "1d" ? "5m" : "1d");
try {
const chart = await fetchYahooChart(symbol, range, interval);
res.json({ chart: chart });
} catch (e) {
res.status(500).json({ error: "Chartdaten aktuell nicht verfÃ¼gbar.", symbol: symbol });
}
});

app.post("/api/market-asset", checkPassword, async function (req, res) {
const type = req.body.type || "stocks";
const symbol = String(req.body.symbol || "").trim().toUpperCase();
const range = req.body.range || "5y";
const education = buildGenericMarketEducation(type);
const overview = buildStaticMarketOverview();
const group = overview[type] || [];
const asset = group.find(function (item) { return String(item.symbol).toUpperCase() === symbol || String(item.yahooSymbol || "").toUpperCase() === symbol; }) || group[0] || { symbol: symbol, name: symbol, link: "https://www.tradingview.com/" };
try {
const chart = await fetchYahooChart(asset.yahooSymbol || asset.symbol, range, range === "1d" ? "5m" : "1d");
const quote = await fetchYahooQuote(asset.yahooSymbol || asset.symbol);
res.json({
type: type,
symbol: asset.symbol || symbol,
yahooSymbol: asset.yahooSymbol || asset.symbol || symbol,
name: asset.name || quote.name || symbol,
title: education.title,
education: education.text,
link: asset.link || "https://www.tradingview.com/",
quote: quote,
chart: chart,
status: "live",
note: "Live-Kurs und Chart geladen. Keine Anlageberatung."
});
} catch (e) {
res.json({
type: type,
symbol: asset.symbol || symbol,
name: asset.name || symbol,
title: education.title,
education: education.text,
link: asset.link || "https://www.tradingview.com/",
status: "fallback",
note: "Live-Daten aktuell nicht erreichbar. Basisdaten werden angezeigt."
});
}
});

function buildEducationSeries(type) {
const now = new Date().toISOString().slice(0, 10);
if (type === "altseason") {
return {
type: type,
title: "Altcoin Season Index",
currentValue: 42,
date: now,
labels: ["Bitcoin Season", "Neutral", "Altcoins stÃ¤rker", "Altcoin Season"],
values: [18, 32, 47, 62, 55, 49, 42],
explanation: "Der Altcoin Season Index zeigt, ob Altcoins im Vergleich zu Bitcoin stÃ¤rker laufen. Unter 25 spricht man eher von Bitcoin-Dominanz, Ã¼ber 75 eher von Altcoin Season. Der Wert hier ist eine Education-NÃ¤herung, bis eine echte BlockchainCenter/CoinMarketCap-Datenquelle angebunden ist.",
source: "Education-Modell; echte Datenquelle spÃ¤ter: BlockchainCenter / CoinMarketCap"
};
}
if (type === "btcdom") {
return {
type: type,
title: "Bitcoin Dominance",
currentValue: 58,
date: now,
labels: ["2017", "2018", "2020", "2021", "2022", "2024", "Heute"],
values: [86, 35, 63, 40, 48, 53, 58],
explanation: "BTC-Dominanz zeigt, wie viel Anteil Bitcoin an der gesamten Krypto-Market-Cap hat. Steigende Dominanz bedeutet oft, dass Kapital eher in Bitcoin als in Altcoins flieÃ�t. Fallende Dominanz kann Altcoin-Phasen begÃ¼nstigen.",
source: "Education-Modell auf Basis typischer Dominanz-Zyklen; Live-Wert kommt aus CoinGecko Global."
};
}
if (type === "ethdom") {
return {
type: type,
title: "Ethereum Dominance",
currentValue: 10,
date: now,
labels: ["2017", "2018", "2020", "2021", "2022", "2024", "Heute"],
values: [5, 13, 11, 20, 18, 16, 10],
explanation: "ETH-Dominanz zeigt den Anteil von Ethereum an der gesamten Krypto-Market-Cap. Eine starke ETH-Dominanz kann auf StÃ¤rke im Smart-Contract-, DeFi-, NFT- oder Layer-2-Ã�kosystem hindeuten.",
source: "Education-Modell; Live-Wert kommt aus CoinGecko Global."
};
}
if (type === "cryptorsi") {
return {
type: type,
title: "Durchschnittlicher Krypto RSI",
currentValue: 50,
date: now,
labels: ["Sehr schwach", "Schwach", "Neutral", "Stark", "Ã�berhitzt"],
values: [31, 42, 50, 61, 72, 54, 50],
explanation: "Der Krypto-RSI ist eine vereinfachte Momentum-NÃ¤herung fÃ¼r den Gesamtmarkt. Werte Ã¼ber 70 kÃ¶nnen Ã�berhitzung andeuten, Werte unter 30 kÃ¶nnen Panik oder Ã�berverkauftheit anzeigen.",
source: "Interne NÃ¤herung aus Top-Coin-Momentum."
};
}
if (type === "rainbow") {
return {
type: type,
title: "Bitcoin Rainbow Chart",
currentValue: 50,
date: now,
labels: ["Fire Sale", "Buy Zone", "Accumulate", "Fair Value", "FOMO", "Bubble"],
values: [15, 25, 40, 55, 75, 92],
explanation: "Der Bitcoin Rainbow Chart ist ein langfristiges, logarithmisches Bewertungsmodell. Die Farben zeigen grobe Bewertungszonen von stark unterbewertet bis Ã¼berhitzt. Es ist kein exaktes Timing-Tool, sondern Education und langfristige Orientierung.",
source: "Education-Nachbau inspiriert von Rainbow-Chart-Modellen."
};
}
return buildEducationSeries("altseason");
}

app.get("/api/market-education-chart", checkPassword, function (req, res) {
const type = req.query.type || "altseason";
res.json(buildEducationSeries(type));
});

app.get("/api/dca-examples", checkPassword, function (req, res) {
res.json({
examples: [
{ amount: 1000, foundation: 500, large: 250, mid: 150, small: 50, cash: 50, steps: [250, 250, 250, 250] },
{ amount: 10000, foundation: 5000, large: 2500, mid: 1500, small: 500, cash: 500, steps: [2500, 2500, 2500, 2500] },
{ amount: 100000, foundation: 50000, large: 25000, mid: 15000, small: 5000, cash: 5000, steps: [25000, 25000, 25000, 25000] }
],
explanation: "DCA bedeutet, Kapital nicht auf einmal zu investieren, sondern in Tranchen zu verteilen. Das kann helfen, Timing-Risiko zu reduzieren. Dies ist nur ein Bildungsbeispiel und keine Anlageberatung."
});
});

app.get("/", function (req, res) { res.sendFile(__dirname + "/public/index.html"); });

app.get("/api/search", checkPassword, async function (req, res) {
try {
const query = req.query.q || "";
if (query.length < 2) return res.json({ coins: [] });
const cached = cacheGet("search_" + query, 5 * 60 * 1000);
if (cached) return res.json({ coins: cached });
const search = await axios.get("https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(query));
const coins = (search.data.coins || []).slice(0, 10).map((coin) => ({ id: coin.id, name: coin.name, symbol: coin.symbol, thumb: coin.thumb, marketCapRank: coin.market_cap_rank || "?" }));
cacheSet("search_" + query, coins);
res.json({ coins });
} catch (error) { res.status(500).json({ error: "Coin-Suche aktuell nicht erreichbar. Bitte kurz warten." }); }
});

app.get("/api/trending", checkPassword, async function (req, res) {
try {
const cached = cacheGet("trending", 15 * 60 * 1000);
if (cached) return res.json(cached);
const trending = await axios.get("https://api.coingecko.com/api/v3/search/trending");
const baseCoins = (trending.data.coins || []).slice(0, 10).map((item) => ({ id: item.item.id, name: item.item.name, symbol: item.item.symbol, thumb: item.item.thumb, rank: item.item.market_cap_rank || "?" }));
const ids = baseCoins.map((coin) => coin.id).join(",");
let marketMap = {};
try {
const markets = await axios.get("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=" + encodeURIComponent(ids) + "&price_change_percentage=24h");
markets.data.forEach((coin) => { marketMap[coin.id] = { price: coin.current_price, change24h: coin.price_change_percentage_24h || 0, image: coin.image }; });
} catch (e) {}
const coins = baseCoins.map((coin) => ({ id: coin.id, name: coin.name, symbol: coin.symbol, thumb: marketMap[coin.id] ? marketMap[coin.id].image : coin.thumb, rank: coin.rank, price: marketMap[coin.id] ? marketMap[coin.id].price : null, change24h: marketMap[coin.id] ? marketMap[coin.id].change24h : null }));
const result = { coins };
cacheSet("trending", result);
res.json(result);
} catch (error) { res.json({ coins: [] }); }
});

function coinMarketMapper(coin) {
return { id: coin.id, name: coin.name, symbol: coin.symbol, image: coin.image, price: coin.current_price, change24h: coin.price_change_percentage_24h, marketCapRank: coin.market_cap_rank || "?" };
}

app.get("/api/top-gainers", checkPassword, async function (req, res) {
try {
const cached = cacheGet("top_gainers", 15 * 60 * 1000);
if (cached) return res.json(cached);
const markets = await axios.get("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h");
const coins = markets.data.filter((coin) => typeof coin.price_change_percentage_24h === "number").sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h).slice(0, 10).map(coinMarketMapper);
const result = { coins };
cacheSet("top_gainers", result);
res.json(result);
} catch (error) { res.json({ coins: [] }); }
});

app.get("/api/top-losers", checkPassword, async function (req, res) {
try {
const cached = cacheGet("top_losers", 15 * 60 * 1000);
if (cached) return res.json(cached);
const markets = await axios.get("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h");
const coins = markets.data.filter((coin) => typeof coin.price_change_percentage_24h === "number").sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h).slice(0, 10).map(coinMarketMapper);
const result = { coins };
cacheSet("top_losers", result);
res.json(result);
} catch (error) { res.json({ coins: [] }); }
});

app.get("/api/watchlist", checkPassword, async function (req, res) {
try {
const ids = req.query.ids || "";
if (!ids) return res.json({ coins: [] });
const cached = cacheGet("watchlist_" + ids, 5 * 60 * 1000);
if (cached) return res.json({ coins: cached });
const markets = await axios.get("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=" + encodeURIComponent(ids) + "&price_change_percentage=24h");
const coins = markets.data.map((coin) => ({ id: coin.id, name: coin.name, symbol: coin.symbol, image: coin.image, price: coin.current_price, change24h: coin.price_change_percentage_24h || 0, marketCapRank: coin.market_cap_rank || "?" }));
cacheSet("watchlist_" + ids, coins);
res.json({ coins });
} catch (error) { res.status(500).json({ error: "Watchlist konnte nicht geladen werden." }); }
});

app.get("/api/exchange-fees", checkPassword, function (req, res) {
res.json({ exchanges: [
{ rank: 1, name: "Binance", maker: "0,10%", taker: "0,10%", kyc: "Ja", card: "Ja \u{1F4B3}", cardUrl: "https://www.binance.com/en/cards", futures: "Ja", staking: "Ja", url: "https://www.binance.com/en/fee", note: "Regul\xe4rer Spot-Wert; BNB/VIP-Rabatte m\xf6glich." },
{ rank: 2, name: "Coinbase Advanced", maker: "bis ca. 0,40%", taker: "bis ca. 0,60%", kyc: "Ja", card: "Ja \u{1F4B3}", cardUrl: "https://www.coinbase.com/card", futures: "Teilweise", staking: "Ja", url: "https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees", note: "Geb\xfchrenstufen abh\xe4ngig von 30-Tage-Volumen." },
{ rank: 3, name: "Bybit", maker: "ca. 0,10%", taker: "ca. 0,15%", kyc: "Ja", card: "Ja \u{1F4B3}", cardUrl: "https://www.bybit.com/en-US/crypto-card", futures: "Ja", staking: "Ja", url: "https://www.bybit.com/en/help-center/article/Bybit-Spot-Fees-Explained", note: "Produkt- und VIP-Level abh\xe4ngig." },
{ rank: 4, name: "OKX", maker: "ca. 0,08%", taker: "ca. 0,10%", kyc: "Ja", card: "Teilweise \u{1F4B3}", cardUrl: "https://www.okx.com/okx-card", futures: "Ja", staking: "Ja", url: "https://www.okx.com/fees", note: "Level- und Volumenabh\xe4ngig." },
{ rank: 5, name: "KuCoin", maker: "ca. 0,10%", taker: "ca. 0,10%", kyc: "Meist ja", card: "Teilweise \u{1F4B3}", cardUrl: "https://www.kucoin.com/cards", futures: "Ja", staking: "Ja", url: "https://www.kucoin.com/vip/level", note: "KCS- und VIP-Rabatte m\xf6glich." },
{ rank: 6, name: "Kraken Pro", maker: "variabel", taker: "variabel", kyc: "Ja", card: "Nein/bedingt", cardUrl: "", futures: "Ja", staking: "Ja", url: "https://www.kraken.com/features/fee-schedule", note: "Abh\xe4ngig von 30-Tage-Volumen und Ordertyp." },
{ rank: 7, name: "Bitget", maker: "ca. 0,10%", taker: "ca. 0,10%", kyc: "Ja", card: "Ja \u{1F4B3}", cardUrl: "https://www.bitget.com/card", futures: "Ja", staking: "Ja", url: "https://www.bitget.com/fee", note: "VIP- und Produktabh\xe4ngig." },
{ rank: 8, name: "Gate.io", maker: "ca. 0,20%", taker: "ca. 0,20%", kyc: "Ja", card: "Teilweise \u{1F4B3}", cardUrl: "https://www.gate.io/card", futures: "Ja", staking: "Ja", url: "https://www.gate.io/fee", note: "VIP- und Rabattmodelle m\xf6glich." },
{ rank: 9, name: "MEXC", maker: "variabel", taker: "variabel", kyc: "Teilweise", card: "Nein \u274c", cardUrl: "", futures: "Ja", staking: "Ja", url: "https://www.mexc.com/fee", note: "Stark aktions- und produktabh\xe4ngig." },
{ rank: 10, name: "Crypto.com", maker: "variabel", taker: "variabel", kyc: "Ja", card: "Ja \u{1F4B3}", cardUrl: "https://crypto.com/cards", futures: "Ja", staking: "Ja", url: "https://crypto.com/exchange/document/fees-limits", note: "Volumen- und Levelabh\xe4ngig." },
{ rank: 11, name: "Bitpanda", maker: "ca. 0,10% (Pro)", taker: "ca. 0,15% (Pro)", kyc: "Ja", card: "Ja \u{1F4B3}", cardUrl: "https://www.bitpanda.com/de/card", futures: "Nein", staking: "Ja", url: "https://support.bitpanda.com/hc/en-us/articles/360000902525", note: "Standard mit Spread, Bitpanda Pro g\xfcnstiger." },
{ rank: 12, name: "BloFin", maker: "ca. 0,10%", taker: "ca. 0,10%", kyc: "Nein \u274c", card: "Nein \u274c", cardUrl: "", futures: "Ja", staking: "Teilweise", url: "https://www.blofin.com", note: "KYC-frei m\xf6glich, Sitz: Cayman Islands." }
]});
});

app.post("/api/explain", checkPassword, async function (req, res) {
const term = req.body.term || "Blockchain";
const mode = req.body.mode || "beginner";
const lang = req.body.lang || "DE";
try {
const cached = cacheGet("explain_" + term + "_" + mode + "_" + lang, 24 * 60 * 60 * 1000);
if (cached) return res.json({ explanation: cached });
const prompt = mode === "pro" ? "Erkl\xe4re den Krypto-/Trading-Begriff professionell, aber verst\xe4ndlich. Formuliere neutral und ohne Anlageberatung: " : "Erkl\xe4re den Krypto-/Trading-Begriff extrem einfach, mit Emojis und Beispiel. Formuliere neutral und ohne Anlageberatung: ";
const aiResponse = await axios.post("https://api.openai.com/v1/chat/completions", {
model: "gpt-4o-mini",
messages: [
{ role: "system", content: "Du bist ein Krypto-Education-Coach. Erkl\xe4re klar, kurz, einfach und ohne Anlageberatung. Wenn eine Frage nach Investieren, DCA oder Timing kommt, erkl\xe4re allgemein und rechtlich neutral. Antworte in der vom Nutzer gew\xfcnschten Sprache: " + lang + "." },
{ role: "user", content: prompt + term }
],
max_tokens: 450
}, { headers: { Authorization: "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json" } });
const explanation = aiResponse.data.choices[0].message.content;
cacheSet("explain_" + term + "_" + mode + "_" + lang, explanation);
res.json({ explanation });
} catch (error) {
res.json({ explanation: "\U0001f9e0 Erkl\xe4rung aktuell nicht verf\xfcgbar. Pr\xfcfe bitte deinen OpenAI API-Key oder versuche es sp\xe4ter erneut." });
}
});

app.get("/api/market-overview", checkPassword, async function (req, res) {
try {
const cached = cacheGet("market_overview", 2 * 60 * 1000);
if (cached) return res.json(cached);
const fearGreedData = await getFearGreed();
const global = await getGlobalMarket();
let averageCryptoRsi = 50;
let altcoinStrength = Math.max(0, Math.min(100, 100 - global.btcDominance));
try {
const marketsRes = await axios.get("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=80&page=1&price_change_percentage=24h");
const topCoins = marketsRes.data || [];
const changes = topCoins.filter((coin) => coin.id !== "bitcoin" && typeof coin.price_change_percentage_24h === "number").map((coin) => coin.price_change_percentage_24h);
const avgChange = changes.reduce((sum, value) => sum + value, 0) / (changes.length || 1);
averageCryptoRsi = Math.max(0, Math.min(100, 50 + avgChange * 3));
const outperformers = topCoins.filter((coin) => coin.id !== "bitcoin" && coin.price_change_percentage_24h > 0).length;
altcoinStrength = Math.max(0, Math.min(100, Math.round((outperformers / Math.max(1, topCoins.length - 1)) * 100)));
} catch (e) {}
const result = {
fearGreed: fearGreedData.fearGreed,
fearGreedValue: fearGreedData.fearGreedValue,
activeCryptos: global.activeCryptos,
markets: global.markets,
totalMarketCap: global.totalMarketCap,
marketCapChange24h: global.marketCapChange24h,
totalVolume24h: global.totalVolume24h,
btcDominance: global.btcDominance.toFixed(2),
ethDominance: global.ethDominance.toFixed(2),
altcoinStrength: String(Math.round(altcoinStrength)),
averageCryptoRsi: String(Math.round(averageCryptoRsi)),
sourceHint: process.env.CMC_API_KEY ? "CoinMarketCap API Key erkannt. Erweiterte CMC-Anbindung kann aktiviert werden." : "Markt\xfcbersicht nutzt CoinGecko Global, Alternative.me Fear & Greed und interne N\xe4herungen f\xfcr Altcoin-St\xe4rke/\xd8 RSI. F\xfcr exakte CoinMarketCap-Werte bitte sp\xe4ter CMC_API_KEY anbinden."
};
cacheSet("market_overview", result);
res.json(result);
} catch (error) {
res.json({ fearGreed: "Keine Daten", fearGreedValue: 50, activeCryptos: 0, markets: 0, totalMarketCap: 0, marketCapChange24h: 0, totalVolume24h: 0, btcDominance: "0", ethDominance: "0", altcoinStrength: "0", averageCryptoRsi: "50", sourceHint: "Daten aktuell nicht verf\xfcgbar." });
}
});

app.post("/api/analyze", checkPassword, rateLimit, async function (req, res) {
const input = req.body.coin || "bitcoin";
const timeframe = req.body.timeframe || "7";
const lang = req.body.lang || "DE";
const tf = normalizeTimeframe(timeframe);
try {
const coinId = await resolveCoinId(input);
if (!coinId) return res.status(404).json({ error: "Coin nicht gefunden. Tipp: \xd6ffne CoinGecko und kopiere den letzten Teil der URL, z.B. kite-ai." });
const cacheKey = "analyze_" + coinId + "_" + timeframe;
const cached = cacheGet(cacheKey, 10 * 60 * 1000);
if (cached) return res.json(cached);
const marketResponse = await axios.get("https://api.coingecko.com/api/v3/coins/" + coinId);
const data = marketResponse.data;
const market = data.market_data;
const price = safeNumber(market.current_price.usd);
const marketCap = safeNumber(market.market_cap.usd);
const change24h = safeNumber(market.price_change_percentage_24h);
const volume24h = safeNumber(market.total_volume.usd);
const circulating = market.circulating_supply;
let maxSupply = market.max_supply;
if (!maxSupply && coinId === "bitcoin") maxSupply = 21000000;
if (!maxSupply) maxSupply = "Nicht definiert";
const chartResponse = await axios.get("https://api.coingecko.com/api/v3/coins/" + coinId + "/market_chart?vs_currency=usd&days=" + tf.days);
const prices = chartResponse.data.prices.map((p) => p[1]);
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
const fearGreedData = await getFearGreed();
let momentum = "Neutral";
if (change24h > 3) momentum = "Bullish \u{1F680}";
if (change24h < -3) momentum = "Bearish \u{1F53B}";
if (change24h > 10) momentum = "HOT Coin \u{1F525}";
if (change24h < -10) momentum = "Starker Abverkauf \u26a0\ufe0f";
const riskLevel = buildRiskLevel(marketCap);
const marketScore = buildAdvancedScore(change24h, rsi, price, ema20, ema50, ema200, fearGreedData.fearGreedValue);
let global = { btcDominance: 0, marketCapChange24h: 0 };
try { global = await getGlobalMarket(); } catch (e) {}
const projectInfo = extractProjectInfo(data);
const tokenomics = buildTokenomicsSummary(data, market);
const scamAnalyzer = buildScamAnalyzer(data, market, marketCap, volume24h, projectInfo.genesisDate !== "Nicht verf\xfcgbar" ? 70 : 35);
const cycle = buildCycleState(price, Number(ema50), Number(ema200), rsi, fearGreedData.fearGreedValue, global.btcDominance, global.marketCapChange24h, market.ath && market.ath.usd ? Number(market.ath.usd) : 0);
let analysis = "Keine AI Analyse verf\xfcgbar.";
let aiErrorMessage = "";
try {
const homepageText = projectInfo.homepage ? "\nWebsite: " + projectInfo.homepage : "";
const categoryText = projectInfo.categories.length ? projectInfo.categories.slice(0, 5).join(", ") : "Nicht klar verf\xfcgbar";
const aiResponse = await axios.post("https://api.openai.com/v1/chat/completions", {
model: "gpt-4o-mini",
messages: [
{ role: "system", content: "Du bist ein professioneller Krypto-Analyst und Education-Coach. Gib keine Anlageberatung, keine Kaufempfehlung und keine Garantie. Formuliere neutral mit W\xf6rtern wie k\xf6nnte, m\xf6glich, potenziell. Arbeite \xfcbersichtlich mit Emojis. Antworte vollst\xe4ndig in dieser Sprache: " + lang + "." },
{ role: "user", content: "Coin: " + data.name + "\nSymbol: " + data.symbol + "\nZeitraum: " + tf.label + "\nPreis: " + price + "\n24h Ver\xe4nderung: " + change24h + "%\nRSI: " + rsi + "\nMomentum: " + momentum + "\nScore: " + marketScore.score + "/100 " + marketScore.label + "\nRisiko: " + riskLevel.label + "\nLong Entry: " + entryZone + "\nLong SL: " + stopLoss + "\nLong TP1: " + upsideTarget1 + "\nLong TP2: " + upsideTarget2 + "\nLong TP3: " + upsideTarget3 + "\nShort Entry: " + entryZone + "\nShort SL: " + resistance + "\nShort TP1: " + downsideTarget1 + "\nShort TP2: " + downsideTarget2 + "\nShort TP3: " + downsideTarget3 + "\nSupport: " + support + "\nResistance: " + resistance + "\nFear & Greed: " + fearGreedData.fearGreed + "\nProjektbeschreibung: " + projectInfo.description + "\nKategorien/Branche: " + categoryText + homepageText + "\nWallets: " + projectInfo.wallets.join(", ") + "\nScam/Risiko Score: " + scamAnalyzer.score + "/100 " + scamAnalyzer.label + "\nMarktzyklus: " + cycle.phase + "\n\nErstelle eine kompakte Analyse mit diesen Abschnitten:\nProjektuebersicht\nWebsite/Netzwerk/Wallets\nTrend\nLong-Szenario\nShort-Szenario\nScam-/Risiko-Check\nFehler vermeiden\nFazit\n\nKeine Anlageberatung." }
],
max_tokens: 850
}, { headers: { Authorization: "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json" } });
analysis = aiResponse.data.choices[0].message.content;
} catch (aiError) {
aiErrorMessage = aiError.response && aiError.response.data ? JSON.stringify(aiError.response.data) : aiError.message;
console.log("AI Fehler:", aiErrorMessage);
}
const tradingViewSymbol = "BINANCE:" + String(data.symbol || "").toUpperCase() + "USDT";
const responseData = {
coin: data.name, coinId, symbol: data.symbol, image: data.image.small, price, marketCap, volume24h, change24h, circulating, maxSupply,
support, resistance, rsi, ema20, ema50, ema200, fib382, fib50, fib618, fib1272, fib1618, fib2618, entryZone, buyZone, stopLoss,
breakoutTarget, upsideTarget1, upsideTarget2, upsideTarget3, downsideTarget1, downsideTarget2, downsideTarget3, elliottBull, elliottBear,
momentum, marketScore, riskLevel, fearGreed: fearGreedData.fearGreed, fearGreedValue: fearGreedData.fearGreedValue, analysis, aiErrorMessage,
projectInfo, tokenomics, scamAnalyzer, cycle, chartData: chartResponse.data, timeframe, timeframeLabel: tf.label, tradingViewSymbol
};
cacheSet(cacheKey, responseData);
res.json(responseData);
} catch (error) {
console.log("Server Fehler:", error.message);
if (error.response && error.response.status === 429) return res.status(429).json({ error: "CoinGecko-Limit erreicht. Bitte kurz warten. Wir arbeiten mit Cache/Fallback-Daten, damit die App stabil bleibt." });
res.status(500).json({ error: "Fehler beim Laden. Der Coin wurde eventuell nicht gefunden oder CoinGecko ist kurzzeitig nicht erreichbar." });
}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () { console.log("CoinPilot l\xe4uft auf Port " + PORT); });
