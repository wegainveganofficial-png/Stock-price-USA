// Proxy to Yahoo Finance (chart, symbol search, news) for the US Stock Tracker page.
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
