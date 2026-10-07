-- Experiments + Release Gate (LLD v0.1 secciones 11.5-11.6 y 19, cierre del MVP-2): un
-- Experiment compara baseline y candidata de un sujeto (skill o harness) sobre los mismos casos
-- y guarda el veredicto del gate. La activacion de una version exige un experimento COMPLETED
-- con decision PASS o PASS_FORM (o un override humano con motivo): ningun agente se promueve solo.
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Numerada 0011 con "when" 1791376000000 (> 0010, ADR-31).
-- Sin DELETE fisico. Identidad y config inmutables desde la creacion; un experimento terminado
-- (COMPLETED, FAILED o CANCELLED) es inmutable entero.
CREATE TABLE IF NOT EXISTS "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"number" integer NOT NULL,
	"subject_type" text NOT NULL,
	"subject_name" text NOT NULL,
	"baseline_version" integer,
	"candidate_version" integer NOT NULL,
	"dataset_id" uuid,
	"splits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gate_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"cost_eur" numeric(14, 6) DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "experiments_dataset_id_evaluation_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."evaluation_datasets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "experiments_status_ck" CHECK ("experiments"."status" in ('DRAFT', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "experiments_subject_type_ck" CHECK ("experiments"."subject_type" in ('skill', 'harness')),
	CONSTRAINT "experiments_decision_ck" CHECK ("experiments"."decision" is null or "experiments"."decision" in ('PASS', 'PASS_FORM', 'FAIL', 'INCONCLUSIVE')),
	CONSTRAINT "experiments_completed_ck" CHECK (("experiments"."status" = 'COMPLETED') = ("experiments"."decision" is not null)),
	CONSTRAINT "experiments_versions_ck" CHECK ("experiments"."candidate_version" >= 1 and ("experiments"."baseline_version" is null or ("experiments"."baseline_version" >= 1 and "experiments"."baseline_version" <> "experiments"."candidate_version"))),
	CONSTRAINT "experiments_name_ck" CHECK ("experiments"."name" ~ '^EXP-[0-9]{3,}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experiments_tenant_name_uq" ON "experiments" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experiments_tenant_number_uq" ON "experiments" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_subject_idx" ON "experiments" USING btree ("tenant_id","subject_type","subject_name","candidate_version","status");--> statement-breakpoint
-- Escrito a mano: sin borrado fisico (seccion 22). Un experimento se cancela (CANCELLED), no se borra.
CREATE OR REPLACE FUNCTION "experiments_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'experiments has no physical DELETE: cancel the experiment instead';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "experiments_no_delete" BEFORE DELETE ON "experiments" FOR EACH ROW EXECUTE FUNCTION "experiments_forbid_delete"();--> statement-breakpoint
-- Un experimento nace DRAFT o RUNNING (nunca con un resultado ya escrito), con el nombre que
-- corresponde a su numero (EXP-003 = 3) y, si cita un dataset, del mismo tenant.
CREATE OR REPLACE FUNCTION "experiments_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	ds_tenant text;
BEGIN
	IF NEW.status NOT IN ('DRAFT', 'RUNNING') THEN
		RAISE EXCEPTION 'experiments: a new experiment is DRAFT or RUNNING, not %', NEW.status;
	END IF;
	IF NEW.number < 1 OR NEW.name IS DISTINCT FROM ('EXP-' || CASE WHEN NEW.number < 1000 THEN lpad(NEW.number::text, 3, '0') ELSE NEW.number::text END) THEN
		RAISE EXCEPTION 'experiments: name % does not match number %', NEW.name, NEW.number;
	END IF;
	IF NEW.dataset_id IS NOT NULL THEN
		SELECT tenant_id INTO ds_tenant FROM evaluation_datasets WHERE id = NEW.dataset_id;
		IF ds_tenant IS DISTINCT FROM NEW.tenant_id THEN
			RAISE EXCEPTION 'experiments: dataset % is not of tenant %', NEW.dataset_id, NEW.tenant_id;
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "experiments_insert_guard" BEFORE INSERT ON "experiments" FOR EACH ROW EXECUTE FUNCTION "experiments_guard_insert"();--> statement-breakpoint
-- Identidad y config inmutables siempre. Transiciones: DRAFT -> RUNNING | FAILED | CANCELLED;
-- RUNNING -> COMPLETED | FAILED | CANCELLED. Terminado (COMPLETED, FAILED, CANCELLED) = inmutable.
CREATE OR REPLACE FUNCTION "experiments_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN
		RAISE EXCEPTION 'experiments: % is % and immutable', OLD.name, OLD.status;
	END IF;
	IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.name IS DISTINCT FROM OLD.name
		OR NEW.number IS DISTINCT FROM OLD.number
		OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
		OR NEW.subject_name IS DISTINCT FROM OLD.subject_name
		OR NEW.baseline_version IS DISTINCT FROM OLD.baseline_version
		OR NEW.candidate_version IS DISTINCT FROM OLD.candidate_version
		OR NEW.config IS DISTINCT FROM OLD.config
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
		RAISE EXCEPTION 'experiments: identity and config of % are immutable', OLD.name;
	END IF;
	IF NEW.dataset_id IS DISTINCT FROM OLD.dataset_id AND OLD.dataset_id IS NOT NULL THEN
		RAISE EXCEPTION 'experiments: the dataset of % cannot change', OLD.name;
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'DRAFT' AND NEW.status IN ('RUNNING', 'FAILED', 'CANCELLED'))
		OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'FAILED', 'CANCELLED'))
	) THEN
		RAISE EXCEPTION 'experiments: invalid transition % -> %', OLD.status, NEW.status;
	END IF;
	IF NEW.status IN ('COMPLETED', 'FAILED', 'CANCELLED') AND NEW.finished_at IS NULL THEN
		RAISE EXCEPTION 'experiments: % needs finished_at', NEW.status;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "experiments_guard" BEFORE UPDATE ON "experiments" FOR EACH ROW EXECUTE FUNCTION "experiments_guard_update"();
