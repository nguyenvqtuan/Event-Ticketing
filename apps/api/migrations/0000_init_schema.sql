CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"sales_open_at" timestamp with time zone NOT NULL,
	"sales_close_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_sales_window" CHECK ("events"."sales_close_at" > "events"."sales_open_at"),
	CONSTRAINT "events_sales_close_before_start" CHECK ("events"."sales_close_at" <= "events"."starts_at"),
	CONSTRAINT "events_name_not_blank" CHECK (length(btrim("events"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_type_valid" CHECK ("ledger_accounts"."type" IN ('ASSET','LIABILITY','REVENUE','EXPENSE','EQUITY'))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_direction_valid" CHECK ("ledger_entries"."direction" IN ('DEBIT','CREDIT')),
	CONSTRAINT "ledger_entries_amount_positive" CHECK ("ledger_entries"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"currency" char(3) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"seat_code" text NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "order_lines_price_non_negative" CHECK ("order_lines"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"failure_reason" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_state_valid" CHECK ("orders"."state" IN ('PENDING','PAID','FAILED','REFUNDED')),
	CONSTRAINT "orders_total_non_negative" CHECK ("orders"."total_minor" >= 0),
	CONSTRAINT "orders_failure_reason_iff_failed" CHECK (("orders"."state" = 'FAILED') = ("orders"."failure_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"succeeded" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"claim_state" text DEFAULT 'HELD' NOT NULL,
	"valid_during" "tstzrange" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_items_claim_state_valid" CHECK ("reservation_items"."claim_state" IN ('HELD','SOLD','RELEASED'))
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"holder_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_state_valid" CHECK ("reservations"."state" IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "reservations_ttl_positive" CHECK ("reservations"."expires_at" > "reservations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"code" text NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seats_price_non_negative" CHECK ("seats"."price_minor" >= 0),
	CONSTRAINT "seats_code_not_blank" CHECK (length(btrim("seats"."code")) > 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_items" ADD CONSTRAINT "reservation_items_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_items" ADD CONSTRAINT "reservation_items_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_on_sale_idx" ON "events" USING btree ("sales_open_at","sales_close_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_name_uq" ON "ledger_accounts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_reference_idx" ON "ledger_transactions" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_order_seat_uq" ON "order_lines" USING btree ("order_id","seat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reservation_uq" ON "orders" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "processed_events_kind_idx" ON "processed_events" USING btree ("kind","processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_items_reservation_seat_uq" ON "reservation_items" USING btree ("reservation_id","seat_id");--> statement-breakpoint
CREATE INDEX "reservation_items_seat_idx" ON "reservation_items" USING btree ("seat_id");--> statement-breakpoint
CREATE INDEX "reservations_pending_expiry_idx" ON "reservations" USING btree ("expires_at") WHERE state = 'PENDING';--> statement-breakpoint
CREATE INDEX "reservations_holder_idx" ON "reservations" USING btree ("holder_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seats_event_code_uq" ON "seats" USING btree ("event_id","code");