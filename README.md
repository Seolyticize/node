# @seolyticize/node

Seolyticize on a Node server. It reports the visitors the browser tag never sees,
AI assistants above all, and the conversions that happen on your server: a
payment webhook, or a sign-up behind a login. It never throws, the request that
reports never waits, and failed sends are retried.

```ts
import seolyticize from "@seolyticize/node/fastify";

await app.register(seolyticize, {
  siteKey: env.SEOLYTICIZE_SITE_KEY,
  serverKey: env.SEOLYTICIZE_SERVER_COLLECT_KEY, // from issue_server_collect_key
  only: "agents", // the tag counts people; the server reports AI agents
  consent: (req) => req.consent?.statistics === true, // a person's ip and user agent only with consent
});

// Anywhere, with no await on the hot path and no throwing:
app.seo.trackPurchase(
  { orderId: pi.id, amountMinor: pi.amount, currency: pi.currency }, // 4200 USD cents is sent as value 42
  { visit: order.visitToken },
);
app.seo.trackLater("First listing", { userId }, { visit: user.visitToken });
```

Express is the same, as middleware:

```ts
import seolyticize from "@seolyticize/node/express";

const seo = seolyticize({ siteKey, serverKey, only: "agents" });
app.use(seo); // req.seo per request; seo.seo is the client, for webhooks and jobs
```

Without a framework, use `createSeolyticize(options)` from `@seolyticize/node`.
It has the same `track`, `trackPurchase`, `trackLater`, `pageview`,
`trackForVisit`, `urlsChanged` and `flush` methods. Server-side collection, bot filtering and query stripping come from
`@seolyticize/sdk`'s collector.

- **Page views.** Each successful HTML page response is reported. Bots are dropped.
  With `only: "agents"`, only AI assistants (ChatGPT-User, Claude-User,
  Perplexity-User and others) are reported, so people are not counted twice
  beside the tag. Set `pageviews: false` to turn this off.
- **Visit tokens.** `track(name, props, { visit })` credits an event to an
  earlier visit's landing page and source. Get the token in the browser with
  `@seolyticize/web`'s `visit()`, or on the server with
  `await req.seo.trackForVisit("Signup")`, and keep it with the account or order.
- **Consent.** `consent(req)` is asked at each call, so a cookie parsed by a later
  hook still counts. Without consent, a person's address and user agent are left
  out. An AI assistant's page view is always reported in full, because it reads
  for somebody and never sees a banner.
- **Money.** `p.value` is in major units: `42` for 42.00, never `4200`.
  `trackPurchase({ orderId, currency, amountMinor })` converts minor units with
  the currency's own digits (4200 USD is 42, 4200 JPY is 4200, 4200 KWD is 4.2);
  pass `value` instead when you already have major units. `currency` must be the
  site's reporting currency (`set_up_web_analytics {currency}`, or the first one
  the site receives): a purchase in another is refused (`422 rejected_currency`,
  counted in `verify_site`), never converted or summed with the rest.
- **Delivery.** Events go through an in-process queue and are sent in batches,
  one JSON array per request: a batch goes as soon as `batchSize` events (default
  50, at most 100) are waiting, or after `flushMs` (default 1000) otherwise, up to
  `concurrency` (default 4) requests at a time. A network failure, 429 or 5xx is
  retried, for the events it hit, with backoff (`backoffMs` doubles each time, up
  to a minute). After `maxAttempts` (default 5) the event is dropped and `onError`
  hears why. A refusal (400, 401, 404, 410 or 422) is not retried. `maxQueue`
  (default 10,000) bounds memory. `await flush()` sends what is waiting and
  resolves when the queue is empty. The Fastify plugin flushes on `app.close()`,
  and a process about to exit with events waiting flushes them first
  (`beforeExit`); call `flush()` yourself before `process.exit()`.
- **Duplicates and refunds.** `props.orderId` is an idempotency key. The same
  event name and id is sent once per process, and the server stores it once per
  site within 30 days, so a redelivered Stripe webhook does not count twice,
  even from another process. `track("Refund", { orderId })` nets that purchase
  out of goal and conversion values (`value` for a partial refund, in major
  units); a refund of an order never recorded is refused (`422 unknown_order`).
- **Changed pages.** With `apiKey` (an API key with `spend:incur`) and `clientId`,
  `await seo.urlsChanged({ changed: [...], removed: [...] })` submits the URLs to
  IndexNow through `submit_indexnow` (up to 500 at once; the client's IndexNow key
  must be verified). A removed page should already answer 404 or 410: the engines
  re-fetch it. Unlike the rest, it rejects when the call fails.
- **Hooks.** `onSend(event, { status, attempt })` hears every attempt that reached
  the network, for your own request log. `onError(error, event)` hears every
  event that was dropped or refused. A hook that throws is ignored.
- **Testing.** `testTransport()` answers 202 and keeps every body sent:

  ```ts
  const transport = testTransport();
  const seo = createSeolyticize({ siteKey, serverKey, transport });
  seo.track("Signup", {}, { visit: "v1.x" });
  await seo.flush();
  expect(transport.events).toEqual([{ k: siteKey, n: "Signup", visit: "v1.x" }]);
  ```

  `testTransport((body) => 503)` answers another status, for testing retries.

**Fastify types.** The plugin needs no `fastify` dependency. To type `req.seo` and `app.seo`, add:

```ts
import type { RequestSeo, Seolyticize } from "@seolyticize/node/fastify";
declare module "fastify" {
  interface FastifyInstance {
    seo: Seolyticize;
  }
  interface FastifyRequest {
    seo: RequestSeo;
  }
}
```

**Version.** Requests carry `X-Seolyticize-Client: node/<version>`, so
`get_next_steps` shows an upgrade row when an older install is still reporting.

## Install

```sh
npm install @seolyticize/node
```
