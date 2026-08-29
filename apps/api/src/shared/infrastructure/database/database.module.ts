import { AsyncLocalStorage } from 'node:async_hooks';
import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppConfigService } from '../../../config/app-config.service.js';
import {
  type TransactionRunner,
  TRANSACTION_RUNNER,
} from '../../domain/transaction-runner.port.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Holds the connection pool and, when inside a transaction, the transaction
 * handle for the current async context.
 *
 * Repositories call `db` and get whichever is correct without being told.
 * The alternative — threading a transaction handle through every repository
 * method — leaks a persistence detail into the application layer's signatures.
 */
@Injectable()
export class DatabaseContext implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseContext.name);
  private readonly pool: Pool;
  private readonly root: Database;
  /** Empty outside a transaction; holds the tx handle inside one. */
  readonly storage = new AsyncLocalStorage<Database>();

  constructor(config: AppConfigService) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

    // Without a listener, an idle client dropped by the server surfaces as an
    // unhandled exception and takes the process down.
    this.pool.on('error', (error) => {
      this.logger.warn(`Idle Postgres client error: ${error.message}`);
    });

    this.root = drizzle(this.pool, { schema });
  }

  /** The transaction for this async context, or the pool when there is none. */
  get db(): Database {
    return this.storage.getStore() ?? this.root;
  }

  get rootDb(): Database {
    return this.root;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Injectable()
class DrizzleTransactionRunner implements TransactionRunner {
  constructor(private readonly context: DatabaseContext) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    // Already inside a transaction: join it rather than opening a nested one,
    // so an inner failure still rolls the whole thing back.
    if (this.context.storage.getStore()) {
      return work();
    }

    // READ COMMITTED, stated explicitly rather than inherited as the default.
    // It suffices because the hold path takes `FOR UPDATE` on the seat rows:
    // once the lock is granted the waiter re-reads the newest committed row,
    // so it observes the winner's claim. REPEATABLE READ would instead abort
    // the waiter with a serialization failure needing an application retry,
    // buying nothing the row lock does not already provide.
    // See docs/concurrency.md.
    return this.context.rootDb.transaction(
      async (tx) => this.context.storage.run(tx as Database, work),
      { isolationLevel: 'read committed' },
    );
  }
}

@Global()
@Module({
  providers: [DatabaseContext, { provide: TRANSACTION_RUNNER, useClass: DrizzleTransactionRunner }],
  exports: [DatabaseContext, TRANSACTION_RUNNER],
})
export class DatabaseModule {}
