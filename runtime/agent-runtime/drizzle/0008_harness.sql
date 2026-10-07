-- Harness versionado v1 (LLD v0.1 sección 7.1, MVP-1, sin processor graph): tablas harnesses y
-- harness_versions (políticas de ejecución, tools, contexto y seguridad), la columna
-- agent_versions.harness_ref ({name} o {name, version}, como las skills) y la columna
-- traces.harness (qué versión exacta y qué valores efectivos usó la ejecución, P4).
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Sin DELETE físico: los triggers rechazan DELETE en ambas tablas y cualquier UPDATE del
-- contenido de una versión (solo cambian status, activated_at y deprecated_at).
-- Journal (ADR-31): su "when" va entre el de la 0007 y el de la 0009 de la rama de memoria.
CREATE TABLE IF NOT EXISTS "harness_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"harness_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"config" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"activated_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "harness_versions_status_ck" CHECK ("harness_versions"."status" in ('DRAFT', 'ACTIVE', 'DEPRECATED')),
	CONSTRAINT "harness_versions_version_ck" CHECK ("harness_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "harnesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"active_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harnesses_status_ck" CHECK ("harnesses"."status" in ('DRAFT', 'ACTIVE', 'DEPRECATED'))
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN IF NOT EXISTS "harness_ref" jsonb;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN IF NOT EXISTS "harness" jsonb;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "harness_versions" ADD CONSTRAINT "harness_versions_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_active_version_id_harness_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."harness_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "harness_versions_harness_version_uq" ON "harness_versions" USING btree ("harness_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "harness_versions_one_active_uq" ON "harness_versions" USING btree ("harness_id") WHERE "harness_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "harness_versions_tenant_idx" ON "harness_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "harnesses_tenant_name_uq" ON "harnesses" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "harnesses_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% has no physical DELETE: deprecate instead', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "harnesses_no_delete" BEFORE DELETE ON "harnesses" FOR EACH ROW EXECUTE FUNCTION "harnesses_forbid_delete"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "harness_versions_no_delete" BEFORE DELETE ON "harness_versions" FOR EACH ROW EXECUTE FUNCTION "harnesses_forbid_delete"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "harness_versions_immutable_content"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.harness_id IS DISTINCT FROM OLD.harness_id
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.config IS DISTINCT FROM OLD.config
		OR NEW.metadata IS DISTINCT FROM OLD.metadata
		OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
		RAISE EXCEPTION 'harness_versions content is immutable: create a new version';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "harness_versions_immutable" BEFORE UPDATE ON "harness_versions" FOR EACH ROW EXECUTE FUNCTION "harness_versions_immutable_content"();
