import {
  ConcurrentModification,
  DomainError,
  InvalidStateTransition,
  InvariantViolation,
} from './domain-error.js';

/**
 * These carry the mapping to HTTP status codes on their *type*, so the
 * interface layer can switch on the class rather than parse a message. That
 * makes their identity part of the contract, and worth a test.
 */
describe('DomainError', () => {
  it.each([
    ['InvalidStateTransition', new InvalidStateTransition('nope')],
    ['InvariantViolation', new InvariantViolation('nope')],
    ['ConcurrentModification', new ConcurrentModification('Reservation', 'res-1')],
  ])('%s is a DomainError that names itself', (name, error) => {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    // `name` follows the subclass rather than staying 'Error', so a log line
    // says which rule was broken without anyone setting it per class.
    expect(error.name).toBe(name);
  });

  it('distinguishes the subclasses, which is how the filter picks a status', () => {
    expect(new InvariantViolation('x')).not.toBeInstanceOf(InvalidStateTransition);
  });

  describe('ConcurrentModification', () => {
    it('names the aggregate and id, and says what to do about it', () => {
      const error = new ConcurrentModification('Reservation', 'res-1');

      expect(error.aggregate).toBe('Reservation');
      expect(error.id).toBe('res-1');
      expect(error.message).toMatch(/Reservation res-1 was modified concurrently/);
      expect(error.message).toMatch(/re-read it and retry/);
    });
  });
});
