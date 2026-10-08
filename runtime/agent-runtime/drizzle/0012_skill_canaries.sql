-- Canario de skills (despliegue post Release Gate): tras un experimento PASS o PASS_FORM, un
-- humano envia un % de las ejecuciones que siguen la version ACTIVE a la candidata (hash
-- determinista del id de la ejecucion: reproducible), compara las metricas y decide: PROMOTED
-- (la candidata pasa a ACTIVE, re-verificando el gate) o ROLLED_BACK (todo vuelve a la estable).
-- Nada se promueve solo: no hay tarea programada que lo haga.
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Numerada 0013 con "when" 1791376200000 (> 0011; la 0012 la reserva optimization_runs, ADR-31).
-- Sin DELETE fisico. Como mucho UN canario ACTIVE por skill (indice unico parcial). Identidad,
-- versiones, porcentaje y experimento inmutables; ACTIVE -> PROMOTED | ROLLED_BACK y un canario
-- terminado es inmutable entero.
CREATE TABLE IF NOT EXISTS "skill_canaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"canary_version_id" uuid NOT NULL,
	"canary_version" integer NOT NULL,
	"stable_version_id" uuid NOT NULL,
	"stable_version" integer NOT NULL,
	"percent" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"experiment_id" uuid NOT NULL,
	"gate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_by" text,
	"finished_at" timestamp with time zone,
	"finished_by" text,
	"finish_reason" text,
	"finish_gate" jsonb,
	CONSTRAINT "skill_canaries_status_ck" CHECK ("skill_canaries"."status" in ('ACTIVE', 'PROMOTED', 'ROLLED_BACK')),
	CONSTRAINT "skill_canaries_percent_ck" CHECK ("skill_canaries"."percent" between 1 and 99),
	CONSTRAINT "skill_canaries_versions_ck" CHECK ("skill_canaries"."canary_version_id" <> "skill_canaries"."stable_version_id"),
	CONSTRAINT "skill_canaries_finished_ck" CHECK (("skill_canaries"."status" = 'ACTIVE') = ("skill_canaries"."finished_at" is null))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "skill_canaries" ADD CONSTRAINT "skill_canaries_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "skill_canaries" ADD CONSTRAINT "skill_canaries_canary_version_id_skill_versions_id_fk" FOREIGN KEY ("canary_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "skill_canaries" ADD CONSTRAINT "skill_canaries_stable_version_id_skill_versions_id_fk" FOREIGN KEY ("stable_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "skill_canaries" ADD CONSTRAINT "skill_canaries_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_canaries_one_active_uq" ON "skill_canaries" USING btree ("skill_id") WHERE "skill_canaries"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_canaries_tenant_skill_idx" ON "skill_canaries" USING btree ("tenant_id","skill_id","started_at");--> statement-breakpoint
-- Escrito a mano: sin borrado fisico (seccion 22). Un canario se cierra (ROLLED_BACK), no se borra.
CREATE OR REPLACE FUNCTION "skill_canaries_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'skill_canaries has no physical DELETE: roll the canary back instead';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "skill_canaries_no_delete" BEFORE DELETE ON "skill_canaries" FOR EACH ROW EXECUTE FUNCTION "skill_canaries_forbid_delete"();--> statement-breakpoint
-- Un canario nace ACTIVE, sin cierre, y sus versiones son de la misma skill y del mismo tenant.
CREATE OR REPLACE FUNCTION "skill_canaries_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	n integer;
BEGIN
	IF NEW.status <> 'ACTIVE' OR NEW.finished_at IS NOT NULL THEN
		RAISE EXCEPTION 'skill_canaries: a new canary is ACTIVE, not %', NEW.status;
	END IF;
	SELECT count(*) INTO n FROM skill_versions
		WHERE id IN (NEW.canary_version_id, NEW.stable_version_id) AND skill_id = NEW.skill_id AND tenant_id = NEW.tenant_id;
	IF n <> 2 THEN
		RAISE EXCEPTION 'skill_canaries: canary and stable versions must belong to skill % of tenant %', NEW.skill_id, NEW.tenant_id;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "skill_canaries_insert_guard" BEFORE INSERT ON "skill_canaries" FOR EACH ROW EXECUTE FUNCTION "skill_canaries_guard_insert"();--> statement-breakpoint
-- Identidad inmutable siempre; solo ACTIVE -> PROMOTED | ROLLED_BACK; terminado = inmutable.
CREATE OR REPLACE FUNCTION "skill_canaries_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'ACTIVE' THEN
		RAISE EXCEPTION 'skill_canaries: canary % is % and immutable', OLD.id, OLD.status;
	END IF;
	IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
		OR NEW.canary_version_id IS DISTINCT FROM OLD.canary_version_id
		OR NEW.canary_version IS DISTINCT FROM OLD.canary_version
		OR NEW.stable_version_id IS DISTINCT FROM OLD.stable_version_id
		OR NEW.stable_version IS DISTINCT FROM OLD.stable_version
		OR NEW.percent IS DISTINCT FROM OLD.percent
		OR NEW.experiment_id IS DISTINCT FROM OLD.experiment_id
		OR NEW.gate IS DISTINCT FROM OLD.gate
		OR NEW.started_at IS DISTINCT FROM OLD.started_at
		OR NEW.started_by IS DISTINCT FROM OLD.started_by THEN
		RAISE EXCEPTION 'skill_canaries: identity of canary % is immutable', OLD.id;
	END IF;
	IF NEW.status NOT IN ('PROMOTED', 'ROLLED_BACK') THEN
		RAISE EXCEPTION 'skill_canaries: invalid transition % -> %', OLD.status, NEW.status;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "skill_canaries_guard" BEFORE UPDATE ON "skill_canaries" FOR EACH ROW EXECUTE FUNCTION "skill_canaries_guard_update"();
