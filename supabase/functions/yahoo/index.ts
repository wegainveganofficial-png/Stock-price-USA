// Proxy to Yahoo Finance (chart, symbol search, news, batch quotes) + S&P 500 list (Wikipedia) + market caps + Bloomberg RSS headlines + stock-of-the-day screen for the US Stock Tracker page.
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
async function dailyCloses(syms: string[]) {
  const out: Record<string, number[]> = {};
  const chunks: string[][] = []; for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));
  for (let i = 0; i < chunks.length; i += 6) {
    await Promise.all(chunks.slice(i, i + 6).map(async (c) => {
      const r = await yget(`/v8/finance/spark?symbols=${c.map(encodeURIComponent).join(',')}&range=6mo&interval=1d`);
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
