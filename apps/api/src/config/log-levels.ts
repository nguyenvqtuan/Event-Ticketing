import { type LogLevel } from '@nestjs/common';
import { type Env } from './env.schema.js';

/**
 * Maps a configured level onto the levels Nest should actually emit.
 * Nest takes an explicit list rather than a threshold, so each entry is
 * cumulative: `warn` also emits `error`.
 */
export const LOG_LEVELS: Record<Env['LOG_LEVEL'], LogLevel[]> = {
  error: ['error'],
  warn: ['error', 'warn'],
  log: ['error', 'warn', 'log'],
  debug: ['error', 'warn', 'log', 'debug'],
  verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
};
