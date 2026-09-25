ALTER TABLE "ledger"."transactions" ALTER COLUMN "occurred_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger"."transactions" ADD COLUMN "occurred_on" date NOT NULL;