-- Knowledge layer (LLD v0.1 secciones 6.4 y 16, MVP-1): memoria semántica mínima.
-- RAW EXPERIENCE -> KNOWLEDGE -> SKILL: nunca trace -> prompt directo. Solo las entradas ACTIVE
-- (con evidencia) de los knowledge_domains de un agente se inyectan en su prompt.
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Numerada 0009 (la 0008 es de feat/harness-v1, "when" 1791375700000): su "when" es mayor (ADR-31).
-- Sin DELETE físico; transiciones válidas y contenido inmutable fuera de PROPOSED/VALIDATED (triggers).
CREATE TABLE IF NOT EXISTS "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"domain" text NOT NULL,
	"topic" text NOT NULL,
	"statement" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"status_reason" text,
	"superseded_by" uuid,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_entries_status_ck" CHECK ("knowledge_entries"."status" in ('PROPOSED', 'VALIDATED', 'ACTIVE', 'SUPERSEDED', 'REJECTED')),
	CONSTRAINT "knowledge_entries_source_ck" CHECK ("knowledge_entries"."source" in ('human', 'experiment', 'agent_proposal')),
	CONSTRAINT "knowledge_entries_confidence_ck" CHECK ("knowledge_entries"."confidence" >= 0 and "knowledge_entries"."confidence" <= 1),
	CONSTRAINT "knowledge_entries_evidence_ck" CHECK (jsonb_typeof("knowledge_entries"."evidence") = 'array'),
	CONSTRAINT "knowledge_entries_active_evidence_ck" CHECK ("knowledge_entries"."status" <> 'ACTIVE' or jsonb_array_length("knowledge_entries"."evidence") > 0)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_superseded_by_knowledge_entries_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."knowledge_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_entries_active_idx" ON "knowledge_entries" USING btree ("tenant_id","status","domain");--> statement-breakpoint
-- Escrito a mano: sin borrado físico (sección 22). Una entrada se retira con SUPERSEDED o REJECTED.
CREATE OR REPLACE FUNCTION "knowledge_entries_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'knowledge_entries has no physical DELETE: supersede or reject instead';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "knowledge_entries_no_delete" BEFORE DELETE ON "knowledge_entries" FOR EACH ROW EXECUTE FUNCTION "knowledge_entries_forbid_delete"();--> statement-breakpoint
-- Transiciones: PROPOSED -> VALIDATED | ACTIVE | REJECTED; VALIDATED -> ACTIVE | REJECTED;
-- ACTIVE -> SUPERSEDED. SUPERSEDED y REJECTED son finales. Fuera de PROPOSED/VALIDATED el
-- contenido (statement, topic, domain, evidence, confidence, source, validez inicial) es inmutable:
-- cambiar un conocimiento ACTIVE = crear una entrada nueva y SUPERSEDED la anterior.
CREATE OR REPLACE FUNCTION "knowledge_entries_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
		RAISE EXCEPTION 'knowledge_entries: tenant_id, created_at and created_by are immutable';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'PROPOSED' AND NEW.status IN ('VALIDATED', 'ACTIVE', 'REJECTED'))
		OR (OLD.status = 'VALIDATED' AND NEW.status IN ('ACTIVE', 'REJECTED'))
		OR (OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED')
	) THEN
		RAISE EXCEPTION 'knowledge_entries: invalid transition % -> %', OLD.status, NEW.status;
	END IF;
	IF OLD.status NOT IN ('PROPOSED', 'VALIDATED') AND (
		NEW.domain IS DISTINCT FROM OLD.domain
		OR NEW.topic IS DISTINCT FROM OLD.topic
		OR NEW.statement IS DISTINCT FROM OLD.statement
		OR NEW.evidence IS DISTINCT FROM OLD.evidence
		OR NEW.confidence IS DISTINCT FROM OLD.confidence
		OR NEW.source IS DISTINCT FROM OLD.source
		OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
		OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
		OR NEW.metadata IS DISTINCT FROM OLD.metadata
	) THEN
		RAISE EXCEPTION 'knowledge_entries content is immutable once %: create a new entry and supersede this one', OLD.status;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "knowledge_entries_guard" BEFORE UPDATE ON "knowledge_entries" FOR EACH ROW EXECUTE FUNCTION "knowledge_entries_guard_update"();
