DROP VIEW "ledger"."current_accounts";--> statement-breakpoint
ALTER TABLE "ledger"."accounts" DROP COLUMN "opened_at";--> statement-breakpoint
CREATE VIEW "ledger"."current_accounts"
WITH (security_invoker = true)
AS
SELECT
	account.id,
	account.kind,
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
