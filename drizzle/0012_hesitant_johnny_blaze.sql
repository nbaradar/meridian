CREATE TABLE "ledger"."balance_observation_retractions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"observation_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger"."balance_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"observed_on" date NOT NULL,
	"amount" numeric NOT NULL,
	"currency" char(3) NOT NULL,
	"source" text NOT NULL,
	"account_source_id" uuid,
	"export_digest" char(64),
	"supersedes_observation_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_observations_currency_check" CHECK ("ledger"."balance_observations"."currency" = 'USD'),
	CONSTRAINT "balance_observations_source_check" CHECK ("ledger"."balance_observations"."source" in ('manual', 'ynab_export')),
	CONSTRAINT "balance_observations_source_columns_check" CHECK (("ledger"."balance_observations"."source" = 'manual' and "ledger"."balance_observations"."account_source_id" is null and "ledger"."balance_observations"."export_digest" is null)
        or ("ledger"."balance_observations"."source" = 'ynab_export' and "ledger"."balance_observations"."account_source_id" is not null and "ledger"."balance_observations"."export_digest" is not null)),
	CONSTRAINT "balance_observations_digest_check" CHECK ("ledger"."balance_observations"."export_digest" is null or "ledger"."balance_observations"."export_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "balance_observations_correction_source_check" CHECK ("ledger"."balance_observations"."supersedes_observation_id" is null or "ledger"."balance_observations"."source" = 'manual'),
	CONSTRAINT "balance_observations_not_self_check" CHECK ("ledger"."balance_observations"."supersedes_observation_id" is null or "ledger"."balance_observations"."supersedes_observation_id" <> "ledger"."balance_observations"."id")
);
--> statement-breakpoint
ALTER TABLE "ledger"."balance_observation_retractions" ADD CONSTRAINT "balance_observation_retractions_observation_fk" FOREIGN KEY ("observation_id") REFERENCES "ledger"."balance_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."balance_observations" ADD CONSTRAINT "balance_observations_account_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."balance_observations" ADD CONSTRAINT "balance_observations_source_fk" FOREIGN KEY ("account_source_id") REFERENCES "ledger"."account_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."balance_observations" ADD CONSTRAINT "balance_observations_predecessor_fk" FOREIGN KEY ("supersedes_observation_id") REFERENCES "ledger"."balance_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "balance_observation_retractions_observation_unique" ON "ledger"."balance_observation_retractions" USING btree ("observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "balance_observations_supersedes_unique" ON "ledger"."balance_observations" USING btree ("supersedes_observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "balance_observations_export_unique" ON "ledger"."balance_observations" USING btree ("account_source_id","export_digest");--> statement-breakpoint
CREATE INDEX "balance_observations_account_idx" ON "ledger"."balance_observations" USING btree ("account_id","observed_on");
--> statement-breakpoint
-- RFC 0006: serialize balance writes per canonical account so tip checks
-- (superseded, retracted) see every committed competitor.
CREATE FUNCTION "ledger"."lock_balance_account"(account_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('ledger.balance_account:' || account_id::text, 0));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_balance_observation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ledger
AS $$
DECLARE
	account_currency char(3);
	account_source_name text;
	predecessor "ledger"."balance_observations"%ROWTYPE;
BEGIN
	-- Mirrors the CHECK constraint, which PostgreSQL evaluates only after this
	-- BEFORE trigger, so the source lookups below never see null columns.
	IF NOT (
		(NEW.source = 'manual' AND NEW.account_source_id IS NULL AND NEW.export_digest IS NULL)
		OR (NEW.source = 'ynab_export' AND NEW.account_source_id IS NOT NULL AND NEW.export_digest IS NOT NULL)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'balance_observations_source_columns_check',
			MESSAGE = 'balance observation source columns are inconsistent with its source';
	END IF;

	PERFORM ledger.lock_balance_account(NEW.account_id);

	SELECT currency INTO account_currency
	FROM ledger.accounts
	WHERE id = NEW.account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			CONSTRAINT = 'balance_observations_account_reference_check',
			MESSAGE = 'a balance observation must reference a recorded account';
	END IF;
	IF account_currency <> NEW.currency THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'balance_observations_account_currency_check',
			MESSAGE = 'a balance observation must use its account''s currency';
	END IF;

	IF NEW.source = 'ynab_export' THEN
		-- Account lock first, then the account-source lock link revisions take.
		PERFORM ledger.lock_account_source(NEW.account_source_id);
		SELECT source INTO account_source_name
		FROM ledger.account_sources
		WHERE id = NEW.account_source_id;
		IF account_source_name IS NULL THEN
			RAISE EXCEPTION USING
				ERRCODE = '23503',
				CONSTRAINT = 'balance_observations_source_reference_check',
				MESSAGE = 'a YNAB export balance must reference a recorded account source';
		END IF;
		IF account_source_name <> 'ynab' THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'balance_observations_source_kind_check',
				MESSAGE = 'a YNAB export balance must reference a YNAB account source';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM ledger.current_account_source_links
			WHERE account_source_id = NEW.account_source_id
				AND account_id = NEW.account_id
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'balance_observations_source_linked_check',
				MESSAGE = 'a YNAB export balance must reference a source currently linked to its account';
		END IF;
	END IF;

	IF NEW.supersedes_observation_id IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT * INTO predecessor
	FROM ledger.balance_observations
	WHERE id = NEW.supersedes_observation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			CONSTRAINT = 'balance_observations_predecessor_reference_check',
			MESSAGE = 'the corrected balance observation does not exist';
	END IF;
	IF predecessor.account_id <> NEW.account_id THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'balance_observations_same_account_check',
			MESSAGE = 'a balance correction must belong to the corrected observation''s account';
	END IF;
	IF EXISTS (
		SELECT 1 FROM ledger.balance_observations
		WHERE supersedes_observation_id = NEW.supersedes_observation_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'balance_observations_superseded_check',
			MESSAGE = 'the corrected balance observation was already superseded';
	END IF;
	IF EXISTS (
		SELECT 1 FROM ledger.balance_observation_retractions
		WHERE observation_id = NEW.supersedes_observation_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'balance_observations_retracted_check',
			MESSAGE = 'a retracted balance observation cannot be corrected';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_balance_observation_retraction"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ledger
AS $$
DECLARE
	target_account_id uuid;
BEGIN
	SELECT account_id INTO target_account_id
	FROM ledger.balance_observations
	WHERE id = NEW.observation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			CONSTRAINT = 'balance_observation_retractions_observation_reference_check',
			MESSAGE = 'the retracted balance observation does not exist';
	END IF;
	PERFORM ledger.lock_balance_account(target_account_id);

	IF EXISTS (
		SELECT 1 FROM ledger.balance_observations
		WHERE supersedes_observation_id = NEW.observation_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'balance_observation_retractions_superseded_check',
			MESSAGE = 'a superseded balance observation cannot be retracted';
	END IF;
	IF EXISTS (
		SELECT 1 FROM ledger.balance_observation_retractions
		WHERE observation_id = NEW.observation_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23505',
			CONSTRAINT = 'balance_observation_retractions_observation_unique',
			MESSAGE = 'the balance observation was already retracted';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "balance_observations_validate"
BEFORE INSERT ON "ledger"."balance_observations"
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_balance_observation"();
--> statement-breakpoint
CREATE TRIGGER "balance_observation_retractions_validate"
BEFORE INSERT ON "ledger"."balance_observation_retractions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_balance_observation_retraction"();
--> statement-breakpoint
CREATE TRIGGER "balance_observations_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."balance_observations"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."balance_observations" ENABLE ALWAYS TRIGGER "balance_observations_reject_mutation";
--> statement-breakpoint
CREATE TRIGGER "balance_observations_reject_truncate"
BEFORE TRUNCATE ON "ledger"."balance_observations"
FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."balance_observations" ENABLE ALWAYS TRIGGER "balance_observations_reject_truncate";
--> statement-breakpoint
CREATE TRIGGER "balance_observation_retractions_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."balance_observation_retractions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."balance_observation_retractions" ENABLE ALWAYS TRIGGER "balance_observation_retractions_reject_mutation";
--> statement-breakpoint
CREATE TRIGGER "balance_observation_retractions_reject_truncate"
BEFORE TRUNCATE ON "ledger"."balance_observation_retractions"
FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."balance_observation_retractions" ENABLE ALWAYS TRIGGER "balance_observation_retractions_reject_truncate";
--> statement-breakpoint
-- RFC 0006 precedence: among observations neither superseded nor retracted,
-- the latest observed_on, then latest recorded_at, then highest id.
CREATE VIEW "ledger"."current_balances"
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (observation.account_id)
	observation.id AS observation_id,
	observation.account_id,
	observation.observed_on,
	observation.amount,
	observation.currency,
	observation.source,
	observation.account_source_id,
	observation.recorded_at
FROM ledger.balance_observations observation
WHERE NOT EXISTS (
		SELECT 1 FROM ledger.balance_observations successor
		WHERE successor.supersedes_observation_id = observation.id
	)
	AND NOT EXISTS (
		SELECT 1 FROM ledger.balance_observation_retractions retraction
		WHERE retraction.observation_id = observation.id
	)
ORDER BY observation.account_id,
	observation.observed_on DESC,
	observation.recorded_at DESC,
	observation.id DESC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "ledger"."lock_balance_account"(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_balance_observation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_balance_observation_retraction"() FROM PUBLIC;
REVOKE ALL ON TABLE
	"ledger"."balance_observations",
	"ledger"."balance_observation_retractions",
	"ledger"."current_balances"
FROM PUBLIC;
GRANT SELECT ON
	"ledger"."balance_observations",
	"ledger"."balance_observation_retractions",
	"ledger"."current_balances"
TO "meridian_app";
GRANT INSERT (
	id, account_id, observed_on, amount, currency, source, account_source_id,
	export_digest, supersedes_observation_id
)
	ON "ledger"."balance_observations" TO "meridian_app";
GRANT INSERT (id, observation_id)
	ON "ledger"."balance_observation_retractions" TO "meridian_app";
