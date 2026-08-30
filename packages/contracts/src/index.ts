/**
 * The HTTP contract between the API and its clients.
 *
 * One definition, imported by both sides, so the web app cannot drift from
 * what the API returns without the build noticing. The API's controllers are
 * annotated with the response types here, which is what makes that true —
 * change a controller's shape and `tsc` fails in `apps/api` at build time,
 * rather than a browser reading `undefined` at runtime.
 *
 * Almost entirely types, which erase to nothing. The exceptions are the two
 * header names below: they are as much part of the wire contract as any field,
 * and a client that spells one of them differently fails silently — the header
 * is simply ignored, which looks like the feature was never built.
 *
 * **Validation is deliberately NOT shared.** The API validates with Zod
 * because a server must never trust a client, and shipping those schemas here
 * would invite the assumption that a client-side check is load-bearing. What
 * keeps the two honest instead is `apps/api/src/contract.spec.ts`, which parses
 * samples of the request types below through the real schemas.
 *
 * The wire format is what these describe: instants are ISO strings, not
 * `Date`, because that is what crosses a network. See `IsoDateTime`.
 */
export * from './errors.js';
export * from './events.js';
export * from './payments.js';
export * from './reservations.js';

/**
 * Read by the API on the way in and echoed on every response, so one id spans
 * a browser action and the server logs it produced.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Required by the paying and refunding endpoints; absent means 400. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
