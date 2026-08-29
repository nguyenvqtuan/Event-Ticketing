import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { z } from 'zod';
import { RequireIdempotencyKey } from '../../shared/infrastructure/idempotency/idempotency.decorator.js';
import { IdempotencyInterceptor } from '../../shared/infrastructure/idempotency/idempotency.interceptor.js';
import { ZodValidationPipe } from '../../shared/interface/zod-validation.pipe.js';
import { CheckoutUseCase } from '../application/checkout.use-case.js';

const reservationIdSchema = z.uuid('must be a UUID');

/**
 * What the client believes it is paying. Checked against the order the domain
 * builds from current seat prices, so a stale client is rejected rather than
 * silently charged a different amount. It is also the payload the idempotency
 * key is hashed over.
 */
const paySchema = z.object({
  amountMinor: z.int().nonnegative(),
  currency: z.string().length(3).toUpperCase(),
});

type PayDto = z.infer<typeof paySchema>;

/**
 * Payment lives in the Payment context even though the URL is reservation-
 * shaped: the operation is a sale, and Payment is what owns orders and the
 * ledger.
 */
@Controller('reservations')
export class PaymentsController {
  constructor(private readonly checkout: CheckoutUseCase) {}

  /**
   * Pays for a held reservation. The Idempotency-Key header is REQUIRED: a
   * client retrying after a timeout cannot know whether the first attempt
   * charged, so the key is the only thing preventing a double charge.
   */
  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @RequireIdempotencyKey()
  @UseInterceptors(IdempotencyInterceptor)
  async pay(
    @Param('id', new ZodValidationPipe(reservationIdSchema)) id: string,
    @Body(new ZodValidationPipe(paySchema)) dto: PayDto,
  ) {
    const result = await this.checkout.execute({
      reservationId: id,
      amountMinor: dto.amountMinor,
      currency: dto.currency,
      now: new Date(),
    });

    return {
      orderId: result.orderId,
      reservationId: result.reservationId,
      state: result.state,
      seatIds: result.seatIds,
      paid: {
        amountMinor: result.total.amountMinor,
        currency: result.total.currency,
      },
    };
  }
}
