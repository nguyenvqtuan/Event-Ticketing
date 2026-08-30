import { InvariantViolation } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { Event } from './event.js';
import { Seat } from './seat.js';

const OPENS = new Date('2026-01-01T00:00:00.000Z');
const CLOSES = new Date('2026-06-01T00:00:00.000Z');
const STARTS = new Date('2026-06-01T19:00:00.000Z');

const schedule = (overrides: Partial<Parameters<typeof Event.schedule>[0]> = {}) =>
  Event.schedule({
    id: 'evt-1',
    name: 'Cup Final',
    startsAt: STARTS,
    salesOpenAt: OPENS,
    salesCloseAt: CLOSES,
    ...overrides,
  });

describe('Event', () => {
  it('requires a name', () => {
    expect(() => schedule({ name: '  ' })).toThrow(InvariantViolation);
  });

  it('requires sales to close after they open', () => {
    expect(() => schedule({ salesCloseAt: OPENS })).toThrow(/close after they open/);
  });

  it('refuses to sell tickets after the event has begun', () => {
    expect(() => schedule({ salesCloseAt: new Date(STARTS.getTime() + 1) })).toThrow(
      /no later than the event start/,
    );
  });

  describe('sales window', () => {
    it('is closed before it opens', () => {
      expect(schedule().isOnSale(new Date(OPENS.getTime() - 1))).toBe(false);
    });

    it('is open at the opening instant', () => {
      expect(schedule().isOnSale(OPENS)).toBe(true);
    });

    it('is closed at the closing instant — the window is half-open', () => {
      expect(schedule().isOnSale(CLOSES)).toBe(false);
    });
  });
});

describe('Seat', () => {
  const price = Money.of(5_000, 'GBP');

  it('requires a code', () => {
    expect(() => Seat.create({ id: 's1', eventId: 'evt-1', code: ' ', price })).toThrow(
      InvariantViolation,
    );
  });

  it('rejects a negative price', () => {
    expect(() =>
      Seat.create({ id: 's1', eventId: 'evt-1', code: 'A12', price: Money.of(-1, 'GBP') }),
    ).toThrow(/cannot be negative/);
  });

  it('carries no status — availability is derived from active claims', () => {
    const seat = Seat.create({ id: 's1', eventId: 'evt-1', code: 'A12', price });

    expect(seat).not.toHaveProperty('status');
  });
});
