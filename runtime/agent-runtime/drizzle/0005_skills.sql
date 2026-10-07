-- Skills versionadas (LLD v0.1 sección 6.3, MVP-1): tablas skills y skill_versions y la columna
-- traces.skill_versions (qué versión exacta de cada skill usó la ejecución, P4).
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Sin DELETE físico: los triggers rechazan DELETE en ambas tablas y cualquier UPDATE del
-- contenido de una versión (solo cambian status, activated_at y deprecated_at).
CREATE TABLE IF NOT EXISTS "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"instructions" text NOT NULL,
	"constraints" text,
	"examples" jsonb,
	"anti_patterns" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"activated_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "skill_versions_status_ck" CHECK ("skill_versions"."status" in ('DRAFT', 'ACTIVE', 'DEPRECATED')),
	CONSTRAINT "skill_versions_version_ck" CHECK ("skill_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"domain" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"active_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_status_ck" CHECK ("skills"."status" in ('DRAFT', 'ACTIVE', 'DEPRECATED'))
);
--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN IF NOT EXISTS "skill_versions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "skills" ADD CONSTRAINT "skills_active_version_id_skill_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_versions_skill_version_uq" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_versions_one_active_uq" ON "skill_versions" USING btree ("skill_id") WHERE "skill_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_versions_tenant_idx" ON "skill_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_tenant_name_uq" ON "skills" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "skills_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% has no physical DELETE: deprecate instead', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "skills_no_delete" BEFORE DELETE ON "skills" FOR EACH ROW EXECUTE FUNCTION "skills_forbid_delete"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "skill_versions_no_delete" BEFORE DELETE ON "skill_versions" FOR EACH ROW EXECUTE FUNCTION "skills_forbid_delete"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "skill_versions_immutable_content"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.instructions IS DISTINCT FROM OLD.instructions
		OR NEW.constraints IS DISTINCT FROM OLD.constraints
		OR NEW.examples IS DISTINCT FROM OLD.examples
		OR NEW.anti_patterns IS DISTINCT FROM OLD.anti_patterns
		OR NEW.metadata IS DISTINCT FROM OLD.metadata
		OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
		RAISE EXCEPTION 'skill_versions content is immutable: create a new version';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "skill_versions_immutable" BEFORE UPDATE ON "skill_versions" FOR EACH ROW EXECUTE FUNCTION "skill_versions_immutable_content"();
