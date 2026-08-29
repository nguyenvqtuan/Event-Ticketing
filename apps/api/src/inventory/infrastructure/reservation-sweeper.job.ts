import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExpireReservationsUseCase } from '../application/expire-reservations.use-case.js';

/**
 * Periodic sweep of lapsed holds.
 *
 * Infrastructure: it owns the schedule and nothing else. All behaviour lives
 * in the use case, which is why the sweep can be tested without waiting for a
 * cron tick.
 *
 * @Cron fires on EVERY replica — there is no leader election here. That is
 * safe because the claim uses `FOR UPDATE SKIP LOCKED`, so concurrent
 * sweepers take disjoint batches rather than colliding. Adding an advisory
 * lock to elect a single sweeper would remove that parallelism for no gain.
 */
@Injectable()
export class ReservationSweeper {
  private readonly logger = new Logger(ReservationSweeper.name);
  /** Guards against a slow sweep overlapping itself on the same instance. */
  private running = false;

  constructor(private readonly expireReservations: ExpireReservationsUseCase) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'expire-reservations' })
  async sweep(): Promise<void> {
    if (this.running) {
      this.logger.debug('Previous sweep still running; skipping this tick');
      return;
    }

    this.running = true;
    try {
      const expired = await this.expireReservations.execute();

      if (expired > 0) {
        this.logger.log(`Expired ${expired} lapsed reservation(s)`);
      }
    } catch (error) {
      // Never let a failed sweep take the process down. Seats are already
      // free by then — this job is bookkeeping, so losing a tick is harmless.
      this.logger.error(`Sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
