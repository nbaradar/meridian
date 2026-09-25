CREATE TABLE "ledger"."ynab_account_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label_digest" text NOT NULL,
	"digest_key_id" text NOT NULL,
	"decision" text NOT NULL,
	"account_source_id" uuid,
	"supersedes_decision_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ynab_account_decisions_decision_check" CHECK ("ledger"."ynab_account_decisions"."decision" in ('tracked', 'excluded')),
	CONSTRAINT "ynab_account_decisions_source_check" CHECK (("ledger"."ynab_account_decisions"."decision" = 'tracked') = ("ledger"."ynab_account_decisions"."account_source_id" is not null)),
	CONSTRAINT "ynab_account_decisions_digest_check" CHECK ("ledger"."ynab_account_decisions"."label_digest" ~ '^[0-9a-f]{64}$' and length(btrim("ledger"."ynab_account_decisions"."digest_key_id")) > 0),
	CONSTRAINT "ynab_account_decisions_not_self_check" CHECK ("ledger"."ynab_account_decisions"."supersedes_decision_id" is null or "ledger"."ynab_account_decisions"."supersedes_decision_id" <> "ledger"."ynab_account_decisions"."id")
);
--> statement-breakpoint
ALTER TABLE "ledger"."ynab_account_decisions" ADD CONSTRAINT "ynab_account_decisions_source_fk" FOREIGN KEY ("account_source_id") REFERENCES "ledger"."account_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."ynab_account_decisions" ADD CONSTRAINT "ynab_account_decisions_predecessor_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "ledger"."ynab_account_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ynab_account_decisions_supersedes_unique" ON "ledger"."ynab_account_decisions" USING btree ("supersedes_decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ynab_account_decisions_root_unique" ON "ledger"."ynab_account_decisions" USING btree ("digest_key_id","label_digest") WHERE "ledger"."ynab_account_decisions"."supersedes_decision_id" is null;--> statement-breakpoint
CREATE INDEX "ynab_account_decisions_source_idx" ON "ledger"."ynab_account_decisions" USING btree ("account_source_id");
--> statement-breakpoint
-- RFC 0005: serialize decisions per recognized YNAB account name. Callers take
-- this lock first in each transaction, before any account-source lock.
CREATE FUNCTION "ledger"."lock_ynab_account_label"(digest_key_id text, label_digest text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('ledger.ynab_account_label:' || digest_key_id || ':' || label_digest, 0));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_ynab_account_decision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	previous_decision "ledger"."ynab_account_decisions"%ROWTYPE;
	account_source_name text;
BEGIN
	PERFORM ledger.lock_ynab_account_label(NEW.digest_key_id, NEW.label_digest);

	IF NEW.decision = 'tracked' THEN
		SELECT source INTO account_source_name
		FROM ledger.account_sources
		WHERE id = NEW.account_source_id;
		IF account_source_name IS NULL THEN
			RAISE EXCEPTION USING
				ERRCODE = '23503',
				CONSTRAINT = 'ynab_account_decisions_source_reference_check',
				MESSAGE = 'a tracked YNAB decision must reference a recorded account source';
		END IF;
		IF account_source_name <> 'ynab' THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'ynab_account_decisions_source_kind_check',
				MESSAGE = 'a tracked YNAB decision must reference a YNAB account source';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM ledger.current_account_source_links
			WHERE account_source_id = NEW.account_source_id
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'ynab_account_decisions_source_linked_check',
				MESSAGE = 'a tracked YNAB decision must reference a currently linked account source';
		END IF;
	END IF;

	IF NEW.supersedes_decision_id IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT * INTO previous_decision
	FROM ledger.ynab_account_decisions
	WHERE id = NEW.supersedes_decision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			CONSTRAINT = 'ynab_account_decisions_predecessor_reference_check',
			MESSAGE = 'the predecessor YNAB decision does not exist';
	END IF;
	IF previous_decision.digest_key_id <> NEW.digest_key_id
		OR previous_decision.label_digest <> NEW.label_digest THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'ynab_account_decisions_identity_check',
			MESSAGE = 'a YNAB decision revision must retain its label digest';
	END IF;
	IF previous_decision.decision <> 'excluded' OR NEW.decision <> 'tracked' THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'ynab_account_decisions_transition_check',
			MESSAGE = 'only an excluded YNAB account may be re-decided, and only as tracked';
	END IF;
	IF NEW.recorded_at < previous_decision.recorded_at THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'ynab_account_decisions_recorded_at_check',
			MESSAGE = 'a YNAB decision revision cannot predate its predecessor';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ynab_account_decisions_validate"
BEFORE INSERT ON "ledger"."ynab_account_decisions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_ynab_account_decision"();
--> statement-breakpoint
CREATE TRIGGER "ynab_account_decisions_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."ynab_account_decisions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."ynab_account_decisions" ENABLE ALWAYS TRIGGER "ynab_account_decisions_reject_mutation";
--> statement-breakpoint
CREATE TRIGGER "ynab_account_decisions_reject_truncate"
BEFORE TRUNCATE ON "ledger"."ynab_account_decisions"
FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."ynab_account_decisions" ENABLE ALWAYS TRIGGER "ynab_account_decisions_reject_truncate";
--> statement-breakpoint
CREATE VIEW "ledger"."current_ynab_account_decisions"
WITH (security_invoker = true)
AS
SELECT decision.id, decision.digest_key_id, decision.label_digest,
	decision.decision, decision.account_source_id, decision.recorded_at
FROM ledger.ynab_account_decisions decision
WHERE NOT EXISTS (
	SELECT 1 FROM ledger.ynab_account_decisions successor
	WHERE successor.supersedes_decision_id = decision.id
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION "ledger"."lock_ynab_account_label"(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_ynab_account_decision"() FROM PUBLIC;
REVOKE ALL ON TABLE "ledger"."ynab_account_decisions", "ledger"."current_ynab_account_decisions" FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "ledger"."lock_ynab_account_label"(text, text) TO "meridian_app";
GRANT SELECT ON "ledger"."ynab_account_decisions", "ledger"."current_ynab_account_decisions" TO "meridian_app";
GRANT INSERT (id, label_digest, digest_key_id, decision, account_source_id, supersedes_decision_id)
	ON "ledger"."ynab_account_decisions" TO "meridian_app";
