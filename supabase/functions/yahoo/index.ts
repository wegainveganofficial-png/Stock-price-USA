// Proxy to Yahoo Finance (chart, symbol search, news, batch quotes) + S&P 500 list (Wikipedia) + market caps + Bloomberg RSS headlines + stock-of-the-day screen + Minervini champion screen + daily trading simulator (incl. 10-shots-a-year elite mode) for the US Stock Tracker page.
// Thai translation of news is done in the browser (translation services block server IPs).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const RANGES = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','max']);
const INTERVALS = new Set(['1m','2m','5m','15m','30m','60m','1h','1d','1wk','1mo']);
const SYM = /^[A-Z0-9.\-^=]{1,15}$/;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', ...extra } });

async function yget(path: string) {
  let last = 'unknown';
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      if (j) return { ok: true, j, status: r.status };
      last = 'HTTP ' + r.status;
    } catch (e) { last = (e as Error).message; }
  }
  return { ok: false, j: { error: 'Yahoo Finance unavailable: ' + last }, status: 502 };
}

/* ---------- news ---------- */
type News = { title: string; summary: string; link: string; publisher: string; time: number | null; related?: boolean };
const newsCache = new Map<string, { t: number; ttl: number; items: News[] }>();
function decode(s: string) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function rssNews(symbol: string): Promise<News[]> {
  try {
    const r = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`, { headers: { 'User-Agent': UA } });
    const x = await r.text();
    return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const g = (t: string) => decode((m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
      const t = Date.parse(g('pubDate'));
      return { title: g('title'), summary: g('description'), link: g('link'), publisher: g('source') || 'Yahoo Finance', time: isNaN(t) ? null : Math.floor(t / 1000) };
    }).filter((n) => n.title && /^https?:\/\//.test(n.link));
  } catch { return []; }
}

async function searchNews(q: string, symbol: string): Promise<News[]> {
  const r = await yget(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=20`);
  if (!r.ok) return [];
  const all = ((r.j as any).news || []).map((n: any) => ({ title: n.title || '', summary: '', link: n.link || '', publisher: n.publisher || '', time: n.providerPublishTime || null, related: ((n.relatedTickers || []) as string[]).includes(symbol) }))
    .filter((n: any) => n.title && /^https?:\/\//.test(n.link));
  const own = all.filter((n: News) => n.related);
  return own.length >= 3 ? own : all;
}

async function getNews(symbol: string, name: string) {
  const key = symbol + '|' + name;
  const c = newsCache.get(key);
  if (c && Date.now() - c.t < c.ttl) return c.items;
  // Company keyword, e.g. "NVIDIA Corporation" -> "NVIDIA"
  const kw = name.replace(/[,.]|\b(Inc|Corp|Corporation|Company|Co|Ltd|Holdings|Platforms|Class [A-C]|plc|Group)\b/gi, ' ').trim().split(/\s+/)[0] || symbol;
  const hits = (n: News) => n.related || new RegExp(`\\b(${symbol.replace(/[^A-Z0-9]/g, '')}|${kw.replace(/[^A-Za-z0-9]/g, '')})\\b`, 'i').test(n.title + ' ' + n.summary);
  const seen = new Set<string>(); let items: News[] = [];
  const add = (list: News[]) => { for (const n of list) if (!seen.has(n.link)) { seen.add(n.link); items.push(n); } };
  add(await searchNews(symbol, symbol));
  if (items.filter(hits).length < 5 && kw.toUpperCase() !== symbol) add(await searchNews(kw, symbol));
  if (items.filter(hits).length < 3) add(await rssNews(symbol));
  const own = items.filter(hits);
  const specific = own.length >= 3;
  items = (specific ? own : items).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 12);
  if (items.length) newsCache.set(key, { t: Date.now(), ttl: specific ? 600000 : 60000, items });
  return items;
}

/* ---------- S&P 500 constituents (Wikipedia, cached 12h) ---------- */
type Member = { symbol: string; name: string; sector: string; industry: string };
let spCache: { t: number; list: Member[] } | null = null;
const strip = (h: string) => decode(h).replace(/\[\d+\]/g, '').trim();
async function sp500(): Promise<Member[]> {
  if (spCache && Date.now() - spCache.t < 12 * 3600 * 1000) return spCache.list;
  const r = await fetch('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies', { headers: { 'User-Agent': 'USStockTracker/1.0 (personal dashboard)' } });
  const html = await r.text();
  const start = html.indexOf('id="constituents"');
  if (start < 0) throw new Error('constituents table not found');
  const table = html.slice(start, html.indexOf('</table>', start));
  const list: Member[] = [];
  for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1]));
    if (cells.length >= 4 && /^[A-Z.\-]{1,6}$/.test(cells[0])) list.push({ symbol: cells[0].replace('.', '-'), name: cells[1], sector: cells[2], industry: cells[3] });
  }
  if (list.length < 450) throw new Error('unexpected constituent count ' + list.length);
  spCache = { t: Date.now(), list };
  return list;
}

/* ---------- batch quotes via Yahoo spark (20 symbols per call) ---------- */
type Q = { symbol: string; price: number | null; prev: number | null; closes: number[] };
async function sparkChunk(syms: string[]): Promise<Q[]> {
  const r = await yget(`/v8/finance/spark?symbols=${syms.map(encodeURIComponent).join(',')}&range=1d&interval=5m`);
  if (!r.ok) return [];
  const j: any = r.j; const out: Q[] = [];
  const thin = (a: (number | null)[]) => { const v = a.filter((x): x is number => x != null); const step = Math.max(1, Math.ceil(v.length / 40)); return v.filter((_, i) => i % step === 0 || i === v.length - 1).map((x) => +x.toFixed(4)); };
  if (j.spark?.result) {
    for (const it of j.spark.result) {
      const res = it.response?.[0]; if (!res) continue;
      const c = res.indicators?.quote?.[0]?.close || [];
      out.push({ symbol: it.symbol, price: res.meta?.regularMarketPrice ?? null, prev: res.meta?.chartPreviousClose ?? res.meta?.previousClose ?? null, closes: thin(c) });
    }
  } else {
    for (const [sym, v] of Object.entries<any>(j)) {
      if (!v || !Array.isArray(v.close)) continue;
      const c = thin(v.close);
      out.push({ symbol: sym, price: c.length ? c[c.length - 1] : null, prev: v.chartPreviousClose ?? v.previousClose ?? null, closes: c });
    }
  }
  return out;
}
async function quotes(syms: string[]) {
  const chunks: string[][] = []; for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));
  const out: Q[] = [];
  for (let i = 0; i < chunks.length; i += 6) (await Promise.all(chunks.slice(i, i + 6).map(sparkChunk))).forEach((a) => out.push(...a));
  return out;
}

/* ---------- market caps via Yahoo v7 quote (needs cookie + crumb), cached 1h ---------- */
let crumb: { t: number; cookie: string; crumb: string } | null = null;
async function getCrumb() {
  if (crumb && Date.now() - crumb.t < 3600 * 1000) return crumb;
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const raw = r1.headers.get('set-cookie') || '';
  const cookie = raw.split(/,(?=\s*[A-Za-z0-9_]+=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const c = (await r2.text()).trim();
  if (!c || c.length > 40 || /[<{]/.test(c)) throw new Error('crumb unavailable (HTTP ' + r2.status + ')');
  crumb = { t: Date.now(), cookie, crumb: c };
  return crumb;
}
const capCache = new Map<string, { t: number; cap: number | null }>();
async function caps(syms: string[]) {
  const need = syms.filter((s) => { const c = capCache.get(s); return !c || Date.now() - c.t > 3600 * 1000; });
  if (need.length) {
    const k = await getCrumb();
    const chunks: string[][] = []; for (let i = 0; i < need.length; i += 150) chunks.push(need.slice(i, i + 150));
    await Promise.all(chunks.map(async (c) => {
      const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${c.map(encodeURIComponent).join(',')}&fields=marketCap&crumb=${encodeURIComponent(k.crumb)}`, { headers: { 'User-Agent': UA, Cookie: k.cookie } });
      const j: any = await r.json().catch(() => null);
      if (!j?.quoteResponse) { crumb = null; throw new Error('quote HTTP ' + r.status); }
      for (const q of j.quoteResponse.result || []) capCache.set(q.symbol, { t: Date.now(), cap: q.marketCap ?? null });
    }));
  }
  return Object.fromEntries(syms.map((s) => [s, capCache.get(s)?.cap ?? null]));
}

/* ---------- Bloomberg public RSS headlines, cached 10 min ---------- */
const BBG: Record<string, string> = { markets: 'https://feeds.bloomberg.com/markets/news.rss', technology: 'https://feeds.bloomberg.com/technology/news.rss', economics: 'https://feeds.bloomberg.com/economics/news.rss' };
const bbgCache = new Map<string, { t: number; items: News[] }>();
async function bloomberg(feed: string) {
  const c = bbgCache.get(feed); if (c && Date.now() - c.t < 600000) return c.items;
  const r = await fetch(BBG[feed], { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml' } });
  const x = await r.text();
  const items = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const g = (t: string) => decode((m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
    const t = Date.parse(g('pubDate'));
    return { title: g('title'), summary: g('description'), link: g('link') || g('guid'), publisher: 'Bloomberg', time: isNaN(t) ? null : Math.floor(t / 1000) };
  }).filter((n) => n.title && /^https?:\/\//.test(n.link)).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 15);
  if (!items.length) throw new Error('Bloomberg RSS HTTP ' + r.status);
  bbgCache.set(feed, { t: Date.now(), items });
  return items;
}

/* ---------- Stock of the day: rule-based screen over the S&P 500 (cached 1h) ---------- */
async function dailyCloses(syms: string[], range = '6mo') {
  const out: Record<string, number[]> = {};
  const chunks: string[][] = []; for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));
  for (let i = 0; i < chunks.length; i += 6) {
    await Promise.all(chunks.slice(i, i + 6).map(async (c) => {
      const r = await yget(`/v8/finance/spark?symbols=${c.map(encodeURIComponent).join(',')}&range=${range}&interval=1d`);
      if (!r.ok) return; const j: any = r.j;
      if (j.spark?.result) { for (const it of j.spark.result) { const q = it.response?.[0]?.indicators?.quote?.[0]?.close; if (q) out[it.symbol] = q.filter((x: any) => x != null); } }
      else for (const [k, v] of Object.entries<any>(j)) if (Array.isArray(v?.close)) out[k] = v.close.filter((x: any) => x != null);
    }));
  }
  return out;
}
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
function rsi14(c: number[]) {
  let g = 0, l = 0; for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= 14; l /= 14;
  for (let i = 15; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
let pickCache: { t: number; data: unknown } | null = null;
async function stockOfDay() {
  if (pickCache && Date.now() - pickCache.t < 3600 * 1000) return pickCache.data;
  const list = await sp500(); const meta = Object.fromEntries(list.map((m) => [m.symbol, m]));
  const closes = await dailyCloses(list.map((m) => m.symbol));
  const rows: any[] = [];
  for (const [sym, c] of Object.entries(closes)) {
    if (c.length < 60) continue;
    const n = c.length, p = c[n - 1], sma20 = avg(c.slice(-20)), sma50 = avg(c.slice(-50)), rsi = rsi14(c);
    const ret20 = p / c[n - 21] - 1, ret5 = p / c[n - 6] - 1, chg = p / c[n - 2] - 1;
    const rets = c.slice(-21).map((v, i, a) => i ? v / a[i - 1] - 1 : 0).slice(1);
    const sd = Math.sqrt(avg(rets.map((r) => (r - avg(rets)) ** 2))) * Math.sqrt(20);
    const hi60 = Math.max(...c.slice(-60)), dist = p / hi60 - 1;
    const pass = p > sma20 && sma20 > sma50 && rsi >= 50 && rsi <= 70 && ret20 > 0 && chg > -0.03;
    const score = ret20 / (sd || 1) + (dist > -0.03 ? 0.5 : 0) + (chg > 0 ? 0.2 : 0);
    rows.push({ symbol: sym, name: meta[sym]?.name, sector: meta[sym]?.sector, price: p, chg, rsi, sma20, sma50, ret20, ret5, vol20: sd, dist, score, pass });
  }
  const passed = rows.filter((r) => r.pass).sort((a, b) => b.score - a.score);
  const data = { asOf: Date.now(), universe: rows.length, passed: passed.length, pick: passed[0] || null, runners: passed.slice(1, 5),
    method: 'Filter: price > SMA20 > SMA50, RSI(14) 50-70, 20-day return > 0, day change > -3%. Rank: 20-day return / 20-day volatility, +0.5 if within 3% of 60-day high, +0.2 if up on the day.' };
  pickCache = { t: Date.now(), data };
  return data;
}

/* ---------- Champion screen: Minervini Trend Template + RS rating over the S&P 500 (cached 1h) ---------- */
const smaAt = (c: number[], n: number, end: number) => avg(c.slice(end - n, end));
let champCache: { t: number; data: unknown } | null = null;
async function champion() {
  if (champCache && Date.now() - champCache.t < 3600 * 1000) return champCache.data;
  const list = await sp500(); const meta = Object.fromEntries(list.map((m) => [m.symbol, m]));
  const closes = await dailyCloses(list.map((m) => m.symbol), '1y');
  // IBD-style RS: 40% last quarter + 20% each of the three earlier quarters, ranked 1-99 across the universe
  const raw: { s: string; v: number }[] = [];
  for (const [s, c] of Object.entries(closes)) {
    if (c.length < 230) continue;
    const n = c.length, p = c[n - 1], q = (k: number) => c[Math.max(0, n - 1 - 63 * k)];
    raw.push({ s, v: 0.4 * (p / q(1)) + 0.2 * (p / q(2)) + 0.2 * (p / q(3)) + 0.2 * (p / q(4)) });
  }
  raw.sort((a, b) => a.v - b.v);
  const rs: Record<string, number> = {}; raw.forEach((r, i) => { rs[r.s] = Math.max(1, Math.min(99, Math.round(((i + 1) / raw.length) * 99))); });
  const rows: any[] = [];
  for (const { s } of raw) {
    const c = closes[s], n = c.length, p = c[n - 1];
    const s50 = smaAt(c, 50, n), s150 = smaAt(c, 150, n), s200 = smaAt(c, 200, n), s200m = smaAt(c, 200, n - 22);
    const last252 = c.slice(-252), hi = Math.max(...last252), lo = Math.min(...last252);
    const crit = [p > s150 && p > s200, s150 > s200, s200 > s200m, s50 > s150 && s50 > s200, p > s50, p >= lo * 1.3, p >= hi * 0.75, rs[s] >= 70];
    const met = crit.filter(Boolean).length;
    // Volatility contraction (closes only): price range of three consecutive 15-day windows, each tighter than the last
    const rg = (a: number[]) => Math.max(...a) / Math.min(...a) - 1;
    const w = [rg(c.slice(n - 45, n - 30)), rg(c.slice(n - 30, n - 15)), rg(c.slice(n - 15))];
    const tight10 = rg(c.slice(-10));
    const vcp = w[0] > w[1] && w[1] > w[2] && w[2] < 0.1;
    const pivot = Math.max(...c.slice(-15));
    const stop = Math.max(Math.min(...c.slice(-10)), p * 0.92);
    rows.push({ symbol: s, name: meta[s]?.name, sector: meta[s]?.sector, price: p, rs: rs[s], met, crit, s50, s150, s200,
      fromHigh: p / hi - 1, aboveLow: p / lo - 1, hi52: hi, lo52: lo, tight10, contractions: w, vcp, pivot, stop, risk: 1 - stop / p });
  }
  const pass = rows.filter((r) => r.met === 8).sort((a, b) => b.rs - a.rs);
  const near = rows.filter((r) => r.met === 7).sort((a, b) => b.rs - a.rs).slice(0, 15);
  const data = { asOf: Date.now(), universe: rows.length, passed: pass.length, rows: pass, near };
  champCache = { t: Date.now(), data };
  return data;
}

/* ---------- Minervini-style daily trading simulator (closing prices, S&P 500 universe) ---------- */
const SHORT_ETF: Record<string, { lev: number; stop: number }> = { SH: { lev: 1, stop: 0.08 }, PSQ: { lev: 1, stop: 0.08 }, SQQQ: { lev: 3, stop: 0.15 } };
const dkey = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
async function dailySeries(syms: string[], range: string) {
  const out: Record<string, { t: number[]; c: (number | null)[] }> = {};
  const chunks: string[][] = []; for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));
  for (let i = 0; i < chunks.length; i += 6) {
    await Promise.all(chunks.slice(i, i + 6).map(async (c) => {
      const r = await yget(`/v8/finance/spark?symbols=${c.map(encodeURIComponent).join(',')}&range=${range}&interval=1d`);
      if (!r.ok) return; const j: any = r.j;
      if (j.spark?.result) { for (const it of j.spark.result) { const res = it.response?.[0]; if (res?.timestamp) out[it.symbol] = { t: res.timestamp, c: res.indicators?.quote?.[0]?.close || [] }; } }
      else for (const [k, v] of Object.entries<any>(j)) if (Array.isArray(v?.timestamp) && Array.isArray(v?.close)) out[k] = { t: v.timestamp, c: v.close };
    }));
  }
  return out;
}
type Ind = { s50: Float64Array; s150: Float64Array; s200: Float64Array; hi: Float64Array; lo: Float64Array; rsv: Float64Array };
function indicators(a: Float64Array, f: number): Ind {
  const T = a.length, pre = new Float64Array(T + 1);
  for (let i = 0; i < T; i++) pre[i + 1] = pre[i] + (i >= f ? a[i] : 0);
  const sma = (n: number) => { const o = new Float64Array(T).fill(NaN); for (let i = f + n - 1; i < T; i++) o[i] = (pre[i + 1] - pre[i + 1 - n]) / n; return o; };
  const hi = new Float64Array(T).fill(NaN), lo = new Float64Array(T).fill(NaN), rsv = new Float64Array(T).fill(NaN);
  const mx: number[] = [], mn: number[] = [];
  for (let i = f; i < T; i++) {
    while (mx.length && a[mx[mx.length - 1]] <= a[i]) mx.pop(); mx.push(i); if (mx[0] <= i - 252) mx.shift();
    while (mn.length && a[mn[mn.length - 1]] >= a[i]) mn.pop(); mn.push(i); if (mn[0] <= i - 252) mn.shift();
    hi[i] = a[mx[0]]; lo[i] = a[mn[0]];
    if (i - 252 >= f) rsv[i] = 0.4 * a[i] / a[i - 63] + 0.2 * a[i] / a[i - 126] + 0.2 * a[i] / a[i - 189] + 0.2 * a[i] / a[i - 252];
  }
  return { s50: sma(50), s150: sma(150), s200: sma(200), hi, lo, rsv };
}
let simData: { t: number; d: any } | null = null;
async function simUniverse() {
  if (simData && Date.now() - simData.t < 3600 * 1000) return simData.d;
  const list = await sp500();
  const extra = ['SPY', 'QQQ', ...Object.keys(SHORT_ETF)];
  const raw = await dailySeries([...list.map((m) => m.symbol), ...extra], '2y');
  if (!raw.SPY || !raw.QQQ) throw new Error('benchmark data unavailable');
  const dates = raw.SPY.t.map(dkey), T = dates.length, idx = new Map(dates.map((d, i) => [d, i]));
  const syms: string[] = [], P: Float64Array[] = [], first: number[] = [];
  for (const [s, v] of Object.entries(raw)) {
    const a = new Float64Array(T).fill(NaN);
    v.t.forEach((ts, i) => { const k = idx.get(dkey(ts)); const c = v.c[i]; if (k !== undefined && c != null) a[k] = c; });
    let f = -1; for (let i = 0; i < T; i++) { if (!isNaN(a[i])) { if (f < 0) f = i; } else if (f >= 0) a[i] = a[i - 1]; }
    if (f < 0) continue;
    syms.push(s); P.push(a); first.push(f);
  }
  const ind = P.map((a, k) => indicators(a, first[k]));
  const etf = new Set(extra);
  const d = { dates, syms, P, first, ind, etf, names: Object.fromEntries(list.map((m) => [m.symbol, m.name])), universe: syms.filter((s) => !etf.has(s)).length, asOf: Date.now() };
  simData = { t: Date.now(), d };
  return d;
}
type SimOpts = { start: number; capital: number; risk: number; maxPos: number; short: string; shortAlloc: number; strig: string; stop: number; tp: number; mode: string; alloc: number; cost: number };
// Elite ("stock of the year") setup: Trend Template + RS >= 90, tight base that is narrowing, near the 52-week high
function eliteSetup(a: Float64Array, I: Ind, t: number, rk: number) {
  const p = a[t];
  if (!(p > I.s150[t] && p > I.s200[t] && I.s150[t] > I.s200[t] && I.s200[t] > I.s200[t - 22] && I.s50[t] > I.s150[t] && I.s50[t] > I.s200[t] && p > I.s50[t] && p >= I.lo[t] * 1.3 && p >= I.hi[t] * 0.85 && rk >= 90)) return null;
  let piv = -Infinity, mn = Infinity; for (let i = t - 15; i < t; i++) { if (a[i] > piv) piv = a[i]; if (a[i] < mn) mn = a[i]; }
  let mx2 = -Infinity, mn2 = Infinity; for (let i = t - 30; i < t - 15; i++) { if (a[i] > mx2) mx2 = a[i]; if (a[i] < mn2) mn2 = a[i]; }
  const base = piv / mn - 1, prior = mx2 / mn2 - 1;
  if (base > 0.12 || base > prior) return null;
  return { piv, base, score: rk + (0.12 - base) * 100 };
}
function runSim(d: any, o: SimOpts) {
  const { dates, syms, P, first, ind, etf } = d; const T = dates.length;
  const at = new Map<string, number>(syms.map((s: string, i: number) => [s, i]));
  const q = at.get('QQQ')!, spy = at.get('SPY')!;
  const stocks = syms.map((_: string, k: number) => k).filter((k: number) => !etf.has(syms[k]));
  let cash = o.capital;
  type Pos = { k: number; kind: 'long' | 'short'; sh: number; init: number; entry: number; t0: number; stop: number; half: boolean; cost: number; got: number; note: string };
  const pos = new Map<number, Pos>(); const trades: any[] = []; const cool = new Map<number, number>();
  const elite = o.mode === 'elite'; const used: Record<string, number> = {}; const shots: any[] = [];
  const eq: number[] = [], bs: number[] = [], bq: number[] = [], reg: string[] = [], expo: number[] = [];
  const equityAt = (t: number) => { let v = cash; for (const p of pos.values()) v += p.sh * P[p.k][t]; return v; };
  const sell = (p: Pos, t: number, sh: number, why: string) => {
    const px = P[p.k][t], val = sh * px; cash += val - val * o.cost; p.got += val - val * o.cost; p.sh -= sh;
    if (p.sh <= 0) {
      pos.delete(p.k); if (why.startsWith('ตัดขาดทุน')) cool.set(p.k, t + 10);
      trades.push({ sym: syms[p.k], kind: p.kind, d0: dates[p.t0], d1: dates[t], entry: +p.entry.toFixed(2), exit: +px.toFixed(2), pnl: +(p.got - p.cost).toFixed(2), pct: +((p.got / p.cost - 1) * 100).toFixed(2), days: t - p.t0, why, note: p.note });
    }
  };
  const buy = (k: number, t: number, sh: number, kind: 'long' | 'short', stop: number) => {
    const px = P[k][t], val = sh * px; cash -= val + val * o.cost;
    pos.set(k, { k, kind, sh, init: sh, entry: px, t0: t, stop, half: false, cost: val + val * o.cost, got: 0, note: '' });
  };
  for (let t = o.start; t < T; t++) {
    // RS rank of the day (1-99)
    const vals: [number, number][] = []; for (const k of stocks) { const v = ind[k].rsv[t]; if (!isNaN(v)) vals.push([v, k]); }
    vals.sort((a, b) => a[0] - b[0]); const rank = new Map<number, number>(); vals.forEach(([, k], i) => rank.set(k, Math.max(1, Math.round(((i + 1) / vals.length) * 99))));
    const qp = P[q][t], q50 = ind[q].s50[t], q200 = ind[q].s200[t];
    const r = qp > q50 && q50 > q200 ? 'U' : qp < q50 && q50 < q200 ? 'D' : 'N';
    const shortOn = o.strig === 'fast' ? qp < q50 : r === 'D';
    // manage open positions
    for (const p of [...pos.values()]) {
      const px = P[p.k][t];
      if (p.kind === 'short') { if (px <= p.stop) sell(p, t, p.sh, 'ตัดขาดทุน ETF ขาลง'); else if (!shortOn) sell(p, t, p.sh, 'ตลาดพ้นขาลง'); continue; }
      if (px <= p.stop) { sell(p, t, p.sh, p.stop >= p.entry ? 'ขายที่จุดคุ้มทุน/ล็อกกำไร' : 'ตัดขาดทุน'); continue; }
      const g = px / p.entry - 1;
      if (g >= o.tp / 2 && p.stop < p.entry) { p.stop = p.entry; }
      if (g >= o.tp && !p.half) { p.half = true; p.note = `ขายครึ่งหนึ่งที่ +${Math.round(o.tp * 100)}%`; p.stop = Math.max(p.stop, p.entry * (1 + o.tp / 4)); sell(p, t, Math.floor(p.sh / 2), ''); }
      if (pos.has(p.k) && p.half && px < ind[p.k].s50[t]) sell(p, t, p.sh, 'หลุด SMA50 หลังทำกำไร');
    }
    // inverse ETF hedge in a confirmed downtrend
    const sk = at.get(o.short);
    if (sk !== undefined && shortOn && ![...pos.values()].some((p) => p.kind === 'short')) {
      const px = P[sk][t], e = equityAt(t), sh = Math.floor(Math.min(e * o.shortAlloc, cash / (1 + o.cost)) / px);
      if (sh > 0) buy(sk, t, sh, 'short', px * (1 - SHORT_ETF[o.short].stop));
    }
    // new long breakouts in a confirmed uptrend
    let longs = [...pos.values()].filter((p) => p.kind === 'long').length;
    const yr = dates[t].slice(0, 4);
    if (elite && r === 'U' && longs === 0 && (used[yr] || 0) < 10) {
      let best: { k: number; score: number; rk: number } | null = null;
      for (const k of stocks) {
        if ((cool.get(k) ?? -1) > t || t - first[k] < 253 || t < 31) continue;
        const a = P[k], rk = rank.get(k) ?? 0, st = eliteSetup(a, ind[k], t, rk);
        if (!st || !(a[t] > st.piv && a[t] <= st.piv * 1.05)) continue;
        if (!best || st.score > best.score) best = { k, score: st.score, rk };
      }
      if (best) {
        const a = P[best.k], px = a[t]; let m10 = Infinity; for (let i = t - 10; i < t; i++) m10 = Math.min(m10, a[i]);
        const stop = Math.min(Math.max(m10, px * (1 - o.stop)), px * (1 - Math.min(0.03, o.stop))), e = equityAt(t);
        const sh = Math.floor(Math.min(e * o.alloc / px, cash / (px * (1 + o.cost))));
        if (sh >= 1) { buy(best.k, t, sh, 'long', stop); used[yr] = (used[yr] || 0) + 1; shots.push({ n: used[yr], year: yr, d: dates[t], sym: syms[best.k], rs: best.rk, entry: +px.toFixed(2), stop: +stop.toFixed(2) }); longs++; }
      }
    }
    if (!elite && r === 'U' && longs < o.maxPos) {
      const cands: [number, number][] = [];
      for (const k of stocks) {
        if (pos.has(k) || (cool.get(k) ?? -1) > t || t - first[k] < 253 || t < 16) continue;
        const a = P[k], I = ind[k], p = a[t], rk = rank.get(k) ?? 0;
        if (!(p > I.s150[t] && p > I.s200[t] && I.s150[t] > I.s200[t] && I.s200[t] > I.s200[t - 22] && I.s50[t] > I.s150[t] && I.s50[t] > I.s200[t] && p > I.s50[t] && p >= I.lo[t] * 1.3 && p >= I.hi[t] * 0.75 && rk >= 70)) continue;
        let piv = -Infinity, mn = Infinity; for (let i = t - 15; i < t; i++) { if (a[i] > piv) piv = a[i]; if (a[i] < mn) mn = a[i]; }
        if (piv / mn - 1 <= 0.15 && p > piv && p <= piv * 1.05) cands.push([rk, k]);
      }
      cands.sort((x, y) => y[0] - x[0]);
      for (const [, k] of cands) {
        if (longs >= o.maxPos) break;
        const a = P[k], px = a[t]; let m10 = Infinity; for (let i = t - 10; i < t; i++) m10 = Math.min(m10, a[i]);
        const stop = Math.min(Math.max(m10, px * (1 - o.stop)), px * (1 - Math.min(0.03, o.stop))), e = equityAt(t);
        const sh = Math.floor(Math.min(e * o.risk / (px - stop), e * 0.25 / px, cash / (px * (1 + o.cost))));
        if (sh < 1) continue;
        buy(k, t, sh, 'long', stop); longs++;
      }
    }
    const e = equityAt(t); let inv = 0; for (const p of pos.values()) inv += p.sh * P[p.k][t];
    eq.push(+e.toFixed(2)); bs.push(+(o.capital * P[spy][t] / P[spy][o.start]).toFixed(2)); bq.push(+(o.capital * P[q][t] / P[q][o.start]).toFixed(2)); reg.push(r); expo.push(e ? inv / e : 0);
  }
  const dd = (a: number[]) => { let pk = -Infinity, m = 0; for (const v of a) { pk = Math.max(pk, v); m = Math.min(m, v / pk - 1); } return +(m * 100).toFixed(2); };
  const ret = (a: number[]) => +((a[a.length - 1] / o.capital - 1) * 100).toFixed(2);
  const wins = trades.filter((x) => x.pnl > 0), losses = trades.filter((x) => x.pnl <= 0);
  const sum = (a: any[], f: string) => a.reduce((s, x) => s + x[f], 0);
  const last = T - 1;
  return {
    dates: dates.slice(o.start), equity: eq, spy: bs, qqq: bq, regime: reg.join(''),
    stats: {
      days: eq.length, ret: ret(eq), spyRet: ret(bs), qqqRet: ret(bq), maxDD: dd(eq), spyDD: dd(bs), qqqDD: dd(bq),
      trades: trades.length, winRate: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : null,
      avgWin: wins.length ? +(sum(wins, 'pct') / wins.length).toFixed(2) : null, avgLoss: losses.length ? +(sum(losses, 'pct') / losses.length).toFixed(2) : null,
      profitFactor: losses.length && sum(losses, 'pnl') < 0 ? +(sum(wins, 'pnl') / -sum(losses, 'pnl')).toFixed(2) : null,
      shortPnl: +sum(trades.filter((x) => x.kind === 'short'), 'pnl').toFixed(2), exposure: +(expo.reduce((a, b) => a + b, 0) / (expo.length || 1) * 100).toFixed(1),
      cash: +cash.toFixed(2),
    },
    open: [...pos.values()].map((p) => ({ sym: syms[p.k], kind: p.kind, d0: dates[p.t0], entry: +p.entry.toFixed(2), price: +P[p.k][last].toFixed(2), sh: p.sh, value: +(p.sh * P[p.k][last]).toFixed(2), pct: +((P[p.k][last] / p.entry - 1) * 100).toFixed(2), stop: +p.stop.toFixed(2), note: p.note })),
    trades: trades.reverse(),
    elite: elite ? eliteToday(d, o, used, shots, pos, r0(T - 1)) : undefined,
  };
  function r0(t: number) { const qp = P[q][t], q50 = ind[q].s50[t], q200 = ind[q].s200[t]; return qp > q50 && q50 > q200 ? 'U' : qp < q50 && q50 < q200 ? 'D' : 'N'; }
}
// Today's view for the elite strategy: signal, holdings, shots used, and names close to a buy point
function eliteToday(d: any, o: SimOpts, used: Record<string, number>, shots: any[], pos: Map<number, any>, regime: string) {
  const { dates, syms, P, first, ind, etf } = d; const t = dates.length - 1; const yr = dates[t].slice(0, 4);
  const stocks = syms.map((_: string, k: number) => k).filter((k: number) => !etf.has(syms[k]));
  const vals: [number, number][] = []; for (const k of stocks) { const v = ind[k].rsv[t]; if (!isNaN(v)) vals.push([v, k]); }
  vals.sort((a, b) => a[0] - b[0]); const rank = new Map<number, number>(); vals.forEach(([, k], i) => rank.set(k, Math.max(1, Math.round(((i + 1) / vals.length) * 99))));
  const watch: any[] = [];
  for (const k of stocks) {
    if (t - first[k] < 253) continue;
    const a = P[k], rk = rank.get(k) ?? 0, st = eliteSetup(a, ind[k], t, rk); if (!st) continue;
    const p = a[t]; let m10 = Infinity; for (let i = t - 10; i < t; i++) m10 = Math.min(m10, a[i]);
    const status = p > st.piv * 1.05 ? 'extended' : p > st.piv ? 'breakout' : p >= st.piv * 0.95 ? 'near' : 'base';
    watch.push({ sym: syms[k], name: d.names[syms[k]] || '', rs: rk, price: +p.toFixed(2), pivot: +st.piv.toFixed(2), toPivot: +((st.piv / p - 1) * 100).toFixed(2), base: +(st.base * 100).toFixed(1), stop: +Math.min(Math.max(m10, st.piv * (1 - o.stop)), st.piv * (1 - Math.min(0.03, o.stop))).toFixed(2), score: +st.score.toFixed(1), status });
  }
  watch.sort((a, b) => b.score - a.score);
  const holding = [...pos.values()].filter((p: any) => p.kind === 'long').map((p: any) => syms[p.k]);
  const left = 10 - (used[yr] || 0);
  const top = watch.find((w) => w.status === 'breakout');
  const signal = holding.length ? { type: 'hold', sym: holding[0] } : regime !== 'U' ? { type: 'wait-market' } : left <= 0 ? { type: 'no-shots' } : top ? { type: 'buy', ...top } : { type: 'none' };
  return { year: yr, used: used[yr] || 0, usedByYear: used, left, regime, signal, shots, watch: watch.slice(0, 8), asOfDate: dates[t] };
}
const simCache = new Map<string, { t: number; v: unknown }>();
async function simulate(u: URL) {
  const d = await simUniverse();
  const period = u.searchParams.get('period') || '1y';
  const short = u.searchParams.get('short') || 'none';
  const o: SimOpts = {
    start: 0, capital: Math.min(1e9, Math.max(1000, +(u.searchParams.get('capital') || 100000))),
    risk: Math.min(0.05, Math.max(0.0025, +(u.searchParams.get('risk') || 1.25) / 100)),
    maxPos: Math.min(12, Math.max(1, Math.round(+(u.searchParams.get('maxpos') || 6)))),
    short: SHORT_ETF[short] ? short : 'none', shortAlloc: Math.min(1, Math.max(0, +(u.searchParams.get('salloc') || 30) / 100)), strig: u.searchParams.get('strig') === 'confirmed' ? 'confirmed' : 'fast',
    stop: Math.min(0.3, Math.max(0.02, +(u.searchParams.get('stop') || 8) / 100)), tp: Math.min(1, Math.max(0.04, +(u.searchParams.get('tp') || 20) / 100)),
    mode: u.searchParams.get('mode') === 'elite' ? 'elite' : 'normal', alloc: Math.min(1, Math.max(0.1, +(u.searchParams.get('alloc') || 50) / 100)), cost: 0.001,
  };
  const T = d.dates.length, PAPER = '2026-11-27';
  if (period === 'paper') {
    const i = d.dates.findIndex((x: string) => x >= PAPER);
    if (i < 0) {
      const q = d.syms.indexOf('QQQ'), qp = d.P[q][T - 1], q50 = d.ind[q].s50[T - 1], q200 = d.ind[q].s200[T - 1];
      const reg = qp > q50 && q50 > q200 ? 'U' : qp < q50 && q50 < q200 ? 'D' : 'N';
      return { pending: true, paperStart: PAPER, lastDate: d.dates[T - 1], universe: d.universe, elite: o.mode === 'elite' ? eliteToday(d, o, {}, [], new Map(), reg) : undefined };
    }
    o.start = i;
  } else o.start = Math.max(253, T - (({ '3m': 63, '6m': 126, '1y': 252 } as Record<string, number>)[period] ?? 252));
  const key = JSON.stringify(o) + d.asOf;
  const c = simCache.get(key); if (c) return c.v;
  const v = { ...runSim(d, o), params: { ...o, period, risk: o.risk * 100, shortAlloc: o.shortAlloc * 100, stop: o.stop * 100, tp: o.tp * 100, alloc: o.alloc * 100 }, universe: d.universe, asOf: d.asOf, paperStart: PAPER };
  if (simCache.size > 50) simCache.clear(); simCache.set(key, { t: Date.now(), v });
  return v;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const u = new URL(req.url);
  const type = u.searchParams.get('type') || 'chart';

  if (type === 'search') {
    const q = (u.searchParams.get('q') || '').trim().slice(0, 40);
    if (!q) return json({ quotes: [] });
    const r = await yget(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`);
    if (!r.ok) return json({ quotes: [], ...r.j }, 502);
    const quotes = ((r.j as any).quotes || [])
      .filter((x: any) => x.symbol && ['EQUITY', 'ETF', 'INDEX'].includes(x.quoteType))
      .map((x: any) => ({ symbol: x.symbol, name: x.shortname || x.longname || '', exch: x.exchDisp || '', type: x.typeDisp || x.quoteType }));
    return json({ quotes }, 200, { 'Cache-Control': 'max-age=300' });
  }

  if (type === 'caps') {
    const syms = [...new Set((u.searchParams.get('symbols') || '').toUpperCase().split(',').map((x) => x.trim()).filter((x) => SYM.test(x)))].slice(0, 600);
    try { return json({ caps: await caps(syms) }, 200, { 'Cache-Control': 'max-age=1800' }); }
    catch (e) { return json({ error: (e as Error).message, caps: {} }, 502); }
  }
  if (type === 'bloomberg') {
    const feed = u.searchParams.get('feed') || 'markets';
    if (!BBG[feed]) return json({ error: 'unknown feed' }, 400);
    try { return json({ feed, items: await bloomberg(feed) }, 200, { 'Cache-Control': 'max-age=300' }); }
    catch (e) { return json({ error: (e as Error).message, items: [] }, 502); }
  }
  if (type === 'sim') {
    try { return json(await simulate(u), 200, { 'Cache-Control': 'max-age=600' }); }
    catch (e) { return json({ error: (e as Error).message }, 502); }
  }
  if (type === 'champion') {
    try { return json(await champion(), 200, { 'Cache-Control': 'max-age=900' }); }
    catch (e) { return json({ error: (e as Error).message }, 502); }
  }
  if (type === 'pick') {
    try { return json(await stockOfDay(), 200, { 'Cache-Control': 'max-age=900' }); }
    catch (e) { return json({ error: (e as Error).message }, 502); }
  }
  if (type === 'sp500') {
    try { return json({ updated: spCache?.t ?? Date.now(), members: await sp500() }, 200, { 'Cache-Control': 'max-age=3600' }); }
    catch (e) { return json({ error: (e as Error).message, members: [] }, 502); }
  }
  if (type === 'quotes') {
    const syms = [...new Set((u.searchParams.get('symbols') || '').toUpperCase().split(',').map((x) => x.trim()).filter((x) => SYM.test(x)))].slice(0, 120);
    if (!syms.length) return json({ quotes: [] });
    return json({ quotes: await quotes(syms) }, 200, { 'Cache-Control': 'max-age=30' });
  }

  const symbol = (u.searchParams.get('symbol') || 'AAPL').trim().toUpperCase();
  if (!SYM.test(symbol)) return json({ error: 'invalid symbol' }, 400);

  if (type === 'news') {
    const name = (u.searchParams.get('name') || '').slice(0, 80);
    const items = await getNews(symbol, name);
    return json({ symbol, items }, 200, { 'Cache-Control': 'max-age=300' });
  }

  const range = u.searchParams.get('range') || '6mo';
  const interval = u.searchParams.get('interval') || '1d';
  if (!RANGES.has(range) || !INTERVALS.has(interval)) return json({ error: 'invalid parameters' }, 400);
  const r = await yget(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`);
  const j: any = r.j;
  if (!r.ok || !j.chart) return json(j.chart ? j : { error: j.error || ('HTTP ' + r.status) }, 502);
  return json(j, j.chart.error ? 404 : 200, { 'Cache-Control': 'max-age=15' });
});
