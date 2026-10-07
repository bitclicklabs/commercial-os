-- Puente de eventos con el exterior (LLD v0.1 sección 20): suscripciones de webhook salientes.
-- Generada con drizzle-kit (como 0005 y renombrada a 0006: la 0005 la reclama otra rama; el
-- journal salta del idx 4 al 6 hasta que se fusione). Idempotente (IF NOT EXISTS) para poder
-- aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
CREATE TABLE IF NOT EXISTS "event_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"target_url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_subscriptions_types_ck" CHECK (cardinality("event_subscriptions"."event_types") > 0),
	CONSTRAINT "event_subscriptions_url_ck" CHECK ("event_subscriptions"."target_url" ~ '^https?://')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_subscriptions_tenant_name_uq" ON "event_subscriptions" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_subscriptions_tenant_enabled_idx" ON "event_subscriptions" USING btree ("tenant_id","enabled");--> statement-breakpoint
-- Escrita a mano: sin borrado físico (sección 22). Una suscripción se apaga con enabled = false.
CREATE OR REPLACE FUNCTION "event_subscriptions_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'event_subscriptions: DELETE is not allowed (set enabled = false)';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "event_subscriptions_no_delete" BEFORE DELETE ON "event_subscriptions" FOR EACH ROW EXECUTE FUNCTION "event_subscriptions_forbid_delete"();
