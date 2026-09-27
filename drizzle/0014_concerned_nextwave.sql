-- RFC 0008: retire Plan 0001's transaction-authority windows and
-- reconciliation checks, superseded before any use. Refuse to run if either
-- table holds a row, so no ledger row is ever deleted.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "ledger"."transaction_authority_revisions")
		OR EXISTS (SELECT 1 FROM "ledger"."reconciliation_checks") THEN
		RAISE EXCEPTION 'retiring RFC 0004 authority objects requires both tables to be empty';
	END IF;
END;
$$;
--> statement-breakpoint
DROP VIEW "ledger"."current_transaction_authority_windows";
--> statement-breakpoint
DROP TABLE "ledger"."transaction_authority_revisions";
--> statement-breakpoint
DROP TABLE "ledger"."reconciliation_checks";
--> statement-breakpoint
DROP FUNCTION "ledger"."validate_transaction_authority_revision"();
DROP FUNCTION "ledger"."validate_reconciliation_check"();
DROP FUNCTION "ledger"."lock_authority_window"(uuid);
DROP FUNCTION "ledger"."lock_authority_account"(uuid);
