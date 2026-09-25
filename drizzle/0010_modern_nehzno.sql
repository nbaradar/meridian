DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM ops.connections)
		OR EXISTS (SELECT 1 FROM ops.discovered_accounts) THEN
		RAISE EXCEPTION 'operational hardening requires an empty pre-live ops control plane';
	END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "ops"."connection_secrets" DROP CONSTRAINT "connection_secrets_envelope_check";--> statement-breakpoint
ALTER TABLE "ops"."discovered_accounts" DROP CONSTRAINT "discovered_accounts_envelope_check";--> statement-breakpoint
ALTER TABLE "ops"."sync_checkpoints" DROP CONSTRAINT "sync_checkpoints_cursor_check";--> statement-breakpoint
ALTER TABLE "ops"."connections" ADD COLUMN "last_operation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."discovered_accounts" ADD COLUMN "credential_generation" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."discovered_accounts" ADD COLUMN "discovery_fencing_token" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."discovered_accounts" ADD COLUMN "lease_owner_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ops"."connection_secrets" ADD CONSTRAINT "connection_secrets_envelope_check" CHECK (length(btrim("ops"."connection_secrets"."encryption_key_id")) > 0
        and "ops"."connection_secrets"."nonce" ~ '^[A-Za-z0-9+/]+={0,2}$'
        and octet_length(decode("ops"."connection_secrets"."nonce", 'base64')) = 24
        and "ops"."connection_secrets"."ciphertext" ~ '^[A-Za-z0-9+/]+={0,2}$'
        and octet_length(decode("ops"."connection_secrets"."ciphertext", 'base64')) >= 16);--> statement-breakpoint
ALTER TABLE "ops"."discovered_accounts" ADD CONSTRAINT "discovered_accounts_generation_check" CHECK ("ops"."discovered_accounts"."credential_generation" > 0 and "ops"."discovered_accounts"."discovery_fencing_token" > 0);--> statement-breakpoint
ALTER TABLE "ops"."discovered_accounts" ADD CONSTRAINT "discovered_accounts_envelope_check" CHECK ("ops"."discovered_accounts"."provider_account_id_nonce" ~ '^[A-Za-z0-9+/]+={0,2}$'
        and octet_length(decode("ops"."discovered_accounts"."provider_account_id_nonce", 'base64')) = 24
        and "ops"."discovered_accounts"."provider_account_id_ciphertext" ~ '^[A-Za-z0-9+/]+={0,2}$'
        and octet_length(decode("ops"."discovered_accounts"."provider_account_id_ciphertext", 'base64')) >= 16
        and "ops"."discovered_accounts"."provider_account_id_digest" ~ '^[0-9a-f]{64}$'
        and length(btrim("ops"."discovered_accounts"."encryption_key_id")) > 0
        and length(btrim("ops"."discovered_accounts"."digest_key_id")) > 0);--> statement-breakpoint
ALTER TABLE "ops"."sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_cursor_check" CHECK (num_nonnulls("ops"."sync_checkpoints"."cursor_encryption_algorithm", "ops"."sync_checkpoints"."cursor_encryption_key_id", "ops"."sync_checkpoints"."cursor_key_status", "ops"."sync_checkpoints"."cursor_nonce", "ops"."sync_checkpoints"."cursor_ciphertext") in (0, 5)
        and ("ops"."sync_checkpoints"."cursor_encryption_algorithm" is null or (
          "ops"."sync_checkpoints"."cursor_encryption_algorithm" = 'xchacha20-poly1305-ietf'
          and "ops"."sync_checkpoints"."cursor_key_status" = 'active'
          and "ops"."sync_checkpoints"."cursor_nonce" ~ '^[A-Za-z0-9+/]+={0,2}$'
          and octet_length(decode("ops"."sync_checkpoints"."cursor_nonce", 'base64')) = 24
          and "ops"."sync_checkpoints"."cursor_ciphertext" ~ '^[A-Za-z0-9+/]+={0,2}$'
          and octet_length(decode("ops"."sync_checkpoints"."cursor_ciphertext", 'base64')) >= 16
        )));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ops"."validate_connection_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	required_role text;
BEGIN
	IF OLD.status = 'revoked' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'a revoked connection is terminal';
	END IF;
	IF NEW.id <> OLD.id OR NEW.source <> OLD.source OR NEW.authorization_class <> OLD.authorization_class OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'stable connection identity cannot change';
	END IF;
	IF NEW.last_operation_id = OLD.last_operation_id THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'a connection transition requires a new operation ID';
	END IF;
	IF NEW.credential_generation = OLD.credential_generation AND (
		NEW.authorized_at IS DISTINCT FROM OLD.authorized_at
		OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'same-generation transition cannot alter authorization validity';
	END IF;
	IF NEW.credential_generation < OLD.credential_generation OR NEW.credential_generation > OLD.credential_generation + 1 THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'credential generation must be unchanged or advance by one';
	END IF;

	IF NEW.credential_generation = OLD.credential_generation + 1 THEN
		IF NEW.status <> 'active' OR OLD.status NOT IN ('pending', 'active', 'reauthorization_required') THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'credential generation may advance only while authorizing an eligible connection';
		END IF;
		required_role := CASE WHEN OLD.status = 'active' THEN 'meridian_read_worker' ELSE 'meridian_ops_control' END;
	ELSIF OLD.status = 'active' AND NEW.status = 'reauthorization_required' THEN
		required_role := 'meridian_read_worker';
	ELSIF OLD.status = 'active' AND NEW.status IN ('disabled', 'revoked') THEN
		required_role := 'meridian_ops_control';
	ELSIF OLD.status = 'disabled' AND NEW.status = 'active' THEN
		IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= clock_timestamp() THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an expired credential cannot be re-enabled';
		END IF;
		required_role := 'meridian_read_worker';
	ELSIF OLD.status IN ('pending', 'reauthorization_required', 'disabled') AND NEW.status = 'revoked' THEN
		required_role := 'meridian_ops_control';
	ELSE
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'illegal connection lifecycle transition';
	END IF;

	IF session_user <> required_role THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'database role is not authorized for this connection transition';
	END IF;
	IF NEW.updated_at < OLD.updated_at THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'connection update time cannot move backward';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ops"."validate_connection_event_state"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
DECLARE
	expected_event_type text;
	expected_reason text;
	expected_actor text;
	expected_generation bigint;
BEGIN
	IF TG_OP = 'INSERT' THEN
		expected_event_type := 'connection_created';
		expected_reason := 'pending_authorization';
		expected_actor := 'owner';
		expected_generation := NULL;
	ELSIF NEW.credential_generation = OLD.credential_generation + 1 THEN
		expected_generation := OLD.credential_generation;
		IF OLD.status = 'active' THEN
			expected_event_type := 'credential_refreshed';
			expected_reason := 'credential_refreshed';
			expected_actor := 'read_worker';
		ELSE
			expected_event_type := 'authorization_installed';
			expected_reason := 'authorization_installed';
			expected_actor := 'owner';
		END IF;
	ELSE
		expected_generation := OLD.credential_generation;
		CASE NEW.status
			WHEN 'reauthorization_required' THEN
				expected_event_type := 'reauthorization_required'; expected_actor := 'read_worker';
			WHEN 'disabled' THEN expected_event_type := 'connection_disabled'; expected_actor := 'owner';
			WHEN 'active' THEN
				expected_event_type := 'connection_reenabled'; expected_reason := 'credential_revalidated'; expected_actor := 'read_worker';
			WHEN 'revoked' THEN expected_event_type := 'connection_revoked'; expected_actor := 'owner';
			ELSE RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'connection transition has no security event mapping';
		END CASE;
		IF expected_reason IS NULL THEN expected_reason := NEW.status_reason; END IF;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM ops.connection_events event
		WHERE event.id = NEW.last_operation_id
			AND event.connection_id = NEW.id
			AND event.event_type = expected_event_type
			AND event.expected_credential_generation IS NOT DISTINCT FROM expected_generation
			AND event.resulting_credential_generation = NEW.credential_generation
			AND event.actor_class = expected_actor
			AND event.reason_code = expected_reason
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'connection lifecycle transition requires its matching security event';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."authorize_connection_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF session_user = 'meridian_ops_control' THEN
		IF NEW.actor_class <> 'owner' OR NEW.event_type NOT IN ('connection_created', 'authorization_installed', 'connection_disabled', 'connection_revoked') THEN
			RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ops control role cannot record this connection event';
		END IF;
	ELSIF session_user = 'meridian_read_worker' THEN
		IF NEW.actor_class <> 'read_worker' OR NEW.event_type NOT IN ('credential_refreshed', 'reauthorization_required', 'connection_reenabled') THEN
			RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'read worker role cannot record this connection event';
		END IF;
	ELSE
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'database role cannot record connection events';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."validate_inserted_connection_event"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM ops.connections connection
		WHERE connection.id = NEW.connection_id
			AND connection.last_operation_id = NEW.id
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'security event must be the current connection operation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."validate_connection_secret_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
DECLARE
	connection_row ops.connections%ROWTYPE;
	event_row ops.connection_events%ROWTYPE;
BEGIN
	SELECT * INTO connection_row FROM ops.connections
	WHERE id = COALESCE(NEW.connection_id, OLD.connection_id);
	SELECT * INTO event_row FROM ops.connection_events
	WHERE id = connection_row.last_operation_id;

	IF TG_OP = 'DELETE' THEN
		IF session_user <> 'meridian_ops_control' OR connection_row.status <> 'revoked' OR event_row.event_type <> 'connection_revoked' THEN
			RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'credential deletion requires an owner revocation';
		END IF;
		RETURN OLD;
	END IF;
	IF TG_OP = 'UPDATE' AND NEW.credential_generation <> OLD.credential_generation + 1 THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'credential replacement must advance generation by one';
	END IF;
	IF NEW.credential_generation <> connection_row.credential_generation OR connection_row.status <> 'active' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'credential envelope must match the active connection generation';
	END IF;
	IF session_user = 'meridian_ops_control' THEN
		IF event_row.event_type <> 'authorization_installed' OR event_row.actor_class <> 'owner' THEN
			RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ops control may only install reviewed authorization';
		END IF;
	ELSIF session_user = 'meridian_read_worker' THEN
		IF TG_OP <> 'UPDATE' OR event_row.event_type <> 'credential_refreshed' OR event_row.actor_class <> 'read_worker' THEN
			RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'read worker may only refresh an existing credential';
		END IF;
	ELSE
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'database role cannot mutate credentials';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."credential_envelope_matches"(
	connection_id uuid,
	credential_generation bigint,
	encryption_algorithm text,
	encryption_key_id text,
	key_status text,
	nonce text,
	ciphertext text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
	SELECT EXISTS (
		SELECT 1 FROM ops.connection_secrets secret
		WHERE secret.connection_id = credential_envelope_matches.connection_id
			AND secret.credential_generation = credential_envelope_matches.credential_generation
			AND secret.encryption_algorithm = credential_envelope_matches.encryption_algorithm
			AND secret.encryption_key_id = credential_envelope_matches.encryption_key_id
			AND secret.key_status = credential_envelope_matches.key_status
			AND secret.nonce = credential_envelope_matches.nonce
			AND secret.ciphertext = credential_envelope_matches.ciphertext
	);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ops"."validate_discovered_account"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, ledger
AS $$
DECLARE
	connection_source text;
	connection_status text;
	connection_generation bigint;
	account_source_name text;
	account_source_kind text;
BEGIN
	IF session_user <> 'meridian_ops_control' THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'only ops control may persist reviewed discovery';
	END IF;
	SELECT source, status, credential_generation
	INTO connection_source, connection_status, connection_generation
	FROM ops.connections WHERE id = NEW.connection_id
	FOR UPDATE;
	SELECT source, source_kind INTO account_source_name, account_source_kind
	FROM ledger.account_sources WHERE id = NEW.account_source_id;

	IF connection_source IS NULL OR account_source_name IS NULL THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'discovered account references an unknown connection or account source';
	END IF;
	IF NEW.source <> connection_source OR NEW.source <> account_source_name OR account_source_kind <> 'connector' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'discovered account source must match a connector account source and connection';
	END IF;
	IF connection_status <> 'active' OR connection_generation <> NEW.credential_generation THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'discovered account generation is no longer active';
	END IF;
	PERFORM 1 FROM ops.sync_checkpoints checkpoint
		WHERE checkpoint.connection_id = NEW.connection_id
			AND checkpoint.feed = 'discovery'
			AND checkpoint.credential_generation = NEW.credential_generation
			AND checkpoint.fencing_token = NEW.discovery_fencing_token
			AND checkpoint.lease_owner_id = NEW.lease_owner_id
			AND checkpoint.lease_expires_at > clock_timestamp()
	FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'discovered account requires the current unexpired discovery fence';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ops"."validate_sync_checkpoint_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
DECLARE
	connection_row ops.connections%ROWTYPE;
	now_at timestamptz := clock_timestamp();
BEGIN
	IF session_user <> 'meridian_read_worker' THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'only read worker may mutate sync checkpoints';
	END IF;
	IF NEW.feed <> 'discovery' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'only discovery checkpoints are enabled';
	END IF;
	SELECT * INTO connection_row FROM ops.connections WHERE id = NEW.connection_id;
	IF connection_row.status <> 'active' OR connection_row.credential_generation <> NEW.credential_generation OR (connection_row.expires_at IS NOT NULL AND connection_row.expires_at <= now_at) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'checkpoint requires an active unexpired connection generation';
	END IF;
	IF TG_OP = 'INSERT' THEN
		IF NEW.fencing_token <> 0 OR NEW.lease_owner_id IS NOT NULL OR NEW.cursor_ciphertext IS NOT NULL THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new checkpoint must begin without a lease or cursor';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.connection_id <> OLD.connection_id OR NEW.feed <> OLD.feed THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'checkpoint identity cannot change';
	END IF;
	IF NEW.fencing_token = OLD.fencing_token + 1 THEN
		IF OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at > now_at THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an unexpired lease cannot be taken over';
		END IF;
		IF NEW.lease_owner_id IS NULL OR NEW.lease_acquired_at IS NULL OR NEW.lease_expires_at IS NULL
			OR abs(extract(epoch from (NEW.lease_acquired_at - now_at))) > 5
			OR NEW.lease_expires_at <= NEW.lease_acquired_at
			OR NEW.lease_expires_at > NEW.lease_acquired_at + interval '15 minutes'
			OR NEW.cursor_encryption_algorithm IS DISTINCT FROM OLD.cursor_encryption_algorithm
			OR NEW.cursor_encryption_key_id IS DISTINCT FROM OLD.cursor_encryption_key_id
			OR NEW.cursor_key_status IS DISTINCT FROM OLD.cursor_key_status
			OR NEW.cursor_nonce IS DISTINCT FROM OLD.cursor_nonce
			OR NEW.cursor_ciphertext IS DISTINCT FROM OLD.cursor_ciphertext
			OR NEW.advanced_at IS DISTINCT FROM OLD.advanced_at THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid fenced lease acquisition';
		END IF;
	ELSIF NEW.fencing_token = OLD.fencing_token THEN
		IF NEW.lease_owner_id IS DISTINCT FROM OLD.lease_owner_id
			OR NEW.lease_acquired_at IS DISTINCT FROM OLD.lease_acquired_at
			OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
			OR NEW.credential_generation <> OLD.credential_generation
			OR OLD.lease_expires_at <= now_at
			OR NEW.advanced_at IS NULL
			OR abs(extract(epoch from (NEW.advanced_at - now_at))) > 5 THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid fenced checkpoint advancement';
		END IF;
	ELSE
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fencing token must remain stable or advance by one';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "connection_events_authorize_insert"
BEFORE INSERT ON ops.connection_events
FOR EACH ROW EXECUTE FUNCTION ops.authorize_connection_event();
CREATE CONSTRAINT TRIGGER "connection_events_validate_connection"
AFTER INSERT ON ops.connection_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ops.validate_inserted_connection_event();
CREATE TRIGGER "connection_secrets_validate_mutation"
BEFORE INSERT OR UPDATE OR DELETE ON ops.connection_secrets
FOR EACH ROW EXECUTE FUNCTION ops.validate_connection_secret_mutation();
CREATE TRIGGER "sync_checkpoints_validate_mutation"
BEFORE INSERT OR UPDATE ON ops.sync_checkpoints
FOR EACH ROW EXECUTE FUNCTION ops.validate_sync_checkpoint_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops.authorize_connection_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.validate_inserted_connection_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.validate_connection_secret_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.validate_sync_checkpoint_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.credential_envelope_matches(uuid, bigint, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.credential_envelope_matches(uuid, bigint, text, text, text, text, text) TO meridian_ops_control, meridian_read_worker;
REVOKE INSERT, UPDATE, DELETE ON ops.sync_runs FROM meridian_read_worker;
REVOKE DELETE ON ops.connection_secrets FROM meridian_read_worker;
GRANT UPDATE (last_operation_id) ON ops.connections TO meridian_ops_control, meridian_read_worker;
GRANT UPDATE (last_succeeded_at) ON ops.connections TO meridian_read_worker;
GRANT INSERT (credential_generation, discovery_fencing_token, lease_owner_id)
	ON ops.discovered_accounts TO meridian_ops_control;
GRANT UPDATE (
	credential_generation, discovery_fencing_token, lease_owner_id,
	provider_account_id_ciphertext, provider_account_id_nonce,
	encryption_algorithm, encryption_key_id, key_status, last_observed_at
) ON ops.discovered_accounts TO meridian_ops_control;
--> statement-breakpoint
CREATE TRIGGER "connection_events_reject_truncate"
BEFORE TRUNCATE ON ops.connection_events
FOR EACH STATEMENT EXECUTE FUNCTION ops.reject_event_mutation();
ALTER TABLE ops.connection_events ENABLE ALWAYS TRIGGER "connection_events_reject_truncate";
--> statement-breakpoint
CREATE TRIGGER "accounts_reject_truncate" BEFORE TRUNCATE ON ledger.accounts FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "account_revisions_reject_truncate" BEFORE TRUNCATE ON ledger.account_revisions FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "categories_reject_truncate" BEFORE TRUNCATE ON ledger.categories FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "category_revisions_reject_truncate" BEFORE TRUNCATE ON ledger.category_revisions FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "raw_payloads_reject_truncate" BEFORE TRUNCATE ON ledger.raw_payloads FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "imports_reject_truncate" BEFORE TRUNCATE ON ledger.imports FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "source_records_reject_truncate" BEFORE TRUNCATE ON ledger.source_records FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "transactions_reject_truncate" BEFORE TRUNCATE ON ledger.transactions FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "entries_reject_truncate" BEFORE TRUNCATE ON ledger.entries FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "account_sources_reject_truncate" BEFORE TRUNCATE ON ledger.account_sources FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "account_source_links_reject_truncate" BEFORE TRUNCATE ON ledger.account_source_link_revisions FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "source_record_account_sets_reject_truncate" BEFORE TRUNCATE ON ledger.source_record_account_sets FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER "source_record_accounts_reject_truncate" BEFORE TRUNCATE ON ledger.source_record_accounts FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
ALTER TABLE ledger.accounts ENABLE ALWAYS TRIGGER "accounts_reject_truncate";
ALTER TABLE ledger.account_revisions ENABLE ALWAYS TRIGGER "account_revisions_reject_truncate";
ALTER TABLE ledger.categories ENABLE ALWAYS TRIGGER "categories_reject_truncate";
ALTER TABLE ledger.category_revisions ENABLE ALWAYS TRIGGER "category_revisions_reject_truncate";
ALTER TABLE ledger.raw_payloads ENABLE ALWAYS TRIGGER "raw_payloads_reject_truncate";
ALTER TABLE ledger.imports ENABLE ALWAYS TRIGGER "imports_reject_truncate";
ALTER TABLE ledger.source_records ENABLE ALWAYS TRIGGER "source_records_reject_truncate";
ALTER TABLE ledger.transactions ENABLE ALWAYS TRIGGER "transactions_reject_truncate";
ALTER TABLE ledger.entries ENABLE ALWAYS TRIGGER "entries_reject_truncate";
ALTER TABLE ledger.account_sources ENABLE ALWAYS TRIGGER "account_sources_reject_truncate";
ALTER TABLE ledger.account_source_link_revisions ENABLE ALWAYS TRIGGER "account_source_links_reject_truncate";
ALTER TABLE ledger.source_record_account_sets ENABLE ALWAYS TRIGGER "source_record_account_sets_reject_truncate";
ALTER TABLE ledger.source_record_accounts ENABLE ALWAYS TRIGGER "source_record_accounts_reject_truncate";
