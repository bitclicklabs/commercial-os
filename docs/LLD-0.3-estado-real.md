# LLD v0.3 — Estado real del sistema

| Campo | Valor |
|---|---|
| Estado | Consolidación del diseño con lo construido |
| Fecha | 2026-10-07 |
| Rama | `docs/lld-0.3` |
| Cubre | Tandas 1 a 5 (PR #1 a #5, fusionadas en `main`) y, marcado como tal, la tanda 6 en curso |
| Base | [LLD v0.1](LLD-0.1-publiexpe-commercial-os.md) (arquitectura) y [LLD v0.2](LLD-0.2-especificacion.md) (especificación del MVP-0) |
| Lector objetivo | Un desarrollador o un agente que llega al proyecto y necesita la verdad actual sin arqueología |

Este documento **no reescribe** el LLD v0.1 ni el v0.2. Sirve para tres cosas:

1. Decirte qué corre hoy, dónde y qué hace cada día.
2. Registrar las decisiones que se tomaron al construir y qué parte del LLD v0.1 o v0.2 modifican.
3. Mostrarte, punto por punto, qué del v0.2 está implementado igual, implementado distinto o pendiente.

**Principio rector (sin cambios):** el CRM es el *system of record*; el Agent OS es el *system of intelligence*.

> **Importante:** si este documento y el v0.2 se contradicen, manda este documento para describir **lo que existe**, y el v0.2 sigue mandando para describir **lo que se pretende construir** en lo que aquí figura como pendiente.

## Cómo leer este documento

| Marca | Significado |
|---|---|
| **Implementado igual** | El código sigue el diseño del v0.1 o del v0.2. |
| **Implementado distinto** | Existe, pero con otra forma. La fila enlaza a la ADR que explica el cambio. |
| **Pendiente** | No existe. Se dice claro, sin matices. |
| `[TANDA 6, EN CURSO]` | Trabajo que el PM ha encargado y que aún no está fusionado en `main`. No lo des por existente. |
| `[NO VERIFICADO]` | Las fuentes no permiten confirmarlo. Se redacta en condicional. |
| `[DE FACTO]` | Decisión que se deduce de lo construido, pero que ninguna fuente registra como decisión explícita. |

Fuentes: LLD v0.1, LLD v0.2, [CHANGELOG](CHANGELOG.md), [ESTADO](ESTADO.md), y los README del [runtime](../runtime/agent-runtime/README.md), de la [Twenty App](../apps/twenty-app/README.md), del [renderer](../services/renderer/README.md) y de [deployments](../deployments/README.md). Cuando se ha contrastado algo directamente en el código de la rama, se indica entre paréntesis (por ejemplo, `src/db/schema.ts`).

## Contenido

1. [Resumen del sistema hoy](#1-resumen-del-sistema-hoy)
1. [Registro de decisiones (ADR)](#2-registro-de-decisiones-adr)
1. [LLD v0.2 → realidad](#3-lld-v02--realidad)
1. [Métricas reales (línea base a 2026-10-07)](#4-métricas-reales-línea-base-a-2026-10-07)
1. [Mapa de pendientes](#5-mapa-de-pendientes)
1. [Contradicciones entre fuentes](#6-contradicciones-entre-fuentes)
1. [Calendario de hitos](#7-calendario-de-hitos)

---

## 1. Resumen del sistema hoy

### 1.1 Qué corre y dónde

Todo corre en Docker Compose (`deployments/docker-compose.yml`), red `pxos-net`, con puertos publicados solo en `127.0.0.1`.

| Componente | Contenedor | Imagen | Puerto host | Qué hace |
|---|---|---|---|---|
| Twenty (UI + API REST/GraphQL) | `pxos-twenty` | `twentycrm/twenty:v2.45.6` | `127.0.0.1:3020` | System of record. Aloja la Twenty App `publiexpe-commercial-os` (4 objetos custom). |
| Worker de Twenty | `pxos-twenty-worker` | `twentycrm/twenty:v2.45.6` | — | Colas de Twenty. Entrega los webhooks. |
| Postgres de Twenty | `pxos-twenty-db` | `postgres:16` | — (interno) | Base de datos de Twenty. |
| Redis de Twenty | `pxos-twenty-redis` | `redis:7.4` | — (interno) | Caché y colas de Twenty. |
| PostgreSQL del Agent OS | `pxos-postgres` | `pgvector/pgvector:pg16` | `127.0.0.1:5440` | Base `agentos`: agentes, tareas, ejecuciones, trazas, eventos, evaluaciones. |
| Redis del Agent OS | `pxos-redis` | `redis:7.4` | `127.0.0.1:6391` | BullMQ (AOF activado): cola de runs, schedules y eventos. |
| Agent Runtime | `pxos-runtime` | `pxos/agent-runtime:0.1.0` | `127.0.0.1:4020` | API Fastify, worker BullMQ y scheduler en un proceso (`RUNTIME_ROLE=all`). Sirve `/dashboard` solo a peticiones locales. |
| Renderer | `pxos-renderer` | `pxos/renderer:0.1.0` | interno `3000`; `127.0.0.1:4030` solo en desarrollo | Playwright + Chromium para leer catálogos JavaScript. |
| Gemini API | — (externo) | — | — | LLM de trabajo del Prospector y del EmailDrafter. |

> **Nota:** `docs/PORTS.md`, el README raíz y `deployments/README.md` todavía no listan `pxos-renderer` ni el puerto `4030` (consulta [Contradicciones](#6-contradicciones-entre-fuentes)).

### 1.2 Qué hace cada día y cada semana

| Cuándo | Tarea | Qué hace |
|---|---|---|
| **Lunes 07:30** (Europe/Madrid) | `weekly-event-scouting` (CRON `30 7 * * 1`) | Prospector en **modo scout**: busca ferias reales con grounding de Google Search vía Gemini, lee sus catálogos (HTML, PDF o JavaScript con el renderer), pagina el listado, abre fichas de los expositores relevantes para obtener su web y escribe en Twenty empresa, señal `FAIR` e hipótesis `PROPOSED`. Entrada por defecto: sector «alimentación y bebidas», España, 6 meses; hasta 3 ferias. Tiempo máximo: 30 minutos. Activa desde 2026-10-07; la primera ejecución automática es el lunes siguiente (deducido de la guía comercial). |
| **Cada día 08:00** (Europe/Madrid) | `daily-event-prospecting` (CRON `0 8 * * *`) | Prospector en **modo directo**: evalúa los expositores del `default_input`, que hoy es la fixture de demostración (`feria-ejemplo.json`, dominios `.example`). Genera registros de demostración. |
| **Por evento** | `draft-email-on-validated` (trigger `EVENT`) | Cuando el comercial valida una hipótesis (aceptada o editada), el `EmailDrafter` genera un borrador del primer email y lo deja como nota en Twenty. No envía nada. |
| **Continuo** | Webhook de Twenty → `POST /webhooks/twenty` | Cada cambio en una `commercialHypothesis` se convierte, si procede, en una evaluación HUMAN (`ACCEPTED` 1.0, `EDITED` 0.5, `DISCARDED` 0.0) y en un evento `evaluation.recorded`. |
| **Continuo** | Scheduler y reconciliador | Sincronizan schedules con BullMQ cada 60 s, recuperan runs huérfanos y re-publican eventos sin despachar. |
| **Bajo demanda** | `GET /metrics/*` y `/dashboard` | Coste, latencia, embudo y tasa de aceptación por versión de agente. |

Acción humana diaria: el comercial revisa **Commercial OS → Hypotheses** en Twenty (vista *By status*), cambia el estado de cada hipótesis y envía a mano los borradores que le parezcan buenos desde `jesus.abril@publiexpe.info` o `j.abril@publiexpe.info`. El canal de email sigue en warm-up (consulta [email-warmup.md](email-warmup.md)).

### 1.3 Flujo de datos

```
 lunes 07:30                     08:00 diario
 weekly-event-scouting           daily-event-prospecting
        │                               │ (fixture de demo)
        ▼                               ▼
 ┌─────────────────────────── PROSPECTOR (Gemini) ───────────────────────────┐
 │ scout: grounding → fetch_url (HTML/PDF) → render_url ──► pxos-renderer     │
 │ por expositor: 1 llamada LLM {relevante, confianza, hipótesis}             │
 │ si relevante y confianza ≥ 0,5: upsert_company → create_signal →           │
 │ create_hypothesis (PROPOSED); siempre: create_agent_run_summary            │
 └───────────────────────────────┬────────────────────────────────────────────┘
                                 ▼
                    TWENTY (system of record)
        Company · commercialSignal · commercialHypothesis · agentRunSummary
                                 │  el comercial cambia Status
                                 ▼
              webhook firmado (HMAC) → POST /webhooks/twenty
                                 ▼
            tabla evaluations (human-v1) → evento evaluation.recorded
                                 ▼
        trigger EVENT {feedback in [ACCEPTED, EDITED], toStatus: VALIDATED}
                                 ▼
          EMAILDRAFTER (Gemini) → nota «Borrador email — …» en Twenty
                                 ▼
             el comercial revisa y envía a mano (el sistema NO envía)
```

### 1.4 Qué no hace

- **No envía emails.** No hay dependencia SMTP, ni API de correo, ni tool de envío en el registro.
- **No tiene Researcher ni Scorer.** No hay registros `research`, ni `score`, ni prioridad `HOT/WARM/COLD`.
- **No tiene Catalog Service.** Los productos recomendados son familias genéricas, sin `productId` ni SKU.
- **No tiene harness, skills como objetos versionados, memoria ni optimizadores.** Consulta [Mapa de pendientes](#5-mapa-de-pendientes).
- **No gestiona inbound** (respuestas, bajas automáticas). La lista de supresión es manual.
- **No usa n8n.**
- **No borra nada.** El `TwentyClient` no tiene método de borrado y el registry rechaza cualquier tool `DESTRUCTIVE`.
- **No promueve, revierte ni evalúa agentes.** Esos endpoints devuelven `501`.

---

## 2. Registro de decisiones (ADR)

Formato compacto. Cada entrada indica fecha, decisión, motivo, qué sección del LLD modifica y su estado. La fecha es la que dan las fuentes; las tandas 3, 4 y 5 figuran todas con fecha 2026-10-07.

| ADR | Decisión | Tanda | Fecha | Modifica |
|---|---|---|---|---|
| [01](#adr-01) | Metadatos de plataforma fuera de Twenty | LLD v0.1 | 2026-10-06 | Confirma v0.1 §4 |
| [02](#adr-02) | Stack del runtime y contrato HTTP | 1 | 2026-10-06 | v0.2 §2.1, §6.1 |
| [03](#adr-03) | Modelo de la Twenty App: desviaciones | 1 | 2026-10-06 | v0.2 §3 |
| [04](#adr-04) | Idempotencia por clave natural en Twenty | 2 | 2026-10-06 | v0.2 §2.3, §3 |
| [05](#adr-05) | Scheduler sobre BullMQ con locks en PostgreSQL | 2 | 2026-10-06 | v0.2 §5.6 |
| [06](#adr-06) | Gemini como LLM de trabajo, con multi-proveedor | 2 | 2026-10-06 | v0.2 §4.4, §5.1; v0.1 §18 |
| [07](#adr-07) | Un solo Prospector (más EmailDrafter) en lugar de tres agentes | 2 `[DE FACTO]` | 2026-10-06 | v0.2 §9, v0.1 §26 |
| [08](#adr-08) | Umbral de confianza ≥ 0,5 en el Prospector | 2 | 2026-10-06 | v0.2 §9.1, D11, D12 |
| [09](#adr-09) | Búsqueda web por grounding de Gemini y contenido no confiable | 3 | 2026-10-07 | v0.2 §5.7, §10.4 |
| [10](#adr-10) | Scout como modo del Prospector | 3 | 2026-10-07 | v0.2 §9.3 |
| [11](#adr-11) | Event bus con tabla `events` append-only | 3 | 2026-10-07 | v0.2 §7.1 |
| [12](#adr-12) | Espera de salud de Twenty antes de runs con tools | 3 | 2026-10-07 | Añade a v0.2 §5.6 |
| [13](#adr-13) | Feedback por transiciones de estado y webhook | 3 | 2026-10-07 | v0.2 §3.4, §5.5, §6.4 |
| [14](#adr-14) | Renderer como servicio aparte, doble barrera y sandbox | 4 y 5 | 2026-10-07 | v0.2 §10.4 punto 5 |
| [15](#adr-15) | Borradores HITL con garantías por código | 4 y `[TANDA 6, EN CURSO]` | 2026-10-07 | v0.1 §10 y §26; v0.2 §9 |
| [16](#adr-16) | Métricas por SQL y dashboard local | 4 | 2026-10-07 | v0.2 §1 punto 29 |
| [17](#adr-17) | Triggers `EVENT` con `{in}` y `toStatus` | 5 | 2026-10-07 | v0.2 §5.6 |
| [18](#adr-18) | `max_profile_lookups` = 20 | 5 | 2026-10-07 | Parámetro nuevo del scout |
| [19](#adr-19) | Archivo en lugar de borrado de agentes de prueba | 5 | 2026-10-07 | v0.2 §2.3 (aplicación) |
| [20](#adr-20) | Canal de email real: `publiexpe.info`, IONOS, DKIM de dominio | LLD v0.1 | 2026-10-06 | Confirma v0.1 §10.1 |
| [21](#adr-21) | Microsoft SNDS no aplica | 5 | 2026-10-07 | v0.1 §10.1 |
| [22](#adr-22) | Lista de supresión manual en una nota de Twenty | 5 | 2026-10-07 | v0.1 §10.1; v0.2 §13 |

Total: **22 ADR**.

<a id="adr-01"></a>
### ADR-01 · Metadatos de plataforma fuera de Twenty

- **Fecha:** 2026-10-06 (decisión `[C1]` del LLD v0.1; implementada en la tanda 1).
- **Decisión:** Twenty guarda solo lo que el comercial ve y toca (4 objetos custom). Todo lo demás vive en el PostgreSQL del Agent OS, en una base `agentos` separada de la de Twenty.
- **Motivo:** un fallo o una actualización de Twenty no pierde ejecuciones ni obliga a reescribir el Agent OS (v0.1 §4; `deployments/README.md`).
- **Modifica:** nada; confirma v0.1 §4 y v0.2 §4. La realidad son **11 tablas**: `agents`, `agent_versions`, `task_definitions`, `task_definition_versions`, `task_runs`, `agent_executions`, `traces`, `trace_steps`, `entity_locks`, `events`, `evaluations` (`src/db/schema.ts`). Frente a las 9 del v0.2 §4: **falta `audit_log`** y se añaden `entity_locks`, `events` y `evaluations`.
- **Estado:** vigente.

<a id="adr-02"></a>
### ADR-02 · Stack del runtime y contrato HTTP

- **Fecha:** 2026-10-06 (tanda 1).
- **Decisión:** Node.js 22 y TypeScript estricto; Fastify 5; **zod 4** para validar contratos; Drizzle ORM con `pg`; BullMQ sobre Redis; Vitest; pnpm. Twenty `v2.45.6`; PostgreSQL 16 con pgvector; Redis 7.4. La API responde en `snake_case`, acepta la cabecera `x-tenant-id` y escucha solo en `127.0.0.1:4020`.
- **Motivo:** cierra el `[POR COMPLETAR]` del v0.2 §2.1 (versión de Node y paquete del runtime). zod da validación y tipos en un solo sitio. Las fuentes no registran por qué se prefirió zod a Ajv `[NO VERIFICADO]`.
- **Modifica:**
  - v0.2 §2.1: validación con zod, no Ajv sobre JSON Schema 2020-12. Los contratos zod **no se exportan** todavía a `schemas/` (esa carpeta no existe).
  - v0.2 §2.2 y §6.1: las respuestas de la API son `snake_case` (el v0.2 pedía camelCase); los payloads de eventos sí son camelCase.
  - v0.2 §6.1 y D9: **no hay autenticación Bearer**. El runtime depende de escuchar solo en loopback; el dashboard rechaza peticiones no locales.
  - v0.2 §6.2: los estados reales son `QUEUED → RUNNING → COMPLETED | FAILED | TIMED_OUT | CANCELLED`, no `SUCCEEDED`/`PARTIAL`. El resultado de negocio (`SUCCESS`, `PARTIAL`, `FAILED`) va en `output.outcome`.
  - v0.2 §6.3: `pause` y `resume` de ejecuciones devuelven `501`.
- **Estado:** vigente. La autenticación y el export de contratos están en [Pendientes](#5-mapa-de-pendientes).

<a id="adr-03"></a>
### ADR-03 · Modelo de la Twenty App: desviaciones del v0.2 §3

- **Fecha:** 2026-10-06 (tanda 1).
- **Decisión:** la App implementa los 4 objetos con las desviaciones documentadas en `apps/twenty-app/README.md`:
  - Nombres camelCase y `type` → `signalType` (`type` es palabra reservada en Twenty); `title` → `name`; campo `name` añadido a `research`, `commercialHypothesis` y `agentRunSummary` (Twenty exige un campo etiqueta).
  - `SignalStatus` = `NEW`, `REVIEWING`, `QUALIFIED`, `DISCARDED`, `EXPIRED` (el v0.2 proponía `NEW`, `VALIDATED`, `DISCARDED`, `EXPIRED`).
  - `researchType` y `timing` son `TEXT`, no `SELECT`. `sources` y `recommendedProducts` son `ARRAY` de texto; `evidence` y `structuredResult` son `RAW_JSON`.
  - **`tenantId` `TEXT` opcional** en todos los objetos, pese a la decisión D4 del v0.2 (que decía que no llevarían `tenantId`).
  - `agentRunSummary` con otros campos: `task`, `agentName`, `agentVersion` (texto), `outcome` (`SUCCESS`, `PARTIAL`, `FAILED`, `CANCELLED`), `cost` (`CURRENCY`), sin `stage`, `funnelIn` ni `funnelOut`.
  - Sin `idempotencyKey` ni `agentExecutionId` único (los `TEXT` vacíos chocarían en un índice único).
  - «Solo lectura» de `research` y `agentRunSummary` aplicado en la UI, no en servidor.
  - La carpeta de navegación **Commercial OS** tiene 4 entradas; sin *Dashboard* ni *Knowledge*.
- **Motivo:** limitaciones y convenciones de Twenty 2.45 (nombres reservados, campo etiqueta obligatorio) y tipos contrastados contra la versión instalada (cierra D18).
- **Modifica:** v0.2 §3.2 a §3.7 y decisiones D1 a D4 (consulta [3.3](#33-decisiones-d1-a-d18-del-v02-14)).
- **Estado:** vigente.

<a id="adr-04"></a>
### ADR-04 · Idempotencia por clave natural en Twenty

- **Fecha:** 2026-10-06 (tanda 2).
- **Decisión:** como los objetos de la App no tienen campo `idempotencyKey`, cada tool de escritura busca primero un registro con su clave natural (dominio normalizado, empresa + tipo + `eventDate` + `sourceDomain`, nombre de la hipótesis `{empresa} — {evento}`…). Si existe, devuelve `created: false` y el registro existente. `upsert_company` nunca sobrescribe una empresa existente.
- **Motivo:** los datos que edita el comercial prevalecen; un reintento no puede duplicar registros (v0.1 §21).
- **Modifica:** v0.2 §2.3 (formatos `publi:...` como clave persistida) y §3.1 (campo `idempotencyKey` en cada objeto). Las claves `publi:company:create:domain:{domain}` siguen existiendo como clave lógica de la tool.
- **Estado:** vigente. Las tareas y las ejecuciones sí persisten su `idempotency_key` con índice único `(tenant_id, idempotency_key)`.

<a id="adr-05"></a>
### ADR-05 · Scheduler sobre BullMQ con locks en PostgreSQL

- **Fecha:** 2026-10-06 (tanda 2).
- **Decisión:** el scheduler usa Job Schedulers de BullMQ (`CRON`, `INTERVAL`), jobs diferidos (`ONCE`) y un trigger `EVENT` (tanda 3). Deduplica por slot con la clave `taskrun:{task_id}:{scheduled_at}`. `max_concurrency` se aplica con `pg_advisory_xact_lock`. Los locks por entidad viven en la tabla `entity_locks` con TTL. Un reconciliador recupera runs huérfanos.
- **Motivo:** el advisory lock no bloquea los `PATCH` de la tarea, y los grupos de BullMQ son de la versión Pro (README del runtime).
- **Modifica:** v0.2 §5.6, que preveía solo `MANUAL` y `CRON`, concurrencia por cola y un lock en Redis `lock:company:{domain}`. `DEPENDENCY` y `CONDITION` siguen sin registrar nada.
- **Estado:** vigente. `EntityLocks` está listo, pero **ninguna tool lo usa todavía**.

<a id="adr-06"></a>
### ADR-06 · Gemini como LLM de trabajo, con multi-proveedor

- **Fecha:** 2026-10-06 (tanda 2).
- **Decisión:** el proveedor de trabajo es Gemini (`gemini-flash-latest`, que el 2026-10-06 servía `gemini-3.8-flash`), con `thinking_level = low`. La abstracción `ModelProvider` es conmutable por agente y entorno (`stub`, `gemini`, `anthropic`). El coste se calcula con una tabla editable por modelo real servido y se convierte a EUR con `usd_to_eur = 0.86`.
- **Motivo:** clave verificada en vivo y coste bajo (~0,005 € por run de demostración). La arquitectura multi-proveedor se mantiene para que un evaluador use un proveedor distinto del ejecutor cuando llegue MVP-2 (v0.1 §18).
- **Modifica:** cierra el `[POR COMPLETAR]` de `model` y `modelProvider` del v0.2 §4.4. `AnthropicProvider` existe como esqueleto y no se llama en los tests.
- **Estado:** vigente. **Riesgo de coste:** la tabla de precios del README del runtime anota que `gemini-3.8-flash` pasa de 0,75 a 1,50 USD por millón de tokens de entrada y de 3,75 a 7,50 de salida desde 2027-01-01. El coste se duplicaría salvo cambio de modelo.

<a id="adr-07"></a>
### ADR-07 · Un solo Prospector (más EmailDrafter) en lugar de tres agentes `[DE FACTO]`

- **Fecha:** 2026-10-06 (tanda 2). Ninguna fuente lo registra como decisión explícita; se deduce de lo construido.
- **Decisión:** existe un agente `Prospector` que, en **una llamada al LLM por expositor**, decide relevancia, confianza e hipótesis, y escribe empresa, señal e hipótesis `PROPOSED`. No existen `Researcher` ni `Scorer`. Se añade un agente que el v0.2 no preveía, el `EmailDrafter` ([ADR-15](#adr-15)).
- **Motivo:** la bitácora delimita la tanda 2 así: «clasificación y generación de hipótesis desde datos de entrada». Las fuentes no explican por qué se descartó el grafo de tres etapas `[NO VERIFICADO]`; el efecto es que el MVP-0 produce valor sin investigación ni scoring separados.
- **Modifica:** v0.2 §9 completo y v0.1 §26 (MVP-0: «1 agente compuesto Prospector→Researcher→Scorer»). Consecuencias: no hay registros `research`; no hay `score`, `priority` ni filtro `HOT`; la decisión D11 (solo `HOT` en Twenty) y D13 (Signal Classifier dentro del Researcher) quedan sin objeto.
- **Estado:** vigente. Reabrir esta decisión es la mayor palanca de diseño pendiente.

<a id="adr-08"></a>
### ADR-08 · Umbral de confianza ≥ 0,5 en el Prospector

- **Fecha:** 2026-10-06 (tanda 2).
- **Decisión:** el Prospector escribe en Twenty solo si el modelo marca el expositor como relevante y `confidence ≥ min_confidence` (0,5 por defecto, configurable en la versión del agente). La señal de feria sin expositores usa `scout.event_signal_confidence = 0.5`.
- **Motivo:** es el valor inicial `minSignalConfidence = 0.5` de la decisión D12 del v0.2, sin base empírica; se recalibra con el feedback.
- **Modifica:** v0.2 §9.1 y D12. El umbral se aplica en el Prospector, no en un Researcher que no existe. Los pesos del Scorer (0,30/0,25/0,20/0,15/0,10) y el umbral `HOT ≥ 70` **no se aplican**.
- **Estado:** vigente.

<a id="adr-09"></a>
### ADR-09 · Búsqueda web por grounding de Gemini y contenido no confiable

- **Fecha:** 2026-10-07 (tanda 3).
- **Decisión:** la búsqueda de ferias es una llamada a Gemini con la tool nativa `google_search` (un paso `MODEL`), no una tool `search_web`. `fetch_url` descarga páginas con guardias SSRF. Todo contenido web entra solo en mensajes `user`, dentro de bloques `<<<DATOS_NO_CONFIABLES …>>>`. El código decide qué tool llamar; el modelo solo devuelve JSON validado. Cada `sourceUrl` se valida contra el `SourceLedger`.
- **Motivo:** `WEB CONTENT ≠ INSTRUCTIONS` (v0.1 §22, v0.2 §10.4). Observado el 2026-10-07: `gemini-3.8-flash` ejecuta las búsquedas pero no devuelve metadatos de fuentes, por lo que el scout verifica cada URL descargándola y exigiendo que la página corrobore la feria (`scout.verify_unsourced_by_fetch`).
- **Modifica:** v0.2 §5.7 (la tool `search_web` **no existe**) y §10.4 puntos 4 y 8 (la validación de URL en texto libre se aplica en el modo scout; en el modo directo sigue pendiente).
- **Estado:** vigente. El coste de búsqueda se registra al precio de lista (14 USD por 1 000 búsquedas en Gemini 3.x), sin descontar la cuota gratuita.

<a id="adr-10"></a>
### ADR-10 · Scout como modo del Prospector

- **Fecha:** 2026-10-07 (tanda 3).
- **Decisión:** el descubrimiento de ferias reales es un **modo del mismo agente** (`mode = "scout"`, o entrada con `sector` o `event_url`), no un agente hermano. Tarea `weekly-event-scouting`, lunes 07:30.
- **Motivo:** el v0.2 asigna al Prospector tanto el descubrimiento de eventos como la evaluación de expositores; un solo agente comparte versión, prompt de evaluación, pipeline por expositor, tool policy y trazas (README del runtime).
- **Modifica:** nada de fondo en v0.2 §9.3; concreta la skill `event-source-discovery`. Límites por ejecución: 3 ferias, 60 expositores por feria, 18 descargas, 4 renders, 3 páginas de catálogo.
- **Estado:** vigente.

<a id="adr-11"></a>
### ADR-11 · Event bus con tabla `events` append-only

- **Fecha:** 2026-10-07 (tanda 3).
- **Decisión:** los eventos se guardan primero en la tabla `events` (con un trigger que prohíbe `DELETE`) y después se encolan en BullMQ (`{QUEUE_NAME}-events`). Un re-publicador reencola los no despachados. Sobre `event.envelope.v1` en camelCase. Guardia anti-bucle: un evento de la tarea T nunca dispara T, y `chainDepth ≥ 5` no dispara nada.
- **Motivo:** outbox mínimo tolerante a fallos de Redis; los consumidores toleran duplicados.
- **Modifica:** v0.2 §7.1. Diferencias: el evento `evaluation.completed` se llama **`evaluation.recorded`**; **`signal.detected` no se emite**; no hay consumo por n8n; no hay esquemas JSON Schema en `schemas/`. Tampoco se emite `task.failed` cuando el reconciliador cierra un huérfano ni en cancelaciones.
- **Estado:** vigente.

<a id="adr-12"></a>
### ADR-12 · Espera de salud de Twenty antes de runs con tools

- **Fecha:** 2026-10-07 (tanda 3).
- **Decisión:** si la versión del agente permite tools de Twenty, el worker comprueba `GET /healthz` de Twenty antes de pasar el run de `QUEUED` a `RUNNING`. Si no responde, aplaza el job (5, 15, 30 y luego 60 s) sin gastar intentos, hasta `TWENTY_WAIT_MAX_MS` (10 minutos por defecto).
- **Motivo:** el 2026-10-07 el catch-up disparó el slot de las 08:00 al encender el host antes de que `pxos-twenty` estuviera sano. El run salió `PARTIAL` con `TWENTY_NETWORK_ERROR`.
- **Modifica:** añade comportamiento no previsto a v0.2 §5.6. Los agentes sin tools de Twenty y las ejecuciones directas (`POST /executions`) no esperan.
- **Estado:** vigente.

<a id="adr-13"></a>
### ADR-13 · Feedback por transiciones de estado y webhook

- **Fecha:** 2026-10-07 (tanda 3).
- **Decisión:** el comercial da feedback **cambiando `status`** de la hipótesis (`VALIDATED`, `REJECTED`) o editando campos de negocio. Twenty envía un webhook firmado (HMAC-SHA256) por cada cambio. El runtime lo convierte en una fila de `evaluations` y en el evento `evaluation.recorded`. `POST /evaluations/human` queda como vía manual y de recuperación.
- **Motivo:** las fuentes no registran el motivo literal `[NO VERIFICADO]`. Lo que sí documentan: la App no declara los campos `humanFeedback*`, la guía pide «cambia el estado desde Twenty» y Twenty 2.45 envía webhooks por registro. El comercial hace un solo gesto.
- **Modifica:** v0.2 §3.4 (**los campos `humanFeedback`, `humanFeedbackNote` y `humanFeedbackAt` no existen**, ni la logic function de la App que los procesaba), §5.5 y §6.4, y las decisiones D1, D3 y D14.
- **Reglas y límites reales:**
  - Mapeo: `PROPOSED → VALIDATED` sin cambios = `ACCEPTED` 1.0; con edición = `EDITED` 0.5; edición de campos de negocio mientras sigue `PROPOSED` = `EDITED`; `PROPOSED` o `VALIDATED → REJECTED` = `DISCARDED` 0.0. Se ignoran `EXPIRED`, vuelta a `PROPOSED` y ediciones tras validar.
  - El webhook trae solo los **nombres** de los campos cambiados, no los valores previos. El estado origen sale de la última evaluación (se asume `PROPOSED` si no hay ninguna) y el «antes» del diff sale de la propuesta original del agente en el trace.
  - La hipótesis **no guarda `agentExecutionId`** en Twenty: el vínculo con la ejecución de origen se resuelve buscando en las trazas.
  - Twenty no reintenta un webhook fallido. Twenty descarta en silencio los envíos a IP privadas salvo que `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS` incluya `pxos-runtime,host.docker.internal`.
  - Deduplicación por `idempotency_key` y por ventana de 10 minutos (`EVALUATION_DEDUPE_WINDOW_MS`).
- **Estado:** vigente. Activo desde 2026-10-07.

<a id="adr-14"></a>
### ADR-14 · Renderer como servicio aparte, con doble barrera y sandbox

- **Fecha:** 2026-10-07 (servicio en la tanda 4; sandbox en la tanda 5).
- **Decisión:** el render de JavaScript vive en un servicio propio, `pxos-renderer` (Playwright + Chromium), sin puerto público (solo `pxos-net`). El runtime lo llama con la tool `render_url`. Seguridad:
  - **Primera barrera:** todas las peticiones del navegador se interceptan y se sirven desde el servicio con guarda SSRF, DNS público y conexión fijada a la IP comprobada.
  - **Segunda barrera:** Chromium arranca con un proxy muerto (`127.0.0.1:9`), de modo que una petición que escapara a la interceptación falla.
  - **Sandbox de Chromium** (tanda 5): perfil seccomp de Playwright (`deployments/seccomp/chromium-seccomp.json`) y `cap_add: [SYS_CHROOT]`. Además: usuario sin privilegios, raíz de solo lectura, `no-new-privileges`, 1,5 GB y 512 procesos.
  - `fetch_url` lee también PDF con `unpdf` (sin binarios nativos), con el mismo tope de 2 MB.
- **Motivo:** el catálogo JavaScript de Gastrónoma daba 0 expositores con `fetch_url`; con el renderer, 20 de 20 en la primera página. Aislar el navegador evita engordar la imagen del runtime y que un fallo de Chromium afecte a los workers.
- **Modifica:** v0.2 §10.4 punto 5 (egress de `fetch_url`) y la estructura del repo v0.1 §25 (`services/renderer/` no estaba prevista).
- **Estado:** vigente. El renderer paginado (`max_pages`) es requisito del scout actual.

<a id="adr-15"></a>
### ADR-15 · Borradores HITL con garantías por código

- **Fecha:** 2026-10-07 (tanda 4). El descriptor de PubliEXPE es `[TANDA 6, EN CURSO]`.
- **Decisión:** al validar una hipótesis, el agente `EmailDrafter` hace **una** llamada a Gemini y guarda el resultado como nota «Borrador email — {hipótesis}» en la empresa y en la hipótesis. **No hay código de envío.** El modelo no escribe lo que exige el cumplimiento; el código lo añade siempre:
  - la **línea de baja** (`Si no quieres recibir más mensajes, respóndeme o escribe a baja@publiexpe.info`), tras quitar cualquier línea de baja que haya escrito el modelo;
  - la **firma** (`Jesús Abril`, `PubliEXPE · Merchandising y regalo promocional personalizado`, `www.publiexpe.com`) y la despedida;
  - el saludo genérico `Hola:` si no hay decision maker (para no inventar un nombre);
  - avisos si el cuerpo sale de 120 a 180 palabras o el asunto pasa de 70 caracteres.
- `[TANDA 6, EN CURSO]` **Descriptor de PubliEXPE:** el PM ha encargado garantizar también por código un descriptor de PubliEXPE en el borrador, al mismo nivel que la línea de baja. Ni el código fusionado ni las fuentes lo contienen. La firma actual ya incluye una línea de actividad de PubliEXPE; el alcance, la redacción y la ubicación del descriptor nuevo quedan por confirmar al cerrar la tanda 6 `[NO VERIFICADO]`.
- **Motivo:** LSSI art. 21 (identificación del remitente y baja en cada correo) y principio HITL del v0.1 §15: enviar exige a una persona. Una garantía por código no depende de que el modelo obedezca el prompt.
- **Modifica:** v0.1 §26 y v0.2 §9: los borradores de email estaban en MVP-1 (Inbound Manager) y el MVP-0 «no envía nada»; ahora existe un agente de borradores de primer contacto dentro del MVP-0. v0.2 §9.2 sigue cumplido: ningún agente tiene `send_email`.
- **Estado:** vigente (tanda 4). Coste medido: ~0,002 € por borrador.

<a id="adr-16"></a>
### ADR-16 · Métricas por SQL y dashboard local

- **Fecha:** 2026-10-07 (tanda 4).
- **Decisión:** `GET /metrics/summary`, `/agents`, `/evaluations` y `/runs` son consultas SQL de solo lectura sobre las tablas del runtime. `/dashboard` es una página HTML sin frameworks ni CDN, servida solo a peticiones locales (IP loopback o privada y cabecera `Host` local, contra DNS rebinding).
- **Motivo:** obtener cuanto antes la tasa de aceptación humana por versión de agente, el coste por run y el embudo (AC-15 a AC-17, v0.1 §17).
- **Modifica:** v0.2 §1 punto 29, que posponía dashboard y OpenTelemetry a v0.3. Hay dashboard mínimo; **OpenTelemetry sigue pendiente**.
- **Estado:** vigente. No hay autenticación; las consultas tardan menos de 1 ms con el volumen actual.

<a id="adr-17"></a>
### ADR-17 · Triggers `EVENT` con `{in}` y `toStatus`

- **Fecha:** 2026-10-07 (trigger `EVENT` en la tanda 3; operador y guarda en la tanda 5).
- **Decisión:** el `filter` de un trigger `EVENT` compara por igualdad estricta rutas de `data`. Cada valor puede ser un literal o `{"in": [v1, v2, …]}` (OR). La tarea `draft-email-on-validated` filtra `{feedback: {in: [ACCEPTED, EDITED]}, subjectType: hypothesis, toStatus: VALIDATED}`. `toStatus` deja fuera los veredictos `EDITED` registrados mientras la hipótesis sigue `PROPOSED` (editar en el sitio no es validar).
- **Motivo:** una hipótesis **editada y validada** también debe generar borrador, con los datos corregidos, sin disparar borradores por ediciones intermedias.
- **Modifica:** v0.2 §5.6: `EVENT` figuraba como `NOT_IMPLEMENTED`. El operador `in` admite un máximo de valores y exige un array no vacío (`src/events/triggers.ts`).
- **Estado:** vigente. El README del runtime todavía dice «no hay operadores» ([Contradicciones](#6-contradicciones-entre-fuentes)).

<a id="adr-18"></a>
### ADR-18 · `max_profile_lookups` = 20

- **Fecha:** 2026-10-07 (tanda 5, seed v5).
- **Decisión:** el scout abre hasta **20 fichas de expositor por ejecución** (máximo duro 30) para obtener la web de los relevantes sin dominio.
- **Motivo:** las fichas no tienen coste de modelo; solo cuestan tiempo (~10 a 12 s por ficha renderizada). En Gastrónoma, 6 de cada 10 fichas publicaban web; con 10 fichas se obtenían 6 empresas, y con 20 se obtienen más dominios resueltos por feria.
- **Modifica:** parámetro nuevo del scout, ausente del v0.2. Verificado en el código (`prospector-core.ts` y `prospector-seed.ts` valen 20).
- **Estado:** vigente. Una feria con muchos relevantes sigue dejando sin dominio a los de menor confianza.

<a id="adr-19"></a>
### ADR-19 · Archivo en lugar de borrado de agentes de prueba

- **Fecha:** 2026-10-07 (tanda 5).
- **Decisión:** los agentes y tareas `[TEST]` se archivan con `pnpm cleanup:archive-test-agents` (`ACTIVE → ARCHIVED`), nunca se borran. Las métricas y el dashboard ocultan los archivados (`include_archived=true` los muestra).
- **Motivo:** regla del proyecto, «prohibido el borrado destructivo» (v0.2 §2.3), y un dashboard limpio.
- **Modifica:** aplica v0.2 §2.3. Resultado: el tenant `publiexpe` queda solo con `Prospector` y `EmailDrafter`.
- **Estado:** vigente.

<a id="adr-20"></a>
### ADR-20 · Canal de email real: `publiexpe.info`, IONOS, DKIM de dominio

- **Fecha:** 2026-10-06.
- **Decisión:** la prospección en frío sale **solo** de `publiexpe.info`, nunca de `@publiexpe.com`. Proveedor IONOS; buzones basic `jesus.abril@publiexpe.info` y `j.abril@publiexpe.info`; `dmarc@` y `baja@` redirigen a `jesus.abril@`. SPF con el asistente de IONOS, **DKIM a nivel de dominio** (firma todos los buzones, sin coste), DMARC `p=none` con `rua=mailto:dmarc@publiexpe.info`. Web mínima en `https://publiexpe.info` con aviso legal y privacidad. Warm-up manual iniciado el 2026-10-06.
- **Motivo:** proteger la reputación del dominio corporativo; Gmail y Microsoft agregan reputación por dominio organizativo, así que un subdominio aísla menos que un dominio aparte.
- **Modifica:** nada; confirma v0.1 §10.1 y cierra el requisito previo S0b del v0.2 §12. Autenticación verificada con `PASS` contra Gmail.
- **Estado:** vigente; el warm-up dura hasta el 2026-11-02 ([calendario](#7-calendario-de-hitos)).

<a id="adr-21"></a>
### ADR-21 · Microsoft SNDS no aplica

- **Fecha:** 2026-10-07 (tanda 5).
- **Decisión:** no te das de alta en SNDS. Para vigilar Outlook se usan pruebas de colocación con cuentas propias, lectura de cabeceras (`Authentication-Results`, `X-Forefront-Antispam-Report`), seguimiento manual de rebotes `5.7.1` y señales indirectas.
- **Motivo:** SNDS autoriza por IP y las IP de IONOS compartido no son tuyas: el correo de autorización iría a contactos de IONOS. Tampoco hay feedback de quejas. Ninguna página oficial de Microsoft lo dice de forma expresa; la conclusión se apoya en la mecánica de SNDS y en fuentes de terceros.
- **Modifica:** v0.1 §10.1 (monitorización con SNDS). Aplicaría si algún día se envía desde una IP dedicada.
- **Estado:** vigente.

<a id="adr-22"></a>
### ADR-22 · Lista de supresión manual en una nota de Twenty

- **Fecha:** 2026-10-07 (tanda 5).
- **Decisión:** hasta que exista el Inbound Manager, la lista de supresión es **una única nota** en Twenty titulada `Lista de supresión — NO contactar`, con una línea `email — fecha — motivo` por baja. Se añade el mismo día, no se borra ni se edita ninguna línea, y se consulta **antes de cada envío en frío**. La nota ya está creada.
- **Motivo:** cumplir LSSI y RGPD sin esperar a MVP-1.
- **Modifica:** v0.1 §10.1 y v0.2 §13 (lista de supresión global en MVP-1). **La comprobación previa al envío depende de una persona**: el `EmailDrafter` no tiene ninguna tool que lea notas (su política es `find_company`, `get_company`, `get_hypothesis` y `create_note`), así que no consulta la lista.
- **Estado:** vigente, provisional hasta MVP-1.

---

## 3. LLD v0.2 → realidad

### 3.1 Los 34 puntos del v0.2 §1

| # | Punto | Estado en el v0.2 | Realidad | Detalle |
|---|---|---|---|---|
| 01 | Objetos Twenty exactos | Cubierto | Implementado distinto | Los 4 objetos existen con otros nombres de campo y sin varios campos. [ADR-03](#adr-03) |
| 02 | Campos y tipos | Cubierto | Implementado distinto | Sin `humanFeedback*`, `score`, `priority`, `agentExecutionId`, `idempotencyKey`; con `tenantId`. [ADR-03](#adr-03), [ADR-13](#adr-13) |
| 03 | Relaciones | Cubierto | Implementado distinto | Mismas relaciones; cambian nombres (`research.commercialSignal`, `Person.decisionMakerHypotheses`) y `SET_NULL` al borrar. [ADR-03](#adr-03) |
| 04 | Enums | Cubierto | Implementado distinto | `SignalStatus` con `REVIEWING` y `QUALIFIED`; sin `HumanFeedback`, `HypothesisPriority`, `PipelineStage`; `RunStatus` sustituido por `outcome`. [ADR-03](#adr-03) |
| 05 | Interfaces TypeScript | Cubierto | Implementado distinto | Hay `ModelProvider`, `Tool`, registry, executor y scheduler con zod. No hay `SkillDefinition`, `Harness` ni `Evaluator` genérico. [ADR-02](#adr-02) |
| 06 | Contratos de API | Cubierto | Implementado distinto | `snake_case`, sin Bearer, estados `COMPLETED`, `pause`/`resume` en `501`. Endpoints extra: `/events`, `/metrics/*`, `/webhooks/twenty`, `/scheduler/status`. [ADR-02](#adr-02) |
| 07 | Contratos de eventos | Cubierto | Implementado distinto | Sobre `event.envelope.v1` y catálogo emitido; `evaluation.recorded`; sin `signal.detected`. [ADR-11](#adr-11) |
| 08 | Interfaces del Agent Runtime | Parcial | Implementado distinto | Agentes como clases con código propio (`StubAgent`, `SmokeAgent`, `ProspectorAgent`, `EmailDrafterAgent`); no hay harness. [ADR-07](#adr-07) |
| 09 | Tool interface | Cubierto | Implementado igual | Mismos campos y clases de riesgo; zod en lugar de JSON Schema. 11 tools reales. |
| 10 | Skill interface | Cubierto | Pendiente | No existe `SkillDefinition` ni skills como ficheros o filas versionadas. Hay prompts versionados en código, referenciados desde `skill_refs`. |
| 11 | Harness interface | Cubierto (mínima) | Pendiente | No hay bucle `CONTEXT → MODEL → TOOL POLICY → EXECUTOR → VERIFIER`. Los agentes orquestan su propio flujo; el `ToolExecutor` aplica allowlist, riesgo y límites. |
| 12 | Memory interface | Pospuesto | Pendiente | Coherente con el v0.2: sin memoria episódica ni semántica. |
| 13 | Evaluator interface | Cubierto | Implementado distinto | Solo el evaluador HUMAN (`human-v1`) y la tabla `evaluations`. No existe `rules-v1`. [ADR-13](#adr-13) |
| 14 | Task scheduler | Cubierto | Implementado distinto | Más tipos que el v0.2 (`ONCE`, `CRON`, `INTERVAL`, `EVENT`, `MANUAL`); `DEPENDENCY` y `CONDITION` no registran nada. [ADR-05](#adr-05), [ADR-17](#adr-17) |
| 15 | Experiment interface | Pospuesto | Pendiente | MVP-2. |
| 16 | Release Gate | Pospuesto | Pendiente | MVP-2. `promote`, `rollback` y `evaluate` devuelven `501`. |
| 17 | Trace schema | Cubierto | Implementado distinto | `traces` y `trace_steps` con pasos `THINK`, `MODEL`, `TOOL`, `FINAL`; sin `trace.v1` en JSON Schema ni `retention_until`. |
| 18 | Esquema de BD | Cubierto | Implementado distinto | 11 tablas, sin `audit_log`. Migraciones Drizzle `0000` a `0003`. [ADR-01](#adr-01) |
| 19 | Workflows n8n | Pospuesto | Pendiente | No hay `integrations/` ni workflows. |
| 20 | Primeros 3 agentes | Cubierto | Implementado distinto | `Prospector` y `EmailDrafter`; sin Researcher ni Scorer. [ADR-07](#adr-07) |
| 21 | Primeras 10 skills | Parcial (5 de 10) | Implementado distinto | Existen 3 prompts versionados (`prospector-event-exhibitors` v2, `event-source-discovery` v3, `email-first-contact-draft` v1); solo uno coincide con las 5 skills del v0.2. |
| 22 | Evaluation dataset | Pospuesto | Pendiente | MVP-2. Hay veredictos humanos en `evaluations` como materia prima. |
| 23 | Benchmark comercial | Pospuesto | Pendiente | MVP-2. |
| 24 | Modelo de seguridad | Cubierto (resumido) | Implementado distinto | Allowlist, techo de riesgo, SSRF, contenido no confiable, `SourceLedger`. Sin `audit_log`, sin batería de ≥ 10 páginas hostiles (AC-12). [ADR-09](#adr-09), [ADR-14](#adr-14) |
| 25 | Arquitectura Docker | Fuera del documento | Implementado igual | `deployments/docker-compose.yml`, 8 contenedores. [Sección 1.1](#11-qué-corre-y-dónde) |
| 26 | CI/CD | Pospuesto | Pendiente | Sin pipeline. Los workflows de `apps/twenty-app/` son los de la plantilla y no se ejecutan en este repositorio. |
| 27 | Estrategia de tests | Pospuesto | Implementado distinto | De facto: Vitest con tests unitarios, de integración y en vivo, y dobles (`FakeTwenty`, `FakeWeb`, `FakeRenderer`). 364 tests en la tanda 5. Sin documento de estrategia. |
| 28 | Datos seed/demo | Pospuesto | Implementado distinto | `pnpm seed` (idempotente) crea `Prospector`, `EmailDrafter` y sus 3 tareas, y la fixture `feria-ejemplo.json`. |
| 29 | Observabilidad | Parcial | Implementado distinto | Trazas, métricas SQL y dashboard local. Sin OpenTelemetry. [ADR-16](#adr-16) |
| 30 | Rollback y recuperación | Pospuesto | Pendiente | Solo backup manual con `pg_dump` y parada segura documentada en el runbook. Rollback de agente: `501`. |
| 31 | Criterios de aceptación | Cubierto | Implementado distinto | Algunos medibles hoy, otros no. [Sección 4.2](#42-criterios-de-aceptación-del-v02-11) |
| 32 | Estructura del repo | Sin cambios | Implementado distinto | Existen `apps/twenty-app/`, `runtime/agent-runtime/`, `services/renderer/`, `deployments/`, `scripts/`, `docs/`. No existen `evaluation/`, `optimization/`, `integrations/`, `schemas/`, `services/catalog/`, `services/inbound/`. |
| 33 | Orden de implementación | Cubierto | Implementado distinto | [Sección 3.4](#34-orden-de-implementación-v02-12). |
| 34 | Master prompt para Codex | Pospuesto | Pendiente | Ninguna fuente lo menciona como hecho. |

Resumen de los 34 puntos: **2 implementados igual** (09 y 25), **21 implementados distinto** y **11 pendientes** (10, 11, 12, 15, 16, 19, 22, 23, 26, 30 y 34).

### 3.2 Secciones relevantes del v0.2

| Sección del v0.2 | Estado | Realidad |
|---|---|---|
| §2.1 Stack fijado | Implementado distinto | Node 22, zod en lugar de Ajv; resto igual. [ADR-02](#adr-02) |
| §2.2 Convenciones de nombres | Implementado distinto | API en `snake_case`; eventos en camelCase; tablas y columnas en `snake_case`. |
| §2.3 Idempotencia | Implementado distinto | Persistida en tareas y ejecuciones; en Twenty, por clave natural. [ADR-04](#adr-04) |
| §2.3 Multi-tenancy `[C6]` | Implementado igual | `tenant_id` en todas las tablas; el `tenantId` también se escribe en Twenty. |
| §3 Objetos Twenty | Implementado distinto | [ADR-03](#adr-03) |
| §3.4 Regla de transición por `humanFeedback` | Implementado distinto | Sustituida por el webhook sobre `status`. [ADR-13](#adr-13) |
| §3.8 Permisos en Twenty | Pendiente | Una sola API key del runtime. El alcance por objeto sigue `[POR COMPLETAR]`; «solo lectura» solo se aplica en la UI. |
| §4 Esquema de BD | Implementado distinto | [ADR-01](#adr-01). Sin `audit_log`. Sin `config_snapshot` en `agent_executions`; el run guarda versión del agente, versiones de skills, harness y entorno en `task_runs` (`processor.ts`). Sin `retention_until` (`schema.ts`). |
| §5.2 Tool | Implementado igual | Registry, riesgos, allowlist y executor con límites. |
| §5.5 Evaluator | Implementado distinto | Solo `human-v1`, con el mapeo D14. |
| §5.6 TaskScheduler | Implementado distinto | [ADR-05](#adr-05) |
| §5.7 Registro de tools | Implementado distinto | Existen `find_company`, `get_company`, `upsert_company`, `create_signal`, `create_research`, `create_hypothesis`, `fetch_url`, y además `create_agent_run_summary`, `get_hypothesis`, `create_note` y `render_url`. **No existen** `search_web`, `create_activity` ni las 5 tools del Catalog Service. |
| §6 API del runtime | Implementado distinto | [ADR-02](#adr-02) |
| §6.4 `POST /evaluations/human` | Implementado distinto | Existe y acepta la forma del v0.2; el camino principal es el webhook. Responde con `event_id`. |
| §7 Eventos y esquemas | Implementado distinto | [ADR-11](#adr-11). Los 6 JSON Schema (`research.result.v1`, `commercial.hypothesis.v1`, `agent.task.*`, `evaluation.human.v1`) no se han materializado. |
| §8 Trace schema | Implementado distinto | Parcial, consulta punto 17. |
| §9 Agentes y skills | Implementado distinto | [ADR-07](#adr-07). El pipeline de grafo fijo y el embudo 120 → 87 → 31 → 14 no existen. |
| §10.1 Clases de riesgo | Implementado igual | Registry rechaza `DESTRUCTIVE`; no existen tools `HIGH_WRITE` ni `EXTERNAL_SIDE_EFFECT`. |
| §10.4 Prompt injection | Implementado distinto | Puntos 1, 2, 3, 5, 6, 7 implementados; punto 4 solo en modo scout; punto 8 (`verifyBeforeCommit` con validador semántico) sin harness. [ADR-09](#adr-09) |
| §10.5 Retención de trazas | Pendiente | Ninguna política automática (`traces` sin `retention_until`). |
| §10.6 Auditoría | Pendiente | Sin `audit_log`. |
| §11 Criterios de aceptación | Parcial | [Sección 4.2](#42-criterios-de-aceptación-del-v02-11) |

### 3.3 Decisiones D1 a D18 del v0.2 §14

Todas eran `[PROPUESTA]`. Esta es su resolución real.

| # | Decisión propuesta | Resolución | Detalle |
|---|---|---|---|
| D1 | Campos `score`, `priority`, `humanFeedback*`, `agentExecutionId` en `commercialHypothesis` | **Modificada** | Ninguno existe. Feedback por transiciones; vínculo con la ejecución por trace. [ADR-13](#adr-13) |
| D2 | Campos de `agentRunSummary` | **Modificada** | Otros campos (`task`, `outcome`, `cost`…). [ADR-03](#adr-03) |
| D3 | Enums nuevos | **Parcial** | `SignalStatus` distinto; `ResearchType` y `HypothesisTiming` como `TEXT`; `HypothesisPriority` y `HumanFeedback` no existen. |
| D4 | Sin `tenantId` en Twenty | **Rechazada** | La App tiene `tenantId` `TEXT` opcional y las tools lo escriben. |
| D5 | Tabla `audit_log` en MVP-0 | **No implementada** | 11 tablas, ninguna es `audit_log`. |
| D6 | `TaskRun` con N ejecuciones | **Confirmada con otro motivo** | N ejecuciones por `TaskRun` son los **intentos**, no las etapas. `task_runs.execution_id` apunta al último. |
| D7 | `promote` y `rollback` sin Release Gate, solo por humano | **No implementada** | Devuelven `501`. |
| D8 | Endpoints añadidos | **Parcial** | Existen `GET /health`, `GET /tasks/:id/runs`, `GET /agents`, `POST /evaluations/human`. La traza se obtiene en `GET /executions/:id` y `GET /task-runs/:id`, no en `/executions/:id/trace`. `/health` informa del servicio y de la BD. |
| D9 | Autenticación Bearer estática | **No implementada** | Sin autenticación en la API. |
| D10 | Event bus BullMQ con outbox mínimo | **Confirmada y ampliada** | Tabla `events` append-only; sin consumo por n8n. [ADR-11](#adr-11) |
| D11 | Solo hipótesis `HOT` en Twenty | **Modificada** | Se escriben todas las relevantes con confianza ≥ 0,5 como `PROPOSED`. [ADR-07](#adr-07), [ADR-08](#adr-08) |
| D12 | Pesos, umbrales (HOT ≥ 70) y `minSignalConfidence` 0,5 | **Parcial** | Solo se aplica el 0,5. [ADR-08](#adr-08) |
| D13 | Signal Classifier como skill del Researcher | **Sin objeto** | No hay Researcher; la clasificación va en la llamada del Prospector. |
| D14 | Mapeo `ACCEPTED` 1.0, `EDITED` 0.5, `DISCARDED` 0.0 | **Confirmada** | Tabla `evaluations`. |
| D15 | Tools nuevas y clases de riesgo | **Confirmada y ampliada** | Se añaden `create_agent_run_summary`, `get_hypothesis`, `create_note`, `render_url`. |
| D16 | Umbrales de aceptación | **Parcial** | Medibles hoy: AC-15 y AC-16. [Sección 4.2](#42-criterios-de-aceptación-del-v02-11) |
| D17 | Retención de trazas de 90 días | **No implementada** | Sin columna ni job de retención. |
| D18 | Tipos de campo de Twenty sin contrastar | **Cerrada** | Contrastados con Twenty 2.45 (`LINKS`, `CURRENCY`, `SELECT` en mayúsculas, relaciones por columna `companyId`…). |

### 3.4 Orden de implementación (v0.2 §12)

| Paso | Entregable | Realidad |
|---|---|---|
| S0 | Infra Docker | Hecho (más `pxos-renderer`). |
| S0b | Dominio, DNS y warm-up | Hecho; warm-up en curso hasta 2026-11-02. [ADR-20](#adr-20) |
| S1 | Esquemas JSON en `schemas/` | **Pendiente.** Contratos en zod, sin export. |
| S2 | Migraciones Drizzle | Hecho (`0000` a `0003`). |
| S3 | Twenty App | Hecho, con desviaciones. [ADR-03](#adr-03) |
| S4 | Runtime base | Hecho, sin autenticación. |
| S5 | `ModelProvider` y tools `READ` web | Hecho (Gemini, `fetch_url`, `render_url`); sin `search_web`. |
| S6 | `TraceRecorder` y trazas | Hecho. |
| S7 | Harness mínimo | **Pendiente.** |
| S8 | Integración con Twenty | Hecho. |
| S9 | Catalog Service stub y tools | **Pendiente.** Falta el contrato con el backend de publiexpe. |
| S10 | 5 skills y 3 agentes | **Distinto.** Un Prospector y un EmailDrafter. [ADR-07](#adr-07) |
| S11 | Pipeline de grafo fijo y scheduler | Scheduler hecho; pipeline de tres etapas **no**. |
| S12 | Eventos y `agentRunSummary` | Hecho. |
| S13 | Validador semántico y evaluador `rules-v1` | **Pendiente.** |
| S14 | Feedback humano | Hecho por webhook. [ADR-13](#adr-13) |
| S15 | Batería de prompt injection (≥ 10 casos) | **Pendiente** como batería formal; hay tests de inyección en el scout y en PDF. |
| S16 | n8n | **Pendiente** (opcional). |
| S17 | Ventana de aceptación de 7 días | **No completada** según las fuentes. |

---

## 4. Métricas reales (línea base a 2026-10-07)

> **Importante:** las cifras salen del [CHANGELOG](CHANGELOG.md), de la bitácora [ESTADO](ESTADO.md) y del README del runtime. Algunas se midieron en la tanda 4 y no se han vuelto a medir tras la limpieza de la tanda 5. La base de desarrollo mezcla datos de prueba con datos reales. Úsalas como línea base, no como resultado de aceptación.

### 4.1 Cifras

**Tests**

| Tanda | Tests |
|---|---|
| 1 | 27/27 |
| 2 | 131/131 (integración combinada) |
| 3 | 278 |
| 4 | 342 |
| 5 | 364 (la bitácora escribe «364 tests×2»; el significado de «×2» no está explicado `[NO VERIFICADO]`) |

**Costes medidos**

| Concepto | Valor | Origen |
|---|---|---|
| Prospector, modo directo, fixture de 3 expositores | ~0,005 a 0,006 € por run | Tanda 2 |
| EmailDrafter | ~0,0018 a 0,002 € por borrador, ~5 s | Tanda 4 |
| Scout e2e en Docker (catálogo JS) | 0,06 € | Tanda 4 |
| Scout sobre `gastronoma.es` (prueba de aceptación) | 0,139 € (63 llamadas al LLM, ~8 min) | Tanda 5 |
| Búsqueda con grounding (7 consultas) | 0,098 USD | 2026-10-07 |
| Estimación de la ejecución semanal (3 ferias de 60 expositores) | hasta ~0,45 € | README del runtime |
| Coste acumulado en el dashboard | 0,19 € | Tanda 4 |
| Coste por feria de 60 expositores (sin grounding) | ~0,14 € | README del runtime |

**Aceptación humana y volumen**

| Concepto | Valor | Origen |
|---|---|---|
| Tasa de aceptación humana | 66,7 % | Tanda 4 (datos reales del dashboard) |
| Ciclo real con el usuario | 5 validaciones → 5 borradores | Tanda 5 |
| Catálogo JS de Gastrónoma, primera página | 20 de 20 expositores (de 91) | Tanda 4 |
| Scout de Gastrónoma | 60 evaluados, 56 relevantes, 10 fichas abiertas, 6 dominios, 6 empresas creadas (señal `FAIR` e hipótesis `PROPOSED`) | Tanda 5 |
| Agentes `[TEST]` archivados | 22 según la bitácora; «30+ agentes/tareas» según el changelog | Tanda 5 |
| Volumen de la BD de desarrollo en la tanda 4 | 219 `task_runs`, 280 `agent_executions`, 16 `evaluations` (con datos de prueba) | README del runtime |

### 4.2 Criterios de aceptación del v0.2 §11

La ventana de 7 días consecutivos de ejecución real **no está completada** según las fuentes.

| ID | Criterio | Estado | Evidencia |
|---|---|---|---|
| AC-01 | 4 objetos con campos del v0.2 | No aplicable tal cual | La App difiere a propósito. [ADR-03](#adr-03) |
| AC-02 | 9 tablas del Agent OS | No aplicable tal cual | Hay 11 tablas; migraciones aplicadas al arrancar. |
| AC-03 | Contrato de API con Ajv | No aplicable tal cual | Contratos en zod; existen tests de API. |
| AC-04 | Tarea diaria a las 08:00 | No medible | Programada. Falta la columna `trigger` en `task_runs`. |
| AC-05 | Trace completo por ejecución | Implementado | Invariantes de `sequence` sin verificar `[NO VERIFICADO]`. |
| AC-06 | Reproducibilidad con `config_snapshot` | Parcial | Sin `config_snapshot`; el run guarda versiones en `task_runs`. |
| AC-07 | Idempotencia sin duplicados | Cumplido en tests | Tests de idempotencia, de reintento y de repetición del mismo evento. |
| AC-08 | Salidas válidas contra esquema | Implementado | Validación zod con un reintento; sin medición del porcentaje. |
| AC-09 | Sin fuentes alucinadas | Parcial | `SourceLedger` en el modo scout; no hay validador semántico sobre el trace. |
| AC-10 | Cumplimiento de políticas | Parcial | Allowlist y techo de riesgo impuestos por el executor; no existe `send_email`; sin `audit_log`. |
| AC-11 | `CRM_CORRECTNESS ≥ 0,95` | No medido | Sin muestreo semanal. |
| AC-12 | Resistencia a prompt injection | Parcial | Tests con inyección en HTML y PDF; sin batería de ≥ 10 páginas. |
| AC-13 | `agentRunSummary` por ejecución | Parcial | El Prospector lo escribe siempre; el EmailDrafter no lo escribe. |
| AC-14 | Feedback llega al Agent OS en ≤ 1 minuto | Parcial | Probado en vivo con HMAC (tanda 3) y ciclo real (tanda 5); latencia sin medir. |
| AC-15 | Coste por run ≤ 3,00 € | **Cumplido** | Observado ~0,14 € por feria; ~0,24 € con grounding (estimación); semanal máxima estimada ~0,45 €. |
| AC-16 | Duración ≤ 30 min | **Cumplido** | Scout de Gastrónoma: ~8 min. |
| AC-17 | Coste por hipótesis `HOT` | Parcial | Se mide por hipótesis nueva; no hay desglose `HOT`. |
| AC-18 | ≥ 5 `HOT` por día laborable | No medible | No existe prioridad `HOT`. |
| AC-19 | Revisión en 48 h ≥ 80 % | No medido | No existe `humanFeedbackAt`; se podría derivar de `evaluations.occurred_at`. |
| AC-20 | Aceptadas o editadas ≥ 40 % | Orientativo: cumplido | `useful_rate ≥ acceptance_rate` = 66,7 % en una muestra pequeña y mezclada con pruebas. |
| AC-21 | Datos de empresa correctos ≥ 90 % | No medido | Requiere muestra de 30 hipótesis revisadas. |

Cómo leer las métricas hoy:

```sh
curl -s "http://127.0.0.1:4020/metrics/summary" -H 'x-tenant-id: publiexpe'
curl -s "http://127.0.0.1:4020/metrics/agents?since=2026-10-01T00:00:00%2B02:00" -H 'x-tenant-id: publiexpe'
```

---

## 5. Mapa de pendientes

### 5.1 Hacia MVP-1 y MVP-2 del v0.1 §26

> **Importante:** **harness, skills, memoria, evaluación formal y optimizadores no han empezado.** Lo construido hasta ahora es un runtime de agentes con código propio, trazas, métricas y feedback humano. Es la base del MVP-0, no del MVP-1.

| Capacidad (v0.1 §26) | Fase | Estado real |
|---|---|---|
| Twenty + App (4 objetos) | MVP-0 | Hecho, con desviaciones. |
| `Agent` + `AgentVersion` | MVP-0 | Hecho. El seed añade una versión nueva del agente si cambia su configuración y deprecia la anterior. |
| `TaskDefinition` + `TaskRun` + `Trace` | MVP-0 | Hecho. |
| Evaluador HUMAN | MVP-0 | Hecho (webhook). |
| Catalog Service (search y match, solo lectura) | MVP-0 | **Pendiente.** A la espera del contrato del conector con el equipo del backend de publiexpe. |
| 1 agente compuesto Prospector → Researcher → Scorer | MVP-0 | **No como se diseñó.** [ADR-07](#adr-07) |
| `publiexpe.info` y warm-up | Requisito previo | En curso. |
| Skills + `SkillVersion` | MVP-1 | **Sin empezar.** Solo prompts versionados en código. |
| Harness + `HarnessVersion` | MVP-1 | **Sin empezar.** |
| Memory (episódica y semántica básica) | MVP-1 | **Sin empezar.** |
| Inbound Manager (clasificación y borradores con aprobación) | MVP-1 | **Sin empezar.** Existen los borradores de **primer** email; no hay lectura de buzón ni clasificación. |
| Experiments, datasets validation y test | MVP-2 | **Sin empezar.** |
| Release Gates, canary, rollback | MVP-2 | **Sin empezar.** Endpoints en `501`. |
| Skill, Harness y Router Optimizer | MVP-3 | Sin empezar. |
| Entornos dinámicos y puente de entrenamiento | MVP-4 | Sin empezar. |

Qué existe y adelanta trabajo de MVP-2: la tabla `evaluations` (veredictos humanos ligados a la ejecución de origen), las métricas por versión de agente y el archivo de agentes de prueba. Son insumo para construir el primer dataset, no el dataset.

### 5.2 Decisiones de diseño abiertas

1. **¿Se construyen Researcher y Scorer o se acepta el Prospector único?** Hoy no hay investigación con fuentes ni scoring. Afecta a AC-18 y a la calidad de la hipótesis.
2. **¿Autenticación del runtime?** El v0.2 propone Bearer; hoy la defensa es escuchar solo en loopback.
3. **¿Fuente real para la tarea diaria?** `daily-event-prospecting` sigue sobre datos de demostración.
4. **Idioma y mercados de prospección** (v0.1 §27, pendiente).
5. **Datos registrales completos del aviso legal** (folio y hoja GR-xxxxx, v0.1 §27).
6. **Contrato del Catalog Service y de `create_quote_request`** con el equipo del backend de publiexpe.

### 5.3 Flecos operativos

**Ejecución y datos**

- Columna `trigger` en `task_runs` para medir AC-04.
- Desglose de hipótesis por prioridad para AC-17 y AC-18, o redefinir esos criterios sin `HOT`.
- Triggers `DEPENDENCY` y `CONDITION`: no registran nada.
- Política de catch-up del scheduler: al volver tras una parada, solo se procesa el slot pendiente y los demás se omiten.
- Eventos aún no emitidos: `task.failed` del reconciliador, cancelaciones y `signal.detected`.
- Ninguna hipótesis caduca sola: hay que marcar `EXPIRED` a mano.
- El `Decision maker` no lo rellena el sistema; no se comprueba si la empresa ya es cliente.
- Modo directo: validación de URL en texto libre contra las fuentes del trace (el scout ya la aplica).
- Las fichas de expositor se abren en serie (~10 a 12 s por ficha); con muchos relevantes, `max_profile_lookups` deja sin dominio a los de menor confianza. Leer la API JSON del catálogo, si existe, sería más barato.
- Grounding sin metadatos de fuentes en `gemini-3.8-flash`: se verifica por descarga.
- `GeminiProvider.stream()` no es incremental.
- Precio de Gemini 3.8 Flash: se duplica desde 2027-01-01.

**Plataforma**

- Export de los contratos zod a JSON Schema versionado en `schemas/`.
- `audit_log`, `config_snapshot`, `retention_until` y política de retención de trazas.
- Alcance limitado de la API key de Twenty por objeto (`[POR COMPLETAR]` del v0.2 §10.2).
- OpenTelemetry, CI/CD y n8n.
- `EntityLocks` listo pero sin tools que lo usen.
- Tools pendientes del registro del MVP-0: `search_web`, `create_activity` y las del Catalog Service.
- `/health` solo informa del servicio y de la base de datos; el v0.2 prevé también Redis y Twenty.

**Email y cumplimiento**

- Warm-up en curso (semanas 3 y 4: 2026-10-20 a 2026-11-02).
- Hito DMARC `p=none` → `p=quarantine` el **2026-11-03**, si los informes de `dmarc@publiexpe.info` salen limpios.
- Lista de supresión manual: la comprobación previa al envío depende de la persona.
- Plantillas por sector y registro de si el comercial envió el borrador.
- `[TANDA 6, EN CURSO]` Descriptor de PubliEXPE en los borradores ([ADR-15](#adr-15)).

**Documentación desactualizada**

- Los README y guías que contradicen la realidad figuran en la sección siguiente.

---

## 6. Contradicciones entre fuentes

Las fuentes se contradicen en estos puntos. Para cada uno se indica cuál está al día.

| # | Contradicción | Cuál es correcta |
|---|---|---|
| 1 | `runtime/agent-runtime/README.md` dice en «Tareas disparadas por evento» que el filtro «no hay operadores» y, en «Borradores de email», que un veredicto `EDITED` no dispara la tarea (el filtro no tiene OR). Su sección «Pendiente» también lista «disparar también con `EDITED`». | CHANGELOG (tanda 5), ESTADO y el seed: el operador `{in}` y la guarda `toStatus` existen, y `EDITED` validada genera borrador. |
| 2 | El README del runtime fija `scout.max_profile_lookups` en 10 (tabla de configuración, «Coste esperado» y «Seed»). | CHANGELOG, ESTADO y el código (`prospector-core.ts`, `prospector-seed.ts`): 20. |
| 3 | El README del runtime («Pendiente») dice que falta integrar `pxos-renderer` en el compose y, opcionalmente, el seccomp. El README del renderer dice que Chromium corre «sin su sandbox» y describe la integración como pasos por hacer. | `deployments/docker-compose.yml`, CHANGELOG y ESTADO: renderer integrado, con seccomp, `SYS_CHROOT` y `RENDER_CHROMIUM_SANDBOX=true`. |
| 4 | El README del runtime («Pendiente») dice que el dashboard no filtra los agentes `[TEST]`. | CHANGELOG (tanda 5): el filtro existe y se ven con `include_archived=true`. |
| 5 | `docs/PORTS.md`, el README raíz y `deployments/README.md` no listan `pxos-renderer` ni el puerto `4030`. El README raíz lista `evaluation/`, `optimization/`, `integrations/`, Catalog Service e Inbound Manager como componentes, sin indicar que no existen. | `deployments/docker-compose.yml` publica `127.0.0.1:4030` solo para desarrollo; esas carpetas no existen. |
| 6 | La bitácora ESTADO habla de «22 agentes [TEST] archivados»; el CHANGELOG, de «30+ agentes/tareas». | Sin resolver. Pueden contar cosas distintas (agentes frente a agentes y tareas). |
| 7 | La bitácora ESTADO anota «364 tests×2» en la tanda 5. | Sin resolver el sentido de «×2» (¿dos suites, dos ejecuciones?). |
| 8 | `docs/guia-comercial.md` dice que el Prospector «no busca por su cuenta» y que el scouting «debería» estar activo, y promete actualizar la guía. El `runbook-local.md` dice «en despliegue». | CHANGELOG (tanda 3) y README del runtime: el modo scout está implementado y programado; la guía y el runbook no se actualizaron. |
| 9 | LLD v0.2 §9 y §12 describen tres agentes y un grafo fijo; LLD v0.1 §26 pide el mismo pipeline para MVP-0. | Es divergencia de diseño frente a realidad, no un error documental. [ADR-07](#adr-07) |
| 10 | `docs/CHANGELOG.md` coloca la sección «Sin publicar» entre la tanda 5 y la tanda 1, y la tanda 1 figura la última. | Orden de lectura incoherente; no cambia ningún dato. |

> **Nota:** este documento **no corrige** esas fuentes (solo toca `docs/` y el README raíz por encargo). Cada fila es una tarea de mantenimiento documental pendiente.

---

## 7. Calendario de hitos

| Fecha | Hito |
|---|---|
| 2026-10-06 | Tandas 1 y 2 (PR #1 y #2). Inicio del warm-up de `publiexpe.info`. SPF, DKIM y DMARC `p=none` verificados. |
| 2026-10-07 | Tandas 3, 4 y 5 (PR #3, #4 y #5). Primer ciclo real: 5 validaciones → 5 borradores. |
| 2026-10-12 (deducido) | Primera ejecución automática del scout (`weekly-event-scouting`, 07:30): el lunes siguiente al 2026-10-07. |
| 2026-10-20 a 2026-11-02 | Semanas 3 y 4 del warm-up (30 a 40 correos por buzón y día). |
| 2026-11-03 | Revisión de informes DMARC y, si están limpios, paso a `p=quarantine`. |
| 2027-01-01 | El precio de `gemini-3.8-flash` se duplica según la tabla del runtime. |
| `[TANDA 6, EN CURSO]` | Descriptor de PubliEXPE en los borradores y el resto del alcance de la tanda 6, no recogido en las fuentes. |
