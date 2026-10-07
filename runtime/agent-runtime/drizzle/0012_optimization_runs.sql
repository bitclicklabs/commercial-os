-- Skill Optimizer automatico (MVP-3, LLD v0.1 seccion 18): un optimization_run cosecha fallos de
-- produccion de una skill, los agrupa, propone una candidata acotada (edit-ops, DRAFT), la pasa por
-- un experimento contra la version ACTIVE y guarda el veredicto del Release Gate. Nunca activa nada:
-- la promocion es humana (POST /skills/:id/versions/:v/activate re-verifica el gate).
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Numerada 0012 con "when" 1791376100000 (> 0011, ADR-31). La 0013 la reserva otra rama (experiments).
-- Sin DELETE fisico. Las transiciones de estado son UPDATE guardados por estado en
-- src/optimizer/service.ts; no hay trigger de inmutabilidad total (el run se cierra a mano).
CREATE TABLE IF NOT EXISTS "optimization_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"base_version" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_clusters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_ops" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidate_version" integer,
	"experiment_id" uuid,
	"verdict" text,
	"cost_eur" numeric(14, 6) DEFAULT 0 NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "optimization_runs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "optimization_runs_status_ck" CHECK ("optimization_runs"."status" in ('PENDING', 'HARVESTING', 'CLUSTERED', 'CANDIDATE_CREATED', 'EXPERIMENT_RUNNING', 'GATE_PASS', 'GATE_FAIL', 'BLOCKED_NO_DATA', 'ERROR', 'PROMOTED', 'DISCARDED')),
	CONSTRAINT "optimization_runs_verdict_ck" CHECK ("optimization_runs"."verdict" is null or "optimization_runs"."verdict" in ('PASS', 'PASS_FORM', 'FAIL', 'INCONCLUSIVE')),
	CONSTRAINT "optimization_runs_versions_ck" CHECK ("optimization_runs"."base_version" >= 1 and ("optimization_runs"."candidate_version" is null or ("optimization_runs"."candidate_version" >= 1 and "optimization_runs"."candidate_version" <> "optimization_runs"."base_version")))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "optimization_runs_skill_idx" ON "optimization_runs" USING btree ("tenant_id","skill_name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "optimization_runs_open_uq" ON "optimization_runs" USING btree ("tenant_id","skill_name") WHERE "optimization_runs"."status" in ('PENDING', 'HARVESTING', 'CLUSTERED', 'CANDIDATE_CREATED', 'EXPERIMENT_RUNNING');--> statement-breakpoint
-- Escrito a mano: sin borrado fisico (seccion 22). Un run se cierra (DISCARDED, ERROR), no se borra.
CREATE OR REPLACE FUNCTION "optimization_runs_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'optimization_runs has no physical DELETE: close the run (DISCARDED) instead';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "optimization_runs_no_delete" BEFORE DELETE ON "optimization_runs" FOR EACH ROW EXECUTE FUNCTION "optimization_runs_forbid_delete"();
