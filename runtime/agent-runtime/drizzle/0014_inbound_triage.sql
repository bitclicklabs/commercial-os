-- Inbound Manager (LLD v0.1 sección 10.2): triaje general del buzón. Una fila por mensaje
-- triado por el InboxAgent (clase, confianza, método RULES|LLM, señales, empresa/hipótesis
-- enlazada, nota creada). message_key = Message-ID (o sha256 del fuente): un mensaje se triaja
-- una sola vez. Sin contenido del cuerpo: solo el asunto saneado y las señales.
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Numerada 0014 con "when" 1791450000000 (> 0013).
CREATE TABLE IF NOT EXISTS "inbound_triage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"message_key" text NOT NULL,
	"message_id" text,
	"mailbox" text NOT NULL,
	"uid_validity" bigint NOT NULL,
	"uid" bigint NOT NULL,
	"received_at" timestamp with time zone,
	"from_email" text,
	"from_domain" text,
	"subject" text,
	"class" text NOT NULL,
	"confidence" numeric(4, 3),
	"method" text NOT NULL,
	"signals" text[] DEFAULT '{}'::text[] NOT NULL,
	"company_id" text,
	"hypothesis_id" text,
	"send_id" uuid,
	"match_by" text,
	"note_id" text,
	"suppression_added" boolean DEFAULT false NOT NULL,
	"event_id" uuid,
	"execution_id" text,
	"cost_eur" numeric(14, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_triage_class_ck" CHECK ("inbound_triage"."class" in ('BAJA', 'NO_INTERESADO', 'INTERESADO', 'PREGUNTA', 'AUTO_REPLY', 'REBOTE', 'OTRO')),
	CONSTRAINT "inbound_triage_method_ck" CHECK ("inbound_triage"."method" in ('RULES', 'LLM')),
	CONSTRAINT "inbound_triage_confidence_ck" CHECK ("inbound_triage"."confidence" is null or ("inbound_triage"."confidence" >= 0 and "inbound_triage"."confidence" <= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_triage_message_uq" ON "inbound_triage" USING btree ("tenant_id","message_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_triage_tenant_created_idx" ON "inbound_triage" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_triage_tenant_class_idx" ON "inbound_triage" USING btree ("tenant_id","class","created_at");
--> statement-breakpoint
-- Escrito a mano: append-only (sección 22). La fila registra lo que se hizo; no se edita ni se borra.
CREATE OR REPLACE FUNCTION "inbound_triage_forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'inbound_triage is append-only: % is not allowed', TG_OP;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "inbound_triage_no_update" BEFORE UPDATE ON "inbound_triage" FOR EACH ROW EXECUTE FUNCTION "inbound_triage_forbid_change"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "inbound_triage_no_delete" BEFORE DELETE ON "inbound_triage" FOR EACH ROW EXECUTE FUNCTION "inbound_triage_forbid_change"();
