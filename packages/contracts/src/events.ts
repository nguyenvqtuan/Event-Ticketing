/** Requests and responses for the Inventory context's event endpoints. */

/**
 * An ISO-8601 instant, as it appears **on the wire**.
 *
 * The API works in `Date` internally and the client parses back to `Date` at
 * the edge; in between it is a string, and saying so is the whole point of
 * this package. A shared type claiming `Date` would be a lie on both sides —
 * JSON has no date type — and `JSON.parse` would hand the client a string
 * typed as a `Date`, which fails at the first `.getTime()`.
 */
export type IsoDateTime = string;

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD';

/** What `GET /events/:id/seats` accepts. `ALL` applies no filter. */
export type SeatStatusFilter = SeatStatus | 'ALL';

/** POST /events */
export interface CreateEventRequest {
  readonly name: string;
  readonly startsAt: IsoDateTime;
  readonly salesOpenAt: IsoDateTime;
  readonly salesCloseAt: IsoDateTime;
  readonly seatMap: {
    readonly rows: number;
    readonly seatsPerRow: number;
  };
  readonly priceMinor: number;
  /** ISO-4217, three letters. Upper-cased by the API. */
  readonly currency: string;
}

export interface CreateEventResponse {
  readonly id: string;
  readonly seatsCreated: number;
  readonly totalSeats: number;
}

/** Counts of the three derived availability states. */
export interface SeatCounts {
  readonly total: number;
  readonly available: number;
  readonly held: number;
  readonly sold: number;
}

/** GET /events/:id */
export interface EventResponse {
  readonly id: string;
  readonly name: string;
  readonly startsAt: IsoDateTime;
  readonly salesOpenAt: IsoDateTime;
  readonly salesCloseAt: IsoDateTime;
  /** Computed against the server's clock, not the client's. */
  readonly onSale: boolean;
  readonly seats: SeatCounts;
}

export interface Seat {
  readonly id: string;
  /** Human-facing label: a row letter then a number, e.g. `A12`. */
  readonly code: string;
  readonly priceMinor: number;
  readonly currency: string;
  /**
   * Derived server-side from live claims, at one instant. Present whatever the
   * filter was, so a map drawn with `status=ALL` colours each seat from the
   * same read rather than stitching three requests together.
   */
  readonly status: SeatStatus;
}

/** GET /events/:id/seats */
export interface ListSeatsQuery {
  /** Defaults to `AVAILABLE` server-side. Pass `ALL` to draw a seat map. */
  readonly status?: SeatStatusFilter;
  /** 1–500. Defaults to 100 server-side. */
  readonly limit?: number;
  readonly offset?: number;
}

export interface SeatPageResponse {
  readonly seats: readonly Seat[];
  readonly pagination: {
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  };
}

/** GET /events — the collection, soonest first. */
export interface ListEventsQuery {
  /** 1–100. Defaults to 20 server-side. */
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * An event as the list page needs it.
 *
 * No seat counts: aggregating them per row would be one aggregate per event on
 * the page. `GET /events/:id` carries them for the one event a user opens.
 */
export interface EventSummary {
  readonly id: string;
  readonly name: string;
  readonly startsAt: IsoDateTime;
  readonly salesOpenAt: IsoDateTime;
  readonly salesCloseAt: IsoDateTime;
  readonly onSale: boolean;
}

export interface EventListResponse {
  readonly events: readonly EventSummary[];
  readonly pagination: {
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  };
}
