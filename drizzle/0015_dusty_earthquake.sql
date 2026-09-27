CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TABLE "app"."inbox_item_states" (
	"item_key" text PRIMARY KEY NOT NULL,
	"item_version" text NOT NULL,
	"state" text NOT NULL,
	"snoozed_until" date,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbox_item_states_key_check" CHECK (length(btrim("app"."inbox_item_states"."item_key")) > 0 and char_length("app"."inbox_item_states"."item_key") <= 500),
	CONSTRAINT "inbox_item_states_version_check" CHECK (length(btrim("app"."inbox_item_states"."item_version")) > 0 and char_length("app"."inbox_item_states"."item_version") <= 500),
	CONSTRAINT "inbox_item_states_state_check" CHECK ("app"."inbox_item_states"."state" in ('snoozed', 'dismissed')),
	CONSTRAINT "inbox_item_states_snooze_check" CHECK (("app"."inbox_item_states"."state" = 'snoozed') = ("app"."inbox_item_states"."snoozed_until" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."inbox_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"account_id" uuid,
	"link" text,
	"due_on" date,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "inbox_tasks_title_check" CHECK (length(btrim("app"."inbox_tasks"."title")) > 0 and "app"."inbox_tasks"."title" = btrim("app"."inbox_tasks"."title") and char_length("app"."inbox_tasks"."title") <= 200),
	CONSTRAINT "inbox_tasks_note_check" CHECK ("app"."inbox_tasks"."note" is null or (length(btrim("app"."inbox_tasks"."note")) > 0 and char_length("app"."inbox_tasks"."note") <= 2000)),
	CONSTRAINT "inbox_tasks_link_check" CHECK ("app"."inbox_tasks"."link" is null or (
        char_length("app"."inbox_tasks"."link") <= 2048
        and "app"."inbox_tasks"."link" !~ '[[:space:][:cntrl:]\\]'
        and ("app"."inbox_tasks"."link" ~ '^/([^/]|$)' or "app"."inbox_tasks"."link" ~* '^https?://[^/]')
      )),
	CONSTRAINT "inbox_tasks_status_check" CHECK ("app"."inbox_tasks"."status" in ('open', 'done')),
	CONSTRAINT "inbox_tasks_completed_check" CHECK (("app"."inbox_tasks"."status" = 'done') = ("app"."inbox_tasks"."completed_at" is not null)),
	CONSTRAINT "inbox_tasks_time_check" CHECK ("app"."inbox_tasks"."updated_at" >= "app"."inbox_tasks"."created_at"
        and ("app"."inbox_tasks"."completed_at" is null or "app"."inbox_tasks"."completed_at" >= "app"."inbox_tasks"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "app"."inbox_tasks" ADD CONSTRAINT "inbox_tasks_account_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_tasks_status_idx" ON "app"."inbox_tasks" USING btree ("status");
--> statement-breakpoint
REVOKE ALL ON SCHEMA "app" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA "app" FROM PUBLIC;
GRANT USAGE ON SCHEMA "app" TO "meridian_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"app"."inbox_tasks",
	"app"."inbox_item_states"
TO "meridian_app";
