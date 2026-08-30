import { Controller, HttpCode, HttpStatus, Param, Post, UseInterceptors } from '@nestjs/common';
import { type RefundResponse } from '@repo/contracts';
import { z } from 'zod';
import { RequireIdempotencyKey } from '../../shared/infrastructure/idempotency/idempotency.decorator.js';
import { IdempotencyInterceptor } from '../../shared/infrastructure/idempotency/idempotency.interceptor.js';
import { ZodValidationPipe } from '../../shared/interface/zod-validation.pipe.js';
import { RefundOrderUseCase } from '../application/refund-order.use-case.js';

const orderIdSchema = z.uuid('must be a UUID');

@Controller('orders')
export class OrdersController {
  constructor(private readonly refundOrder: RefundOrderUseCase) {}

  /**
   * Refunds a paid order by posting reversing entries.
   *
   * Idempotent for the same reason paying is: a client retrying after a
   * timeout cannot know whether the refund went through, and refunding twice
   * moves real money. Note the two protections are different — the key stops a
   * RETRY re-running, while the order's state machine stops a genuine SECOND
   * refund even under a fresh key.
   */
  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  @RequireIdempotencyKey()
  @UseInterceptors(IdempotencyInterceptor)
  async refund(
    @Param('id', new ZodValidationPipe(orderIdSchema)) id: string,
  ): Promise<RefundResponse> {
    const result = await this.refundOrder.execute(id, new Date());

    return {
      orderId: result.orderId,
      state: result.state,
      seatIds: result.seatIds,
      refunded: {
        amountMinor: result.refunded.amountMinor,
        currency: result.refunded.currency,
      },
    };
  }
}
