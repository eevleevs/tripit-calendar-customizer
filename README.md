# tripit-calendar-customizer

Cloudflare Worker that proxies a private TripIt iCal feed and strips all-day
events.

```
GET /feed/ical/private/<token>/tripit.ics
  → fetches https://tripit.com/feed/ical/private/<token>/tripit.ics
  → removes VEVENTs whose DTSTART is a bare DATE (all-day)
  → returns the filtered text/calendar, edge-cached for 15 minutes
```

## Commands (bun, no Node.js required)

| Command             | Effect                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `bun install`       | Install dev dependencies (wrangler, typescript, workers-types)                 |
| `bun test`          | Unit tests for the iCalendar filter                                            |
| `bun run typecheck` | Strict TypeScript check of `src/`                                              |
| `bun run dev`       | Local dev server on `http://127.0.0.1:8787`                                    |
| `bun run deploy`    | Deploy to your `workers.dev` subdomain (requires `bun x wrangler login` first) |

> **Why does `dev` use Deno?** Wrangler officially doesn't support the Bun
> runtime, and Bun's `fetch()` can't proxy requests into the local workerd
> runtime (it ignores the undici dispatcher), so `wrangler dev` under Bun fails
> with a 503. The dev script runs wrangler via Deno instead; installing Node
> LTS and running `wrangler dev` with it works too. `bun test`, `typecheck` and
> `deploy` all run fine under Bun.

## Behavior

- **Path matching**: only `/feed/ical/private/<token>/tripit.ics` is served;
  anything else → 404, non-GET/HEAD → 405.
- **Upstream errors**: invalid token → upstream status passed through (TripIt
  returns `404`/`410`); TripIt down → last
  cached copy if any, else `502`. Errors are never cached.
- **Caching**: `caches.default`, keyed by origin + path (query strings ignored),
  15-minute freshness via an internal timestamp header, stale copy served on
  upstream failure.
- **Conditional requests**: responses carry a content `ETag`; matching
  `If-None-Match` → `304`.
- **Filtering**: whole `VEVENT` blocks are dropped when their own `DTSTART`
  value is `YYYYMMDD`. Surviving events are re-emitted byte-for-byte (line
  folding preserved); calendar header, `VTIMEZONE` and other components are
  untouched. Rules are a composable list in `src/filter.ts`.
