import { validateEnv } from './env.schema.js';

const VALID_DB_URL = 'postgresql://postgres:postgres@localhost:5432/event_ticketing';

describe('validateEnv', () => {
  describe('required values', () => {
    it('rejects a missing DATABASE_URL', () => {
      expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    });

    it('names the offending variable in the message', () => {
      // The whole point of failing fast is that the operator can see *what*
      // is wrong without reading the source.
      expect(() => validateEnv({})).toThrow(/Invalid environment configuration/);
    });

    it('rejects a DATABASE_URL that is not a postgres connection string', () => {
      expect(() => validateEnv({ DATABASE_URL: 'mysql://localhost:3306/db' })).toThrow(/postgres/);
    });

    it('accepts both postgres:// and postgresql:// schemes', () => {
      expect(validateEnv({ DATABASE_URL: 'postgres://localhost:5432/db' })).toBeDefined();
      expect(validateEnv({ DATABASE_URL: 'postgresql://localhost:5432/db' })).toBeDefined();
    });
  });

  describe('defaults', () => {
    it('applies sensible local defaults when only the required vars are set', () => {
      const env = validateEnv({ DATABASE_URL: VALID_DB_URL });

      expect(env).toMatchObject({
        NODE_ENV: 'development',
        PORT: 3000,
        LOG_LEVEL: 'log',
        RESERVATION_TTL_SECONDS: 900,
        CORS_ORIGIN: 'http://localhost:3001',
      });
    });
  });

  describe('coercion and bounds', () => {
    it('coerces numeric strings, since env vars are always strings', () => {
      const env = validateEnv({
        DATABASE_URL: VALID_DB_URL,
        PORT: '8080',
        RESERVATION_TTL_SECONDS: '60',
      });

      expect(env.PORT).toBe(8080);
      expect(env.RESERVATION_TTL_SECONDS).toBe(60);
    });

    it('rejects a port outside the valid range', () => {
      expect(() => validateEnv({ DATABASE_URL: VALID_DB_URL, PORT: '70000' })).toThrow(/PORT/);
    });

    it('rejects a non-numeric port rather than coercing it to NaN', () => {
      expect(() => validateEnv({ DATABASE_URL: VALID_DB_URL, PORT: 'not-a-port' })).toThrow(/PORT/);
    });

    it('rejects a non-positive reservation TTL', () => {
      expect(() =>
        validateEnv({ DATABASE_URL: VALID_DB_URL, RESERVATION_TTL_SECONDS: '0' }),
      ).toThrow(/RESERVATION_TTL_SECONDS/);
    });

    it('rejects an unknown log level', () => {
      expect(() => validateEnv({ DATABASE_URL: VALID_DB_URL, LOG_LEVEL: 'chatty' })).toThrow(
        /LOG_LEVEL/,
      );
    });
  });

  it('reports every problem at once, not just the first', () => {
    try {
      validateEnv({ PORT: '70000', LOG_LEVEL: 'chatty' });
      fail('expected validateEnv to throw');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toMatch(/DATABASE_URL/);
      expect(message).toMatch(/PORT/);
      expect(message).toMatch(/LOG_LEVEL/);
    }
  });
});
