CREATE TABLE "ledger"."account_source_link_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_source_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"supersedes_link_revision_id" uuid,
	"reason_code" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_source_links_status_check" CHECK ("ledger"."account_source_link_revisions"."status" in ('linked', 'unlinked')),
	CONSTRAINT "account_source_links_reason_check" CHECK ((
        ("ledger"."account_source_link_revisions"."status" = 'linked' and "ledger"."account_source_link_revisions"."reason_code" in ('initial_mapping', 'mapping_correction_linked', 'source_reassociated'))
        or ("ledger"."account_source_link_revisions"."status" = 'unlinked' and "ledger"."account_source_link_revisions"."reason_code" in ('user_unlinked', 'mapping_correction_unlinked'))
      )),
	CONSTRAINT "account_source_links_not_self_check" CHECK ("ledger"."account_source_link_revisions"."supersedes_link_revision_id" is null or "ledger"."account_source_link_revisions"."supersedes_link_revision_id" <> "ledger"."account_source_link_revisions"."id")
);
--> statement-breakpoint
CREATE TABLE "ledger"."account_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_kind" text NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_sources_source_check" CHECK ("ledger"."account_sources"."source" in ('ynab', 'manual_csv', 'simplefin', 'teller', 'schwab', 'snaptrade')),
	CONSTRAINT "account_sources_kind_check" CHECK ("ledger"."account_sources"."source_kind" in ('import', 'connector')),
	CONSTRAINT "account_sources_time_check" CHECK ("ledger"."account_sources"."ingested_at" <= "ledger"."account_sources"."recorded_at")
);
--> statement-breakpoint
ALTER TABLE "ledger"."account_source_link_revisions" ADD CONSTRAINT "account_source_links_source_fk" FOREIGN KEY ("account_source_id") REFERENCES "ledger"."account_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."account_source_link_revisions" ADD CONSTRAINT "account_source_links_account_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."account_source_link_revisions" ADD CONSTRAINT "account_source_links_predecessor_fk" FOREIGN KEY ("supersedes_link_revision_id") REFERENCES "ledger"."account_source_link_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_source_links_supersedes_unique" ON "ledger"."account_source_link_revisions" USING btree ("supersedes_link_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_source_links_root_unique" ON "ledger"."account_source_link_revisions" USING btree ("account_source_id") WHERE "ledger"."account_source_link_revisions"."supersedes_link_revision_id" is null;--> statement-breakpoint
CREATE INDEX "account_source_links_account_idx" ON "ledger"."account_source_link_revisions" USING btree ("account_id");
--> statement-breakpoint
CREATE FUNCTION "ledger"."validate_account_source_link_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	previous_revision "ledger"."account_source_link_revisions"%ROWTYPE;
BEGIN
	IF NEW.supersedes_link_revision_id IS NULL THEN
		IF NEW.status <> 'linked' OR NEW.reason_code <> 'initial_mapping' THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'account_source_links_root_state_check',
				MESSAGE = 'an account-source link root must be an initial linked mapping';
		END IF;
		RETURN NEW;
	END IF;

	SELECT *
	INTO previous_revision
	FROM "ledger"."account_source_link_revisions"
	WHERE id = NEW.supersedes_link_revision_id;

	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			CONSTRAINT = 'account_source_links_predecessor_reference_check',
			MESSAGE = 'the predecessor link revision does not exist';
	END IF;

	IF NEW.account_source_id <> previous_revision.account_source_id THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'account_source_links_identity_check',
			MESSAGE = 'a link revision must retain its account-source identity';
	END IF;

	IF NEW.recorded_at < previous_revision.recorded_at THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'account_source_links_recorded_at_check',
			MESSAGE = 'a link revision cannot predate its predecessor';
	END IF;

	IF previous_revision.status = 'linked' THEN
		IF NEW.status <> 'unlinked'
			OR NEW.account_id <> previous_revision.account_id
			OR NEW.reason_code NOT IN ('user_unlinked', 'mapping_correction_unlinked') THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'account_source_links_unlink_transition_check',
				MESSAGE = 'a linked source must explicitly unlink from the same account';
		END IF;
	ELSIF previous_revision.status = 'unlinked' THEN
		IF NEW.status <> 'linked'
			OR NEW.reason_code NOT IN ('mapping_correction_linked', 'source_reassociated') THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'account_source_links_relink_transition_check',
				MESSAGE = 'an unlinked source may only transition to an explicit relink';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "account_source_links_transition_check"
BEFORE INSERT ON "ledger"."account_source_link_revisions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."validate_account_source_link_revision"();
--> statement-breakpoint
CREATE TRIGGER "account_sources_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."account_sources"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."account_sources" ENABLE ALWAYS TRIGGER "account_sources_reject_mutation";
--> statement-breakpoint
CREATE TRIGGER "account_source_links_reject_mutation"
BEFORE UPDATE OR DELETE ON "ledger"."account_source_link_revisions"
FOR EACH ROW EXECUTE FUNCTION "ledger"."reject_mutation"();
ALTER TABLE "ledger"."account_source_link_revisions" ENABLE ALWAYS TRIGGER "account_source_links_reject_mutation";
--> statement-breakpoint
CREATE VIEW "ledger"."current_account_source_links"
WITH (security_invoker = true)
AS
SELECT
	source.id AS account_source_id,
	source.source,
	source.source_kind,
	revision.account_id,
	revision.id AS link_revision_id,
	revision.reason_code,
	revision.recorded_at
FROM "ledger"."account_sources" source
JOIN "ledger"."account_source_link_revisions" revision
	ON revision.account_source_id = source.id
WHERE revision.status = 'linked'
	AND NOT EXISTS (
		SELECT 1
		FROM "ledger"."account_source_link_revisions" successor
		WHERE successor.supersedes_link_revision_id = revision.id
	);
--> statement-breakpoint
REVOKE ALL ON TABLE
	"ledger"."account_sources",
	"ledger"."account_source_link_revisions",
	"ledger"."current_account_source_links"
FROM PUBLIC;
REVOKE ALL ON FUNCTION "ledger"."validate_account_source_link_revision"() FROM PUBLIC;
GRANT SELECT ON TABLE
	"ledger"."account_sources",
	"ledger"."account_source_link_revisions"
TO "meridian_app";
GRANT INSERT (id, source, source_kind, ingested_at)
	ON "ledger"."account_sources" TO "meridian_app";
GRANT INSERT (
	id, account_source_id, account_id, status,
	supersedes_link_revision_id, reason_code
)
	ON "ledger"."account_source_link_revisions" TO "meridian_app";
GRANT SELECT ON TABLE "ledger"."current_account_source_links" TO "meridian_app";
