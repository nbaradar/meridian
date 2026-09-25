CREATE TABLE "ledger"."reconciliation_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"account_source_id" uuid NOT NULL,
	"cutoff_on" date NOT NULL,
	"observation_starts_on" date NOT NULL,
	"observation_ends_on" date NOT NULL,
	"ledger_balance" numeric NOT NULL,
	"provider_balance" numeric NOT NULL,
	"currency" char(3) NOT NULL,
	"balance_semantic" text NOT NULL,
	"difference" numeric NOT NULL,
	"tolerance" numeric,
	"result" text NOT NULL,
	"raw_payload_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_checks_currency_check" CHECK ("ledger"."reconciliation_checks"."currency" = 'USD'),
	CONSTRAINT "reconciliation_checks_observation_check" CHECK ("ledger"."reconciliation_checks"."observation_ends_on" > "ledger"."reconciliation_checks"."observation_starts_on"),
	CONSTRAINT "reconciliation_checks_semantic_check" CHECK ("ledger"."reconciliation_checks"."balance_semantic" in ('current', 'available', 'posted_only', 'includes_pending', 'unknown')),
	CONSTRAINT "reconciliation_checks_difference_check" CHECK ("ledger"."reconciliation_checks"."difference" = "ledger"."reconciliation_checks"."provider_balance" - "ledger"."reconciliation_checks"."ledger_balance"),
	CONSTRAINT "reconciliation_checks_tolerance_check" CHECK ("ledger"."reconciliation_checks"."tolerance" is null or ("ledger"."reconciliation_checks"."tolerance" >= 0 and "ledger"."reconciliation_checks"."balance_semantic" <> 'unknown')),
	CONSTRAINT "reconciliation_checks_result_check" CHECK (("ledger"."reconciliation_checks"."result" = 'passed' and "ledger"."reconciliation_checks"."tolerance" is not null and abs("ledger"."reconciliation_checks"."difference") <= "ledger"."reconciliation_checks"."tolerance")
        or ("ledger"."reconciliation_checks"."result" = 'failed' and "ledger"."reconciliation_checks"."tolerance" is not null and abs("ledger"."reconciliation_checks"."difference") > "ledger"."reconciliation_checks"."tolerance")
        or ("ledger"."reconciliation_checks"."result" = 'not_comparable' and "ledger"."reconciliation_checks"."tolerance" is null))
);
--> statement-breakpoint
CREATE TABLE "ledger"."transaction_authority_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"authority_window_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"account_source_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"status" text NOT NULL,
	"supersedes_revision_id" uuid,
	"reason_code" text NOT NULL,
	"reconciliation_check_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_authority_range_check" CHECK ("ledger"."transaction_authority_revisions"."ends_on" is null or "ledger"."transaction_authority_revisions"."ends_on" > "ledger"."transaction_authority_revisions"."starts_on"),
	CONSTRAINT "transaction_authority_status_check" CHECK ("ledger"."transaction_authority_revisions"."status" in ('proposed', 'active', 'revoked')),
	CONSTRAINT "transaction_authority_reason_check" CHECK (("ledger"."transaction_authority_revisions"."status" = 'proposed' and "ledger"."transaction_authority_revisions"."reason_code" = 'window_proposed')
        or ("ledger"."transaction_authority_revisions"."status" = 'active' and "ledger"."transaction_authority_revisions"."reason_code" = 'window_activated')
        or ("ledger"."transaction_authority_revisions"."status" = 'revoked' and "ledger"."transaction_authority_revisions"."reason_code" in ('owner_revoked', 'schedule_replaced'))),
	CONSTRAINT "transaction_authority_root_check" CHECK (("ledger"."transaction_authority_revisions"."supersedes_revision_id" is null) = ("ledger"."transaction_authority_revisions"."status" = 'proposed')),
	CONSTRAINT "transaction_authority_check_status_check" CHECK ("ledger"."transaction_authority_revisions"."reconciliation_check_id" is null or "ledger"."transaction_authority_revisions"."status" = 'active'),
	CONSTRAINT "transaction_authority_not_self_check" CHECK ("ledger"."transaction_authority_revisions"."supersedes_revision_id" is null or "ledger"."transaction_authority_revisions"."supersedes_revision_id" <> "ledger"."transaction_authority_revisions"."id")
);
--> statement-breakpoint
ALTER TABLE "ledger"."reconciliation_checks" ADD CONSTRAINT "reconciliation_checks_account_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."reconciliation_checks" ADD CONSTRAINT "reconciliation_checks_source_fk" FOREIGN KEY ("account_source_id") REFERENCES "ledger"."account_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."reconciliation_checks" ADD CONSTRAINT "reconciliation_checks_raw_payload_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "ledger"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transaction_authority_revisions" ADD CONSTRAINT "transaction_authority_account_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transaction_authority_revisions" ADD CONSTRAINT "transaction_authority_source_fk" FOREIGN KEY ("account_source_id") REFERENCES "ledger"."account_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transaction_authority_revisions" ADD CONSTRAINT "transaction_authority_predecessor_fk" FOREIGN KEY ("supersedes_revision_id") REFERENCES "ledger"."transaction_authority_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transaction_authority_revisions" ADD CONSTRAINT "transaction_authority_check_fk" FOREIGN KEY ("reconciliation_check_id") REFERENCES "ledger"."reconciliation_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_checks_account_idx" ON "ledger"."reconciliation_checks" USING btree ("account_id","account_source_id","cutoff_on");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_authority_supersedes_unique" ON "ledger"."transaction_authority_revisions" USING btree ("supersedes_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_authority_root_unique" ON "ledger"."transaction_authority_revisions" USING btree ("authority_window_id") WHERE "ledger"."transaction_authority_revisions"."supersedes_revision_id" is null;--> statement-breakpoint
CREATE INDEX "transaction_authority_account_idx" ON "ledger"."transaction_authority_revisions" USING btree ("account_id","starts_on");
--> statement-breakpoint
-- RFC 0004 lock order for authority decisions: authority window, then
-- canonical account, then account source (the lock RFC 0002 link revisions
-- take). Each decision locks at most one identity per domain, so the domain
-- order is the whole global order.
CREATE FUNCTION "ledger"."lock_authority_window"(authority_window_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('ledger.authority_window:' || authority_window_id::text, 0));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."lock_authority_account"(account_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('ledger.authority_account:' || account_id::text, 0));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_reconciliation_check"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ledger
AS $$
DECLARE
	account_currency char(3);
BEGIN
	PERFORM ledger.lock_authority_account(NEW.account_id);
	PERFORM ledger.lock_account_source(NEW.account_source_id);

	SELECT currency INTO account_currency
	FROM ledger.accounts
	WHERE id = NEW.account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			CONSTRAINT = 'reconciliation_checks_account_reference_check',
			MESSAGE = 'a reconciliation check must reference a recorded account';
	END IF;
	IF account_currency <> NEW.currency THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'reconciliation_checks_account_currency_check',
			MESSAGE = 'a reconciliation check must use its account''s currency';
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM ledger.current_account_source_links
		WHERE account_source_id = NEW.account_source_id
			AND account_id = NEW.account_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'reconciliation_checks_source_linked_check',
			MESSAGE = 'a reconciliation check must reference a source currently linked to its account';
	END IF;

	-- The ledger side is always computed here; a caller cannot supply it.
	-- Entries dated on the cutoff belong to the new source's window.
	SELECT coalesce(sum(entry.amount), 0) INTO NEW.ledger_balance
	FROM ledger.entries entry
	JOIN ledger.transactions txn ON txn.id = entry.transaction_id
	WHERE entry.account_id = NEW.account_id
		AND txn.occurred_on < NEW.cutoff_on;
	NEW.difference := NEW.provider_balance - NEW.ledger_balance;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_transaction_authority_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ledger
AS $$
DECLARE
	predecessor ledger.transaction_authority_revisions%ROWTYPE;
	source_kind_name text;
	evidence ledger.reconciliation_checks%ROWTYPE;
BEGIN
	PERFORM ledger.lock_authority_window(NEW.authority_window_id);
	PERFORM ledger.lock_authority_account(NEW.account_id);
	PERFORM ledger.lock_account_source(NEW.account_source_id);

	SELECT source_kind INTO source_kind_name
	FROM ledger.account_sources
	WHERE id = NEW.account_source_id;
	IF source_kind_name IS NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			CONSTRAINT = 'transaction_authority_source_reference_check',
			MESSAGE = 'an authority revision must reference a recorded account source';
	END IF;

	IF NEW.supersedes_revision_id IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT * INTO predecessor
	FROM ledger.transaction_authority_revisions
	WHERE id = NEW.supersedes_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			CONSTRAINT = 'transaction_authority_predecessor_reference_check',
			MESSAGE = 'the superseded authority revision does not exist';
	END IF;
	IF predecessor.authority_window_id <> NEW.authority_window_id
		OR predecessor.account_id <> NEW.account_id
		OR predecessor.account_source_id <> NEW.account_source_id
		OR predecessor.starts_on <> NEW.starts_on
		OR predecessor.ends_on IS DISTINCT FROM NEW.ends_on THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transaction_authority_identity_check',
			MESSAGE = 'an authority revision must retain its window, account, source, and range';
	END IF;
	IF EXISTS (
		SELECT 1 FROM ledger.transaction_authority_revisions
		WHERE supersedes_revision_id = predecessor.id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transaction_authority_tip_check',
			MESSAGE = 'the superseded authority revision is not the current tip';
	END IF;
	IF NOT (
		(predecessor.status = 'proposed' AND NEW.status IN ('active', 'revoked'))
		OR (predecessor.status = 'active' AND NEW.status = 'revoked')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transaction_authority_transition_check',
			MESSAGE = format('an authority window cannot go from %s to %s', predecessor.status, NEW.status);
	END IF;
	IF NEW.recorded_at < predecessor.recorded_at THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transaction_authority_recorded_at_check',
			MESSAGE = 'an authority revision cannot predate its predecessor';
	END IF;

	IF NEW.status <> 'active' THEN
		RETURN NEW;
	END IF;

	-- Activation proves the exact current RFC 0002 link under the source lock
	-- that relinks also take.
	IF NOT EXISTS (
		SELECT 1 FROM ledger.current_account_source_links
		WHERE account_source_id = NEW.account_source_id
			AND account_id = NEW.account_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transaction_authority_link_check',
			MESSAGE = 'an authority window can activate only for a source currently linked to its account';
	END IF;

	IF NEW.reconciliation_check_id IS NOT NULL THEN
		SELECT * INTO evidence
		FROM ledger.reconciliation_checks
		WHERE id = NEW.reconciliation_check_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION USING
				ERRCODE = '23503',
				CONSTRAINT = 'transaction_authority_check_reference_check',
				MESSAGE = 'the reconciliation check does not exist';
		END IF;
		IF evidence.account_id <> NEW.account_id
			OR evidence.account_source_id <> NEW.account_source_id
			OR evidence.cutoff_on <> NEW.starts_on THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'transaction_authority_check_boundary_check',
				MESSAGE = 'the reconciliation check must cover the same account, source, and cutoff';
		END IF;
		IF evidence.result <> 'passed' THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'transaction_authority_check_result_check',
				MESSAGE = format('a %s reconciliation check cannot activate an authority window', evidence.result);
		END IF;
	ELSIF source_kind_name = 'connector' THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transaction_authority_check_required_check',
			MESSAGE = 'a live connector window needs a passed reconciliation check to activate';
	END IF;

	IF EXISTS (
		SELECT 1 FROM ledger.transaction_authority_revisions other
		WHERE other.account_id = NEW.account_id
			AND other.authority_window_id <> NEW.authority_window_id
			AND other.status = 'active'
			AND NOT EXISTS (
				SELECT 1 FROM ledger.transaction_authority_revisions successor
				WHERE successor.supersedes_revision_id = other.id
			)
			AND daterange(other.starts_on, other.ends_on, '[)')
				&& daterange(NEW.starts_on, NEW.ends_on, '[)')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transaction_authority_overlap_check',
			MESSAGE = 'an active authority window would overlap another active window for the account';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reconciliation_checks_validate"
BEFORE INSERT ON "ledger"."reconciliation_checks"
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_reconciliation_check"();
--> statement-breakpoint
CREATE TRIGGER "transaction_authority_validate"
BEFORE INSERT ON "ledger"."transaction_authority_revisions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_transaction_authority_revision"();
--> statement-breakpoint
CREATE TRIGGER "reconciliation_checks_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."reconciliation_checks"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."reconciliation_checks" ENABLE ALWAYS TRIGGER "reconciliation_checks_reject_mutation";
--> statement-breakpoint
CREATE TRIGGER "reconciliation_checks_reject_truncate"
BEFORE TRUNCATE ON "ledger"."reconciliation_checks"
FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."reconciliation_checks" ENABLE ALWAYS TRIGGER "reconciliation_checks_reject_truncate";
--> statement-breakpoint
CREATE TRIGGER "transaction_authority_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."transaction_authority_revisions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."transaction_authority_revisions" ENABLE ALWAYS TRIGGER "transaction_authority_reject_mutation";
--> statement-breakpoint
CREATE TRIGGER "transaction_authority_reject_truncate"
BEFORE TRUNCATE ON "ledger"."transaction_authority_revisions"
FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."transaction_authority_revisions" ENABLE ALWAYS TRIGGER "transaction_authority_reject_truncate";
--> statement-breakpoint
CREATE VIEW "ledger"."current_transaction_authority_windows"
WITH (security_invoker = true)
AS
SELECT revision.id AS revision_id, revision.authority_window_id,
	revision.account_id, revision.account_source_id, revision.starts_on,
	revision.ends_on, revision.status, revision.supersedes_revision_id,
	revision.reason_code, revision.reconciliation_check_id, revision.recorded_at
FROM ledger.transaction_authority_revisions revision
WHERE NOT EXISTS (
	SELECT 1 FROM ledger.transaction_authority_revisions successor
	WHERE successor.supersedes_revision_id = revision.id
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION "ledger"."lock_authority_window"(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."lock_authority_account"(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_reconciliation_check"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_transaction_authority_revision"() FROM PUBLIC;
REVOKE ALL ON TABLE
	"ledger"."reconciliation_checks",
	"ledger"."transaction_authority_revisions",
	"ledger"."current_transaction_authority_windows"
FROM PUBLIC;
GRANT SELECT ON
	"ledger"."reconciliation_checks",
	"ledger"."transaction_authority_revisions",
	"ledger"."current_transaction_authority_windows"
TO "meridian_app";
GRANT INSERT (
	id, account_id, account_source_id, cutoff_on, observation_starts_on,
	observation_ends_on, provider_balance, currency, balance_semantic,
	tolerance, result, raw_payload_id
)
	ON "ledger"."reconciliation_checks" TO "meridian_app";
GRANT INSERT (
	id, authority_window_id, account_id, account_source_id, starts_on, ends_on,
	status, supersedes_revision_id, reason_code, reconciliation_check_id
)
	ON "ledger"."transaction_authority_revisions" TO "meridian_app";
