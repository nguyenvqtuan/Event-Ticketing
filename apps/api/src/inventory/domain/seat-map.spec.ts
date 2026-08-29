import { InvariantViolation } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { MAX_SEATS_PER_EVENT, generateSeatMap, rowLabel } from './seat-map.js';

const price = Money.of(5_000, 'GBP');
const spec = (rows: number, seatsPerRow: number) => ({ rows, seatsPerRow, price });

describe('rowLabel', () => {
  it.each([
    [1, 'A'],
    [26, 'Z'],
    [27, 'AA'],
    [28, 'AB'],
    [52, 'AZ'],
    [53, 'BA'],
    [702, 'ZZ'],
    [703, 'AAA'],
  ])('maps row %i to %s', (index, expected) => {
    expect(rowLabel(index)).toBe(expected);
  });

  it('rejects a non-positive row', () => {
    expect(() => rowLabel(0)).toThrow(InvariantViolation);
  });
});

describe('generateSeatMap', () => {
  it('generates rows × seatsPerRow seats', () => {
    expect(generateSeatMap(spec(3, 10))).toHaveLength(30);
  });

  it('numbers seats from 1 within each row', () => {
    const seats = generateSeatMap(spec(2, 3));

    expect(seats.map((s) => s.code)).toEqual(['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  });

  it('zero-pads seat numbers so codes sort naturally, not A1/A10/A2', () => {
    const codes = generateSeatMap(spec(1, 12)).map((s) => s.code);

    expect(codes.slice(0, 3)).toEqual(['A01', 'A02', 'A03']);
    // Sorting the codes as strings must give the same order they were built in
    // — this is exactly what the seats endpoint does in SQL.
    expect([...codes].sort()).toEqual(codes);
  });

  it('pads only as wide as needed', () => {
    expect(generateSeatMap(spec(1, 9))[0]!.code).toBe('A1');
    expect(generateSeatMap(spec(1, 10))[0]!.code).toBe('A01');
    expect(generateSeatMap(spec(1, 100))[0]!.code).toBe('A001');
  });

  it('gives every seat the same price', () => {
    const seats = generateSeatMap(spec(2, 2));

    expect(seats.every((s) => s.price.equals(price))).toBe(true);
  });

  it('produces codes unique within the map — what makes re-generation idempotent', () => {
    const seats = generateSeatMap(spec(40, 30)); // crosses the Z→AA boundary
    const codes = new Set(seats.map((s) => s.code));

    expect(codes.size).toBe(seats.length);
  });

  it('is deterministic — the same spec yields the same codes in the same order', () => {
    expect(generateSeatMap(spec(5, 5))).toEqual(generateSeatMap(spec(5, 5)));
  });

  describe('rejects specs it cannot honour', () => {
    it.each([
      ['zero rows', 0, 10],
      ['negative rows', -1, 10],
      ['fractional rows', 1.5, 10],
      ['zero seats per row', 10, 0],
      ['fractional seats per row', 10, 2.5],
    ])('%s', (_label, rows, seatsPerRow) => {
      expect(() => generateSeatMap(spec(rows, seatsPerRow))).toThrow(InvariantViolation);
    });

    it('a negative price', () => {
      expect(() =>
        generateSeatMap({ rows: 1, seatsPerRow: 1, price: Money.of(-1, 'GBP') }),
      ).toThrow(/cannot be negative/);
    });

    it('a map larger than the cap, which would hold locks for too long', () => {
      expect(() => generateSeatMap(spec(1000, 51))).toThrow(
        new RegExp(String(MAX_SEATS_PER_EVENT)),
      );
    });

    it('but allows a map exactly at the cap', () => {
      expect(generateSeatMap(spec(1000, 50))).toHaveLength(MAX_SEATS_PER_EVENT);
    });
  });
});
