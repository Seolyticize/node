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

/** The parts of an Express (or Connect, or Node http) request this reads. */
export type ExpressRequestLike = NodeRequestLike & { method?: string; seo?: RequestSeo };
type ExpressResponseLike = {
  statusCode: number;
  on(event: "finish", listener: () => void): unknown;
};

/**
 * Express middleware: req.seo is the client with this request's visitor and
 * consent filled in, successful page responses are reported (only AI
 * assistants with only: "agents"), and the middleware's .seo is the client
 * itself, for webhooks and jobs.
 *
 *   const seo = seolyticize({ siteKey, serverKey, only: "agents" });
 *   app.use(seo);
 *   seo.seo.trackLater("First listing", { userId }, { visit });
 */
export default function seolyticize<Req extends ExpressRequestLike = ExpressRequestLike>(
  options: AdapterOptions<Req>,
): ((req: Req, res: ExpressResponseLike, next: () => void) => void) & {
  seo: Seolyticize;
} {
  const client = createSeolyticize(options);
  const trustProxy = options.trustProxy !== false;
  const middleware = (req: Req, res: ExpressResponseLike, next: () => void) => {
    const consent = options.consent;
    const seo = forRequest(
      client,
      visitorFrom(req, trustProxy),
      consent && (() => consent(req)),
    );
    req.seo = seo;
    if (
      options.pageviews !== false &&
      isPageRequest(req.method ?? "GET", headersFrom(req.headers))
    ) {
      res.on("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) seo.pageview();
      });
    }
    next();
  };
  return Object.assign(middleware, { seo: client });
}
