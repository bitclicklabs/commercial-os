-- Evaluador HUMAN (MVP-0, LLD v0.2 secciones 5.5 y 6.4, decisión D14).
-- Generada con drizzle-kit (salió como 0002) y renombrada a 0003: la rama del event bus
-- reclama el 0002. Es idempotente (IF NOT EXISTS, FKs dentro del CREATE TABLE) para que
-- pueda aplicarse a mano en una BD compartida sin registrar fila en __drizzle_migrations.
CREATE TABLE IF NOT EXISTS "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text DEFAULT 'HUMAN' NOT NULL,
	"evaluator_id" text DEFAULT 'human-v1' NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"agent_execution_id" uuid,
	"task_run_id" uuid,
	"feedback" text NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'api' NOT NULL,
	"idempotency_key" text,
	"evaluated_by" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluations_agent_execution_id_agent_executions_id_fk" FOREIGN KEY ("agent_execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "evaluations_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluations_tenant_subject_idx" ON "evaluations" USING btree ("tenant_id","subject_type","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluations_tenant_execution_idx" ON "evaluations" USING btree ("tenant_id","agent_execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evaluations_idem_uq" ON "evaluations" USING btree ("tenant_id","idempotency_key");
