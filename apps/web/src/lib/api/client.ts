import {
  CORRELATION_HEADER,
  type ApiErrorBody,
  type CancelReservationResponse,
  type ConfirmReservationResponse,
  type CreateEventRequest,
  type CreateEventResponse,
  type CreateReservationRequest,
  type EventResponse,
  type ListSeatsQuery,
  type PayRequest,
  type PayResponse,
  type RefundResponse,
  type ReservationDetailResponse,
  type ReservationResponse,
  type SeatPageResponse,
  IDEMPOTENCY_HEADER,
} from '@repo/contracts';
import { apiBaseUrl } from './config';
import { NetworkError, toApiError } from './errors';

/**
 * The typed client for the API.
 *
 * Every method's return type comes from `@repo/contracts`, which the API's
 * controllers are annotated with — so these are not this app's *guess* at the
 * response shape, they are the shape the API is compiled against. Change a
 * controller and `apps/api` stops building; the drift never reaches here.
 *
 * `fetch` is injected rather than reached for, so tests drive it without a
 * network or a running API, and a caller can pass Next's instrumented fetch to
 * get caching and revalidation.
 */

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Generates the correlation id sent with each request. Overridable so a
   * caller already inside a traced request can continue that trace rather than
   * starting a new one.
   */
  correlationId?: () => string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Required by the paying and refunding endpoints. */
  idempotencyKey?: string;
  /** Passed through to Next's fetch for caching; ignored elsewhere. */
  next?: { revalidate?: number | false; tags?: string[] };
  signal?: AbortSignal;
}

function newCorrelationId(): string {
  // Available in every browser this targets and in Node 19+; the fallback is
  // for the rare insecure context, where `crypto.randomUUID` is not exposed.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export class ApiClient {
  private readonly configuredBaseUrl: string | undefined;
  private readonly doFetch: typeof globalThis.fetch | undefined;
  private readonly correlationId: () => string;

  constructor(options: ApiClientOptions = {}) {
    this.configuredBaseUrl = options.baseUrl;
    this.doFetch = options.fetch;
    this.correlationId = options.correlationId ?? newCorrelationId;
  }

  /**
   * Resolved per request, not in the constructor. Constructing the default
   * client must have no side effects: `apiBaseUrl()` throws when unconfigured
   * in production, and doing that at module scope would fail the Next build
   * itself rather than the one page that actually needs the API.
   *
   * `fetch` is read late for the same reason — Next replaces the global with
   * its instrumented version, and capturing it at construction can win the
   * race and lose caching.
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL((this.configuredBaseUrl ?? apiBaseUrl()) + path);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    // Generated per request, not per client: one id per action is what makes a
    // server log line traceable back to the click that caused it.
    const correlationId = this.correlationId();

    const headers: Record<string, string> = { [CORRELATION_HEADER]: correlationId };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;

    let response: Response;
    try {
      response = await (this.doFetch ?? globalThis.fetch)(url.toString(), {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        ...(options.next ? { next: options.next } : {}),
      } as RequestInit);
    } catch (cause) {
      // No response at all. Distinct from a 5xx because the request may still
      // have been processed — which is why retrying a payment needs the same
      // idempotency key.
      throw new NetworkError(
        cause instanceof Error ? cause.message : 'The request could not be sent',
        correlationId,
        cause,
      );
    }

    // Prefer the id the SERVER logged under. It equals the one sent, unless a
    // proxy rewrote it — in which case the server's is the one worth showing.
    const echoed = response.headers.get(CORRELATION_HEADER) ?? correlationId;

    if (!response.ok) {
      throw toApiError(response.status, await readJson<ApiErrorBody>(response), echoed);
    }

    // 204, or any empty body: there is nothing to parse and callers type it as
    // void rather than being handed `null` typed as `T`.
    if (response.status === 204) return undefined as T;

    const parsed = await readJson<T>(response);
    return parsed as T;
  }

  // ---- Events ---------------------------------------------------------------

  createEvent(body: CreateEventRequest, idempotencyKey?: string): Promise<CreateEventResponse> {
    return this.request('/events', { method: 'POST', body, idempotencyKey });
  }

  getEvent(
    eventId: string,
    options?: Pick<RequestOptions, 'next' | 'signal'>,
  ): Promise<EventResponse> {
    return this.request(`/events/${encodeURIComponent(eventId)}`, options);
  }

  listSeats(
    eventId: string,
    query: ListSeatsQuery = {},
    options?: Pick<RequestOptions, 'next' | 'signal'>,
  ): Promise<SeatPageResponse> {
    return this.request(`/events/${encodeURIComponent(eventId)}/seats`, {
      ...options,
      query: { status: query.status, limit: query.limit, offset: query.offset },
    });
  }

  // ---- Reservations ---------------------------------------------------------

  holdSeats(body: CreateReservationRequest, idempotencyKey?: string): Promise<ReservationResponse> {
    return this.request('/reservations', { method: 'POST', body, idempotencyKey });
  }

  getReservation(reservationId: string): Promise<ReservationDetailResponse> {
    return this.request(`/reservations/${encodeURIComponent(reservationId)}`);
  }

  confirmReservation(reservationId: string): Promise<ConfirmReservationResponse> {
    return this.request(`/reservations/${encodeURIComponent(reservationId)}/confirm`, {
      method: 'POST',
    });
  }

  cancelReservation(reservationId: string): Promise<CancelReservationResponse> {
    return this.request(`/reservations/${encodeURIComponent(reservationId)}/cancel`, {
      method: 'POST',
    });
  }

  // ---- Payment --------------------------------------------------------------

  /**
   * The key is REQUIRED, so it is a required parameter rather than an option a
   * caller can forget. One key per checkout attempt, reused across retries of
   * that attempt — that is what makes a retry safe.
   */
  pay(reservationId: string, body: PayRequest, idempotencyKey: string): Promise<PayResponse> {
    return this.request(`/reservations/${encodeURIComponent(reservationId)}/pay`, {
      method: 'POST',
      body,
      idempotencyKey,
    });
  }

  refund(orderId: string, idempotencyKey: string): Promise<RefundResponse> {
    return this.request(`/orders/${encodeURIComponent(orderId)}/refund`, {
      method: 'POST',
      idempotencyKey,
    });
  }
}

/** Tolerates a non-JSON body — an error page from a proxy, say — without throwing. */
async function readJson<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/**
 * The default client, configured from the environment.
 *
 * Safe at module scope because nothing is resolved until a request is made.
 */
export const api = new ApiClient();
