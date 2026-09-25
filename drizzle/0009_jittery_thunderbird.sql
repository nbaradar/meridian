CREATE TABLE "ledger"."source_record_account_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_record_id" uuid NOT NULL,
	"supersedes_account_set_revision_id" uuid,
	"member_count" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_record_account_sets_member_count_check" CHECK ("ledger"."source_record_account_sets"."member_count" > 0),
	CONSTRAINT "source_record_account_sets_not_self_check" CHECK ("ledger"."source_record_account_sets"."supersedes_account_set_revision_id" is null or "ledger"."source_record_account_sets"."supersedes_account_set_revision_id" <> "ledger"."source_record_account_sets"."id")
);
--> statement-breakpoint
CREATE TABLE "ledger"."source_record_accounts" (
	"account_set_revision_id" uuid NOT NULL,
	"account_source_id" uuid NOT NULL,
	"link_revision_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "source_record_accounts_account_set_revision_id_account_source_id_pk" PRIMARY KEY("account_set_revision_id","account_source_id"),
	CONSTRAINT "source_record_accounts_role_check" CHECK ("ledger"."source_record_accounts"."role" = 'observed_account')
);
--> statement-breakpoint
ALTER TABLE "ledger"."source_record_account_sets" ADD CONSTRAINT "source_record_account_sets_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "ledger"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."source_record_account_sets" ADD CONSTRAINT "source_record_account_sets_supersedes_account_set_revision_id_source_record_account_sets_id_fk" FOREIGN KEY ("supersedes_account_set_revision_id") REFERENCES "ledger"."source_record_account_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."source_record_accounts" ADD CONSTRAINT "source_record_accounts_account_set_revision_id_source_record_account_sets_id_fk" FOREIGN KEY ("account_set_revision_id") REFERENCES "ledger"."source_record_account_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."source_record_accounts" ADD CONSTRAINT "source_record_accounts_account_source_id_account_sources_id_fk" FOREIGN KEY ("account_source_id") REFERENCES "ledger"."account_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."source_record_accounts" ADD CONSTRAINT "source_record_accounts_link_revision_id_account_source_link_revisions_id_fk" FOREIGN KEY ("link_revision_id") REFERENCES "ledger"."account_source_link_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_account_sets_supersedes_unique" ON "ledger"."source_record_account_sets" USING btree ("supersedes_account_set_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_account_sets_root_unique" ON "ledger"."source_record_account_sets" USING btree ("source_record_id") WHERE "ledger"."source_record_account_sets"."supersedes_account_set_revision_id" is null;
--> statement-breakpoint
CREATE FUNCTION "ledger"."lock_account_source"(account_source_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('ledger.account_source:' || account_source_id::text, 0));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."lock_source_record"(source_record_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('ledger.source_record:' || source_record_id::text, 0));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."lock_account_source_link_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ledger
AS $$
BEGIN
	PERFORM ledger.lock_account_source(NEW.account_source_id);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_source_record_account_set"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ledger
AS $$
DECLARE
	previous_set ledger.source_record_account_sets%ROWTYPE;
BEGIN
	PERFORM ledger.lock_source_record(NEW.source_record_id);

	IF NEW.supersedes_account_set_revision_id IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT * INTO previous_set
	FROM ledger.source_record_account_sets
	WHERE id = NEW.supersedes_account_set_revision_id;

	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'the predecessor account-set revision does not exist';
	END IF;
	IF previous_set.source_record_id <> NEW.source_record_id THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an account-set revision must retain its source record';
	END IF;
	IF EXISTS (
		SELECT 1 FROM ledger.source_record_account_sets
		WHERE supersedes_account_set_revision_id = previous_set.id
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'the predecessor account-set revision is not the current tip';
	END IF;
	IF NEW.recorded_at < previous_set.recorded_at THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an account-set revision cannot predate its predecessor';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_source_record_account_member"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ledger
AS $$
DECLARE
	set_source text;
	account_source_name text;
	link_row ledger.account_source_link_revisions%ROWTYPE;
BEGIN
	PERFORM ledger.lock_account_source(NEW.account_source_id);

	SELECT source_record.source INTO set_source
	FROM ledger.source_record_account_sets account_set
	JOIN ledger.source_records source_record ON source_record.id = account_set.source_record_id
	WHERE account_set.id = NEW.account_set_revision_id;

	SELECT source INTO account_source_name
	FROM ledger.account_sources
	WHERE id = NEW.account_source_id;

	SELECT * INTO link_row
	FROM ledger.account_source_link_revisions
	WHERE id = NEW.link_revision_id;

	IF set_source IS NULL OR account_source_name IS NULL OR NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'account-set member references are incomplete';
	END IF;
	IF set_source <> account_source_name THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'source record and account source must use the same source';
	END IF;
	IF link_row.account_source_id <> NEW.account_source_id OR link_row.status <> 'linked' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account-set member must reference a linked revision for its account source';
	END IF;
	IF EXISTS (
		SELECT 1 FROM ledger.account_source_link_revisions
		WHERE supersedes_link_revision_id = link_row.id
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account-set member link revision is not the current tip';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_source_record_account_member_count"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	set_id uuid;
	expected_count integer;
	actual_count integer;
BEGIN
	IF TG_TABLE_NAME = 'source_record_accounts' THEN
		set_id := NEW.account_set_revision_id;
	ELSE
		set_id := NEW.id;
	END IF;
	SELECT member_count INTO expected_count
	FROM ledger.source_record_account_sets
	WHERE id = set_id;
	IF expected_count IS NULL THEN
		RETURN NULL;
	END IF;
	SELECT count(*) INTO actual_count
	FROM ledger.source_record_accounts
	WHERE account_set_revision_id = set_id;
	IF actual_count <> expected_count THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account-set member count does not match its sealed declaration';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "account_source_links_00_lock"
BEFORE INSERT ON "ledger"."account_source_link_revisions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."lock_account_source_link_revision"();
--> statement-breakpoint
CREATE TRIGGER "source_record_account_sets_validate_transition"
BEFORE INSERT ON "ledger"."source_record_account_sets"
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_source_record_account_set"();
--> statement-breakpoint
CREATE TRIGGER "source_record_accounts_validate_member"
BEFORE INSERT ON "ledger"."source_record_accounts"
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_source_record_account_member"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "source_record_account_sets_validate_count"
AFTER INSERT ON "ledger"."source_record_account_sets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_source_record_account_member_count"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "source_record_accounts_validate_count"
AFTER INSERT ON "ledger"."source_record_accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_source_record_account_member_count"();
--> statement-breakpoint
CREATE TRIGGER "source_record_account_sets_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."source_record_account_sets"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."source_record_account_sets" ENABLE ALWAYS TRIGGER "source_record_account_sets_reject_mutation";
--> statement-breakpoint
CREATE TRIGGER "source_record_accounts_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."source_record_accounts"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."source_record_accounts" ENABLE ALWAYS TRIGGER "source_record_accounts_reject_mutation";
--> statement-breakpoint
CREATE VIEW "ledger"."current_source_record_account_sets"
WITH (security_invoker = true)
AS
SELECT account_set.id, account_set.source_record_id,
	account_set.supersedes_account_set_revision_id,
	account_set.member_count, account_set.recorded_at
FROM ledger.source_record_account_sets account_set
WHERE NOT EXISTS (
	SELECT 1 FROM ledger.source_record_account_sets successor
	WHERE successor.supersedes_account_set_revision_id = account_set.id
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION "ledger"."lock_account_source"(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."lock_source_record"(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."lock_account_source_link_revision"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_source_record_account_set"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_source_record_account_member"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_source_record_account_member_count"() FROM PUBLIC;
REVOKE ALL ON TABLE "ledger"."source_record_account_sets", "ledger"."source_record_accounts", "ledger"."current_source_record_account_sets" FROM PUBLIC;
GRANT SELECT ON "ledger"."source_record_account_sets", "ledger"."source_record_accounts", "ledger"."current_source_record_account_sets" TO "meridian_app";
GRANT INSERT (id, source_record_id, supersedes_account_set_revision_id, member_count)
	ON "ledger"."source_record_account_sets" TO "meridian_app";
GRANT INSERT (account_set_revision_id, account_source_id, link_revision_id, role)
	ON "ledger"."source_record_accounts" TO "meridian_app";
