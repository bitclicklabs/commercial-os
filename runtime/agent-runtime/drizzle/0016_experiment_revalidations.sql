-- Revalidacion de experimentos PASS_FORM (src/experiments/revalidation.ts): cuando llegan
-- veredictos humanos sobre entidades que un experimento PASS_FORM ya ejecuto, se mide la accuracy
-- de cada brazo sobre las salidas por caso que el experimento guardo, sin llamar a ningun modelo
-- (coste 0). El experimento terminado es inmutable (0011), asi que la revalidacion es un registro
-- nuevo enlazado: experiment_id, etiquetas usadas, accuracy por brazo y veredicto
-- (CONFIRMED / REFUTED / INSUFFICIENT).
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Numerada 0016 con "when" 1791450200000 (la 0014 y la 0015 son de otras ramas; el PM re-encadena
-- el idx, ADR-31).
-- Sin DELETE fisico. Una fila es inmutable salvo "consequence" (nota en Twenty y evento), que se
-- escribe una sola vez desde '{}' despues de insertar la fila.
CREATE TABLE IF NOT EXISTS "experiment_revalidations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"experiment_id" uuid NOT NULL,
	"experiment_name" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_name" text NOT NULL,
	"baseline_version" integer,
	"candidate_version" integer NOT NULL,
	"verdict" text NOT NULL,
	"labels_hash" text NOT NULL,
	"label_case_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"evaluation_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accuracy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"baseline_accuracy" numeric(5, 4),
	"candidate_accuracy" numeric(5, 4),
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"version_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs_source" text NOT NULL,
	"consequence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_eur" numeric(14, 6) DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'api' NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_revalidations_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "experiment_revalidations_verdict_ck" CHECK ("experiment_revalidations"."verdict" in ('CONFIRMED', 'REFUTED', 'INSUFFICIENT')),
	CONSTRAINT "experiment_revalidations_cost_ck" CHECK ("experiment_revalidations"."cost_eur" = 0),
	CONSTRAINT "experiment_revalidations_outputs_ck" CHECK ("experiment_revalidations"."outputs_source" in ('metrics', 'artifact'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experiment_revalidations_labels_uq" ON "experiment_revalidations" USING btree ("tenant_id","experiment_id","labels_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_revalidations_experiment_idx" ON "experiment_revalidations" USING btree ("tenant_id","experiment_id","created_at");--> statement-breakpoint
-- Escrito a mano: sin borrado fisico (seccion 22). Una revalidacion no se borra: la siguiente,
-- con mas etiquetas, es otra fila.
CREATE OR REPLACE FUNCTION "experiment_revalidations_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'experiment_revalidations has no physical DELETE: a re-validation is append-only';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "experiment_revalidations_no_delete" BEFORE DELETE ON "experiment_revalidations" FOR EACH ROW EXECUTE FUNCTION "experiment_revalidations_forbid_delete"();--> statement-breakpoint
-- Escrito a mano: la fila es inmutable; solo "consequence" se puede escribir, una vez, desde '{}'.
CREATE OR REPLACE FUNCTION "experiment_revalidations_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.consequence <> '{}'::jsonb THEN
		RAISE EXCEPTION 'experiment_revalidations % is immutable (consequence already recorded)', OLD.id;
	END IF;
	IF (to_jsonb(NEW) - 'consequence') IS DISTINCT FROM (to_jsonb(OLD) - 'consequence') THEN
		RAISE EXCEPTION 'experiment_revalidations % is immutable: only consequence can be written, once', OLD.id;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "experiment_revalidations_immutable" BEFORE UPDATE ON "experiment_revalidations" FOR EACH ROW EXECUTE FUNCTION "experiment_revalidations_guard_update"();
