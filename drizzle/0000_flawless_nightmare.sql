CREATE SCHEMA "ledger";
--> statement-breakpoint
CREATE TABLE "ledger"."account_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"display_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_revisions_name_check" CHECK (length(btrim("ledger"."account_revisions"."name")) > 0),
	CONSTRAINT "account_revisions_status_check" CHECK ("ledger"."account_revisions"."status" in ('active', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"currency" char(3) NOT NULL,
	"opened_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_kind_check" CHECK ("ledger"."accounts"."kind" in ('asset', 'liability')),
	CONSTRAINT "accounts_currency_check" CHECK ("ledger"."accounts"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "ledger"."categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_kind_check" CHECK ("ledger"."categories"."kind" in ('expense', 'income', 'transfer'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."category_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"parent_category_id" uuid,
	"name" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_revisions_name_check" CHECK (length(btrim("ledger"."category_revisions"."name")) > 0),
	CONSTRAINT "category_revisions_parent_check" CHECK ("ledger"."category_revisions"."parent_category_id" is null or "ledger"."category_revisions"."parent_category_id" <> "ledger"."category_revisions"."category_id")
);
--> statement-breakpoint
CREATE TABLE "ledger"."entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid,
	"category_id" uuid,
	"amount" numeric NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_destination_check" CHECK (num_nonnulls("ledger"."entries"."account_id", "ledger"."entries"."category_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "ledger"."imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"importer_id" text NOT NULL,
	"importer_version" text NOT NULL,
	"content_digest" char(64) NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_importer_id_check" CHECK (length(btrim("ledger"."imports"."importer_id")) > 0),
	CONSTRAINT "imports_importer_version_check" CHECK (length(btrim("ledger"."imports"."importer_version")) > 0),
	CONSTRAINT "imports_digest_check" CHECK ("ledger"."imports"."content_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "ledger"."raw_payloads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"content_digest" char(64) NOT NULL,
	"encryption_algorithm" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "raw_payloads_source_check" CHECK (length(btrim("ledger"."raw_payloads"."source")) > 0),
	CONSTRAINT "raw_payloads_digest_check" CHECK ("ledger"."raw_payloads"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "raw_payloads_algorithm_check" CHECK (length(btrim("ledger"."raw_payloads"."encryption_algorithm")) > 0),
	CONSTRAINT "raw_payloads_key_id_check" CHECK (length(btrim("ledger"."raw_payloads"."encryption_key_id")) > 0),
	CONSTRAINT "raw_payloads_nonce_check" CHECK (length("ledger"."raw_payloads"."nonce") > 0),
	CONSTRAINT "raw_payloads_ciphertext_check" CHECK (length("ledger"."raw_payloads"."ciphertext") > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger"."source_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"content_digest" char(64) NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"supersedes_source_record_id" uuid,
	"ingested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_records_source_check" CHECK (length(btrim("ledger"."source_records"."source")) > 0),
	CONSTRAINT "source_records_source_ref_check" CHECK (length(btrim("ledger"."source_records"."source_ref")) > 0),
	CONSTRAINT "source_records_digest_check" CHECK ("ledger"."source_records"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_records_not_self_check" CHECK ("ledger"."source_records"."supersedes_source_record_id" is null or "ledger"."source_records"."supersedes_source_record_id" <> "ledger"."source_records"."id")
);
--> statement-breakpoint
CREATE TABLE "ledger"."transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"currency" char(3) NOT NULL,
	"source_record_id" uuid,
	"corrects_transaction_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_description_check" CHECK (length(btrim("ledger"."transactions"."description")) > 0),
	CONSTRAINT "transactions_currency_check" CHECK ("ledger"."transactions"."currency" = 'USD'),
	CONSTRAINT "transactions_not_self_correction_check" CHECK ("ledger"."transactions"."corrects_transaction_id" is null or "ledger"."transactions"."corrects_transaction_id" <> "ledger"."transactions"."id"),
	CONSTRAINT "transactions_correction_source_check" CHECK ("ledger"."transactions"."corrects_transaction_id" is null or "ledger"."transactions"."source_record_id" is null)
);
--> statement-breakpoint
ALTER TABLE "ledger"."account_revisions" ADD CONSTRAINT "account_revisions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."category_revisions" ADD CONSTRAINT "category_revisions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "ledger"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."category_revisions" ADD CONSTRAINT "category_revisions_parent_category_id_categories_id_fk" FOREIGN KEY ("parent_category_id") REFERENCES "ledger"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."entries" ADD CONSTRAINT "entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "ledger"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."entries" ADD CONSTRAINT "entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."entries" ADD CONSTRAINT "entries_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "ledger"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."imports" ADD CONSTRAINT "imports_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "ledger"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."source_records" ADD CONSTRAINT "source_records_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "ledger"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."source_records" ADD CONSTRAINT "source_records_supersedes_source_record_id_source_records_id_fk" FOREIGN KEY ("supersedes_source_record_id") REFERENCES "ledger"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transactions" ADD CONSTRAINT "transactions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "ledger"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transactions" ADD CONSTRAINT "transactions_corrects_transaction_id_transactions_id_fk" FOREIGN KEY ("corrects_transaction_id") REFERENCES "ledger"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_revisions_current_idx" ON "ledger"."account_revisions" USING btree ("account_id","effective_at","recorded_at");--> statement-breakpoint
CREATE INDEX "category_revisions_current_idx" ON "ledger"."category_revisions" USING btree ("category_id","effective_at","recorded_at");--> statement-breakpoint
CREATE INDEX "entries_transaction_idx" ON "ledger"."entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "entries_account_idx" ON "ledger"."entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "entries_category_idx" ON "ledger"."entries" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imports_content_unique" ON "ledger"."imports" USING btree ("importer_id","importer_version","content_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_version_unique" ON "ledger"."source_records" USING btree ("source","source_ref","content_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_supersedes_unique" ON "ledger"."source_records" USING btree ("supersedes_source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_root_unique" ON "ledger"."source_records" USING btree ("source","source_ref") WHERE "ledger"."source_records"."supersedes_source_record_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_source_record_unique" ON "ledger"."transactions" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_correction_unique" ON "ledger"."transactions" USING btree ("corrects_transaction_id");--> statement-breakpoint

CREATE FUNCTION "ledger"."reject_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = format('ledger.%s is append-only; %s is forbidden', TG_TABLE_NAME, TG_OP);
END;
$$;--> statement-breakpoint

CREATE FUNCTION "ledger"."validate_transaction_balance"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_transaction_id uuid;
	entry_count bigint;
	entry_total numeric;
BEGIN
	target_transaction_id := CASE
		WHEN TG_TABLE_NAME = 'transactions' THEN NEW.id
		ELSE (to_jsonb(NEW) ->> 'transaction_id')::uuid
	END;

	IF NOT EXISTS (
		SELECT 1 FROM "ledger"."transactions" WHERE id = target_transaction_id
	) THEN
		RETURN NULL;
	END IF;

	SELECT count(*), coalesce(sum(amount), 0)
	INTO entry_count, entry_total
	FROM "ledger"."entries"
	WHERE transaction_id = target_transaction_id;

	IF entry_count < 2 OR entry_total <> 0 THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transactions_entries_balance_check',
			MESSAGE = format(
				'transaction %s must have at least two entries that sum exactly to zero',
				target_transaction_id
			);
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "ledger"."validate_transaction_correction"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_transaction_id uuid;
	original_transaction_id uuid;
	target_currency char(3);
	original_currency char(3);
BEGIN
	target_transaction_id := CASE
		WHEN TG_TABLE_NAME = 'transactions' THEN NEW.id
		ELSE (to_jsonb(NEW) ->> 'transaction_id')::uuid
	END;

	SELECT corrects_transaction_id, currency
	INTO original_transaction_id, target_currency
	FROM "ledger"."transactions"
	WHERE id = target_transaction_id;

	IF original_transaction_id IS NULL THEN
		RETURN NULL;
	END IF;

	SELECT currency
	INTO STRICT original_currency
	FROM "ledger"."transactions"
	WHERE id = original_transaction_id;

	IF target_currency <> original_currency THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transactions_correction_currency_check',
			MESSAGE = format(
				'correction %s must use the currency of transaction %s',
				target_transaction_id,
				original_transaction_id
			);
	END IF;

	IF EXISTS (
		WITH original_postings AS (
			SELECT
				CASE WHEN account_id IS NOT NULL THEN 'account' ELSE 'category' END AS destination_kind,
				coalesce(account_id, category_id) AS destination_id,
				sum(amount) AS amount
			FROM "ledger"."entries"
			WHERE transaction_id = original_transaction_id
			GROUP BY destination_kind, destination_id
		),
		correction_postings AS (
			SELECT
				CASE WHEN account_id IS NOT NULL THEN 'account' ELSE 'category' END AS destination_kind,
				coalesce(account_id, category_id) AS destination_id,
				sum(amount) AS amount
			FROM "ledger"."entries"
			WHERE transaction_id = target_transaction_id
			GROUP BY destination_kind, destination_id
		)
		SELECT 1
		FROM original_postings original
		FULL JOIN correction_postings correction
			ON correction.destination_kind = original.destination_kind
			AND correction.destination_id = original.destination_id
		WHERE original.amount IS NULL
			OR correction.amount IS NULL
			OR original.amount + correction.amount <> 0
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'transactions_correction_postings_check',
			MESSAGE = format(
				'correction %s must exactly reverse transaction %s by destination',
				target_transaction_id,
				original_transaction_id
			);
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "ledger"."validate_source_record_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	previous_record "ledger"."source_records"%ROWTYPE;
	payload_source text;
BEGIN
	SELECT source
	INTO STRICT payload_source
	FROM "ledger"."raw_payloads"
	WHERE id = NEW.raw_payload_id;

	IF payload_source <> NEW.source THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'source_records_payload_source_check',
			MESSAGE = 'source record and raw payload must have the same source';
	END IF;

	IF NEW.supersedes_source_record_id IS NOT NULL THEN
		SELECT *
		INTO STRICT previous_record
		FROM "ledger"."source_records"
		WHERE id = NEW.supersedes_source_record_id;

		IF NEW.source <> previous_record.source OR NEW.source_ref <> previous_record.source_ref THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'source_records_identity_check',
				MESSAGE = 'a source-record revision must retain source and source_ref';
		END IF;

		IF NEW.ingested_at < previous_record.ingested_at THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'source_records_ingested_at_check',
				MESSAGE = 'a source-record revision cannot predate its predecessor';
		END IF;
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "ledger"."validate_import_payload"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	payload_digest char(64);
BEGIN
	SELECT content_digest
	INTO STRICT payload_digest
	FROM "ledger"."raw_payloads"
	WHERE id = NEW.raw_payload_id;

	IF payload_digest <> NEW.content_digest THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'imports_payload_digest_check',
			MESSAGE = 'import and raw payload content digests must match';
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "transactions_balance_from_transaction"
AFTER INSERT ON "ledger"."transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_transaction_balance"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "transactions_balance_from_entry"
AFTER INSERT ON "ledger"."entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_transaction_balance"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "transactions_correction_from_transaction"
AFTER INSERT ON "ledger"."transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_transaction_correction"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "transactions_correction_from_entry"
AFTER INSERT ON "ledger"."entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_transaction_correction"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "source_records_version_check"
AFTER INSERT ON "ledger"."source_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_source_record_version"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "imports_payload_check"
AFTER INSERT ON "ledger"."imports"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_import_payload"();--> statement-breakpoint

CREATE TRIGGER "accounts_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."accounts" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."accounts" ENABLE ALWAYS TRIGGER "accounts_reject_mutation";--> statement-breakpoint
CREATE TRIGGER "account_revisions_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."account_revisions" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."account_revisions" ENABLE ALWAYS TRIGGER "account_revisions_reject_mutation";--> statement-breakpoint
CREATE TRIGGER "categories_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."categories" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."categories" ENABLE ALWAYS TRIGGER "categories_reject_mutation";--> statement-breakpoint
CREATE TRIGGER "category_revisions_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."category_revisions" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."category_revisions" ENABLE ALWAYS TRIGGER "category_revisions_reject_mutation";--> statement-breakpoint
CREATE TRIGGER "raw_payloads_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."raw_payloads" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."raw_payloads" ENABLE ALWAYS TRIGGER "raw_payloads_reject_mutation";--> statement-breakpoint
CREATE TRIGGER "imports_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."imports" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."imports" ENABLE ALWAYS TRIGGER "imports_reject_mutation";--> statement-breakpoint
CREATE TRIGGER "source_records_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."source_records" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."source_records" ENABLE ALWAYS TRIGGER "source_records_reject_mutation";--> statement-breakpoint
CREATE TRIGGER "transactions_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."transactions" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."transactions" ENABLE ALWAYS TRIGGER "transactions_reject_mutation";--> statement-breakpoint
CREATE TRIGGER "entries_reject_mutation" BEFORE UPDATE OR DELETE ON "ledger"."entries" FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."entries" ENABLE ALWAYS TRIGGER "entries_reject_mutation";--> statement-breakpoint

CREATE VIEW "ledger"."current_accounts"
WITH (security_invoker = true)
AS
SELECT
	account.id,
	account.kind,
	account.currency,
	account.opened_at,
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

CREATE VIEW "ledger"."current_categories"
WITH (security_invoker = true)
AS
SELECT
	category.id,
	category.kind,
	revision.parent_category_id,
	revision.name,
	revision.effective_at AS revision_effective_at,
	revision.recorded_at AS revision_recorded_at
FROM "ledger"."categories" category
LEFT JOIN LATERAL (
	SELECT *
	FROM "ledger"."category_revisions"
	WHERE category_id = category.id AND effective_at <= now()
	ORDER BY effective_at DESC, recorded_at DESC, id DESC
	LIMIT 1
) revision ON true;--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'meridian_app') THEN
		RAISE EXCEPTION 'database role meridian_app must be provisioned before migration';
	END IF;
END;
$$;--> statement-breakpoint

REVOKE ALL ON SCHEMA "ledger" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA "ledger" FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "ledger" FROM PUBLIC;
REVOKE CREATE ON SCHEMA "public" FROM "meridian_app";--> statement-breakpoint
GRANT USAGE ON SCHEMA "ledger" TO "meridian_app";
GRANT SELECT, INSERT ON TABLE
	"ledger"."accounts",
	"ledger"."account_revisions",
	"ledger"."categories",
	"ledger"."category_revisions",
	"ledger"."raw_payloads",
	"ledger"."imports",
	"ledger"."source_records",
	"ledger"."transactions",
	"ledger"."entries"
TO "meridian_app";
GRANT SELECT ON TABLE
	"ledger"."current_accounts",
	"ledger"."current_categories"
TO "meridian_app";
