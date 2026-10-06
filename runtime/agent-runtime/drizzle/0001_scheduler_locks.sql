CREATE TABLE "entity_locks" (
	"tenant_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"locked_by_execution" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_locks_pk" PRIMARY KEY("tenant_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE INDEX "entity_locks_execution_idx" ON "entity_locks" USING btree ("locked_by_execution");--> statement-breakpoint
CREATE INDEX "task_runs_status_updated_idx" ON "task_runs" USING btree ("status","updated_at");