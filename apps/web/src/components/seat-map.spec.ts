import { type Seat } from '@repo/contracts';
import { splitCode, toRows } from './seat-map';

/**
 * The grouping is the only real logic in the seat map, and it is pure — so it
 * is tested directly rather than through a rendered DOM. The rendering itself
 * gets a harness when TICK-F3 gives it behaviour worth asserting.
 */
const seat = (code: string, status: Seat['status'] = 'AVAILABLE'): Seat => ({
  id: `id-${code}`,
  code,
  priceMinor: 5000,
  currency: 'GBP',
  status,
});

describe('splitCode', () => {
  it('splits a code into its row letters and seat number', () => {
    expect(splitCode('A12')).toEqual({ row: 'A', number: 12 });
    expect(splitCode('AA3')).toEqual({ row: 'AA', number: 3 });
  });

  it('degrades rather than throwing on a code it does not recognise', () => {
    // A map that renders one seat oddly beats a page that will not render.
    expect(splitCode('weird')).toEqual({ row: '?', number: 0 });
  });
});

describe('toRows', () => {
  it('groups seats by row and orders each row by seat number', () => {
    // Deliberately out of order, and 10 before 2 in string terms.
    const rows = toRows([seat('B2'), seat('A10'), seat('A2'), seat('B1')]);

    expect(rows.map((r) => [r.row, r.seats.map((s) => s.code)])).toEqual([
      ['A', ['A2', 'A10']],
      ['B', ['B1', 'B2']],
    ]);
  });

  it('puts AA after Z, not after A', () => {
    // The domain wraps row labels at Z → AA, so a plain lexicographic sort
    // would file AA between A and B and scramble a venue with 27+ rows.
    const rows = toRows([seat('AA1'), seat('B1'), seat('Z1'), seat('A1')]);

    expect(rows.map((r) => r.row)).toEqual(['A', 'B', 'Z', 'AA']);
  });

  it('keeps every seat whatever its status', () => {
    const rows = toRows([seat('A1', 'SOLD'), seat('A2', 'HELD'), seat('A3')]);

    // The map draws all three states; filtering here would silently shrink it.
    expect(rows[0]!.seats.map((s) => s.status)).toEqual(['SOLD', 'HELD', 'AVAILABLE']);
  });

  it('returns nothing for no seats', () => {
    expect(toRows([])).toEqual([]);
  });
});
