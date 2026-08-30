import { CORRELATION_HEADER, IDEMPOTENCY_HEADER } from '@repo/contracts';
import { ApiClient } from './client';
import {
  ConflictError,
  NetworkError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from './errors';

/**
 * The client is driven with a stub `fetch`: no network, no running API.
 *
 * What is worth asserting here is everything the client DECIDES — which header
 * it sends, which error class a status maps to, what it does with a body that
 * is not JSON. The response shapes themselves are not re-asserted, because
 * they come from `@repo/contracts` and the API is compiled against them; a
 * test restating them here would only check that this file agrees with itself.
 */

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` that records what it was asked for and answers as instructed. */
function stubFetch(response: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  text?: string;
}) {
  const calls: Call[] = [];

  const fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const status = response.status ?? 200;
    const body =
      response.text ?? (response.body === undefined ? '' : JSON.stringify(response.body));

    return Promise.resolve(new Response(body, { status, headers: { ...response.headers } }));
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

const client = (fetch: typeof globalThis.fetch, correlationId = () => 'fixed-id') =>
  new ApiClient({ baseUrl: 'http://api.test', fetch, correlationId });

const headersOf = (call: Call) => call.init.headers as Record<string, string>;

describe('ApiClient', () => {
  describe('correlation id', () => {
    it('sends one on every request', async () => {
      const { fetch, calls } = stubFetch({ body: { id: 'e1' } });

      await client(fetch).getEvent('e1');

      expect(headersOf(calls[0]!)[CORRELATION_HEADER]).toBe('fixed-id');
    });

    it('generates a NEW one per request, not one per client', async () => {
      let n = 0;
      const { fetch, calls } = stubFetch({ body: {} });
      const api = client(fetch, () => `id-${++n}`);

      await api.getEvent('a');
      await api.getEvent('b');

      expect(headersOf(calls[0]!)[CORRELATION_HEADER]).toBe('id-1');
      expect(headersOf(calls[1]!)[CORRELATION_HEADER]).toBe('id-2');
    });

    it('reports the id the SERVER echoed, which is what its logs are keyed by', async () => {
      const { fetch } = stubFetch({
        status: 500,
        body: { message: 'boom' },
        // A proxy replaced ours on the way through.
        headers: { [CORRELATION_HEADER]: 'server-side-id' },
      });

      await expect(client(fetch).getEvent('e1')).rejects.toMatchObject({
        correlationId: 'server-side-id',
      });
    });
  });

  describe('requests', () => {
    it('builds a query string, omitting absent parameters', async () => {
      const { fetch, calls } = stubFetch({ body: { seats: [], pagination: {} } });

      await client(fetch).listSeats('e1', { status: 'AVAILABLE', limit: 10 });

      expect(calls[0]!.url).toBe('http://api.test/events/e1/seats?status=AVAILABLE&limit=10');
    });

    it('encodes ids into the path', async () => {
      const { fetch, calls } = stubFetch({ body: {} });

      await client(fetch).getEvent('a/../b');

      expect(calls[0]!.url).toBe('http://api.test/events/a%2F..%2Fb');
    });

    it('sends the idempotency key the paying endpoint requires', async () => {
      const { fetch, calls } = stubFetch({ body: { orderId: 'o1' } });

      await client(fetch).pay('r1', { amountMinor: 100, currency: 'GBP' }, 'key-1');

      expect(headersOf(calls[0]!)[IDEMPOTENCY_HEADER]).toBe('key-1');
      expect(calls[0]!.init.body).toBe('{"amountMinor":100,"currency":"GBP"}');
    });

    it('sends no content-type when there is no body', async () => {
      const { fetch, calls } = stubFetch({ body: {} });

      await client(fetch).cancelReservation('r1');

      expect(headersOf(calls[0]!)['content-type']).toBeUndefined();
    });
  });

  describe('error mapping', () => {
    it('maps 400 with field errors to ValidationError', async () => {
      const { fetch } = stubFetch({
        status: 400,
        body: {
          message: 'Validation failed',
          errors: [{ field: 'name', message: 'is required' }],
        },
      });

      const error = await client(fetch)
        .createEvent({} as never)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.kind).toBe('validation');
      expect(validation.byField()).toEqual({ name: 'is required' });
    });

    it('maps 409 with seat ids to ConflictError, carrying which seats went', async () => {
      const { fetch } = stubFetch({
        status: 409,
        body: {
          statusCode: 409,
          error: 'SeatsUnavailable',
          message: 'Cannot hold seats',
          unavailableSeatIds: ['s1'],
          missingSeatIds: [],
        },
      });

      const error = (await client(fetch)
        .holdSeats({ eventId: 'e', holderId: 'h', seatIds: ['s1'] })
        .catch((e: unknown) => e)) as ConflictError;

      expect(error).toBeInstanceOf(ConflictError);
      expect(error.unavailableSeatIds).toEqual(['s1']);
    });

    it('maps a 409 that carries no seat ids without inventing any', async () => {
      // Sales closed, or a hold that is no longer PENDING — same status, no ids.
      const { fetch } = stubFetch({
        status: 409,
        body: { statusCode: 409, error: 'SalesClosed', message: 'not on sale' },
      });

      const error = (await client(fetch)
        .confirmReservation('r1')
        .catch((e: unknown) => e)) as ConflictError;

      expect(error).toBeInstanceOf(ConflictError);
      expect(error.unavailableSeatIds).toEqual([]);
      expect(error.message).toBe('not on sale');
    });

    it('maps 404 and 422 to their own types', async () => {
      const notFound = stubFetch({ status: 404, body: { message: 'gone' } });
      await expect(client(notFound.fetch).getEvent('e1')).rejects.toBeInstanceOf(NotFoundError);

      const unprocessable = stubFetch({ status: 422, body: { message: 'wrong amount' } });
      await expect(
        client(unprocessable.fetch).pay('r1', { amountMinor: 1, currency: 'GBP' }, 'k'),
      ).rejects.toBeInstanceOf(UnprocessableError);
    });

    it('surfaces a transport failure as NetworkError, not a server error', async () => {
      const fetch = (() =>
        Promise.reject(new Error('offline'))) as unknown as typeof globalThis.fetch;

      const error = (await client(fetch)
        .getEvent('e1')
        .catch((e: unknown) => e)) as NetworkError;

      // The distinction matters: a request that never got an answer may still
      // have been processed, so retrying a payment needs the same key.
      expect(error).toBeInstanceOf(NetworkError);
      expect(error.status).toBeNull();
    });

    it('does not choke on an error body that is not JSON', async () => {
      // A proxy's HTML error page, which is what a 502 usually looks like.
      const { fetch } = stubFetch({ status: 502, text: '<html>Bad Gateway</html>' });

      const error = (await client(fetch)
        .getEvent('e1')
        .catch((e: unknown) => e)) as Error & {
        status: number;
      };

      expect(error.status).toBe(502);
      expect(error.message).toBe('Request failed with status 502');
    });
  });
});
