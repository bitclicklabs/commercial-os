-- Inbound Manager (LLD v0.1 sección 10.2), primera pieza: cursor IMAP del procesador de bajas.
-- Generada con drizzle-kit. Idempotente (IF NOT EXISTS) para poder aplicarla a mano en una
-- BD compartida sin registrar fila en __drizzle_migrations.
CREATE TABLE IF NOT EXISTS "inbound_state" (
	"tenant_id" text NOT NULL,
	"consumer" text NOT NULL,
	"mailbox" text NOT NULL,
	"uid_validity" bigint NOT NULL,
	"last_uid" bigint DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_state_pk" PRIMARY KEY("tenant_id","consumer","mailbox"),
	CONSTRAINT "inbound_state_last_uid_ck" CHECK ("inbound_state"."last_uid" >= 0)
);
