import {
  createSeolyticize,
  forRequest,
  headersFrom,
  isPageRequest,
  visitorFrom,
  type AdapterOptions,
  type NodeRequestLike,
  type RequestSeo,
  type Seolyticize,
} from "./index.js";

export type { RequestSeo, Seolyticize } from "./index.js";
export { testTransport } from "./index.js";

/** The parts of a Fastify request this reads. */
export type FastifyRequestLike = NodeRequestLike & {
  method: string;
  seo?: RequestSeo | null;
};

/** The parts of a Fastify instance this uses. */
export type FastifyLike = {
  decorate(name: "seo", value: Seolyticize): unknown;
  decorateRequest(name: "seo", value: null): unknown;
  addHook(name: "onRequest", hook: (req: FastifyRequestLike) => Promise<void>): unknown;
  addHook(
    name: "onResponse",
    hook: (req: FastifyRequestLike, reply: { statusCode: number }) => Promise<void>,
  ): unknown;
  addHook(name: "onClose", hook: () => Promise<void>): unknown;
};

/**
 * The Fastify plugin: app.seo is the client, req.seo the same with this
 * request's visitor and consent filled in, and successful page responses are
 * reported (only AI assistants with only: "agents"). The queue is flushed when
 * the app closes.
 *
 *   await app.register(seolyticize, { siteKey, serverKey, only: "agents" });
 *   req.seo.track("Purchase", { value: 42, currency: "USD", orderId }, { visit });
 */
async function seolyticize<Req extends FastifyRequestLike = FastifyRequestLike>(
  app: FastifyLike,
  options: AdapterOptions<Req>,
): Promise<void> {
  const client = createSeolyticize(options);
  const trustProxy = options.trustProxy !== false;
  app.decorate("seo", client);
  app.decorateRequest("seo", null);
  app.addHook("onRequest", async (req) => {
    const consent = options.consent;
    req.seo = forRequest(
      client,
      visitorFrom(req, trustProxy),
      consent && (() => consent(req as Req)),
    );
  });
  if (options.pageviews !== false) {
    app.addHook("onResponse", async (req, reply) => {
      if (reply.statusCode < 200 || reply.statusCode >= 300) return;
      if (isPageRequest(req.method, headersFrom(req.headers))) req.seo?.pageview();
    });
  }
  app.addHook("onClose", () => client.flush());
}

// What fastify-plugin sets: the decorations reach the whole app, not one encapsulated scope.
Object.assign(seolyticize, {
  [Symbol.for("skip-override")]: true,
  [Symbol.for("fastify.display-name")]: "@seolyticize/node",
});

export default seolyticize;
