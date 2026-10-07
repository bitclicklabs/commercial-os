-- Evaluation datasets (LLD v0.1 seccion 11.4 y P5, MVP-2): EvaluationDataset versionado con
-- splits TRAIN / VALIDATION / TEST y control de contaminacion (used_by).
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Numerada 0010 con "when" 1791375900000 (> 0009); la 0011 la reserva la rama de experiments (ADR-31).
-- Sin DELETE fisico. Un dataset solo cambia de estado; un caso es inmutable salvo used_by, que solo crece.
CREATE TABLE IF NOT EXISTS "evaluation_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"version" integer NOT NULL,
	"description" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"build_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "evaluation_datasets_status_ck" CHECK ("evaluation_datasets"."status" in ('DRAFT', 'ACTIVE', 'ARCHIVED')),
	CONSTRAINT "evaluation_datasets_version_ck" CHECK ("evaluation_datasets"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"split" text NOT NULL,
	"entity_key" text NOT NULL,
	"input" jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"difficulty" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"content_hash" text NOT NULL,
	"used_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_cases_dataset_id_evaluation_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."evaluation_datasets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "evaluation_cases_split_ck" CHECK ("evaluation_cases"."split" in ('TRAIN', 'VALIDATION', 'TEST')),
	CONSTRAINT "evaluation_cases_used_by_ck" CHECK (jsonb_typeof("evaluation_cases"."used_by") = 'array'),
	CONSTRAINT "evaluation_cases_origin_ck" CHECK ("evaluation_cases"."source"->>'origin' in ('harvested', 'synthetic', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_cases_dataset_hash_uq" ON "evaluation_cases" USING btree ("dataset_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_cases_dataset_split_idx" ON "evaluation_cases" USING btree ("dataset_id","split");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_cases_tenant_entity_idx" ON "evaluation_cases" USING btree ("tenant_id","entity_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_datasets_name_version_uq" ON "evaluation_datasets" USING btree ("tenant_id","name","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_datasets_tenant_domain_idx" ON "evaluation_datasets" USING btree ("tenant_id","domain","status");--> statement-breakpoint
-- Escrito a mano: sin borrado fisico (seccion 22). Un dataset se retira con ARCHIVED.
CREATE OR REPLACE FUNCTION "evaluation_datasets_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'evaluation_datasets has no physical DELETE: archive the version instead';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "evaluation_datasets_no_delete" BEFORE DELETE ON "evaluation_datasets" FOR EACH ROW EXECUTE FUNCTION "evaluation_datasets_forbid_delete"();--> statement-breakpoint
-- Una version es inmutable: re-cosechar crea una version nueva. Solo cambia el estado:
-- DRAFT -> ACTIVE | ARCHIVED; ACTIVE -> ARCHIVED. ARCHIVED es final.
CREATE OR REPLACE FUNCTION "evaluation_datasets_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.name IS DISTINCT FROM OLD.name
		OR NEW.domain IS DISTINCT FROM OLD.domain
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.description IS DISTINCT FROM OLD.description
		OR NEW.build_info IS DISTINCT FROM OLD.build_info
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
		RAISE EXCEPTION 'evaluation_datasets version is immutable: build a new version instead';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'ARCHIVED'))
		OR (OLD.status = 'ACTIVE' AND NEW.status = 'ARCHIVED')
	) THEN
		RAISE EXCEPTION 'evaluation_datasets: invalid transition % -> %', OLD.status, NEW.status;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "evaluation_datasets_guard" BEFORE UPDATE ON "evaluation_datasets" FOR EACH ROW EXECUTE FUNCTION "evaluation_datasets_guard_update"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "evaluation_cases_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'evaluation_cases has no physical DELETE: cases are immutable';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "evaluation_cases_no_delete" BEFORE DELETE ON "evaluation_cases" FOR EACH ROW EXECUTE FUNCTION "evaluation_cases_forbid_delete"();--> statement-breakpoint
-- Un caso solo se inserta en un dataset DRAFT del mismo tenant (una version ACTIVE o ARCHIVED
-- no gana casos: se construye otra).
CREATE OR REPLACE FUNCTION "evaluation_cases_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	ds record;
BEGIN
	SELECT tenant_id, status INTO ds FROM evaluation_datasets WHERE id = NEW.dataset_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'evaluation_cases: dataset % not found', NEW.dataset_id;
	END IF;
	IF ds.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
		RAISE EXCEPTION 'evaluation_cases: tenant_id must match the dataset tenant';
	END IF;
	IF ds.status <> 'DRAFT' THEN
		RAISE EXCEPTION 'evaluation_cases: dataset is % (cases are only added while DRAFT; build a new version)', ds.status;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "evaluation_cases_insert_guard" BEFORE INSERT ON "evaluation_cases" FOR EACH ROW EXECUTE FUNCTION "evaluation_cases_guard_insert"();--> statement-breakpoint
-- Caso inmutable; used_by (registro P5 de que experimentos lo consumieron y en que papel) solo
-- crece: el valor nuevo debe contener al anterior.
CREATE OR REPLACE FUNCTION "evaluation_cases_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.split IS DISTINCT FROM OLD.split
		OR NEW.entity_key IS DISTINCT FROM OLD.entity_key
		OR NEW.input IS DISTINCT FROM OLD.input
		OR NEW.context IS DISTINCT FROM OLD.context
		OR NEW.expected IS DISTINCT FROM OLD.expected
		OR NEW.source IS DISTINCT FROM OLD.source
		OR NEW.difficulty IS DISTINCT FROM OLD.difficulty
		OR NEW.tags IS DISTINCT FROM OLD.tags
		OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'evaluation_cases are immutable (only used_by can grow)';
	END IF;
	IF NOT (NEW.used_by @> OLD.used_by) THEN
		RAISE EXCEPTION 'evaluation_cases.used_by is append-only';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "evaluation_cases_guard" BEFORE UPDATE ON "evaluation_cases" FOR EACH ROW EXECUTE FUNCTION "evaluation_cases_guard_update"();
