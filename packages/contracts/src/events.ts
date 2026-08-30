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
  /** Human-facing label, e.g. `A-12`. */
  readonly code: string;
  readonly priceMinor: number;
  readonly currency: string;
}

/** GET /events/:id/seats */
export interface ListSeatsQuery {
  readonly status?: SeatStatus;
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
