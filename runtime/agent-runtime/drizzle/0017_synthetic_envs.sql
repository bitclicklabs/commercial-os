-- Environments sinteticos con ground truth conocida (MVP-4, LLD v0.1 seccion 13): casos de
-- evaluacion generados por construccion (src/synthetic/, `pnpm synth:build`), sin quemar datos
-- reales.
-- Generada con drizzle-kit y retocada a mano: idempotente (IF NOT EXISTS / DROP CONSTRAINT IF
-- EXISTS + ADD / CREATE OR REPLACE) para poder aplicarla a mano en una BD compartida sin
-- registrar fila en __drizzle_migrations.
-- Numerada 0017 con "when" 1791530000000 (ADR-31).
-- No borra datos: solo amplia restricciones y anade una columna con valor por defecto.
--
-- 1. evaluation_datasets.origin: HARVESTED (por defecto, todo lo existente) | SYNTHETIC | MIXED.
--    Inmutable como el resto de la version (trigger de 0010 ampliado).
-- 2. evaluation_cases.split admite SYNTH: los casos sinteticos no entran en el reparto 50/25/25.
-- 3. evaluation_cases_synth_ck: un caso SYNTH es exactamente uno generado (expected.kind =
--    'synthetic', source.origin = 'synthetic', source.expected_source = 'synthetic') y su
--    used_by es siempre [] (P5 no los quema: son regenerables). Ningun caso fuera de SYNTH puede
--    llevar kind 'synthetic', asi que la accuracy del Release Gate no puede confundir una
--    ground truth sintetica con una etiqueta humana.
-- 4. Insercion: un caso SYNTH solo entra en un dataset SYNTHETIC o MIXED, y un dataset
--    SYNTHETIC solo admite casos SYNTH.
-- 5. evaluation_cases.curriculum_level (1-3): nivel del escenario sintetico (datos + trampas).
--    No sustituye a "difficulty", que conserva su semantica original en todos los casos
--    (easy / medium / hard = datos ricos / sector / solo nombre). Obligatorio en SYNTH, nulo
--    fuera; inmutable como el resto del caso (trigger de 0010 ampliado).
ALTER TABLE "evaluation_datasets" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'HARVESTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD COLUMN IF NOT EXISTS "curriculum_level" integer;--> statement-breakpoint
ALTER TABLE "evaluation_cases" DROP CONSTRAINT IF EXISTS "evaluation_cases_curriculum_ck";--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_curriculum_ck" CHECK (("evaluation_cases"."split" = 'SYNTH') = ("evaluation_cases"."curriculum_level" is not null) and ("evaluation_cases"."curriculum_level" is null or "evaluation_cases"."curriculum_level" between 1 and 3));--> statement-breakpoint
ALTER TABLE "evaluation_datasets" DROP CONSTRAINT IF EXISTS "evaluation_datasets_origin_ck";--> statement-breakpoint
ALTER TABLE "evaluation_datasets" ADD CONSTRAINT "evaluation_datasets_origin_ck" CHECK ("evaluation_datasets"."origin" in ('HARVESTED', 'SYNTHETIC', 'MIXED'));--> statement-breakpoint
ALTER TABLE "evaluation_cases" DROP CONSTRAINT IF EXISTS "evaluation_cases_split_ck";--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_split_ck" CHECK ("evaluation_cases"."split" in ('TRAIN', 'VALIDATION', 'TEST', 'SYNTH'));--> statement-breakpoint
ALTER TABLE "evaluation_cases" DROP CONSTRAINT IF EXISTS "evaluation_cases_synth_ck";--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_synth_ck" CHECK (("evaluation_cases"."split" = 'SYNTH') = (coalesce("evaluation_cases"."expected"->>'kind', '') = 'synthetic') and ("evaluation_cases"."split" <> 'SYNTH' or ("evaluation_cases"."source"->>'origin' = 'synthetic' and "evaluation_cases"."source"->>'expected_source' = 'synthetic' and "evaluation_cases"."used_by" = '[]'::jsonb)));--> statement-breakpoint
-- Escrito a mano: el trigger de 0010 con "origin" en la lista de campos inmutables.
CREATE OR REPLACE FUNCTION "evaluation_datasets_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.name IS DISTINCT FROM OLD.name
		OR NEW.domain IS DISTINCT FROM OLD.domain
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.description IS DISTINCT FROM OLD.description
		OR NEW.origin IS DISTINCT FROM OLD.origin
		OR NEW.build_info IS DISTINCT FROM OLD.build_info
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
		RAISE EXCEPTION 'evaluation_datasets version is immutable: build a new version instead';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'ARCHIVED'))
		OR (OLD.status = 'ACTIVE' AND NEW.status = 'ARCHIVED')
	) THEN
		RAISE EXCEPTION 'evaluation_datasets: invalid transition % -> %', OLD.status, NEW.status;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
-- Escrito a mano: el trigger de insercion de 0010 con la regla de origen.
CREATE OR REPLACE FUNCTION "evaluation_cases_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	ds record;
BEGIN
	SELECT tenant_id, status, origin INTO ds FROM evaluation_datasets WHERE id = NEW.dataset_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'evaluation_cases: dataset % not found', NEW.dataset_id;
	END IF;
	IF ds.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
		RAISE EXCEPTION 'evaluation_cases: tenant_id must match the dataset tenant';
	END IF;
	IF ds.status <> 'DRAFT' THEN
		RAISE EXCEPTION 'evaluation_cases: dataset is % (cases are only added while DRAFT; build a new version)', ds.status;
	END IF;
	IF NEW.split = 'SYNTH' AND ds.origin NOT IN ('SYNTHETIC', 'MIXED') THEN
		RAISE EXCEPTION 'evaluation_cases: a SYNTH case only goes into a SYNTHETIC or MIXED dataset (this one is %)', ds.origin;
	END IF;
	IF ds.origin = 'SYNTHETIC' AND NEW.split <> 'SYNTH' THEN
		RAISE EXCEPTION 'evaluation_cases: a SYNTHETIC dataset only holds SYNTH cases';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
-- Escrito a mano: el trigger de 0010 con "curriculum_level" en la lista de campos inmutables.
CREATE OR REPLACE FUNCTION "evaluation_cases_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.split IS DISTINCT FROM OLD.split
		OR NEW.entity_key IS DISTINCT FROM OLD.entity_key
		OR NEW.input IS DISTINCT FROM OLD.input
		OR NEW.context IS DISTINCT FROM OLD.context
		OR NEW.expected IS DISTINCT FROM OLD.expected
		OR NEW.source IS DISTINCT FROM OLD.source
		OR NEW.difficulty IS DISTINCT FROM OLD.difficulty
		OR NEW.curriculum_level IS DISTINCT FROM OLD.curriculum_level
		OR NEW.tags IS DISTINCT FROM OLD.tags
		OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'evaluation_cases are immutable (only used_by can grow)';
	END IF;
	IF NOT (NEW.used_by @> OLD.used_by) THEN
		RAISE EXCEPTION 'evaluation_cases.used_by is append-only';
	END IF;
	RETURN NEW;
END;
$$;
