CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TABLE "ops"."connection_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"expected_credential_generation" bigint,
	"resulting_credential_generation" bigint NOT NULL,
	"actor_class" text NOT NULL,
	"reason_code" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_events_type_check" CHECK ("ops"."connection_events"."event_type" in ('connection_created', 'authorization_installed', 'credential_refreshed', 'reauthorization_required', 'connection_disabled', 'connection_reenabled', 'connection_revoked')),
	CONSTRAINT "connection_events_generation_check" CHECK ("ops"."connection_events"."resulting_credential_generation" >= 0 and ("ops"."connection_events"."expected_credential_generation" is null or "ops"."connection_events"."expected_credential_generation" >= 0)),
	CONSTRAINT "connection_events_actor_check" CHECK ("ops"."connection_events"."actor_class" in ('owner', 'read_worker', 'system')),
	CONSTRAINT "connection_events_reason_check" CHECK ("ops"."connection_events"."reason_code" in ('pending_authorization', 'authorization_installed', 'credential_refreshed', 'provider_authentication_failed', 'credential_expired', 'credential_key_unavailable', 'restore_validation_required', 'user_disabled', 'credential_revalidated', 'user_revoked', 'provider_revoked'))
);
--> statement-breakpoint
CREATE TABLE "ops"."connection_secrets" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"credential_generation" bigint NOT NULL,
	"encryption_algorithm" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"key_status" text NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_secrets_generation_check" CHECK ("ops"."connection_secrets"."credential_generation" > 0),
	CONSTRAINT "connection_secrets_algorithm_check" CHECK ("ops"."connection_secrets"."encryption_algorithm" = 'xchacha20-poly1305-ietf'),
	CONSTRAINT "connection_secrets_key_status_check" CHECK ("ops"."connection_secrets"."key_status" = 'active'),
	CONSTRAINT "connection_secrets_envelope_check" CHECK (length(btrim("ops"."connection_secrets"."encryption_key_id")) > 0 and length("ops"."connection_secrets"."nonce") > 0 and length("ops"."connection_secrets"."ciphertext") > 0)
);
--> statement-breakpoint
CREATE TABLE "ops"."connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"authorization_class" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"credential_generation" bigint NOT NULL,
	"authorized_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connections_source_check" CHECK ("ops"."connections"."source" in ('simplefin', 'teller', 'schwab', 'snaptrade')),
	CONSTRAINT "connections_authorization_class_check" CHECK ("ops"."connections"."authorization_class" = 'read_only'),
	CONSTRAINT "connections_status_check" CHECK ("ops"."connections"."status" in ('pending', 'active', 'reauthorization_required', 'disabled', 'revoked')),
	CONSTRAINT "connections_generation_check" CHECK ("ops"."connections"."credential_generation" >= 0),
	CONSTRAINT "connections_authorization_check" CHECK (("ops"."connections"."status" = 'pending' and "ops"."connections"."authorized_at" is null and "ops"."connections"."credential_generation" = 0)
		or ("ops"."connections"."status" = 'revoked' and "ops"."connections"."credential_generation" >= 0)
		or ("ops"."connections"."status" not in ('pending', 'revoked') and "ops"."connections"."credential_generation" > 0)),
	CONSTRAINT "connections_expiry_check" CHECK ("ops"."connections"."expires_at" is null or "ops"."connections"."authorized_at" is null or "ops"."connections"."expires_at" > "ops"."connections"."authorized_at")
);
--> statement-breakpoint
CREATE TABLE "ops"."discovered_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_source_id" uuid NOT NULL,
	"source" text NOT NULL,
	"provider_account_id_ciphertext" text NOT NULL,
	"provider_account_id_nonce" text NOT NULL,
	"provider_account_id_digest" text NOT NULL,
	"encryption_algorithm" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"digest_key_id" text NOT NULL,
	"key_status" text NOT NULL,
	"status" text NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "discovered_accounts_source_check" CHECK ("ops"."discovered_accounts"."source" in ('simplefin', 'teller', 'schwab', 'snaptrade')),
	CONSTRAINT "discovered_accounts_algorithm_check" CHECK ("ops"."discovered_accounts"."encryption_algorithm" = 'xchacha20-poly1305-ietf'),
	CONSTRAINT "discovered_accounts_key_status_check" CHECK ("ops"."discovered_accounts"."key_status" = 'active'),
	CONSTRAINT "discovered_accounts_status_check" CHECK ("ops"."discovered_accounts"."status" in ('active', 'retired')),
	CONSTRAINT "discovered_accounts_envelope_check" CHECK (length("ops"."discovered_accounts"."provider_account_id_ciphertext") > 0 and length("ops"."discovered_accounts"."provider_account_id_nonce") > 0 and length("ops"."discovered_accounts"."provider_account_id_digest") > 0 and length(btrim("ops"."discovered_accounts"."encryption_key_id")) > 0 and length(btrim("ops"."discovered_accounts"."digest_key_id")) > 0),
	CONSTRAINT "discovered_accounts_time_check" CHECK ("ops"."discovered_accounts"."first_observed_at" <= "ops"."discovered_accounts"."last_observed_at")
);
--> statement-breakpoint
CREATE TABLE "ops"."sync_checkpoints" (
	"connection_id" uuid NOT NULL,
	"feed" text NOT NULL,
	"credential_generation" bigint NOT NULL,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"lease_owner_id" uuid,
	"lease_acquired_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"cursor_encryption_algorithm" text,
	"cursor_encryption_key_id" text,
	"cursor_key_status" text,
	"cursor_nonce" text,
	"cursor_ciphertext" text,
	"advanced_at" timestamp with time zone,
	CONSTRAINT "sync_checkpoints_connection_id_feed_pk" PRIMARY KEY("connection_id","feed"),
	CONSTRAINT "sync_checkpoints_feed_check" CHECK ("ops"."sync_checkpoints"."feed" in ('discovery', 'balances', 'transactions', 'positions')),
	CONSTRAINT "sync_checkpoints_generation_check" CHECK ("ops"."sync_checkpoints"."credential_generation" >= 0 and "ops"."sync_checkpoints"."fencing_token" >= 0),
	CONSTRAINT "sync_checkpoints_lease_check" CHECK (num_nonnulls("ops"."sync_checkpoints"."lease_owner_id", "ops"."sync_checkpoints"."lease_acquired_at", "ops"."sync_checkpoints"."lease_expires_at") in (0, 3)
        and ("ops"."sync_checkpoints"."lease_expires_at" is null or "ops"."sync_checkpoints"."lease_expires_at" > "ops"."sync_checkpoints"."lease_acquired_at")),
	CONSTRAINT "sync_checkpoints_cursor_check" CHECK (num_nonnulls("ops"."sync_checkpoints"."cursor_encryption_algorithm", "ops"."sync_checkpoints"."cursor_encryption_key_id", "ops"."sync_checkpoints"."cursor_key_status", "ops"."sync_checkpoints"."cursor_nonce", "ops"."sync_checkpoints"."cursor_ciphertext") in (0, 5))
);
--> statement-breakpoint
CREATE TABLE "ops"."sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"feed" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"status" text NOT NULL,
	"reason_code" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "sync_runs_feed_check" CHECK ("ops"."sync_runs"."feed" in ('discovery', 'balances', 'transactions', 'positions')),
	CONSTRAINT "sync_runs_status_check" CHECK ("ops"."sync_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "sync_runs_reason_check" CHECK (length(btrim("ops"."sync_runs"."reason_code")) > 0),
	CONSTRAINT "sync_runs_attempt_check" CHECK ("ops"."sync_runs"."attempt_count" > 0 and "ops"."sync_runs"."fencing_token" > 0),
	CONSTRAINT "sync_runs_time_check" CHECK ("ops"."sync_runs"."completed_at" is null or "ops"."sync_runs"."completed_at" >= "ops"."sync_runs"."started_at")
);
--> statement-breakpoint
ALTER TABLE "ops"."connection_events" ADD CONSTRAINT "connection_events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "ops"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."connection_secrets" ADD CONSTRAINT "connection_secrets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "ops"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."discovered_accounts" ADD CONSTRAINT "discovered_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "ops"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."discovered_accounts" ADD CONSTRAINT "discovered_accounts_account_source_id_account_sources_id_fk" FOREIGN KEY ("account_source_id") REFERENCES "ledger"."account_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "ops"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "ops"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_events_connection_idx" ON "ops"."connection_events" USING btree ("connection_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_accounts_provider_unique" ON "ops"."discovered_accounts" USING btree ("connection_id","digest_key_id","provider_account_id_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_accounts_active_source_unique" ON "ops"."discovered_accounts" USING btree ("account_source_id") WHERE "ops"."discovered_accounts"."status" = 'active';
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'meridian_ops_control') THEN
		RAISE EXCEPTION 'database role meridian_ops_control must be provisioned before migration';
	END IF;
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'meridian_read_worker') THEN
		RAISE EXCEPTION 'database role meridian_read_worker must be provisioned before migration';
	END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."reject_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = format('ops.connection_events is append-only; %s is forbidden', TG_OP);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."validate_connection_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.status = 'revoked' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'a revoked connection is terminal';
	END IF;

	IF NEW.id <> OLD.id OR NEW.source <> OLD.source OR NEW.authorization_class <> OLD.authorization_class OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'stable connection identity cannot change';
	END IF;

	IF NEW.credential_generation < OLD.credential_generation OR NEW.credential_generation > OLD.credential_generation + 1 THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'credential generation must be unchanged or advance by one';
	END IF;

	IF NEW.credential_generation = OLD.credential_generation + 1 THEN
		IF NEW.status <> 'active' OR OLD.status NOT IN ('pending', 'active', 'reauthorization_required') THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'credential generation may advance only while authorizing an eligible connection';
		END IF;
	ELSIF NOT (
		(OLD.status = 'active' AND NEW.status IN ('reauthorization_required', 'disabled', 'revoked'))
		OR (OLD.status = 'disabled' AND NEW.status IN ('active', 'revoked'))
		OR (OLD.status = 'reauthorization_required' AND NEW.status = 'revoked')
		OR (OLD.status = 'pending' AND NEW.status = 'revoked')
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'illegal connection lifecycle transition';
	END IF;

	IF NEW.updated_at < OLD.updated_at THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'connection update time cannot move backward';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."validate_connection_credential_state"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
DECLARE
	connection_row ops.connections%ROWTYPE;
	secret_generation bigint;
	target_connection_id uuid;
BEGIN
	IF TG_TABLE_NAME = 'connections' THEN
		target_connection_id := COALESCE(NEW.id, OLD.id);
	ELSE
		target_connection_id := COALESCE(NEW.connection_id, OLD.connection_id);
	END IF;
	SELECT * INTO connection_row
	FROM ops.connections
	WHERE id = target_connection_id;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	SELECT credential_generation INTO secret_generation
	FROM ops.connection_secrets
	WHERE connection_id = connection_row.id;

	IF connection_row.status IN ('pending', 'revoked') THEN
		IF secret_generation IS NOT NULL THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'pending or revoked connection cannot retain a credential';
		END IF;
	ELSIF secret_generation IS NULL OR secret_generation <> connection_row.credential_generation THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'connection credential generation does not match current connection state';
	END IF;

	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."validate_discovered_account"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, ledger
AS $$
DECLARE
	connection_source text;
	account_source_name text;
	account_source_kind text;
BEGIN
	SELECT source INTO connection_source FROM ops.connections WHERE id = NEW.connection_id;
	SELECT source, source_kind INTO account_source_name, account_source_kind
	FROM ledger.account_sources WHERE id = NEW.account_source_id;

	IF connection_source IS NULL OR account_source_name IS NULL THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'discovered account references an unknown connection or account source';
	END IF;
	IF NEW.source <> connection_source OR NEW.source <> account_source_name OR account_source_kind <> 'connector' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'discovered account source must match a connector account source and connection';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."validate_connection_event_state"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
DECLARE
	expected_event_type text;
	expected_reason text;
	expected_generation bigint;
BEGIN
	IF TG_OP = 'INSERT' THEN
		expected_event_type := 'connection_created';
		expected_reason := 'pending_authorization';
		expected_generation := NULL;
	ELSIF NEW.credential_generation = OLD.credential_generation + 1 THEN
		expected_generation := OLD.credential_generation;
		IF OLD.status = 'active' THEN
			expected_event_type := 'credential_refreshed';
			expected_reason := 'credential_refreshed';
		ELSE
			expected_event_type := 'authorization_installed';
			expected_reason := 'authorization_installed';
		END IF;
	ELSE
		expected_generation := OLD.credential_generation;
		CASE NEW.status
			WHEN 'reauthorization_required' THEN expected_event_type := 'reauthorization_required';
			WHEN 'disabled' THEN expected_event_type := 'connection_disabled';
			WHEN 'active' THEN
				expected_event_type := 'connection_reenabled';
				expected_reason := 'credential_revalidated';
			WHEN 'revoked' THEN expected_event_type := 'connection_revoked';
			ELSE RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'connection transition has no security event mapping';
		END CASE;
		IF expected_reason IS NULL THEN
			expected_reason := NEW.status_reason;
		END IF;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM ops.connection_events event
		WHERE event.connection_id = NEW.id
			AND event.event_type = expected_event_type
			AND event.expected_credential_generation IS NOT DISTINCT FROM expected_generation
			AND event.resulting_credential_generation = NEW.credential_generation
			AND event.reason_code = expected_reason
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'connection lifecycle transition requires a matching security event';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "connections_validate_transition"
BEFORE UPDATE ON "ops"."connections"
FOR EACH ROW EXECUTE FUNCTION "ops"."validate_connection_transition"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "connections_validate_credential_state"
AFTER INSERT OR UPDATE ON "ops"."connections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ops"."validate_connection_credential_state"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "connection_secrets_validate_state"
AFTER INSERT OR UPDATE OR DELETE ON "ops"."connection_secrets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ops"."validate_connection_credential_state"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "connections_validate_event_state"
AFTER INSERT OR UPDATE ON "ops"."connections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ops"."validate_connection_event_state"();
--> statement-breakpoint
CREATE TRIGGER "discovered_accounts_validate_source"
BEFORE INSERT OR UPDATE ON "ops"."discovered_accounts"
FOR EACH ROW EXECUTE FUNCTION "ops"."validate_discovered_account"();
--> statement-breakpoint
CREATE TRIGGER "connection_events_reject_mutation"
BEFORE UPDATE OR DELETE ON "ops"."connection_events"
FOR EACH ROW EXECUTE FUNCTION "ops"."reject_event_mutation"();
--> statement-breakpoint
ALTER TABLE "ops"."connection_events" ENABLE ALWAYS TRIGGER "connection_events_reject_mutation";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "ops"."reject_event_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ops"."validate_connection_transition"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ops"."validate_connection_credential_state"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ops"."validate_discovered_account"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "ops"."validate_connection_event_state"() FROM PUBLIC;
REVOKE ALL ON SCHEMA "ops" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA "ops" FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "ops" FROM PUBLIC;
GRANT USAGE ON SCHEMA "ops" TO "meridian_ops_control", "meridian_read_worker";
GRANT SELECT ON "ops"."connections", "ops"."discovered_accounts", "ops"."sync_runs", "ops"."connection_events" TO "meridian_ops_control";
GRANT SELECT (connection_id, credential_generation) ON "ops"."connection_secrets" TO "meridian_ops_control";
GRANT SELECT ON "ops"."connections", "ops"."connection_secrets", "ops"."discovered_accounts", "ops"."sync_checkpoints", "ops"."sync_runs", "ops"."connection_events" TO "meridian_read_worker";
GRANT INSERT ON "ops"."connections", "ops"."discovered_accounts" TO "meridian_ops_control";
GRANT INSERT ON "ops"."connection_secrets", "ops"."discovered_accounts", "ops"."sync_checkpoints", "ops"."sync_runs" TO "meridian_read_worker";
GRANT INSERT (id, connection_id, event_type, expected_credential_generation, resulting_credential_generation, actor_class, reason_code)
	ON "ops"."connection_events" TO "meridian_ops_control", "meridian_read_worker";
GRANT UPDATE (status, status_reason, credential_generation, authorized_at, expires_at, updated_at) ON "ops"."connections" TO "meridian_ops_control", "meridian_read_worker";
GRANT UPDATE (credential_generation, encryption_algorithm, encryption_key_id, key_status, nonce, ciphertext, updated_at) ON "ops"."connection_secrets" TO "meridian_ops_control", "meridian_read_worker";
GRANT INSERT ON "ops"."connection_secrets" TO "meridian_ops_control";
GRANT DELETE ON "ops"."connection_secrets" TO "meridian_ops_control", "meridian_read_worker";
GRANT UPDATE (status, last_observed_at) ON "ops"."discovered_accounts" TO "meridian_ops_control", "meridian_read_worker";
GRANT UPDATE ON "ops"."sync_checkpoints", "ops"."sync_runs" TO "meridian_read_worker";
