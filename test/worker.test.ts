import { beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/worker";

const TOKEN = "AABBCCDD-EEFF0011223344556677889900AABB";
const URL_ = `https://cal.example.com/feed/ical/private/${TOKEN}/tripit.ics`;

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261101",
  "DTEND;VALUE=DATE:20261205",
  "SUMMARY:All-day trip span",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261101T200500Z",
  "DTEND:20261101T213000Z",
  "SUMMARY:FR6334 PSA to GRO",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const ctx = (): {
  waitUntil: (p: Promise<unknown>) => void;
  pending: Promise<unknown>[];
} => {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p) => pending.push(p), pending };
};

const handlerCtx = (c: ReturnType<typeof ctx>) =>
  ({
    waitUntil: c.waitUntil,
    passThroughOnException: () => {},
  }) as unknown as ExecutionContext;

class MemoryCache {
  store = new Map<
    string,
    { body: string; status: number; headers: string[][] }
  >();
  async match(req: Request): Promise<Response | undefined> {
    const hit = this.store.get(req.url);
    return hit
      ? new Response(hit.body, { status: hit.status, headers: hit.headers })
      : undefined;
  }
  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, {
      body: await res.text(),
      status: res.status,
      headers: [...new Headers(res.headers)],
    });
  }
}

let cache: MemoryCache;
let upstreamCalls: string[];
let upstream: () => Response | Promise<Response>;

const doFetch = async (url = URL_, init?: RequestInit): Promise<Response> => {
  const c = ctx();
  const response = await worker.fetch(
    new Request(url, init),
    {} as Env,
    handlerCtx(c),
  );
  await Promise.all(c.pending);
  return response;
};

type Env = Record<string, never>;

beforeEach(() => {
  cache = new MemoryCache();
  (globalThis as Record<string, unknown>).caches = { default: cache };
  upstreamCalls = [];
  upstream = () =>
    new Response(ICS, { headers: { "Content-Type": "text/calendar" } });
  (globalThis as Record<string, unknown>).fetch = async (
    input: RequestInfo | URL,
  ) => {
    upstreamCalls.push(String(input));
    return upstream();
  };
});

describe("worker.fetch", () => {
  test("404 on foreign path, 405 on non-GET", async () => {
    expect((await doFetch("https://cal.example.com/other")).status).toBe(404);
    expect((await doFetch(URL_, { method: "POST" })).status).toBe(405);
    expect(upstreamCalls).toHaveLength(0);
  });

  test("filters all-day events and serves text/calendar with ETag", async () => {
    const response = await doFetch();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="tripit.ics"',
    );
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=900");
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]{16}"$/);
    expect(response.headers.get("X-Tripit-Customizer-Epoch")).toBeNull();
    const body = await response.text();
    expect(body).not.toContain("All-day trip span");
    expect(body).toContain("FR6334 PSA to GRO");
    expect(upstreamCalls).toEqual([
      `https://tripit.com/feed/ical/private/${TOKEN}/tripit.ics`,
    ]);
    expect(cache.store.size).toBe(1);
  });

  test("second request inside TTL is served from cache", async () => {
    await doFetch();
    const response = await doFetch();
    expect(response.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(await response.text()).toContain("FR6334");
  });

  test("expired cache entry refetches upstream", async () => {
    await doFetch();
    const entry = [...cache.store.values()][0]!;
    const headers = new Headers(entry.headers);
    headers.set("X-Tripit-Customizer-Epoch", String(Date.now() - 901_000));
    entry.headers = [...headers];
    await doFetch();
    expect(upstreamCalls).toHaveLength(2);
  });

  test("stale cache is served when upstream fails", async () => {
    await doFetch();
    const entry = [...cache.store.values()][0]!;
    const headers = new Headers(entry.headers);
    headers.set("X-Tripit-Customizer-Epoch", String(Date.now() - 901_000));
    entry.headers = [...headers];
    upstream = () => Promise.reject(new Error("network down"));
    const response = await doFetch();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("FR6334");
  });

  test("502 when upstream fails and nothing is cached", async () => {
    upstream = () => Promise.reject(new Error("network down"));
    expect((await doFetch()).status).toBe(502);
    expect(cache.store.size).toBe(0);
  });

  test("502 when reading the upstream body fails (unhandled throw guard)", async () => {
    const broken = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("connection reset mid-body")),
    } as unknown as Response;
    upstream = () => broken;
    expect((await doFetch()).status).toBe(502);
    expect(cache.store.size).toBe(0);
  });

  test("upstream 404 passes through uncached", async () => {
    upstream = () => new Response("not found", { status: 404 });
    const response = await doFetch();
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("invalid token");
    expect(cache.store.size).toBe(0);
  });

  test("If-None-Match with current ETag returns 304", async () => {
    const first = await doFetch();
    const etag = first.headers.get("ETag")!;
    await first.text();
    const response = await doFetch(URL_, {
      headers: { "If-None-Match": etag },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(await response.text()).toBe("");
  });

  test("HEAD returns headers without a body", async () => {
    const response = await doFetch(URL_, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(await response.text()).toBe("");
  });

  test("cache key ignores query strings", async () => {
    await doFetch();
    await doFetch(`${URL_}?utm=1`);
    expect(upstreamCalls).toHaveLength(1);
  });
});
