const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();
const config = JSON.parse(fs.readFileSync("config.json"));

const SYMBOLS = config.symbols || [];
const TIMEFRAMES = config.timeframes || ["5m", "15m", "1h", "4h", "1d"];
const SCAN_INTERVAL_MS = (config.scanIntervalSeconds || 60) * 1000;

let lastSignals = {}; 
// lastSignals[symbol][tf] = { side, entry, tp, sl, reason, time }

// =============== GÖSTERGELER (EMA, RSI, RANGE) ===============

function ema(values, period) {
  const k = 2 / (period + 1);
  let arr = [];
  let prev;

  values.forEach((v, i) => {
    if (i === 0) {
      prev = v;
      arr.push(v);
    } else {
      const curr = v * k + prev * (1 - k);
      arr.push(curr);
      prev = curr;
    }
  });

  return arr;
}

function rsi(values, period = 14) {
  if (values.length <= period) return [];

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  let rsiArr = [100 - 100 / (1 + rs)];

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArr.push(100 - 100 / (1 + rs));
  }

  const prefix = new Array(values.length - rsiArr.length).fill(null);
  return prefix.concat(rsiArr);
}

function avgRange(highs, lows, period = 20) {
  const len = highs.length;
  const start = Math.max(0, len - period);
  let sum = 0;
  let count = 0;

  for (let i = start; i < len; i++) {
    sum += highs[i] - lows[i];
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

// =============== BYBIT VERİ ÇEKME ===============
//
// Burada Binance yerine BYBIT futures/perp kline endpoint'i kullanıyoruz.
// .P uzantısını siliyoruz: BTCUSDT.P -> BTCUSDT

function mapTimeframeToBybit(tf) {
  //  Bybit interval param:
  //  "1","3","5","15","30","60","120","240","360","720","D","W","M"
  if (tf === "5m") return "5";
  if (tf === "15m") return "15";
  if (tf === "1h") return "60";
  if (tf === "4h") return "240";
  if (tf === "1d" || tf === "1D") return "D";
  return "15"; // default
}

async function fetchCandles(symbol, timeframe) {
  const cleanSymbol = symbol.endsWith(".P")
    ? symbol.replace(".P", "USDT")
    : symbol;

  const bybitInterval = mapTimeframeToBybit(timeframe);

  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${cleanSymbol}&interval=${bybitInterval}&limit=200`;

  const res = await axios.get(url, { timeout: 8000 });

  if (res.data.retCode !== 0) {
    throw new Error("Bybit retCode " + res.data.retCode);
  }

  const list = res.data.result.list || [];

  // Bybit list elemanları genelde string array: [openTime, open, high, low, close, volume, ...]
  const closes = list.map(c => Number(c[4]));
  const highs = list.map(c => Number(c[2]));
  const lows = list.map(c => Number(c[3]));

  return { closes, highs, lows };
}

// =============== ICT BENZERİ SİNYAL ÜRETİCİ ===============
//
// Mantık özeti:
// - EMA20 / EMA50 ile bias (bullish / bearish)
// - Son 30 mum: range high / low -> premium / discount
// - OTE tarzı bölge (0.618 - 0.79 fib)
// - RSI filtresi

function generateICTLikeSignal(symbol, timeframe, closes, highs, lows) {
  if (closes.length < 80) return null;

  const len = closes.length;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiArr = rsi(closes, 14);

  const price = closes[len - 1];
  const ema20Now = ema20[len - 1];
  const ema50Now = ema50[len - 1];
  const rsiNow = rsiArr[len - 1];

  const recentCloses = closes.slice(len - 30);
  const recentHigh = Math.max(...recentCloses);
  const recentLow = Math.min(...recentCloses);
  const mid = (recentHigh + recentLow) / 2;

  const range = avgRange(highs, lows, 20) || price * 0.01;

  const bullishBias = ema20Now > ema50Now;
  const bearishBias = ema20Now < ema50Now;

  let oteLow, oteHigh;

  if (bullishBias) {
    const swingLow = recentLow;
    const swingHigh = recentHigh;
    const diff = swingHigh - swingLow;
    oteHigh = swingLow + diff * 0.79;
    oteLow = swingLow + diff * 0.618;
  } else if (bearishBias) {
    const swingHigh = recentHigh;
    const swingLow = recentLow;
    const diff = swingHigh - swingLow;
    oteLow = swingLow + diff * (1 - 0.79);
    oteHigh = swingLow + diff * (1 - 0.618);
  }

  let side = "FLAT";
  let entry = price;
  let tp = null;
  let sl = null;
  let reason = "No setup";

  if (
    bullishBias &&
    price < mid &&
    rsiNow !== null &&
    rsiNow > 40 &&
    rsiNow < 70 &&
    price >= oteLow &&
    price <= oteHigh
  ) {
    side = "LONG";
    entry = price;
    tp = entry + range * 2.5;
    sl = entry - range * 1.2;
    reason = `[${timeframe}] Bullish bias, discount OTE, RSI ${rsiNow.toFixed(
      1
    )}`;
  } else if (
    bearishBias &&
    price > mid &&
    rsiNow !== null &&
    rsiNow < 60 &&
    rsiNow > 30 &&
    price >= oteLow &&
    price <= oteHigh
  ) {
    side = "SHORT";
    entry = price;
    tp = entry - range * 2.5;
    sl = entry + range * 1.2;
    reason = `[${timeframe}] Bearish bias, premium OTE, RSI ${rsiNow.toFixed(
      1
    )}`;
  }

  return {
    symbol,
    timeframe,
    side,
    entry,
    tp,
    sl,
    reason,
    time: new Date().toISOString()
  };
}

// =============== TARAMA DÖNGÜSÜ ===============

async function scanAll() {
  console.log("🔄 Çoklu timeframe ICT sinyal taraması (BYBIT) başlıyor...");

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      try {
        const { closes, highs, lows } = await fetchCandles(symbol, tf);
        const sig = generateICTLikeSignal(symbol, tf, closes, highs, lows);

        if (!lastSignals[symbol]) lastSignals[symbol] = {};

        if (sig) {
          lastSignals[symbol][tf] = sig;
          console.log(
            `📊 ${symbol} [${tf}] → ${sig.side} | entry: ${sig.entry.toFixed(4)}`
          );
        } else {
          lastSignals[symbol][tf] = {
            symbol,
            timeframe: tf,
            side: "FLAT",
            entry: closes[closes.length - 1],
            tp: null,
            sl: null,
            reason: "No clear ICT setup",
            time: new Date().toISOString()
          };
        }
      } catch (err) {
        console.log(`❌ ${symbol} [${tf}] veri hatası:`, err.message);
      }
    }
  }

  console.log("✅ Tarama bitti.\n");
}

// İlk tarama
scanAll();

// Periyodik tarama
setInterval(scanAll, SCAN_INTERVAL_MS);

// =============== WEB PANEL ===============

const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => {
  let rows = "";

  for (const symbol of SYMBOLS) {
    const tfMap = lastSignals[symbol] || {};
    for (const tf of TIMEFRAMES) {
      const sig = tfMap[tf];
      if (!sig) {
        rows += `
          <tr>
            <td>${symbol}</td>
            <td>${tf}</td>
            <td colspan="5">Henüz sinyal yok...</td>
          </tr>
        `;
        continue;
      }

      rows += `
        <tr>
          <td>${symbol}</td>
          <td>${tf}</td>
          <td>${sig.side}</td>
          <td>${sig.entry ? sig.entry.toFixed(6) : "-"}</td>
          <td>${sig.tp ? sig.tp.toFixed(6) : "-"}</td>
          <td>${sig.sl ? sig.sl.toFixed(6) : "-"}</td>
          <td>${sig.reason}</td>
        </tr>
      `;
    }
  }

  res.send(`
    <h1>📊 ICT-Style Multi-Timeframe Sinyal Botu (Bybit Datası)</h1>
    <p><b>Mode:</b> Sinyal (gerçek trade YOK, sadece entry/TP/SL hesaplar)</p>
    <p><b>Timeframes:</b> ${TIMEFRAMES.join(", ")}</p>
    <p><b>Pairs:</b> ${SYMBOLS.join(", ")}</p>

    <table border="1" cellpadding="6">
      <tr>
        <th>Pair</th>
        <th>TF</th>
        <th>Yön</th>
        <th>Entry</th>
        <th>TP</th>
        <th>SL</th>
        <th>Neden</th>
      </tr>
      ${rows}
    </table>
  `);
});

app.listen(PORT, () => {
  console.log("🌐 ICT multi-timeframe signal server (BYBIT) running on port", PORT);
});
