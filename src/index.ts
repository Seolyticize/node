import {
  addressFrom,
  classifyAgent,
  createClient,
  createCollector,
  DEFAULT_COLLECT_URL,
  type CollectorOptions,
  type LaterEvent,
  type PageView,
} from "@seolyticize/sdk";
import { CLIENT } from "./version.js";

export { CLIENT };
export { classifyAgent, isPageRequest } from "@seolyticize/sdk";
export type { PageView, LaterEvent } from "@seolyticize/sdk";

/**
 * Seolyticize on a Node server. Every report goes through an in-process queue:
 * the request that made it never waits, nothing throws, and a failed send is
 * retried with backoff before it is dropped. Reports are sent in batches, as
 * one JSON array per request. Built on the SDK's collector, so bot filtering,
 * query stripping and the /api/collect contract stay in one place.
 */

export type Props = Record<string, string | number | boolean>;

/** One queued report: a page view, an event for the visitor in front of you, or one credited to an earlier visit. */
export type QueuedEvent =
  | { kind: "pageview"; view: PageView }
  | { kind: "event"; view: PageView & { name: string } }
  | { kind: "later"; event: LaterEvent };

/** What one attempt got back: an HTTP status, or 0 when the network failed or timed out. */
export type SendResult = { status: number; attempt: number };

/** The visitor a request came from, as an adapter reads it. */
export type Visitor = {
  url: string;
  userAgent?: string | null;
  ip?: string | null;
  referrer?: string | null;
  country?: string | null;
  clientHints?: string | null;
  signatureAgent?: string | null;
};

export type NodeOptions = Omit<CollectorOptions, "onError" | "fetchImpl" | "client"> & {
  /** Sends before an event is dropped (default 5). */
  maxAttempts?: number;
  /** The first retry's wait; each later one doubles, up to a minute (default 1000). */
  backoffMs?: number;
  /** Batches in flight at once (default 4). */
  concurrency?: number;
  /** Events sent in one request, at most 100 (default 50). A full batch is sent at once. */
  batchSize?: number;
  /** How long an event waits for its batch to fill before it is sent anyway (default 1000). */
  flushMs?: number;
  /** Events held at most; past it new ones are dropped with onError (default 10000). */
  maxQueue?: number;
  /** Hears every event that was dropped, refused or not credited, with why. */
  onError?: (error: unknown, event: QueuedEvent) => void;
  /** Hears every attempt that reached the network, for your own request log. */
  onSend?: (event: QueuedEvent, result: SendResult) => void;
  /** Replaces fetch: testTransport() in tests, or your own logged fetch. */
  transport?: typeof fetch;
  /** An API key with spend:incur and the client's id, for urlsChanged() (IndexNow). */
  apiKey?: string;
  clientId?: string;
  /** Another deployment's API origin, for urlsChanged(). */
  apiBaseUrl?: string;
};

export type TrackOptions = {
  /** The visit token from visit() in the browser or trackForVisit(): credits the event to that visit. */
  visit?: string | null;
  /** The visitor in front of you; the adapters fill it in. */
  visitor?: Visitor;
  /** False leaves the visitor's address and user agent out (no consent). */
  consented?: boolean;
};

/** A purchase: value in major units (42 for 42.00), or amountMinor in the currency's minor unit (4200). */
export type Purchase = {
  orderId: string;
  /** ISO 4217, and the site's reporting currency: another is refused (rejected_currency). */
  currency: string;
  value?: number;
  amountMinor?: number;
  /** Any other properties, up to the collect limit of 10 in all. */
  props?: Props;
};

export type Seolyticize = {
  /**
   * Queues a custom event. With a visit token it is credited to that visit
   * (a payment webhook, a sign-up behind a login); otherwise it needs the
   * visitor, or at least its url. props.orderId is an idempotency key: the
   * same event name and orderId is sent once per process, and the server
   * stores it once within 30 days. track("Refund", { orderId }) nets that
   * Purchase out of revenue (props.value for a partial refund).
   */
  track(name: string, props?: Props, options?: TrackOptions): void;
  /** track("Purchase") with p.value in major units, converted from amountMinor when that is given. */
  trackPurchase(purchase: Purchase, options?: TrackOptions): void;
  /** track() for an event that happened after the visit: the token is required. */
  trackLater(name: string, props: Props | undefined, options: { visit: string }): void;
  /** Queues a page view (bots dropped; with only "agents", only AI assistants). */
  pageview(view: PageView): void;
  /** Sends an event now and resolves with its visit token, to keep with the account or order. Never rejects. */
  trackForVisit(
    name: string,
    props: Props | undefined,
    visitor: Visitor,
  ): Promise<string | null>;
  /**
   * Tells search engines through IndexNow (submit_indexnow) that pages changed
   * or were removed, up to 500 at once. Needs apiKey and clientId. Resolves
   * with the tool's answer (null when there was nothing to send); rejects
   * when the call fails, since a deploy step should know.
   */
  urlsChanged(urls: { changed?: string[]; removed?: string[] }): Promise<unknown>;
  /** Sends everything queued now and resolves when it has been sent or dropped, retries included. */
  flush(): Promise<void>;
  /** Events waiting or in flight. */
  readonly pending: number;
};

const retryable = (status: number) => status === 0 || status === 429 || status >= 500;
/** Drops that are the visitor's choice, the site's settings or a duplicate, not faults. */
const quietDrop = /^(gpc|excluded_|outside_|duplicate_order|already_refunded)/;

/** amountMinor in major units, by the currency's own minor-unit digits (JPY 0, USD 2, KWD 3). */
export function majorUnits(amountMinor: number, currency: string): number {
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits;
  return amountMinor / 10 ** (digits ?? 2);
}

/** Every client with events pending, flushed once when the process would otherwise exit. */
const unsent = new Set<() => Promise<void>>();
let exitHooked = false;
function flushOnExit(flush: () => Promise<void>) {
  unsent.add(flush);
  if (exitHooked || typeof process === "undefined" || !process.once) return;
  exitHooked = true;
  process.once("beforeExit", () => {
    exitHooked = false;
    for (const each of unsent) void each();
  });
}

type Item = { event: QueuedEvent; body: Record<string, unknown>; attempt: number };

export function createSeolyticize(options: NodeOptions): Seolyticize {
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffMs = options.backoffMs ?? 1000;
  const concurrency = options.concurrency ?? 4;
  const batchSize = Math.min(Math.max(options.batchSize ?? 50, 1), 100);
  const flushMs = options.flushMs ?? 1000;
  const maxQueue = options.maxQueue ?? 10_000;
  const transport = options.transport ?? fetch;
  const endpoint = options.endpoint ?? DEFAULT_COLLECT_URL;
  const queue: Item[] = [];
  const orders = new Set<string>();
  let active = 0;
  let sending = 0;
  let waiting = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: Array<() => void> = [];

  /*
   * The collector writes each body and hands it to its fetch before its first
   * await, so a fetch that only keeps the body turns the collector into the
   * body builder: bot filtering, include/exclude and query stripping included.
   */
  let built: Record<string, unknown> | null = null;
  let building: QueuedEvent | null = null;
  const builder = createCollector({
    ...options,
    client: CLIENT,
    onError: (error) =>
      building && safely(() => options.onError?.(error, building as QueuedEvent)),
    fetchImpl: async (_url, init) => {
      built = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 202 });
    },
  });
  function bodyOf(event: QueuedEvent): Record<string, unknown> | null {
    built = null;
    building = event;
    if (event.kind === "pageview") void builder.track(event.view);
    else if (event.kind === "event") void builder.trackForVisit(event.view);
    else void builder.trackLater(event.event);
    building = null;
    return built;
  }

  // Awaited sends, never queued: trackForVisit needs the answer's token.
  const direct = createCollector({
    ...options,
    client: CLIENT,
    fetchImpl: transport,
    onError: (error) =>
      safely(() =>
        options.onError?.(error, { kind: "event", view: { url: "", name: "" } }),
      ),
  });

  const settle = () => {
    if (sending === 0 && waiting === 0 && queue.length === 0) {
      unsent.delete(client.flush);
      const done = idle;
      idle = [];
      for (const resolve of done) resolve();
    }
  };

  /** Each item's status, in order: from the batch's answer, or the whole answer's. */
  async function post(
    batch: Item[],
  ): Promise<Array<{ status: number; answer: unknown }>> {
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const response = await transport(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.serverKey}`,
          "x-seolyticize-client": CLIENT,
        },
        body: JSON.stringify(batch.map((item) => item.body)),
        signal: controller.signal,
      });
      const answer = (await response.json().catch(() => null)) as {
        results?: Array<{ status: number }>;
        error?: string;
      } | null;
      const results = answer?.results;
      if (response.status === 202 && Array.isArray(results)) {
        return batch.map((_, index) => ({
          status: results[index]?.status ?? 0,
          answer: results[index],
        }));
      }
      return batch.map(() => ({ status: response.status, answer }));
    } catch (error) {
      return batch.map(() => ({ status: 0, answer: error }));
    } finally {
      clearTimeout(stop);
    }
  }

  function settled(item: Item, status: number, answer: unknown) {
    item.attempt += 1;
    safely(() => options.onSend?.(item.event, { status, attempt: item.attempt }));
    if (retryable(status) && item.attempt < maxAttempts) {
      waiting += 1;
      const delay = Math.min(backoffMs * 2 ** (item.attempt - 1), 60_000);
      setTimeout(() => {
        waiting -= 1;
        queue.push(item);
        pump(true);
      }, delay).unref?.();
      return;
    }
    const said = (answer ?? {}) as { dropped?: string; error?: string };
    if (status === 202 && (!said.dropped || quietDrop.test(said.dropped))) return;
    const error =
      answer instanceof Error
        ? answer
        : new Error(
            status === 202
              ? `Seolyticize dropped the event: ${said.dropped}.`
              : `Seolyticize answered HTTP ${status} after ${item.attempt} attempts${said.error ? `: ${said.error}` : "."}`,
          );
    safely(() => options.onError?.(error, item.event));
  }

  /** Sends full batches, and a partial one when now is set (the timer, flush or a retry). */
  function pump(now = false) {
    while (active < concurrency && queue.length >= (now ? 1 : batchSize)) {
      const batch = queue.splice(0, batchSize);
      active += 1;
      sending += batch.length;
      void post(batch)
        .then((results) =>
          batch.forEach((item, index) =>
            settled(item, results[index]!.status, results[index]!.answer),
          ),
        )
        .catch((error) =>
          batch.forEach((item) => safely(() => options.onError?.(error, item.event))),
        )
        .finally(() => {
          active -= 1;
          sending -= batch.length;
          // While someone awaits flush(), the rest goes now rather than on the timer.
          pump(idle.length > 0);
          settle();
        });
    }
    if (queue.length > 0 && timer === null) {
      timer = setTimeout(() => {
        timer = null;
        pump(true);
      }, flushMs);
      timer.unref?.();
    }
  }

  function enqueue(event: QueuedEvent) {
    if (queue.length + sending + waiting >= maxQueue) {
      safely(() =>
        options.onError?.(new Error("Seolyticize queue is full; event dropped."), event),
      );
      return;
    }
    const body = bodyOf(event);
    // null: nothing to send (a bot, an excluded path), which is not a failure.
    if (!body) return;
    queue.push({ event, body, attempt: 0 });
    flushOnExit(client.flush);
    pump();
  }

  /** False when this event name and orderId were already sent from this process. */
  function firstOrder(name: string, props: Props | undefined): boolean {
    const id = props?.orderId;
    // A refund may come in parts; the server caps them at the order's value.
    if (id === undefined || name === "Refund") return true;
    const key = `${name}\u0000${String(id)}`;
    if (orders.has(key)) return false;
    orders.add(key);
    // Bounded: the oldest ids go first; the server keeps the long memory.
    if (orders.size > 10_000) orders.delete(orders.values().next().value!);
    return true;
  }

  const client: Seolyticize = {
    track(name, props, opts = {}) {
      safely(() => {
        if (!firstOrder(name, props)) return;
        if (opts.visit) {
          enqueue({
            kind: "later",
            event: { visit: opts.visit, name, props, url: opts.visitor?.url },
          });
        } else if (opts.visitor) {
          const view = asView(opts.visitor, opts.consented !== false);
          enqueue({ kind: "event", view: { ...view, name, props } });
        } else {
          options.onError?.(
            new Error(`"${name}" needs a visit token or the visitor; it was not sent.`),
            { kind: "event", view: { url: "", name, props } },
          );
        }
      });
    },
    trackPurchase(purchase, opts) {
      let props: Props;
      try {
        const value =
          purchase.amountMinor !== undefined
            ? majorUnits(purchase.amountMinor, purchase.currency)
            : purchase.value;
        props = {
          ...purchase.props,
          orderId: purchase.orderId,
          currency: purchase.currency.toUpperCase(),
        };
        if (value !== undefined) props.value = value;
      } catch (error) {
        // An unknown currency code: Intl throws a RangeError.
        const view = { url: "", name: "Purchase" };
        safely(() => options.onError?.(error, { kind: "event", view }));
        return;
      }
      client.track("Purchase", props, opts);
    },
    trackLater(name, props, opts) {
      client.track(name, props, opts);
    },
    pageview(view) {
      safely(() => enqueue({ kind: "pageview", view }));
    },
    async trackForVisit(name, props, visitor) {
      return direct.trackForVisit({ ...visitor, name, props });
    },
    async urlsChanged({ changed = [], removed = [] }) {
      if (!options.apiKey || !options.clientId) {
        throw new Error("urlsChanged needs apiKey (with spend:incur) and clientId.");
      }
      const urls = [...new Set([...changed, ...removed])];
      if (urls.length === 0) return null;
      const api = createClient({
        apiKey: options.apiKey,
        client: CLIENT,
        ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
        ...(options.transport ? { fetch: options.transport } : {}),
      });
      // IndexNow has no "removed": the engines re-fetch each URL and see its 404 or 410.
      return api.call("submit_indexnow", { clientId: options.clientId, urls });
    },
    flush() {
      return new Promise((resolve) => {
        idle.push(resolve);
        pump(true);
        settle();
      });
    },
    get pending() {
      return queue.length + sending + waiting;
    },
  };
  return client;
}

function safely(fn: () => void) {
  try {
    fn();
  } catch {
    // A hook that throws must not take the caller's request down with it.
  }
}

/**
 * A transport that answers 202 and keeps every event sent, so tests read what
 * would have gone to Seolyticize instead of mocking fetch. reply() picks
 * another status per event, e.g. to test retries.
 */
export function testTransport(
  reply: (body: Record<string, unknown>) => number = () => 202,
): typeof fetch & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const one = (body: Record<string, unknown>) => {
    const status = reply(body);
    if (status === 202) events.push(body);
    return status;
  };
  const send = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
    if (Array.isArray(body)) {
      const results = (body as Array<Record<string, unknown>>).map((item) => ({
        status: one(item),
      }));
      return new Response(JSON.stringify({ results }), { status: 202 });
    }
    const status = one(body as Record<string, unknown>);
    return new Response(status === 202 ? JSON.stringify({ visit: "v1.test" }) : null, {
      status,
    });
  };
  return Object.assign(send as typeof fetch, { events });
}

/** The visitor as sent: without address and user agent when there is no consent. */
const asView = (visitor: Visitor, consented: boolean): PageView =>
  consented
    ? visitor
    : { url: visitor.url, referrer: visitor.referrer, country: visitor.country };

/** The parts of a Node request both adapters read. */
export type NodeRequestLike = {
  url?: string | undefined;
  originalUrl?: string | undefined;
  protocol?: string | undefined;
  ip?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | undefined;
};

/** Node's header object as standard Headers. */
export function headersFrom(raw: NodeRequestLike["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined)
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/** The visitor behind a Node (Express, Fastify, http) request. */
export function visitorFrom(req: NodeRequestLike, trustProxy = true): Visitor {
  const headers = headersFrom(req.headers);
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost")
    .split(",")[0]!
    .trim();
  const scheme =
    headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? req.protocol ?? "https";
  return {
    url: `${scheme}://${host}${req.originalUrl ?? req.url ?? "/"}`,
    userAgent: headers.get("user-agent") || null,
    ip:
      (trustProxy ? addressFrom(headers) : undefined) ??
      req.ip ??
      req.socket?.remoteAddress,
    referrer: headers.get("referer"),
    country: headers.get("cf-ipcountry"),
    clientHints: headers.get("sec-ch-ua"),
    signatureAgent: headers.get("signature-agent"),
  };
}

/** What req.seo is: track() with the request's visitor and consent filled in. */
export type RequestSeo = {
  track(name: string, props?: Props, options?: { visit?: string | null }): void;
  trackForVisit(name: string, props?: Props): Promise<string | null>;
  /**
   * Queues this request as a page view. An AI assistant is reported in full
   * (it reads for somebody and never sees a banner); a person's address and
   * user agent only with consent.
   */
  pageview(): void;
};

/**
 * req.seo for one request. consent is asked at each call, not up front, so a
 * consent cookie parsed by a later hook still counts; one that throws is a no.
 */
export function forRequest(
  client: Seolyticize,
  visitor: Visitor,
  consent: (() => boolean) | undefined,
): RequestSeo {
  const consented = () => {
    try {
      return consent ? consent() === true : true;
    } catch {
      return false;
    }
  };
  return {
    track: (name, props, opts = {}) =>
      client.track(name, props, { visit: opts.visit, visitor, consented: consented() }),
    trackForVisit: (name, props) =>
      client.trackForVisit(name, props, asView(visitor, consented())),
    pageview: () => {
      const agent =
        classifyAgent(visitor.userAgent ?? "", visitor.signatureAgent) === "agent";
      client.pageview(asView(visitor, agent || consented()));
    },
  };
}

/** Options both adapters take, Req being the framework's request. */
export type AdapterOptions<Req> = NodeOptions & {
  /** Whether this request's visitor agreed to statistics; without it, address and user agent stay home. Default: always. */
  consent?: (req: Req) => boolean;
  /** False when no proxy in front sets X-Forwarded-For and friends. */
  trustProxy?: boolean;
  /** Report page views (AI agents only with only: "agents"). Default true. */
  pageviews?: boolean;
};
