// api/get-risk.js — Sentinel Risk Terminal v9.0
// Proxy seguro + cache Supabase + rate limiting + PC fixes

/* ========== SUPABASE HELPER ========== */
async function supaFetch(path, method = "GET", body = null, extraHeaders = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL o SUPABASE_ANON_KEY no configuradas.");
  const headers = {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extraHeaders
  };
  if (method === "POST") headers["Prefer"] = headers["Prefer"] || "return=representation";
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${url}/rest/v1/${path}`, opts);
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Supabase ${r.status}: ${err.slice(0, 200)}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/* ========== CACHE HELPER (PC-1: Supabase cache para Finnhub) ==========
   TTLs: quote=5min, metrics=1h, insiders=6h, recommendations=6h, news=30min
   Protege el rate limit de Finnhub con múltiples usuarios simultáneos.
*/
const CACHE_TTL = {
  quote:           5 * 60 * 1000,   // 5 minutos — precio cambia frecuente
  metrics:         60 * 60 * 1000,  // 1 hora — fundamentales cambian poco
  profile:         24 * 60 * 60 * 1000, // 24 horas — nombre/sector casi nunca cambia
  news:            30 * 60 * 1000,  // 30 minutos
  insiders:        6 * 60 * 60 * 1000,  // 6 horas
  recommendations: 6 * 60 * 60 * 1000,  // 6 horas
  "market-state":  60 * 60 * 1000,  // 1 hora
  "macro-context": 4 * 60 * 60 * 1000   // 4 horas
};

async function cacheGet(key) {
  try {
    const rows = await supaFetch(
      `finnhub_cache?cache_key=eq.${encodeURIComponent(key)}&limit=1`
    );
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    if (new Date(row.expires_at) < new Date()) {
      // Expired — delete silently
      supaFetch(`finnhub_cache?cache_key=eq.${encodeURIComponent(key)}`, "DELETE").catch(() => {});
      return null;
    }
    return row.data;
  } catch (e) {
    return null; // Cache miss — proceed to Finnhub
  }
}

async function cacheSet(key, data, ttlMs) {
  try {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await supaFetch(
      "finnhub_cache?on_conflict=cache_key",
      "POST",
      { cache_key: key, data, expires_at: expiresAt },
      { "Prefer": "resolution=merge-duplicates,return=minimal" }
    );
  } catch (e) {
    // Cache write failure is non-critical — continue normally
  }
}

async function cachedFinnhub(cacheKey, ttlType, fetchFn) {
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _cached: true };
  const fresh = await fetchFn();
  cacheSet(cacheKey, fresh, CACHE_TTL[ttlType] || 60 * 60 * 1000).catch(() => {});
  return fresh;
}

/* ========== RATE LIMITER ========== */
const rateState = { tokens: 50, resetAt: Date.now() + 60000 };
function canCallFinnhub(cost = 1) {
  const now = Date.now();
  if (now > rateState.resetAt) { rateState.tokens = 50; rateState.resetAt = now + 60000; }
  if (rateState.tokens < cost) return false;
  rateState.tokens -= cost;
  return true;
}
async function finnhubFetch(path, key, cost = 1) {
  if (!canCallFinnhub(cost)) throw new Error("Rate limit Finnhub: espera unos segundos.");
  const url = `https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub ${r.status}: ${path}`);
  return await r.json();
}

/* ========== VOLATILITY + MOMENTUM ========== */
function calcVolatility(closes) {
  if (!closes || closes.length < 30) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}
function calcMomentum(closes) {
  if (!closes || closes.length < 60) return null;
  const latest = closes[closes.length - 1];
  const base = closes[closes.length - 60] || closes[0];
  return ((latest - base) / base) * 100;
}
function vixToRegime(vix) {
  if (vix == null) return "neutral";
  if (vix > 28) return "stress";
  if (vix < 15) return "euphoria";
  return "neutral";
}

/* ========== MAIN HANDLER ========== */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, ticker } = req.query;
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!FINNHUB_KEY) return res.status(500).json({ error: "FINNHUB_API_KEY no configurada." });
  if (!ANTHROPIC_KEY && type === "claude") return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada." });

  try {

    if (type === "quote") {
      if (!ticker) return res.status(400).json({ error: "Falta ticker" });
      const data = await cachedFinnhub(
        `quote_${ticker}`, "quote",
        () => finnhubFetch(`/quote?symbol=${ticker}`, FINNHUB_KEY)
      );
      return res.status(200).json(data);
    }

    if (type === "profile") {
      if (!ticker) return res.status(400).json({ error: "Falta ticker" });
      if (ticker.includes(".") && !["BRK.A","BRK.B","BRK-B"].includes(ticker)) {
        return res.status(400).json({
          error: `Sentinel solo soporta acciones de NYSE/NASDAQ en el plan actual. El ticker "${ticker}" parece ser de una bolsa internacional (${ticker.split(".").pop()}). Prueba con el equivalente en USA si existe (ej: AMZN en vez de AMZN.MX).`
        });
      }
      const data = await cachedFinnhub(
        `profile_${ticker}`, "profile",
        () => finnhubFetch(`/stock/profile2?symbol=${ticker}`, FINNHUB_KEY)
      );
      return res.status(200).json(data);
    }

    if (type === "metrics") {
      if (!ticker) return res.status(400).json({ error: "Falta ticker" });
      const data = await cachedFinnhub(
        `metrics_${ticker}`, "metrics",
        () => finnhubFetch(`/stock/metric?symbol=${ticker}&metric=all`, FINNHUB_KEY)
      );
      return res.status(200).json(data);
    }

    if (type === "search") {
      const q = req.query.q || "";
      if (!q) return res.status(200).json({ result: [] });
      const data = await finnhubFetch(`/search?q=${encodeURIComponent(q)}`, FINNHUB_KEY);
      const filtered = (data.result || []).filter(x => x.type === "Common Stock").slice(0, 8);
      return res.status(200).json({ result: filtered });
    }

    if (type === "news") {
      if (!ticker) return res.status(400).json({ error: "Falta ticker" });
      const cacheKey = `news_${ticker}_${new Date().toISOString().split("T")[0]}`;
      const cached = await cacheGet(cacheKey);
      if (cached) return res.status(200).json(cached);

      const now = new Date();
      const to = now.toISOString().split("T")[0];
      const from = new Date(now - 7 * 864e5).toISOString().split("T")[0];
      const [articles, sentData] = await Promise.all([
        finnhubFetch(`/company-news?symbol=${ticker}&from=${from}&to=${to}`, FINNHUB_KEY).catch(() => []),
        finnhubFetch(`/news-sentiment?symbol=${ticker}`, FINNHUB_KEY).catch(() => ({}))
      ]);
      const mapped = (articles || []).slice(0, 10).map(a => ({
        headline: a.headline, source: a.source, url: a.url,
        datetime: a.datetime, date: new Date(a.datetime * 1000).toISOString().split("T")[0],
        summary: (a.summary || "").slice(0, 200)
      }));
      let sentiment = null;
      if (sentData && sentData.sentiment) {
        sentiment = {
          bullishPercent: sentData.sentiment.bullishPercent,
          bearishPercent: sentData.sentiment.bearishPercent,
          score: sentData.companyNewsScore,
          articleCount: sentData.buzz?.articlesInLastWeek,
          sectorAvgScore: sentData.sectorAverageBullishPercent
        };
      }
      const result = { articles: mapped, sentiment };
      cacheSet(cacheKey, result, CACHE_TTL.news).catch(() => {});
      return res.status(200).json(result);
    }

    if (type === "claude") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const { prompt } = req.body || {};
      if (!prompt) return res.status(400).json({ error: "Falta prompt" });
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1400,
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: `Claude ${r.status}: ${err.slice(0, 200)}` });
      }
      return res.status(200).json(await r.json());
    }

    /* ========== MARKET STATE (VIX + régimen) ========== */
    if (type === "market-state") {
      const cached = await supaFetch("market_state?id=eq.1");
      if (cached && cached[0] && cached[0].vix != null) {
        const age = Date.now() - new Date(cached[0].updated_at).getTime();
        if (age < 3600000) {
          return res.status(200).json({
            vix: cached[0].vix,
            regime: cached[0].regime,
            cached: true,
            age_minutes: Math.round(age / 60000)
          });
        }
      }
      // Fetch fresh VIX via ^VIX, fallback a SPY volatility
      let vix = null;
      try {
        const data = await finnhubFetch(`/quote?symbol=^VIX`, FINNHUB_KEY);
        if (data.c && data.c > 0) vix = data.c;
      } catch (e) { /* ignore */ }

      if (vix == null) {
        try {
          const now = Math.floor(Date.now() / 1000);
          const from = now - (45 * 86400);
          const spy = await finnhubFetch(`/stock/candle?symbol=SPY&resolution=D&from=${from}&to=${now}`, FINNHUB_KEY, 2);
          if (spy.s === "ok" && spy.c) vix = calcVolatility(spy.c);
        } catch (e) { /* ignore */ }
      }

      const regime = vixToRegime(vix);
      try {
        await supaFetch("market_state?id=eq.1", "PATCH", { vix, regime, updated_at: new Date().toISOString() });
      } catch (e) { /* swallow */ }
      return res.status(200).json({ vix, regime, cached: false });
    }

    /* ========== MACRO CONTEXT — Bono 10Y + DXY ========== */
    if (type === "macro-context") {
      // Try to get from Supabase cache first (TTL 4 hours)
      let cached = null;
      try {
        const row = await supaFetch("market_state?id=eq.1");
        if (row && row[0] && row[0].updated_at) {
          const age = Date.now() - new Date(row[0].updated_at).getTime();
          if (age < 14400000 && row[0].bond_yield != null) {
            cached = { bond10y: row[0].bond_yield, dxy: row[0].dxy, cached: true };
          }
        }
      } catch (e) { /* ignore */ }
      if (cached) return res.status(200).json(cached);

      // Fetch US10Y bond yield and DXY from Finnhub forex
      let bond10y = null;
      let dxy = null;

      try {
        // US 10-Year Treasury yield via Finnhub quote
        const bondData = await finnhubFetch(`/quote?symbol=US10Y`, FINNHUB_KEY);
        if (bondData.c && bondData.c > 0) bond10y = bondData.c;
      } catch (e) { /* ignore */ }

      try {
        // DXY via forex — OANDA:USD_BASKET or use FOREX rate as proxy
        const dxyData = await finnhubFetch(`/quote?symbol=FOREX:USD_INDEX`, FINNHUB_KEY);
        if (dxyData.c && dxyData.c > 0) dxy = dxyData.c;
      } catch (e) { /* try alternative */ }

      // Alternative: use EUR/USD as inverse DXY proxy (strong USD = low EURUSD)
      if (dxy == null) {
        try {
          const eurData = await finnhubFetch(`/quote?symbol=OANDA:EUR_USD`, FINNHUB_KEY);
          if (eurData.c && eurData.c > 0) {
            // Inverse: strong dollar = low EUR/USD
            // Approximate DXY from EUR/USD (EUR is ~57% of DXY)
            dxy = eurData.c < 1.05 ? "strong" : eurData.c < 1.10 ? "neutral" : "weak";
          }
        } catch (e) { /* ignore */ }
      }

      // Interpret bond yield
      let bondSignal = null;
      if (bond10y != null) {
        bondSignal = bond10y > 5.0 ? "restrictive"   // High rates = tight financial conditions
                   : bond10y > 4.0 ? "elevated"
                   : bond10y > 3.0 ? "neutral"
                   : "loose";
      }

      // Macro interpretation
      let macroRisk = "neutral";
      let macroDesc = "";
      if (bondSignal === "restrictive") {
        macroRisk = "stress";
        macroDesc = `Bono 10Y al ${bond10y?.toFixed(2)}% — condiciones financieras restrictivas. Múltiplos de valuación bajo presión.`;
      } else if (bondSignal === "elevated") {
        macroRisk = "elevated";
        macroDesc = `Bono 10Y al ${bond10y?.toFixed(2)}% — tasas elevadas comprimen valuaciones de crecimiento.`;
      } else if (bond10y != null) {
        macroDesc = `Bono 10Y al ${bond10y?.toFixed(2)}% — condiciones financieras normalizadas.`;
      }

      // Cache in market_state (add columns if needed, fail silently)
      try {
        await supaFetch("market_state?id=eq.1", "PATCH", {
          bond_yield: bond10y,
          dxy: typeof dxy === "number" ? dxy : null,
          updated_at: new Date().toISOString()
        });
      } catch (e) { /* column may not exist, ignore */ }

      return res.status(200).json({
        bond10y,
        bondSignal,
        dxy,
        macroRisk,
        macroDesc,
        cached: false
      });
    }

    /* ========== CANDLES (volatilidad + momentum) ========== */
    if (type === "candles") {
      if (!ticker) return res.status(400).json({ error: "Falta ticker" });
      const now = Math.floor(Date.now() / 1000);
      const from = now - (120 * 86400);
      try {
        const data = await finnhubFetch(`/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${now}`, FINNHUB_KEY, 2);
        if (data.s !== "ok") return res.status(200).json({ volatility: null, momentum: null, avgVolume: null, note: "no_data" });
        return res.status(200).json({
          volatility: calcVolatility(data.c),
          momentum: calcMomentum(data.c),
          avgVolume: data.v ? data.v.slice(-30).reduce((s, v) => s + v, 0) / 30 : null
        });
      } catch (e) {
        // Finnhub free tier no incluye históricos — devolver null sin error
        return res.status(200).json({ volatility: null, momentum: null, avgVolume: null, note: "premium_required" });
      }
    }

    /* ========== SNAPSHOT (con UPSERT para deduplicación) ========== */
    if (type === "snapshot") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const d = req.body;
      if (!d || !d.ticker) return res.status(400).json({ error: "Falta data" });
      const today = new Date().toISOString().split("T")[0];
      const payload = {
        ticker: d.ticker, price: d.price, score: d.score, regime: d.regime,
        sector_key: d.sector_key,
        valuation_sub: d.valuation_sub, health_sub: d.health_sub, growth_sub: d.growth_sub,
        pe: d.pe, de: d.de, net_margin: d.net_margin, rev_growth: d.rev_growth,
        news_sentiment: d.news_sentiment,
        volatility: d.volatility, vix: d.vix, beta: d.beta,
        avg_volume: d.avg_volume, momentum_90d: d.momentum_90d,
        confidence: d.confidence,
        analysis_date: today
      };
      const row = await supaFetch(
        "risk_snapshots?on_conflict=ticker,analysis_date",
        "POST",
        payload,
        { "Prefer": "resolution=merge-duplicates,return=representation" }
      );
      return res.status(200).json({ ok: true, row });
    }

    if (type === "history") {
      if (!ticker) return res.status(400).json({ error: "Falta ticker" });
      const limit = req.query.limit || 30;
      const rows = await supaFetch(`risk_snapshots?ticker=eq.${ticker}&order=analysis_date.desc&limit=${limit}`);
      return res.status(200).json(rows || []);
    }

    if (type === "portfolio-save") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const { name, holdings } = req.body || {};
      const pfName = name || "default";
      await supaFetch(`portfolios?name=eq.${encodeURIComponent(pfName)}`, "DELETE");
      if (holdings && holdings.length > 0) {
        const rows = holdings.map(h => ({
          name: pfName,
          ticker: h.ticker,
          weight: h.weight,
          sector_key: h.sectorKey,
          sector: h.sector || h.sectorKey
        }));
        await supaFetch("portfolios", "POST", rows);
      }
      return res.status(200).json({ ok: true });
    }

    if (type === "portfolio-load") {
      const pfName = req.query.name || "default";
      const rows = await supaFetch(`portfolios?name=eq.${encodeURIComponent(pfName)}&order=added_at.asc`);
      return res.status(200).json(rows || []);
    }

    /* ========== PORTFOLIO SaN HISTORY ========== */
    if (type === "portfolio-san-save") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const { san, composite, techExposure, holdingCount } = req.body || {};
      const today = new Date().toISOString().split("T")[0];
      try {
        await supaFetch(
          "portfolio_history?on_conflict=portfolio_name,recorded_at",
          "POST",
          { portfolio_name: "default", san_score: san, composite_risk: composite, tech_exposure: techExposure, holding_count: holdingCount, recorded_at: today },
          { "Prefer": "resolution=merge-duplicates,return=minimal" }
        );
      } catch (e) { /* table may not exist yet */ }
      return res.status(200).json({ ok: true });
    }

    if (type === "portfolio-san-history") {
      try {
        const rows = await supaFetch("portfolio_history?portfolio_name=eq.default&order=recorded_at.desc&limit=30");
        return res.status(200).json(rows || []);
      } catch (e) {
        return res.status(200).json([]);
      }
    }

    /* ========== BACKTEST STATS (globales) ========== */
    if (type === "backtest-stats") {
      const results = await supaFetch("backtest_results?order=evaluated_at.desc&limit=1000");
      if (!results || results.length === 0) return res.status(200).json({ sample_size: 0 });
      const high = results.filter(r => r.original_score >= 70);
      const hits = high.filter(r => r.hit_prediction === true).length;
      const avgReturn = high.length > 0 ? high.reduce((s, r) => s + (r.price_return || 0), 0) / high.length : null;
      return res.status(200).json({
        sample_size: results.length,
        high_risk_signals: high.length,
        hit_rate: high.length > 0 ? (hits / high.length) * 100 : null,
        avg_return_high_risk: avgReturn
      });
    }

    /* ========== RUN BACKTEST (cron endpoint) ========== */
    if (type === "run-backtest") {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const provided = req.headers.authorization?.replace("Bearer ", "");
        if (provided !== cronSecret) return res.status(401).json({ error: "No autorizado" });
      }
      const targetDate = new Date(Date.now() - 30 * 864e5).toISOString().split("T")[0];
      const cutoff = new Date(Date.now() - 33 * 864e5).toISOString().split("T")[0];
      const snaps = await supaFetch(
        `risk_snapshots?analysis_date=lte.${targetDate}&analysis_date=gte.${cutoff}&select=id,ticker,score,price,analysis_date&limit=50`
      );
      const evaluated = [];
      for (const s of snaps || []) {
        const existing = await supaFetch(`backtest_results?snapshot_id=eq.${s.id}&limit=1`);
        if (existing && existing.length > 0) continue;
        try {
          const quote = await finnhubFetch(`/quote?symbol=${s.ticker}`, FINNHUB_KEY);
          const currentPrice = quote.c;
          if (!currentPrice || !s.price) continue;
          const priceReturn = ((currentPrice - s.price) / s.price) * 100;
          const hitPrediction = s.score >= 70 ? (priceReturn < 0) : (priceReturn >= 0);
          const daysElapsed = Math.floor((Date.now() - new Date(s.analysis_date).getTime()) / 864e5);
          await supaFetch("backtest_results", "POST", {
            snapshot_id: s.id, ticker: s.ticker,
            original_score: s.score, original_price: s.price,
            original_date: s.analysis_date, current_price: currentPrice,
            days_elapsed: daysElapsed, price_return: priceReturn,
            hit_prediction: hitPrediction
          });
          evaluated.push({ ticker: s.ticker, hit: hitPrediction, return: priceReturn });
        } catch (e) {
          console.error(`Backtest error ${s.ticker}:`, e.message);
        }
      }
      return res.status(200).json({ evaluated_count: evaluated.length, details: evaluated.slice(0, 10) });
    }

    /* ========== BASELINES LOAD — carga desde Supabase ========== */
    if (type === "baselines-load") {
      const rows = await supaFetch("sector_baselines?order=sector.asc");
      if (!rows || rows.length === 0) return res.status(200).json({ baselines: null });
      const baselines = {};
      rows.forEach(r => {
        baselines[r.sector] = {
          pe: r.pe, de: r.de,
          netMargin: r.net_margin,
          revGrowth: r.rev_growth,
          updatedAt: r.updated_at
        };
      });
      return res.status(200).json({ baselines });
    }

    /* ========== BASELINES REFRESH — actualiza con datos reales de Finnhub ==========
       Usa una muestra de tickers representativos por sector para calcular medianas.
       Llamar trimestralmente (manual o via cron).
    */
    if (type === "baselines-refresh") {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const provided = req.headers.authorization?.replace("Bearer ", "");
        if (provided !== cronSecret) return res.status(401).json({ error: "No autorizado" });
      }

      // Tickers representativos por sector (10+ por sector = mediana robusta)
      const SECTOR_SAMPLES = {
        "Technology":             ["AAPL","MSFT","NVDA","GOOGL","META","ORCL","CRM","AMD","INTC","QCOM"],
        "Communication Services": ["NFLX","DIS","CMCSA","T","VZ","SNAP","PINS","EA","TTWO","WBD"],
        "Financial Services":     ["JPM","BAC","WFC","GS","MS","BLK","SCHW","AXP","C","USB"],
        "Healthcare":             ["JNJ","UNH","PFE","MRK","ABBV","TMO","ABT","CVS","MDT","BMY"],
        "Consumer Cyclical":      ["AMZN","TSLA","HD","MCD","NKE","SBUX","TGT","LOW","BKNG","GM"],
        "Consumer Defensive":     ["WMT","PG","KO","PEP","COST","PM","MO","CL","GIS","K"],
        "Industrials":            ["CAT","HON","UPS","BA","MMM","GE","LMT","RTX","DE","FDX"],
        "Energy":                 ["XOM","CVX","SLB","COP","EOG","MPC","PSX","VLO","HAL","OXY"],
        "Utilities":              ["NEE","DUK","SO","AEP","EXC","SRE","PCG","ED","ETR","XEL"],
        "Basic Materials":        ["LIN","APD","ECL","DD","NUE","CF","MOS","ALB","FMC","CE"],
        "Real Estate":            ["AMT","PLD","CCI","EQIX","PSA","DLR","O","SPG","AVB","EQR"],
        "Conglomerate":           ["BRK.B","GE","HON","MMM","UTX","ITW","EMR","ETN","PH","DOV"]
      };

      const results = {};
      const errors = [];

      for (const [sector, tickers] of Object.entries(SECTOR_SAMPLES)) {
        const peValues = [], deValues = [], marginValues = [], growthValues = [];

        for (const t of tickers.slice(0, 6)) { // máximo 6 por sector para no agotar rate limit
          try {
            const data = await finnhubFetch(`/stock/metric?symbol=${t}&metric=all`, FINNHUB_KEY, 1);
            const m = data.metric || {};
            if (m.peBasicExclExtraTTM && m.peBasicExclExtraTTM > 0 && m.peBasicExclExtraTTM < 500) peValues.push(m.peBasicExclExtraTTM);
            if (m["totalDebt/totalEquityAnnual"] && m["totalDebt/totalEquityAnnual"] > 0) deValues.push(m["totalDebt/totalEquityAnnual"]);
            if (m.netProfitMarginTTM) marginValues.push(m.netProfitMarginTTM);
            if (m.revenueGrowthTTMYoy != null) growthValues.push(m.revenueGrowthTTMYoy * 100);
          } catch (e) {
            errors.push(`${t}: ${e.message}`);
          }
        }

        // Mediana (más robusta que media ante outliers)
        const median = arr => {
          if (!arr.length) return null;
          const s = [...arr].sort((a, b) => a - b);
          const mid = Math.floor(s.length / 2);
          return s.length % 2 ? s[mid] : (s[mid-1] + s[mid]) / 2;
        };

        const pe = median(peValues);
        const de = median(deValues);
        const netMargin = median(marginValues);
        const revGrowth = median(growthValues);

        if (pe || de || netMargin || revGrowth) {
          // Update Supabase
          await supaFetch(`sector_baselines?sector=eq.${encodeURIComponent(sector)}`, "PATCH", {
            ...(pe        != null && { pe }),
            ...(de        != null && { de }),
            ...(netMargin != null && { net_margin: netMargin }),
            ...(revGrowth != null && { rev_growth: revGrowth }),
            updated_at: new Date().toISOString()
          });
          results[sector] = { pe, de, netMargin, revGrowth, samples: peValues.length };
        }
      }

      return res.status(200).json({ updated: Object.keys(results).length, results, errors: errors.slice(0, 10) });
    }

    /* ========== INSIDERS — transacciones de directivos (PC-3: ventas programadas) ========== */
    if (type === "insiders") {
      if (!ticker) return res.status(400).json({ error: "Falta ticker" });

      // Check cache first
      const cachedInsiders = await cacheGet(`insiders_${ticker}`);
      if (cachedInsiders) return res.status(200).json({ ...cachedInsiders, _cached: true });

      const data = await finnhubFetch(`/stock/insider-transactions?symbol=${ticker}`, FINNHUB_KEY);
      const txs = (data.data || []).slice(0, 20);

      const cutoff = Date.now() - 90 * 864e5;
      const recent = txs.filter(t => new Date(t.transactionDate).getTime() > cutoff);

      let buyValue = 0, sellValue = 0;
      // PC-3: Track programmed (10b5-1) vs opportunistic sales
      let programmedSellValue = 0;
      recent.forEach(t => {
        const val = Math.abs((t.share || 0) * (t.transactionPrice || 0));
        if (t.transactionCode === "P") buyValue += val;
        else if (t.transactionCode === "S") {
          sellValue += val;
          // 10b5-1 plans are often flagged in the filing text or have "10b5" in description
          if (t.filing && (t.filing.includes("10b5") || t.filing.includes("Rule 10b5"))) {
            programmedSellValue += val;
          }
        }
      });

      const opportunisticSellValue = sellValue - programmedSellValue;
      const netSignal = buyValue - opportunisticSellValue; // Only count opportunistic sales as bearish signal

      const signal = netSignal > 50000 ? "bullish" : netSignal < -50000 ? "bearish" : "neutral";
      const topTransactions = recent.slice(0, 5).map(t => ({
        name: t.name,
        title: t.reportingTitle || "Directivo",
        date: t.transactionDate,
        shares: t.share,
        price: t.transactionPrice,
        value: Math.abs((t.share || 0) * (t.transactionPrice || 0)),
        type: t.transactionCode === "P" ? "buy" : t.transactionCode === "S" ? "sell" : "other",
        isProgrammed: t.filing && (t.filing.includes("10b5") || t.filing.includes("Rule 10b5"))
      }));

      const result = {
        signal,
        buyValue,
        sellValue,
        programmedSellValue,
        opportunisticSellValue,
        netValue: netSignal,
        recentCount: recent.length,
        transactions: topTransactions,
        hasProgrammedSales: programmedSellValue > 0
      };
      cacheSet(`insiders_${ticker}`, result, CACHE_TTL.insiders).catch(() => {});
      return res.status(200).json(result);
    }

    /* ========== RECOMMENDATIONS — consenso de analistas ========== */
    if (type === "recommendations") {
      if (!ticker) return res.status(400).json({ error: "Falta ticker" });

      // Check cache first
      const cachedRecs = await cacheGet(`recommendations_${ticker}`);
      if (cachedRecs) return res.status(200).json({ ...cachedRecs, _cached: true });

      const data = await finnhubFetch(`/stock/recommendation?symbol=${ticker}`, FINNHUB_KEY);
      if (!data || data.length === 0) return res.status(200).json({ trend: "unknown", data: [] });

      // Últimos 3 períodos
      const recent = data.slice(0, 3);
      const latest = recent[0] || {};
      const prev = recent[1] || {};

      // Score: strongBuy=5, buy=4, hold=3, sell=2, strongSell=1
      const score = r => r.strongBuy ? (r.strongBuy*5 + r.buy*4 + r.hold*3 + r.sell*2 + r.strongSell*1) /
        Math.max(1, r.strongBuy + r.buy + r.hold + r.sell + r.strongSell) : null;

      const latestScore = score(latest);
      const prevScore = score(prev);
      const delta = latestScore && prevScore ? latestScore - prevScore : null;

      const trend = delta === null ? "unknown"
        : delta > 0.2 ? "improving"
        : delta < -0.2 ? "deteriorating"
        : "stable";

      const recsResult = {
        trend,
        delta,
        latest: {
          period: latest.period,
          strongBuy: latest.strongBuy,
          buy: latest.buy,
          hold: latest.hold,
          sell: latest.sell,
          strongSell: latest.strongSell,
          total: (latest.strongBuy||0) + (latest.buy||0) + (latest.hold||0) + (latest.sell||0) + (latest.strongSell||0),
          score: latestScore
        },
        history: recent.map(r => ({ period: r.period, score: score(r) }))
      };
      cacheSet(`recommendations_${ticker}`, recsResult, CACHE_TTL.recommendations).catch(() => {});
      return res.status(200).json(recsResult);
    }

    /* ========== STRESS TEST ========== */
    if (type === "stress-test") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const { scenario, metrics, sectorKey } = req.body || {};
      if (!scenario || !metrics) return res.status(400).json({ error: "Falta scenario o metrics" });

      // Escenarios predefinidos — alteran los inputs del motor
      const SCENARIOS = {
        "black-swan": {
          label: "Cisne Negro",
          desc: "Crisis sistémica: VIX 45, caída de ingresos -20%, márgenes comprimidos",
          vixOverride: 45,
          peMultiplier: 0.60,      // múltiplos se contraen 40%
          revenueGrowthShock: -20, // caída absoluta en puntos
          marginShock: -8,         // compresión de márgenes
          volatilityOverride: 65
        },
        "recession": {
          label: "Recesión Inflacionaria",
          desc: "Tasas altas, compresión de márgenes, crecimiento estancado",
          vixOverride: 32,
          peMultiplier: 0.75,
          revenueGrowthShock: -8,
          marginShock: -5,
          volatilityOverride: 42
        },
        "tech-crash": {
          label: "Tech Crash",
          desc: "Rotación sectorial severa, múltiplos tech colapsados -30%",
          vixOverride: 38,
          peMultiplier: 0.70,
          revenueGrowthShock: -5,
          marginShock: -3,
          volatilityOverride: 55
        }
      };

      const sc = SCENARIOS[scenario];
      if (!sc) return res.status(400).json({ error: `Escenario desconocido: ${scenario}` });

      // Aplicar shocks a los metrics
      const stressed = {
        pe: metrics.pe != null ? metrics.pe * sc.peMultiplier : null,
        de: metrics.de,  // deuda no cambia inmediatamente
        netMargin: metrics.netMargin != null ? metrics.netMargin + sc.marginShock : null,
        revGrowth: metrics.revGrowth != null ? metrics.revGrowth + sc.revenueGrowthShock : null,
        beta: metrics.beta
      };

      return res.status(200).json({
        scenario: sc.label,
        desc: sc.desc,
        vix: sc.vixOverride,
        regime: sc.vixOverride > 28 ? "stress" : "neutral",
        stressedMetrics: stressed,
        shocks: {
          peMultiplier: sc.peMultiplier,
          revenueGrowthShock: sc.revenueGrowthShock,
          marginShock: sc.marginShock,
          volatility: sc.volatilityOverride
        }
      });
    }

    return res.status(400).json({ error: `Tipo desconocido: ${type}` });

  } catch (err) {
    console.error("[Sentinel proxy error]", err);
    return res.status(500).json({ error: err.message });
  }
}
