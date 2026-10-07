CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	"schema_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"producer" text NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key" text,
	"dispatched_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_source_ck" CHECK ("events"."source" in ('runtime', 'twenty', 'n8n'))
);
--> statement-breakpoint
CREATE INDEX "events_tenant_type_occurred_idx" ON "events" USING btree ("tenant_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_tenant_occurred_idx" ON "events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_correlation_idx" ON "events" USING btree ("tenant_id","correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_idem_uq" ON "events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "events_undispatched_idx" ON "events" USING btree ("created_at") WHERE "events"."dispatched_at" is null;--> statement-breakpoint
-- Hand-written: the event log is append-only (LLD section 22). UPDATE is allowed only for
-- dispatch bookkeeping; DELETE is rejected.
CREATE FUNCTION "events_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'events is append-only: DELETE is not allowed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "events_no_delete" BEFORE DELETE ON "events" FOR EACH ROW EXECUTE FUNCTION "events_forbid_delete"();
