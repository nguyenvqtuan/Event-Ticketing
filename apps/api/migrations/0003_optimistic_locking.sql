ALTER TABLE "orders" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;