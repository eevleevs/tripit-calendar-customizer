import { filterCalendar } from './filter';

type Env = Record<string, never>;

const PATH = /^\/feed\/ical\/private\/[^/]+\/tripit\.ics$/;
const TTL_SECONDS = 15 * 60;
const EPOCH_HEADER = 'X-Tripit-Customizer-Epoch';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const etagOf = async (body: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `"${hex}"`;
};

/** Shape a stored response for the client: strip internals, honor If-None-Match, drop body on HEAD. */
const respond = (request: Request, source: Response, head: boolean): Response => {
  const headers = new Headers(source.headers);
  headers.delete(EPOCH_HEADER);
  const etag = headers.get('ETag');
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (etag && ifNoneMatch && (ifNoneMatch === '*' || ifNoneMatch.split(',').some((v) => v.trim() === etag)))
    return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(head ? null : source.body, { status: source.status, headers });
};

const route = async (request: Request, ctx: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url);
  const head = request.method === 'HEAD';
  if (request.method !== 'GET' && !head) return text('Method Not Allowed', 405, { Allow: 'GET, HEAD' });
  if (!PATH.test(url.pathname)) return text('Not Found', 404);

  // Cache key ignores query strings; callers only ever need the path.
  const key = new Request(`${url.origin}${url.pathname}`);
  const cache = caches.default;
  const now = Date.now();
  const cached = await cache.match(key);
  const fresh =
    cached && Number(cached.headers.get(EPOCH_HEADER)) + TTL_SECONDS * 1000 > now ? cached : undefined;
  if (fresh) return respond(request, fresh, head);

  let upstream: Response;
  try {
    upstream = await fetch(`https://tripit.com${url.pathname}`, {
      headers: { 'User-Agent': UA, Accept: 'text/calendar, text/plain, */*;q=0.8' },
    });
  } catch {
    // TripIt unreachable: serve a stale copy if we ever had one.
    if (cached) return respond(request, cached, head);
    return text('Upstream unreachable', 502);
  }

  if (!upstream.ok) {
    const message =
      upstream.status === 404 ? 'Feed not found (invalid token?)' : `Upstream error (${upstream.status})`;
    return text(message, upstream.status);
  }

  const filtered = filterCalendar(await upstream.text());
  const headers = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="tripit.ics"',
    'Cache-Control': `public, max-age=${TTL_SECONDS}, s-maxage=${TTL_SECONDS}`,
    ETag: await etagOf(filtered),
    [EPOCH_HEADER]: String(now),
  };
  const response = new Response(filtered, { headers });
  ctx.waitUntil(cache.put(key, new Response(filtered, { headers })));
  return respond(request, response, head);
};

const text = (body: string, status: number, headers: HeadersInit = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, ctx);
    } catch (error) {
      console.error('unhandled error serving feed', error);
      return text('Internal error', 502);
    }
  },
} satisfies ExportedHandler<Env>;
