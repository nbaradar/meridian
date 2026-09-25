ALTER TABLE "ledger"."accounts" DROP CONSTRAINT "accounts_kind_check";--> statement-breakpoint
ALTER TABLE "ledger"."accounts" ADD COLUMN "type" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_class_check" CHECK ("ledger"."accounts"."kind" in ('asset', 'liability'));--> statement-breakpoint
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_type_check" CHECK ("ledger"."accounts"."type" in ('checking', 'savings', 'cash', 'credit_card', 'loan', 'mortgage', 'brokerage', 'retirement', 'crypto', 'other'));--> statement-breakpoint
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_type_class_check" CHECK ((
        ("ledger"."accounts"."type" in ('checking', 'savings', 'cash', 'brokerage', 'retirement', 'crypto') and "ledger"."accounts"."kind" = 'asset')
        or ("ledger"."accounts"."type" in ('credit_card', 'loan', 'mortgage') and "ledger"."accounts"."kind" = 'liability')
        or "ledger"."accounts"."type" = 'other'
      ));--> statement-breakpoint
DROP VIEW "ledger"."current_accounts";--> statement-breakpoint
CREATE VIEW "ledger"."current_accounts"
WITH (security_invoker = true)
AS
SELECT
	account.id,
	account.kind AS class,
	account.type,
	account.currency,
	account.opened_on,
	revision.name,
	revision.status,
	revision.display_metadata,
	revision.effective_at AS revision_effective_at,
	revision.recorded_at AS revision_recorded_at
FROM "ledger"."accounts" account
LEFT JOIN LATERAL (
	SELECT *
	FROM "ledger"."account_revisions"
	WHERE account_id = account.id AND effective_at <= now()
	ORDER BY effective_at DESC, recorded_at DESC, id DESC
	LIMIT 1
) revision ON true;--> statement-breakpoint
GRANT SELECT ON TABLE "ledger"."current_accounts" TO "meridian_app";
