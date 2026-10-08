-- Tanda 12: audit_log de acciones administrativas y retención de trazas sin pérdida (LLD v0.1
-- secciones 22 y 24).
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / CREATE OR REPLACE)
-- para poder aplicarla a mano en una BD compartida sin registrar fila en __drizzle_migrations.
-- Numerada 0015 con "when" 1791450100000 (ADR-31). La 0014 la reserva otra rama de la tanda 12.
--
-- 1. audit_log: una fila por petición administrativa de la API (src/audit/), append-only:
--    los triggers rechazan UPDATE, DELETE y TRUNCATE.
-- 2. traces / trace_steps: hasta ahora sin ningún trigger. Se añade:
--    - sin DELETE físico en traces ni en trace_steps (sección 22);
--    - trace_steps inmutable salvo UNA transición estrecha: el aligerado del archivado
--      (src/maintenance/trace-archive.ts). Un campo pesado (input, output, tool_input,
--      tool_output) solo puede pasar de su contenido a un puntero exacto
--      {archived: true, file, line, field, sha256, bytes} cuyo sha256 es el del contenido que
--      sustituye (calculado aquí sobre OLD, no confiado al cliente). Todo lo demás (tipo,
--      timestamps, tokens, modelo, tool, latencia, error, reward, secuencia) no cambia nunca, y
--      un puntero no vuelve a cambiar.
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text DEFAULT 'api' NOT NULL,
	"actor_ip" text,
	"actor_label" text,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"subject_version" integer,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"request_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" text NOT NULL,
	"status_code" integer NOT NULL,
	"error_code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_log_result_ck" CHECK ("audit_log"."result" in ('ok', 'rejected', 'error')),
	CONSTRAINT "audit_log_status_ck" CHECK ("audit_log"."status_code" between 100 and 599)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_tenant_occurred_idx" ON "audit_log" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_tenant_action_idx" ON "audit_log" USING btree ("tenant_id","action","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_subject_idx" ON "audit_log" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
-- Escrito a mano: audit_log append-only.
CREATE OR REPLACE FUNCTION "audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "audit_log_no_update" BEFORE UPDATE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "audit_log_no_delete" BEFORE DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();--> statement-breakpoint
-- Escrito a mano: trazas sin DELETE físico.
CREATE OR REPLACE FUNCTION "traces_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% has no physical DELETE (LLD section 22): archive heavy payloads with pnpm traces:archive instead', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "traces_no_delete" BEFORE DELETE ON "traces" FOR EACH ROW EXECUTE FUNCTION "traces_forbid_delete"();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trace_steps_no_delete" BEFORE DELETE ON "trace_steps" FOR EACH ROW EXECUTE FUNCTION "traces_forbid_delete"();--> statement-breakpoint
-- Escrito a mano: la única transición permitida de un campo pesado de trace_steps.
-- true si el campo no cambia, o si pasa de un contenido (no puntero) a su puntero exacto.
CREATE OR REPLACE FUNCTION "trace_step_payload_archive_ok"(o jsonb, n jsonb, field text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
	-- COALESCE / IS DISTINCT FROM: never NULL (a NULL here would let the UPDATE through).
	SELECT COALESCE(
		o IS NOT DISTINCT FROM n
		OR (
			o IS NOT NULL
			AND (o -> 'archived') IS DISTINCT FROM 'true'::jsonb
			AND n IS NOT NULL
			AND jsonb_typeof(n) = 'object'
			AND (n -> 'archived') IS NOT DISTINCT FROM 'true'::jsonb
			AND jsonb_typeof(n -> 'file') IS NOT DISTINCT FROM 'string'
			AND jsonb_typeof(n -> 'line') IS NOT DISTINCT FROM 'number'
			AND jsonb_typeof(n -> 'bytes') IS NOT DISTINCT FROM 'number'
			AND (n ->> 'field') IS NOT DISTINCT FROM field
			AND (n ->> 'sha256') IS NOT DISTINCT FROM encode(sha256(convert_to(o::text, 'UTF8')), 'hex')
			AND (n - ARRAY['archived', 'file', 'line', 'field', 'sha256', 'bytes']) = '{}'::jsonb
		),
		false
	)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trace_steps_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (NEW.id, NEW.tenant_id, NEW.trace_id, NEW.sequence, NEW."timestamp", NEW.type, NEW.model, NEW.input_tokens, NEW.output_tokens, NEW.tool, NEW.latency_ms, NEW.error, NEW.reward)
		IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.trace_id, OLD.sequence, OLD."timestamp", OLD.type, OLD.model, OLD.input_tokens, OLD.output_tokens, OLD.tool, OLD.latency_ms, OLD.error, OLD.reward) THEN
		RAISE EXCEPTION 'trace_steps % is immutable: only heavy payloads can be archived (input, output, tool_input, tool_output)', OLD.id;
	END IF;
	IF NOT COALESCE(
		"trace_step_payload_archive_ok"(OLD.input, NEW.input, 'input')
		AND "trace_step_payload_archive_ok"(OLD.output, NEW.output, 'output')
		AND "trace_step_payload_archive_ok"(OLD.tool_input, NEW.tool_input, 'tool_input')
		AND "trace_step_payload_archive_ok"(OLD.tool_output, NEW.tool_output, 'tool_output'),
		false
	) THEN
		RAISE EXCEPTION 'trace_steps %: a payload can only be replaced by its archive pointer {archived: true, file, line, field, sha256, bytes} (sha256 of the replaced content)', OLD.id;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trace_steps_guard" BEFORE UPDATE ON "trace_steps" FOR EACH ROW EXECUTE FUNCTION "trace_steps_guard_update"();
