import { InvalidStateTransition, InvariantViolation } from '../../shared/domain/domain-error.js';
import { Reservation } from './reservation.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const TTL = 900; // 15 minutes
const AFTER_TTL = new Date(NOW.getTime() + TTL * 1_000);

const open = (overrides: Partial<Parameters<typeof Reservation.open>[0]> = {}) =>
  Reservation.open({
    id: 'res-1',
    eventId: 'evt-1',
    holderId: 'user-1',
    seatIds: ['seat-1', 'seat-2'],
    now: NOW,
    ttlSeconds: TTL,
    ...overrides,
  });

describe('Reservation', () => {
  describe('opening', () => {
    it('starts PENDING and holds its seats', () => {
      const reservation = open();

      expect(reservation.state).toBe('PENDING');
      expect(reservation.holdsSeats).toBe(true);
      expect(reservation.seatIds).toEqual(['seat-1', 'seat-2']);
    });

    it('expires exactly ttlSeconds after creation', () => {
      expect(open().expiresAt).toEqual(AFTER_TTL);
    });

    it('rejects a reservation with no seats', () => {
      expect(() => open({ seatIds: [] })).toThrow(InvariantViolation);
    });

    it('rejects the same seat twice', () => {
      expect(() => open({ seatIds: ['seat-1', 'seat-1'] })).toThrow(/same seat twice/);
    });

    it('rejects a non-positive TTL', () => {
      expect(() => open({ ttlSeconds: 0 })).toThrow(InvariantViolation);
    });

    it('copies the seat list, so later mutation of the caller array cannot alter it', () => {
      const seatIds = ['seat-1'];
      const reservation = open({ seatIds });

      seatIds.push('seat-smuggled');

      expect(reservation.seatIds).toEqual(['seat-1']);
    });
  });

  describe('expiry', () => {
    it('is not expired before the TTL elapses', () => {
      expect(open().isExpired(new Date(AFTER_TTL.getTime() - 1))).toBe(false);
    });

    it('is expired once the TTL elapses, even before anything marks it so', () => {
      const reservation = open();

      expect(reservation.isExpired(AFTER_TTL)).toBe(true);
      expect(reservation.state).toBe('PENDING'); // no sweeper has run
    });

    it('refuses to expire early — that would release seats a user still holds', () => {
      const reservation = open();

      expect(() => reservation.expire(NOW)).toThrow(InvalidStateTransition);
      expect(reservation.state).toBe('PENDING');
    });

    it('records PENDING → EXPIRED once the TTL has genuinely lapsed', () => {
      const reservation = open();
      reservation.expire(AFTER_TTL);

      expect(reservation.state).toBe('EXPIRED');
      expect(reservation.holdsSeats).toBe(false);
    });
  });

  describe('confirmation', () => {
    it('moves PENDING → CONFIRMED within the TTL', () => {
      const reservation = open();
      reservation.confirm(NOW);

      expect(reservation.state).toBe('CONFIRMED');
    });

    it('refuses to confirm after the TTL, even if nothing marked it expired', () => {
      const reservation = open();

      expect(() => reservation.confirm(AFTER_TTL)).toThrow(/expired/);
      expect(reservation.state).toBe('PENDING');
    });

    it('refuses to confirm twice', () => {
      const reservation = open();
      reservation.confirm(NOW);

      expect(() => reservation.confirm(NOW)).toThrow(InvalidStateTransition);
    });

    it('refuses to confirm a cancelled reservation', () => {
      const reservation = open();
      reservation.cancel();

      expect(() => reservation.confirm(NOW)).toThrow(/CANCELLED/);
    });
  });

  describe('cancellation', () => {
    it('moves PENDING → CANCELLED and releases the seats', () => {
      const reservation = open();
      reservation.cancel();

      expect(reservation.state).toBe('CANCELLED');
      expect(reservation.holdsSeats).toBe(false);
    });

    it('refuses to cancel a confirmed reservation', () => {
      const reservation = open();
      reservation.confirm(NOW);

      expect(() => reservation.cancel()).toThrow(InvalidStateTransition);
    });
  });

  describe('terminal states are terminal', () => {
    it.each(['CONFIRMED', 'CANCELLED', 'EXPIRED'] as const)(
      'allows no transition out of %s',
      (target) => {
        const reservation = open();

        if (target === 'CONFIRMED') reservation.confirm(NOW);
        if (target === 'CANCELLED') reservation.cancel();
        if (target === 'EXPIRED') reservation.expire(AFTER_TTL);

        expect(reservation.state).toBe(target);
        expect(() => reservation.confirm(NOW)).toThrow(InvalidStateTransition);
        expect(() => reservation.cancel()).toThrow(InvalidStateTransition);
        expect(() => reservation.expire(AFTER_TTL)).toThrow(InvalidStateTransition);
      },
    );
  });
});
