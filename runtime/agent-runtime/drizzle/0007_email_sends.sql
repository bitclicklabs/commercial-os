-- Email-ops (LLD v0.1 sección 10.1): envíos observados desde Twenty (emailStatus -> SENT).
-- Generada con drizzle-kit. Idempotente (IF NOT EXISTS) para poder aplicarla a mano en una
-- BD compartida sin registrar fila en __drizzle_migrations.
CREATE TABLE IF NOT EXISTS "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"hypothesis_id" text NOT NULL,
	"company_id" text,
	"to_email" text NOT NULL,
	"to_domain" text,
	"subject" text,
	"sent_at" timestamp with time zone NOT NULL,
	"workspace_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_sends_dedupe_uq" ON "email_sends" USING btree ("tenant_id","hypothesis_id","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_sends_tenant_sent_idx" ON "email_sends" USING btree ("tenant_id","sent_at");--> statement-breakpoint
-- Escrita a mano: sin borrado físico (sección 22). Un envío que ya salió no se deshace.
CREATE OR REPLACE FUNCTION "email_sends_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'email_sends: DELETE is not allowed (append-only log of sent emails)';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "email_sends_no_delete" BEFORE DELETE ON "email_sends" FOR EACH ROW EXECUTE FUNCTION "email_sends_forbid_delete"();
