CREATE TYPE "public"."agent_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'DEPRECATED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."agent_version_status" AS ENUM('DRAFT', 'CANDIDATE', 'EVALUATING', 'APPROVED', 'ACTIVE', 'REJECTED', 'DEPRECATED');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT');--> statement-breakpoint
CREATE TYPE "public"."task_definition_status" AS ENUM('ACTIVE', 'PAUSED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."trace_step_type" AS ENUM('THINK', 'MODEL', 'TOOL', 'DELEGATE', 'MEMORY_READ', 'MEMORY_WRITE', 'VERIFY', 'REFLECT', 'FINAL');--> statement-breakpoint
CREATE TABLE "agent_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version_id" uuid,
	"task_run_id" uuid,
	"idempotency_key" text,
	"status" "run_status" DEFAULT 'QUEUED' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"tool_cost" numeric(14, 6) DEFAULT 0 NOT NULL,
	"model_cost" numeric(14, 6) DEFAULT 0 NOT NULL,
	"total_cost" numeric(14, 6) DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "agent_version_status" DEFAULT 'DRAFT' NOT NULL,
	"model" text NOT NULL,
	"model_provider" text NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"skill_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"harness_version_id" text,
	"router_version_id" text,
	"tool_policy_id" text,
	"memory_policy_id" text,
	"evaluation_policy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"role" text,
	"status" "agent_status" DEFAULT 'DRAFT' NOT NULL,
	"active_version_id" uuid,
	"default_schedule_id" text,
	"risk_level" text DEFAULT 'LOW' NOT NULL,
	"owner" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_definition_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"task_definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "task_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"agent_id" uuid NOT NULL,
	"status" "task_definition_status" DEFAULT 'ACTIVE' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"current_version_id" uuid,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"default_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" jsonb DEFAULT '{"type":"MANUAL"}'::jsonb NOT NULL,
	"timezone" text DEFAULT 'Europe/Madrid' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"retry_policy" jsonb DEFAULT '{"max_attempts":1,"backoff_ms":0}'::jsonb NOT NULL,
	"timeout_ms" integer DEFAULT 300000 NOT NULL,
	"approval_policy" jsonb,
	"environment_id" text,
	"evaluation_policy" jsonb,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"task_definition_id" uuid NOT NULL,
	"task_definition_version_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" "run_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"agent_version_id" uuid,
	"agent_version" integer,
	"harness_version" text,
	"skill_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"environment_version" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"execution_id" uuid,
	"score" numeric(6, 4),
	"cost" numeric(14, 6) DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"trace_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"type" "trace_step_type" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"tool" text,
	"tool_input" jsonb,
	"tool_output" jsonb,
	"latency_ms" integer,
	"error" jsonb,
	"reward" numeric(8, 4)
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"execution_id" uuid NOT NULL,
	"task_run_id" uuid,
	"task_definition_id" uuid,
	"agent_id" uuid NOT NULL,
	"agent_version_id" uuid,
	"harness_version" text,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"memory_reads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"memory_writes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delegations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_output" jsonb,
	"evaluation" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"tool_cost" numeric(14, 6) DEFAULT 0 NOT NULL,
	"model_cost" numeric(14, 6) DEFAULT 0 NOT NULL,
	"total_cost" numeric(14, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_active_version_id_agent_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_definition_versions" ADD CONSTRAINT "task_definition_versions_task_definition_id_task_definitions_id_fk" FOREIGN KEY ("task_definition_id") REFERENCES "public"."task_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_definition_versions" ADD CONSTRAINT "task_definition_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_definitions" ADD CONSTRAINT "task_definitions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_definitions" ADD CONSTRAINT "task_definitions_current_version_id_task_definition_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."task_definition_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_definition_id_task_definitions_id_fk" FOREIGN KEY ("task_definition_id") REFERENCES "public"."task_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_definition_version_id_task_definition_versions_id_fk" FOREIGN KEY ("task_definition_version_id") REFERENCES "public"."task_definition_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_execution_id_agent_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_steps" ADD CONSTRAINT "trace_steps_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_execution_id_agent_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_task_definition_id_task_definitions_id_fk" FOREIGN KEY ("task_definition_id") REFERENCES "public"."task_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_executions_idem_uq" ON "agent_executions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_executions_tenant_status_idx" ON "agent_executions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "agent_executions_task_run_idx" ON "agent_executions" USING btree ("task_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_agent_version_uq" ON "agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX "agent_versions_tenant_idx" ON "agent_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_tenant_name_uq" ON "agents" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "agents_tenant_status_idx" ON "agents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "task_definition_versions_uq" ON "task_definition_versions" USING btree ("task_definition_id","version");--> statement-breakpoint
CREATE INDEX "task_definitions_tenant_status_idx" ON "task_definitions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "task_definitions_agent_idx" ON "task_definitions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_runs_idem_uq" ON "task_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "task_runs_task_scheduled_idx" ON "task_runs" USING btree ("task_definition_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "task_runs_tenant_status_idx" ON "task_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_steps_trace_seq_uq" ON "trace_steps" USING btree ("trace_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "traces_execution_uq" ON "traces" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "traces_tenant_agent_idx" ON "traces" USING btree ("tenant_id","agent_id");