# LLD v0.3 — Estado real del sistema

| Campo | Valor |
|---|---|
| Estado | Consolidación del diseño con lo construido |
| Fecha | 2026-10-07 |
| Rama | `docs/lld-0.3` (tandas 1 a 6) y `docs/adrs-tanda7` (ADR de las tandas 6 y 7) |
| Cubre | Tandas 1 a 7 (PR #1 a #7, fusionadas en `main`). Lo que la tanda 8 tiene en curso va marcado como tal |
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
| `[TANDA 8, EN CURSO]` | Trabajo que el PM ha encargado y que aún no está fusionado en `main`. No lo des por existente. (La marca `[TANDA 6, EN CURSO]` de la primera edición ya no se usa: la tanda 6 está fusionada.) |
| `[NO VERIFICADO]` | Las fuentes no permiten confirmarlo. Se redacta en condicional. |
| `[DE FACTO]` | Decisión que se deduce de lo construido, pero que ninguna fuente registra como decisión explícita. |

Fuentes: LLD v0.1, LLD v0.2, [CHANGELOG](CHANGELOG.md), [ESTADO](ESTADO.md), la guía [Enviar los borradores desde Twenty](twenty-envio-email.md), la guía [Integración de eventos con n8n](n8n-integracion.md) y los README del [runtime](../runtime/agent-runtime/README.md), de la [Twenty App](../apps/twenty-app/README.md), del [renderer](../services/renderer/README.md) y de [deployments](../deployments/README.md). Cuando se ha contrastado algo directamente en el código de la rama, se indica entre paréntesis (por ejemplo, `src/db/schema.ts`).

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
| Agent Runtime | `pxos-runtime` | `pxos/agent-runtime:0.1.0` | `127.0.0.1:4020` | API Fastify, worker BullMQ y scheduler en un proceso (`RUNTIME_ROLE=all`). Sirve `/dashboard` solo a peticiones locales. Lee el buzón de bajas por IMAP (solo lectura) y aplica las migraciones `0000` a `0006` al arrancar. |
| Renderer | `pxos-renderer` | `pxos/renderer:0.1.0` | interno `3000`; `127.0.0.1:4030` solo en desarrollo | Playwright + Chromium para leer catálogos JavaScript. |
| Gemini API | — (externo) | — | — | LLM de trabajo del Prospector y del EmailDrafter. |
| Buzón IONOS (IMAP) | — (externo) | — | — | Solo lectura, para el BajasAgent. El envío de correo no sale del runtime: lo hace Twenty por SMTP con el buzón que conecta una persona ([ADR-27](#adr-27)). |

> **Nota:** `docs/PORTS.md` ya lista `pxos-renderer` y el puerto `4030`; el README raíz y `deployments/README.md` siguen sin hacerlo (consulta [Contradicciones](#6-contradicciones-entre-fuentes)).

### 1.2 Qué hace cada día y cada semana

| Cuándo | Tarea | Qué hace |
|---|---|---|
| **Lunes 07:30** (Europe/Madrid) | `weekly-event-scouting` (CRON `30 7 * * 1`) | Prospector en **modo scout**: busca ferias reales con grounding de Google Search vía Gemini, lee sus catálogos (HTML, PDF o JavaScript con el renderer), pagina el listado, abre fichas de los expositores relevantes para obtener su web y escribe en Twenty empresa, señal `FAIR` e hipótesis `PROPOSED`. Entrada por defecto: sector «alimentación y bebidas», España, 6 meses; hasta 3 ferias. Lee el catálogo entero (por la API JSON de la SPA si existe, [ADR-25](#adr-25)) y se corta limpio con un presupuesto de 20 minutos ([ADR-26](#adr-26)); timeout de la tarea: 30 minutos. Activa desde 2026-10-07; la primera ejecución automática es el lunes siguiente (deducido de la guía comercial). |
| **Cada día 08:00** (Europe/Madrid) | `daily-event-prospecting` (CRON `0 8 * * *`) | Prospector en **modo directo**: evalúa los expositores del `default_input`, que hoy es la fixture de demostración (`feria-ejemplo.json`, dominios `.example`). Genera registros de demostración. |
| **Cada 2 horas** | `process-unsubscribes` (CRON `0 */2 * * *`) | El `BajasAgent` lee el buzón por IMAP en solo lectura, detecta peticiones de baja y las añade a la nota de supresión de Twenty ([ADR-24](#adr-24)). No usa LLM. |
| **Por evento** | `draft-email-on-validated` (trigger `EVENT`) | Cuando el comercial valida una hipótesis (aceptada o editada), el `EmailDrafter` genera un borrador del primer email, lo deja como nota en Twenty y lo escribe en los campos de la hipótesis (`emailTo`, `emailSubject`, `emailBody`, `emailStatus = DRAFT`). No envía nada. |
| **A demanda (una persona)** | Workflow manual de Twenty «Enviar borrador de email» | El comercial revisa el borrador, pone `Email status = Reviewed` y pulsa el workflow. Twenty envía por SMTP desde su buzón conectado ([ADR-27](#adr-27)). |
| **Opcional** | `POST /events/external` y suscripciones salientes | n8n y otros sistemas intercambian eventos `ext.*` con el bus ([ADR-30](#adr-30)). |
| **Continuo** | Webhook de Twenty → `POST /webhooks/twenty` | Cada cambio en una `commercialHypothesis` se convierte, si procede, en una evaluación HUMAN (`ACCEPTED` 1.0, `EDITED` 0.5, `DISCARDED` 0.0) y en un evento `evaluation.recorded`. |
| **Continuo** | Scheduler y reconciliador | Sincronizan schedules con BullMQ cada 60 s, recuperan runs huérfanos y re-publican eventos sin despachar. |
| **Bajo demanda** | `GET /metrics/*` y `/dashboard` | Coste, latencia, embudo y tasa de aceptación por versión de agente. |

Acción humana diaria: el comercial revisa **Commercial OS → Hypotheses** en Twenty (vista *By status*), cambia el estado de cada hipótesis, revisa el borrador en la propia hipótesis y lo envía con un clic desde Twenty (workflow manual, buzón conectado) o, si prefiere, lo copia de la nota y lo envía desde el webmail. El envío con un clic está operativo desde el 2026-10-07 (el usuario conectó la cuenta SMTP, activó el workflow y el primer envío real llegó bien; confirmación del PM, sin traza en el repositorio). El canal de email sigue en warm-up (consulta [email-warmup.md](email-warmup.md)).

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
                               + campos de la hipótesis (Email to/subject/body,
                                 Email status = Draft)
                                 ▼
        el comercial edita, comprueba la lista de supresión y pone Reviewed
                                 ▼
       el comercial pulsa «Enviar borrador de email» (workflow manual de Twenty)
                                 ▼
        Twenty envía por SMTP desde el buzón conectado de quien pulsó
        (el runtime NO envía; Email status: Reviewed → Sending → Sent)

 cada 2 h:  process-unsubscribes → BAJASAGENT (sin LLM) lee el buzón por IMAP
            (solo lectura) → añade las bajas a la nota «Lista de supresión»
```

### 1.4 Qué no hace

- **El runtime no envía emails.** No hay dependencia SMTP, ni API de correo, ni tool de envío en el registro. El envío lo hace una persona con un workflow manual de Twenty ([ADR-27](#adr-27)), y la API key del runtime no puede usar las tools de correo de Twenty ([ADR-28](#adr-28)).
- **No tiene Researcher ni Scorer.** No hay registros `research`, ni `score`, ni prioridad `HOT/WARM/COLD`.
- **No tiene Catalog Service.** Los productos recomendados son familias genéricas, sin `productId` ni SKU.
- **No tiene harness, memoria ni optimizadores.** Las skills sí son objetos versionados en BD ([ADR-29](#adr-29)), pero sin optimizador. Consulta [Mapa de pendientes](#5-mapa-de-pendientes).
- **No hace triaje general del inbound.** Solo detecta bajas ([ADR-24](#adr-24)): no clasifica respuestas, no responde ni mueve correos. La comprobación de la lista antes de enviar sigue siendo una tarea de la persona.
- **No tiene workflows de negocio en n8n.** Existe el puente de eventos y un ejemplo importable ([ADR-30](#adr-30)); n8n no contiene inteligencia.
- **No borra nada.** El `TwentyClient` no tiene método de borrado y el registry rechaza cualquier tool `DESTRUCTIVE`.
- **No promueve, revierte ni evalúa agentes.** Esos endpoints devuelven `501`.

---

## 2. Registro de decisiones (ADR)

Formato compacto. Cada entrada indica fecha, decisión, motivo, qué sección del LLD modifica y su estado. La fecha es la que dan las fuentes; las tandas 3 a 7 figuran todas con fecha 2026-10-07.

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
| [15](#adr-15) | Borradores HITL con garantías por código | 4 y 6 | 2026-10-07 | v0.1 §10 y §26; v0.2 §9 |
| [16](#adr-16) | Métricas por SQL y dashboard local | 4 | 2026-10-07 | v0.2 §1 punto 29 |
| [17](#adr-17) | Triggers `EVENT` con `{in}` y `toStatus` | 5 | 2026-10-07 | v0.2 §5.6 |
| [18](#adr-18) | `max_profile_lookups` = 20 (sustituido por 100 en la tanda 6) | 5 | 2026-10-07 | Parámetro nuevo del scout |
| [19](#adr-19) | Archivo en lugar de borrado de agentes de prueba | 5 | 2026-10-07 | v0.2 §2.3 (aplicación) |
| [20](#adr-20) | Canal de email real: `publiexpe.info`, IONOS, DKIM de dominio | LLD v0.1 | 2026-10-06 | Confirma v0.1 §10.1 |
| [21](#adr-21) | Microsoft SNDS no aplica | 5 | 2026-10-07 | v0.1 §10.1 |
| [22](#adr-22) | Lista de supresión manual en una nota de Twenty | 5 | 2026-10-07 | v0.1 §10.1; v0.2 §13 |
| [23](#adr-23) | Descriptor de PubliEXPE garantizado por código | 6 | 2026-10-07 | Completa ADR-15 |
| [24](#adr-24) | BajasAgent determinista con IMAP de solo lectura | 6 | 2026-10-07 | v0.1 §10.2; v0.2 §13; completa ADR-22 |
| [25](#adr-25) | Captura de la API JSON de los catálogos en el renderer | 6 | 2026-10-07 | Completa ADR-14 y ADR-10 |
| [26](#adr-26) | Presupuesto por tiempo del scout | 6 | 2026-10-07 | Sustituye a ADR-18 |
| [27](#adr-27) | Envío HITL con un workflow manual de Twenty | 7 | 2026-10-07 | v0.1 §10 y §15; completa ADR-15 |
| [28](#adr-28) | Rol restringido «Agent runtime» para la API key | 7 | 2026-10-07 | v0.2 §3.8 y §10.2 |
| [29](#adr-29) | Skills versionadas en BD, inmutables, con fallback a código | 7 | 2026-10-07 | v0.1 §6.3 y §26 (MVP-1); v0.2 §5 |
| [30](#adr-30) | Puente de eventos externos: `ext.*` y firma HMAC | 7 | 2026-10-07 | v0.1 §20; v0.2 §7.1; completa ADR-11 |
| [31](#adr-31) | Journal de migraciones: refechar al fusionar | 7 | 2026-10-07 | Regla operativa (v0.2 §4) |

Total: **31 ADR**.

<a id="adr-01"></a>
### ADR-01 · Metadatos de plataforma fuera de Twenty

- **Fecha:** 2026-10-06 (decisión `[C1]` del LLD v0.1; implementada en la tanda 1).
- **Decisión:** Twenty guarda solo lo que el comercial ve y toca (4 objetos custom). Todo lo demás vive en el PostgreSQL del Agent OS, en una base `agentos` separada de la de Twenty.
- **Motivo:** un fallo o una actualización de Twenty no pierde ejecuciones ni obliga a reescribir el Agent OS (v0.1 §4; `deployments/README.md`).
- **Modifica:** nada; confirma v0.1 §4 y v0.2 §4. La realidad son **15 tablas** (`src/db/schema.ts`): `agents`, `agent_versions`, `task_definitions`, `task_definition_versions`, `task_runs`, `agent_executions`, `traces`, `trace_steps`, `entity_locks`, `events`, `evaluations` (hasta la tanda 5) y, desde la tanda 6 y 7, `inbound_state` ([ADR-24](#adr-24)), `skills`, `skill_versions` ([ADR-29](#adr-29)) y `event_subscriptions` ([ADR-30](#adr-30)). Frente a las 9 del v0.2 §4: **falta `audit_log`** y se añaden las otras seis.
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
  - Tanda 7: `commercialHypothesis` gana cuatro campos de borrador, `emailTo`, `emailSubject`, `emailBody` y `emailStatus` (`DRAFT`, `READY` con etiqueta *Reviewed*, `SENDING`, `SENT`). Consulta [ADR-27](#adr-27).
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
- **Modifica:** v0.2 §7.1. Diferencias: el evento `evaluation.completed` se llama **`evaluation.recorded`**; **`signal.detected` no se emite**; el puente con n8n existe desde la tanda 7 ([ADR-30](#adr-30)); no hay esquemas JSON Schema en `schemas/`. Tampoco se emite `task.failed` cuando el reconciliador cierra un huérfano ni en cancelaciones.
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

- **Fecha:** 2026-10-07 (tanda 4). El descriptor de PubliEXPE se añadió en la tanda 6 ([ADR-23](#adr-23)).
- **Decisión:** al validar una hipótesis, el agente `EmailDrafter` hace **una** llamada a Gemini y guarda el resultado como nota «Borrador email — {hipótesis}» en la empresa y en la hipótesis. **No hay código de envío.** El modelo no escribe lo que exige el cumplimiento; el código lo añade siempre:
  - la **línea de baja** (`Si no quieres recibir más mensajes, respóndeme o escribe a baja@publiexpe.info`), tras quitar cualquier línea de baja que haya escrito el modelo;
  - la **firma** (`Jesús Abril`, `PubliEXPE · Merchandising y regalo promocional personalizado`, `www.publiexpe.com`) y la despedida;
  - el saludo genérico `Hola:` si no hay decision maker (para no inventar un nombre);
  - avisos si el cuerpo sale de 120 a 180 palabras o el asunto pasa de 70 caracteres.
- **Descriptor de PubliEXPE** (tanda 6, fusionado): el código garantiza también que la primera mención de PubliEXPE en el cuerpo diga qué es, al mismo nivel que la línea de baja. Detalle en [ADR-23](#adr-23).
- **Motivo:** LSSI art. 21 (identificación del remitente y baja en cada correo) y principio HITL del v0.1 §15: enviar exige a una persona. Una garantía por código no depende de que el modelo obedezca el prompt.
- **Modifica:** v0.1 §26 y v0.2 §9: los borradores de email estaban en MVP-1 (Inbound Manager) y el MVP-0 «no envía nada»; ahora existe un agente de borradores de primer contacto dentro del MVP-0. v0.2 §9.2 sigue cumplido: ningún agente tiene `send_email`.
- **Estado:** vigente. Coste medido: ~0,002 € por borrador. Desde la tanda 7 el borrador se escribe además en los campos de la hipótesis y una persona puede enviarlo desde Twenty ([ADR-27](#adr-27)); el agente sigue sin ninguna tool de envío.

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
- **Estado:** sustituido en la tanda 6: el valor por defecto es 100 y el límite real lo pone el presupuesto de tiempo ([ADR-26](#adr-26)). Se conserva la decisión original como registro histórico.

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
- **Estado:** vigente, provisional hasta MVP-1. Desde la tanda 6 las **altas** en la lista las hace el `BajasAgent` ([ADR-24](#adr-24)); la **comprobación antes de enviar** sigue siendo de la persona. `[TANDA 8, EN CURSO]` Otro agente trabaja en una comprobación de red de seguridad en el flujo de envío (rama `feat/email-ops-flujo`, sin fusionar); no la des por existente.


<a id="adr-23"></a>
### ADR-23 · Descriptor de PubliEXPE garantizado por código

- **Fecha:** 2026-10-07 (tanda 6, fusionada en el PR #6).
- **Decisión:** la primera mención de PubliEXPE en el cuerpo del borrador dice siempre qué es la empresa. Se pide en el prompt y, como en la línea de baja, **lo garantiza el código** (`finalizeDraft` → `ensureCompanyDescriptor`, `src/agents/email-draft.ts`):
  - busca la primera mención del nombre de la empresa en el cuerpo, antes de la firma;
  - si la frase ya describe a la empresa (contiene `merchandising`, regalo o artículo promocional, o el propio descriptor), no toca nada;
  - si no, inserta el descriptor justo detrás del nombre (`PubliEXPE, expertos en merchandising para empresas, …`) y anota la corrección `company_descriptor_added`.
- **Configuración:** `configuration.company_descriptor` de la versión del agente; valor por defecto `expertos en merchandising para empresas`. Cambiarlo crea una versión nueva del `EmailDrafter` con `pnpm seed`.
- **Motivo:** feedback directo del usuario (CHANGELOG, tanda 6): un destinatario en frío no sabe quién es PubliEXPE. La firma ya llevaba una línea de actividad, pero no basta si el cuerpo nombra a la empresa sin decir qué hace. Que lo garantice el código evita depender de que el modelo obedezca el prompt.
- **Modifica:** completa [ADR-15](#adr-15). Cierra la marca `[TANDA 6, EN CURSO]` de la primera edición de este documento.
- **Estado:** vigente. Va en el `EmailDrafter` v2 y siguientes (ESTADO). Límite: si el cuerpo no menciona el nombre de la empresa, el código no inserta nada.

<a id="adr-24"></a>
### ADR-24 · BajasAgent determinista con IMAP de solo lectura

- **Fecha:** 2026-10-07 (tanda 6, fusionada en el PR #6; migración `0004_inbound`).
- **Decisión:** las peticiones de baja se procesan con un agente **sin LLM** (`BajasAgent`, `implementation = "inbound_bajas"`) y **sin aprobación humana**. La tarea `process-unsubscribes` (`CRON 0 */2 * * *`, `Europe/Madrid`, `max_concurrency = 1`) hace esto:
  1. Abre el buzón por IMAP con `EXAMINE` (solo lectura) y descarga con `BODY.PEEK[]`, que no marca el correo como leído.
  1. Clasifica con reglas fijas y estrictas (destinatario `baja@`, asunto, frases de baja, primera línea `BAJA`/`STOP`). Nunca es baja el correo automático, el de los dominios propios ni el que no tiene `From` válido. La dirección sale siempre de `From`, nunca del cuerpo.
  1. Añade al final de la nota `Lista de supresión — NO contactar` una línea `email — fecha — motivo` por dirección nueva, con deduplicación (`get_note` y `update_note`, solo añadir, `LOW_WRITE`).
  1. Avanza el cursor (`inbound_state`: `UIDVALIDITY` y último UID) solo si la escritura en Twenty fue bien.
- **Garantía de solo lectura:** el cliente IMAP del runtime no tiene métodos de escritura y las pruebas comprueban que el servidor solo recibe `EXAMINE`, `UID SEARCH` y `UID FETCH … BODY.PEEK[]` (README del runtime; ESTADO). Con `mark_seen: true` (por defecto `false`) añade solo el flag `\Seen` a las bajas procesadas. El runtime no usa SMTP en ningún sitio.
- **Motivo:** cumplimiento (LSSI y RGPD): una baja debe quedar anotada el mismo día. Un correo entrante es **dato no confiable**; con un modelo en medio, un correo hostil podría inducir una baja falsa o esconder una real. Las reglas fijas son auditables y no cuestan nada por ejecución. Un falso positivo solo deja de contactar a una persona, así que se acepta sin aprobación (deducido del diseño; las fuentes no lo formulan como decisión).
- **Modifica:** adelanta una pieza del Inbound Manager del v0.1 §10.2 (MVP-1) y sustituye el procedimiento manual de [ADR-22](#adr-22) en lo que se refiere a las **altas** en la lista. No hace triaje general: lo que no es una baja se ignora. Añade la tabla `inbound_state` y las tools `get_note` y `update_note`.
- **Estado:** vigente. Prueba en vivo con el buzón real en solo lectura: correcta. Primer run en Docker: 4 mensajes revisados, 0 bajas (ESTADO). Sin `IONOS_IMAP_USER` o `IONOS_IMAP_PASSWORD`, la ejecución termina `COMPLETED` con `outcome = SKIPPED`. Pendiente: la comprobación **antes de enviar** sigue siendo de la persona ([ADR-22](#adr-22)).

<a id="adr-25"></a>
### ADR-25 · Captura de la API JSON de los catálogos en el renderer

- **Fecha:** 2026-10-07 (tanda 6, fusionada en el PR #6).
- **Decisión:** muchos catálogos SPA descargan la lista completa de expositores como JSON y la paginan en el navegador. El renderer, con `captureJson`, devuelve las respuestas JSON de **mismo origen** que recibió la página (como máximo 5 de 200 KB). El scout (`src/agents/catalog-json.ts`) busca entre ellas el array que es la lista de expositores y la usa como **fuente preferente**:
  - exige al menos 3 objetos con un campo de nombre presente en el 80 % y con valores distintos, y se queda con el array cuyos nombres aparecen más veces en el texto renderizado (así no gana una lista de provincias o sectores);
  - valida igual que una página: los nombres se comprueban contra el JSON y el dominio tiene que estar en él;
  - cita como fuente la **página renderizada del listado** (visitada, en el `SourceLedger`), nunca la URL de la API;
  - no hace la extracción del listado con el LLM, y aprende la plantilla de URL de las fichas a partir de al menos 2 enlaces.
- **Activación:** `scout.capture_json = true` por defecto. Sin captura (renderer anterior, opción desactivada o ninguna lista reconocible), el flujo es el de antes: extracción del texto renderizado.
- **Motivo:** completar el listado más allá de las páginas renderizadas y ahorrar llamadas al LLM. Caso real: `POST https://apps.feriavalencia.com/api/puisearch` devuelve los 91 expositores de Gastrónoma en 52 KB.
- **Seguridad:** el JSON es contenido web **no confiable** ([ADR-09](#adr-09)): no se ejecuta, sus textos solo llegan al LLM dentro de bloques `DATOS_NO_CONFIABLES` y las URL que se escriben en Twenty pasan por el `SourceLedger`.
- **Modifica:** completa [ADR-14](#adr-14) (el renderer ahora admite hasta 20 páginas con parada temprana y captura de JSON) y [ADR-10](#adr-10) (`max_catalog_pages` por defecto 10, tope 20).
- **Estado:** vigente. Verificado en vivo con Gastrónoma (91 de 91 nombres en la página). El atajo depende de que el catálogo use una API JSON de mismo origen; con otros catálogos podría no activarse `[NO VERIFICADO]`.

<a id="adr-26"></a>
### ADR-26 · Presupuesto por tiempo del scout

- **Fecha:** 2026-10-07 (tanda 6, fusionada en el PR #6).
- **Decisión:** el scout se gobierna por **tiempo**, no por un contador de fichas. `scout.time_budget_ms` vale 20 minutos por defecto (tope 25: el timeout de 30 minutos de `weekly-event-scouting` menos 5 para las escrituras y el resumen). Se comprueba antes de cada feria, página, render, extracción, evaluación y ficha. Al agotarse, la ejecución **se corta limpia**:
  - lo ya evaluado se escribe igualmente en Twenty: no se pierde ninguna evaluación pagada;
  - las fichas no abiertas quedan como `time_budget_exhausted` y el expositor como `skipped_no_domain`;
  - una feria sin ningún expositor leído no escribe nada (ni la señal de feria sin lista, que sería engañosa);
  - el `outcome` es `PARTIAL` con el motivo y los contadores; `output.time_budget` guarda `budget_ms`, `elapsed_ms`, `exhausted` y la fase.
- **Parámetros asociados:** `max_profile_lookups` pasa de 20 a **100** (tope 100), y las fichas se abren de 2 en 2 (`profile_concurrency`). La entrada `scout_time_budget_ms` solo puede bajar el presupuesto.
- **Motivo:** con el catálogo completo (91 expositores) el coste real es el tiempo: unos 10 a 12 s por ficha renderizada, sin coste de modelo. Un tope de fichas fijo dejaba sin dominio a empresas relevantes o alargaba la ejecución sin control. El agente no conoce el timeout de su tarea, así que el presupuesto se configura aparte.
- **Modifica:** sustituye a [ADR-18](#adr-18). Nuevo parámetro del scout, ausente del v0.2. El `agentRunSummary` pone primero los totales, el tiempo y el coste, y después una línea por expositor.
- **Estado:** vigente. Run real (2026-10-07, Gastrónoma, configuración por defecto): 91 de 91 expositores evaluados, 29 empresas con dominio (23 nuevas), 0,195 €, 16,4 minutos de 20. Si recortas el timeout de la tarea, recorta también `time_budget_ms`.

<a id="adr-27"></a>
### ADR-27 · Envío HITL con un workflow manual de Twenty

- **Fecha:** 2026-10-07 (tanda 7, fusionada en el PR #7).
- **Decisión:** el envío con un clic lo hace **Twenty**, no el runtime, con un workflow manual sobre la hipótesis:
  1. El `EmailDrafter` escribe el borrador en los campos de la hipótesis (`emailTo`, `emailSubject`, `emailBody`, `emailStatus = DRAFT`) con la tool `set_hypothesis_draft` (`LOW_WRITE`), solo si su versión tiene `send_from_twenty.enabled = true` (activado en el seed de la tanda 7) y solo si `emailStatus` está vacío, para no pisar ediciones.
  1. La persona edita en la hipótesis, comprueba la lista de supresión y pone `Email status = Reviewed` (valor interno `READY`).
  1. Pulsa **Enviar borrador de email**. El workflow `Commercial OS · Enviar borrador de email` relee la hipótesis en la base de datos, sigue solo si `Reviewed` y `Validated` y con Para, Asunto y Cuerpo no vacíos, pone `Sending`, envía por SMTP **desde el buzón conectado de quien pulsó** (`trigger.metadata.workspaceMemberId`) y pone `Sent`.
  - Sin reintentos (`retryOnFailure = 0`: un reintento podría duplicar el correo). Un segundo clic se detiene en el filtro. Si el envío falla, queda `Sending`, nunca un `Sent` falso.
  - El script `pnpm twenty:send-workflow` crea el workflow **en borrador** y no tiene opción para activarlo: lo activa una persona. El cuerpo va como `<pre>` con `white-space: pre-wrap` para conservar los saltos de línea.
- **Alternativas descartadas** (`docs/twenty-envio-email.md`, verificadas contra Twenty 2.45.6):
  - **Borrador nativo** (*Draft Email* en la carpeta Borradores del buzón): exige IMAP y sincronizar el buzón con el CRM (el contenido completo quedaría en la base de datos de Twenty) y obligaría al runtime a usar las tools de correo de Twenty, la misma puerta que `send_email`.
  - **Enlace `mailto:`**: no hace falta porque el workflow es viable. Además, abriría el cliente de correo local y el envío quedaría fuera de Twenty, sin estado ni registro (deducido; las fuentes solo dicen que no es necesaria).
- **Hecho técnico que lo condiciona:** Twenty 2.45.6 solo admite cuentas IMAP/SMTP/CalDAV genéricas (Google y Microsoft están desactivados por falta de credenciales OAuth). Para IONOS es lo que hace falta. Se recomienda conectar **solo SMTP**: no se sincroniza nada del buzón.
- **Motivo:** mantener el principio HITL del v0.1 §15 (enviar exige a una persona) y que «el runtime no puede enviar» siga siendo cierto, a la vez que se quita la copia manual entre la nota y el webmail.
- **Modifica:** completa [ADR-15](#adr-15): el v0.1 §10 y §26 situaban el envío fuera del MVP-0. Añade 4 campos a `commercialHypothesis` ([ADR-03](#adr-03)) y la tool `set_hypothesis_draft`.
- **Estado:** **operativo desde 2026-10-07**: el usuario conectó la cuenta SMTP, activó el workflow y el primer envío real llegó bien (confirmación del PM; el repositorio solo contiene la preparación). Límites conocidos:
  - el workflow **no consulta la lista de supresión**: la comprobación previa es de la persona. `[TANDA 8, EN CURSO]` Otro agente trabaja en una comprobación de red de seguridad (rama `feat/email-ops-flujo`); no la des por existente hasta que se fusione;
  - el remitente es la primera cuenta capaz de enviar del usuario: un buzón por usuario en Twenty;
  - con solo SMTP el correo no se copia en *Enviados* de IONOS;
  - Twenty 2.45 no verifica el certificado TLS del servidor de correo (`rejectUnauthorized: false` en su código);
  - los envíos cuentan para los límites de IONOS y para el calendario de [warm-up](email-warmup.md).

<a id="adr-28"></a>
### ADR-28 · Rol restringido «Agent runtime» para la API key

- **Fecha:** 2026-10-07 (tanda 7, fusionada en el PR #7).
- **Hallazgo de seguridad:** la API key `agent-runtime` de Twenty tenía el rol **Admin** (`canAccessAllTools: true`). El endpoint MCP de Twenty (`/mcp`) acepta API keys y ofrecía a ese rol las tools `send_email`, `draft_email` y `find_connected_accounts`. Sin buzón conectado no podían enviar nada, pero **en cuanto se conectara uno, cualquiera con esa key podría enviar desde él**: sin usuario, `SendEmailTool` elige la primera cuenta del workspace.
- **Decisión:** la API key del runtime usa un rol propio, `Agent runtime`: lectura y escritura de los objetos (sin borrado definitivo), **ninguna tool** (ni *Send Email*, ni *Workflows*, ni *HTTP Request*) y, como mucho, el ajuste *API keys & webhooks* para `pnpm register:webhook`. El rol se creó y se asignó a la key antes de conectar el buzón.
- **Verificación:** `get_tool_catalog` por `/mcp` con la key devuelve 0 coincidencias de `send_email` (ESTADO y CHANGELOG, tanda 7). El runtime sigue escribiendo en Twenty con normalidad.
- **Motivo:** devolver también en Twenty la garantía «el sistema no puede enviar». La política de tools del runtime ya no tenía `send_email`; faltaba cerrar la puerta lateral de Twenty.
- **Modifica:** cierra en parte el alcance de la API key del v0.2 §3.8 y §10.2 (`[POR COMPLETAR]`): el alcance es **por tools**, no por objeto; los objetos siguen en lectura y escritura generales.
- **Consecuencias operativas:**
  - Al **rotar la API key** hay que reasignar el rol restringido a la key nueva antes de usarla. Una key nueva no hereda la asignación de la anterior; con qué rol nace por defecto no consta en las fuentes `[NO VERIFICADO]`, así que no la pongas en producción sin comprobarlo.
  - `scripts/sync-twenty-app.ps1` y `pnpm twenty:send-workflow` necesitan una key con permisos de administración: ejecútalos antes de restringir o con una key temporal de rol Admin que revoques después.
  - Si el runtime falla por permisos, amplía los permisos **de objetos** del rol, nunca los de tools.
- **Estado:** vigente. El rol se gestiona a mano en la UI de Twenty; no hay script que lo cree ni lo compruebe `[NO VERIFICADO]`.

<a id="adr-29"></a>
### ADR-29 · Skills versionadas en BD, inmutables, con fallback a código

- **Fecha:** 2026-10-07 (tanda 7, fusionada en el PR #7; migración `0005_skills`).
- **Decisión:** las skills dejan de ser constantes de TypeScript y pasan a ser objetos versionados en dos tablas, `skills` y `skill_versions`. La fuente de verdad es la BD; las constantes quedan como **fallback**.
  - **Inmutabilidad por trigger SQL:** no hay `DELETE` físico en ninguna de las dos tablas y el contenido de una versión no se puede modificar; solo cambian `status`, `activated_at` y `deprecated_at`. Para cambiar una skill se crea una versión nueva. Un índice único parcial permite como mucho una versión `ACTIVE` por skill.
  - **Resolución:** `agent_versions.skill_refs` apunta por nombre (`{"name": "x"}` = versión `ACTIVE`; con `version` = una versión exacta, útil para probar un `DRAFT`). Las ejecuciones nuevas recogen la versión activa al empezar; activar una versión no toca las ejecuciones en marcha.
  - **Fallback:** si la ref no se resuelve (la skill no existe, no hay versión activa o la BD falla), el agente usa el prompt del MVP-0 y el runtime registra un aviso. Una skill que falta no hace fallar ninguna ejecución.
  - **Trazabilidad:** `traces.skill_versions` guarda qué se inyectó (`name`, `version`, `skill_version_id`, `content_hash`, `source` = `db`, `code` o `none`; en el fallback, también el texto exacto). `task_runs.skill_versions` guarda lo mismo sin el texto.
  - **API:** `GET /skills`, `GET /skills/:id`, `POST /skills`, `POST /skills/:id/versions` (con `copy_from: "active"`), `POST …/versions/:v/activate` y `…/deprecate`. Activar depreca la anterior en la misma transacción; deprecar la activa reactiva la anterior (rollback). No hay `DELETE`.
  - **Seed:** 4 skills migradas **byte a byte** como v1 `ACTIVE`: `prospector-event-exhibitors`, `event-source-discovery`, `exhibitor-list-extraction` (separada de la anterior para versionarla por separado) y `email-first-contact-draft`. Los agentes las referencian por nombre.
- **Motivo:** primer paso del MVP-1 (v0.1 §6.3 y §26): poder cambiar un prompt sin redesplegar, saber con qué versión exacta se hizo cada ejecución (LLD P4) y volver atrás. Es la base de los experimentos del MVP-2 (consulta [Pendientes](#5-mapa-de-pendientes)).
- **Modifica:** cierra el punto 10 de los 34 del v0.2 en su parte de almacenamiento, versionado y trazabilidad (consulta [3.1](#31-los-34-puntos-del-v02-1)). El README del runtime lo documenta en «Skills».
- **Estado:** vigente. **Sin optimizador.** Pendientes: `workflow` y `optimization_budget` del v0.1 §6.3 y la comprobación del `content_hash` al cargar. Al crear una versión, la respuesta avisa si falta la regla de contenido web no confiable. El código necesita la migración `0005` aplicada antes de desplegar.

<a id="adr-30"></a>
### ADR-30 · Puente de eventos externos: `ext.*` y firma HMAC

- **Fecha:** 2026-10-07 (tanda 7, fusionada en el PR #7; migración `0006_event_subscriptions`).
- **Decisión:** el event bus habla con el exterior en las dos direcciones, con n8n como primer consumidor y productor. n8n integra, **nunca contiene la inteligencia** (v0.1 §20).
  - **Entrada** (`POST /events/external`): autenticación con `Authorization: Bearer <EXTERNAL_EVENTS_TOKEN>` (sin token configurado, `503`; con otro, `401`). El cuerpo es estricto y `type` debe empezar por un prefijo de `EXTERNAL_EVENT_TYPE_PREFIXES` (`ext.` por defecto). El runtime **rechaza al arrancar** cualquier prefijo que cubra sus propios eventos (`task.`, `agent.`, `evaluation.`): un cliente externo no puede suplantar un evento interno. Fuerza `data.chainDepth = 0`, deduplica con `ext:{producer}:{clave}` y publica con el `EventBus` normal, de modo que los triggers `EVENT` lo evalúan como cualquier evento. El contenido es **dato no confiable**.
  - **Salida** (`event_subscriptions`): cada fila es un webhook. El runtime envía los eventos cuyo tipo case (exacto o prefijo `task.*`) con firma **HMAC-SHA256** en `X-Pxos-Event-Signature`, calculada sobre `{timestamp}:{cuerpo}` (el mismo esquema que Twenty), 3 intentos con backoff exponencial y guarda SSRF con la IP fijada. Sin `DELETE`: se apaga con `PATCH {"enabled": false}`.
  - Ejemplo importable: `integrations/n8n/ejemplo-eventos.json`. Contrato completo en [n8n-integracion.md](n8n-integracion.md).
- **Motivo:** conectar n8n sin darle control sobre el sistema: los hechos externos entran como eventos y las tareas de negocio siguen viviendo en el runtime. La firma HMAC deja al consumidor verificar el origen; el Bearer protege la entrada.
- **Modifica:** completa [ADR-11](#adr-11) (el v0.2 §7.1 preveía el consumo por n8n) y adelanta la integración n8n del v0.1 §20. Añade `POST /events/external`, `/event-subscriptions` y la tabla `event_subscriptions`.
- **Estado:** vigente. Límites:
  - los eventos externos entran con `chainDepth = 0`, así que la guardia anti-bucle **no corta** un ciclo que pase por n8n (`task.completed` → n8n → `ext.*` → la misma tarea);
  - `deployments/docker-compose.yml` no pasa `EXTERNAL_EVENTS_TOKEN` ni `EXTERNAL_WEBHOOK_ALLOW_PRIVATE` a `pxos-runtime`: con el compose actual, la entrada responde `503` hasta que se añadan (verificado en el compose de la rama);
  - no hay workflows de negocio en n8n, solo el ejemplo.

<a id="adr-31"></a>
### ADR-31 · Journal de migraciones: refechar al fusionar

- **Fecha:** 2026-10-07 (tanda 7; incidencia del PM al fusionar las ramas de skills y de eventos).
- **Contexto:** las ramas `feat/skills-versionadas` (`0005_skills`) y `feat/n8n-events` (`0006_event_subscriptions`) se desarrollaron en paralelo. Al fusionarlas, el orden por **fecha** (`when` del journal de Drizzle) contradecía el orden por **índice** (`idx`). Drizzle aplica solo las migraciones cuya fecha es posterior a la de la última migración aplicada: con ese orden, **habría saltado la `0006` en silencio**, sin error.
- **Decisión (regla operativa):** al fusionar una rama con migraciones, el PM comprueba que `when` crece con `idx` en `drizzle/meta/_journal.json` y, si no, **refecha** la migración (le pone un `when` posterior al de la anterior) y reencadena el snapshot. En la tanda 7, el commit de fusión reordenó el journal para que `0005` < `0006` y reencadenó el snapshot.
- **Comprobación rápida** (desde `runtime/agent-runtime/`; devuelve `OK` si las fechas crecen):

  ```sh
  node -e "const j=require('./drizzle/meta/_journal.json').entries;let ok=true;j.forEach((e,i)=>{if(i&&e.when<=j[i-1].when){ok=false;console.error('when no creciente:',e.tag)}});console.log(ok?'OK':'KO');process.exit(ok?0:1)"
  ```

- **Motivo:** el fallo es silencioso y se descubriría con una tabla que no existe en producción.
- **Modifica:** nada del diseño; es una regla de operación sobre el esquema del v0.2 §4. Hoy no hay un test ni un paso de CI que lo compruebe `[NO VERIFICADO]`.
- **Estado:** vigente. Journal actual (`0000` a `0006`) verificado: las fechas crecen.

---

## 3. LLD v0.2 → realidad

### 3.1 Los 34 puntos del v0.2 §1

| # | Punto | Estado en el v0.2 | Realidad | Detalle |
|---|---|---|---|---|
| 01 | Objetos Twenty exactos | Cubierto | Implementado distinto | Los 4 objetos existen con otros nombres de campo y sin varios campos. [ADR-03](#adr-03) |
| 02 | Campos y tipos | Cubierto | Implementado distinto | Sin `humanFeedback*`, `score`, `priority`, `agentExecutionId`, `idempotencyKey`; con `tenantId` y los 4 campos `email*` de la hipótesis. [ADR-03](#adr-03), [ADR-13](#adr-13), [ADR-27](#adr-27) |
| 03 | Relaciones | Cubierto | Implementado distinto | Mismas relaciones; cambian nombres (`research.commercialSignal`, `Person.decisionMakerHypotheses`) y `SET_NULL` al borrar. [ADR-03](#adr-03) |
| 04 | Enums | Cubierto | Implementado distinto | `SignalStatus` con `REVIEWING` y `QUALIFIED`; sin `HumanFeedback`, `HypothesisPriority`, `PipelineStage`; `RunStatus` sustituido por `outcome`. [ADR-03](#adr-03) |
| 05 | Interfaces TypeScript | Cubierto | Implementado distinto | Hay `ModelProvider`, `Tool`, registry, executor y scheduler con zod, y las skills son filas versionadas ([ADR-29](#adr-29)). No hay `Harness` ni `Evaluator` genérico. [ADR-02](#adr-02) |
| 06 | Contratos de API | Cubierto | Implementado distinto | `snake_case`, sin Bearer (salvo `POST /events/external`), estados `COMPLETED`, `pause`/`resume` en `501`. Endpoints extra: `/events`, `/metrics/*`, `/webhooks/twenty`, `/scheduler/status`, `/skills`, `/events/external` y `/event-subscriptions`. [ADR-02](#adr-02), [ADR-29](#adr-29), [ADR-30](#adr-30) |
| 07 | Contratos de eventos | Cubierto | Implementado distinto | Sobre `event.envelope.v1` y catálogo emitido; `evaluation.recorded`; sin `signal.detected`; eventos externos `ext.*`. [ADR-11](#adr-11), [ADR-30](#adr-30) |
| 08 | Interfaces del Agent Runtime | Parcial | Implementado distinto | Agentes como clases con código propio (`StubAgent`, `SmokeAgent`, `ProspectorAgent`, `EmailDrafterAgent`, `BajasAgent`); no hay harness. [ADR-07](#adr-07), [ADR-24](#adr-24) |
| 09 | Tool interface | Cubierto | Implementado igual | Mismos campos y clases de riesgo; zod en lugar de JSON Schema. 14 tools reales (contadas en `src/tools`). |
| 10 | Skill interface | Cubierto | Implementado distinto | Skills como filas versionadas en BD (`skills`, `skill_versions`), inmutables por trigger, con fallback a código y API de activación y rollback. Sin optimizador, `workflow`, `optimization_budget` ni comprobación de `content_hash` al cargar. [ADR-29](#adr-29) |
| 11 | Harness interface | Cubierto (mínima) | Pendiente | No hay bucle `CONTEXT → MODEL → TOOL POLICY → EXECUTOR → VERIFIER`. Los agentes orquestan su propio flujo; el `ToolExecutor` aplica allowlist, riesgo y límites. |
| 12 | Memory interface | Pospuesto | Pendiente | Coherente con el v0.2: sin memoria episódica ni semántica. |
| 13 | Evaluator interface | Cubierto | Implementado distinto | Solo el evaluador HUMAN (`human-v1`) y la tabla `evaluations`. No existe `rules-v1`. [ADR-13](#adr-13) |
| 14 | Task scheduler | Cubierto | Implementado distinto | Más tipos que el v0.2 (`ONCE`, `CRON`, `INTERVAL`, `EVENT`, `MANUAL`); `DEPENDENCY` y `CONDITION` no registran nada. [ADR-05](#adr-05), [ADR-17](#adr-17) |
| 15 | Experiment interface | Pospuesto | Pendiente | MVP-2. |
| 16 | Release Gate | Pospuesto | Pendiente | MVP-2. `promote`, `rollback` y `evaluate` devuelven `501`. |
| 17 | Trace schema | Cubierto | Implementado distinto | `traces` y `trace_steps` con pasos `THINK`, `MODEL`, `TOOL`, `FINAL`; sin `trace.v1` en JSON Schema ni `retention_until`. |
| 18 | Esquema de BD | Cubierto | Implementado distinto | 15 tablas, sin `audit_log`. Migraciones Drizzle `0000` a `0006`. [ADR-01](#adr-01), [ADR-31](#adr-31) |
| 19 | Workflows n8n | Pospuesto | Implementado distinto | Existe el puente de eventos en las dos direcciones y un workflow de ejemplo importable (`integrations/n8n/ejemplo-eventos.json`). No hay workflows de negocio. [ADR-30](#adr-30) |
| 20 | Primeros 3 agentes | Cubierto | Implementado distinto | `Prospector`, `EmailDrafter` y `BajasAgent` (determinista); sin Researcher ni Scorer. [ADR-07](#adr-07), [ADR-24](#adr-24) |
| 21 | Primeras 10 skills | Parcial (5 de 10) | Implementado distinto | Existen 4 skills versionadas en BD, todas v1 `ACTIVE` (`prospector-event-exhibitors`, `event-source-discovery`, `exhibitor-list-extraction`, `email-first-contact-draft`); solo una coincide con las 5 skills del v0.2. [ADR-29](#adr-29) |
| 22 | Evaluation dataset | Pospuesto | Pendiente | MVP-2. Hay veredictos humanos en `evaluations` como materia prima. |
| 23 | Benchmark comercial | Pospuesto | Pendiente | MVP-2. |
| 24 | Modelo de seguridad | Cubierto (resumido) | Implementado distinto | Allowlist, techo de riesgo, SSRF, contenido no confiable, `SourceLedger`, rol restringido de la API key de Twenty, IMAP de solo lectura, firma HMAC y Bearer en el puente de eventos. Sin `audit_log`, sin batería de ≥ 10 páginas hostiles (AC-12). [ADR-09](#adr-09), [ADR-14](#adr-14), [ADR-24](#adr-24), [ADR-28](#adr-28), [ADR-30](#adr-30) |
| 25 | Arquitectura Docker | Fuera del documento | Implementado igual | `deployments/docker-compose.yml`, 8 contenedores. [Sección 1.1](#11-qué-corre-y-dónde) |
| 26 | CI/CD | Pospuesto | Pendiente | Sin pipeline. Los workflows de `apps/twenty-app/` son los de la plantilla y no se ejecutan en este repositorio. |
| 27 | Estrategia de tests | Pospuesto | Implementado distinto | De facto: Vitest con tests unitarios, de integración y en vivo, y dobles (`FakeTwenty`, `FakeWeb`, `FakeRenderer`, `FakeImapServer`). 510 tests en la tanda 7. Sin documento de estrategia. |
| 28 | Datos seed/demo | Pospuesto | Implementado distinto | `pnpm seed` (idempotente) crea `Prospector`, `EmailDrafter`, `BajasAgent`, sus 4 tareas, las 4 skills v1 y la fixture `feria-ejemplo.json`. |
| 29 | Observabilidad | Parcial | Implementado distinto | Trazas, métricas SQL y dashboard local. Sin OpenTelemetry. [ADR-16](#adr-16) |
| 30 | Rollback y recuperación | Pospuesto | Pendiente | Solo backup manual con `pg_dump` y parada segura documentada en el runbook. Rollback de agente: `501`. |
| 31 | Criterios de aceptación | Cubierto | Implementado distinto | Algunos medibles hoy, otros no. [Sección 4.2](#42-criterios-de-aceptación-del-v02-11) |
| 32 | Estructura del repo | Sin cambios | Implementado distinto | Existen `apps/twenty-app/`, `runtime/agent-runtime/`, `services/renderer/`, `integrations/n8n/`, `deployments/`, `scripts/`, `docs/`. No existen `evaluation/`, `optimization/`, `schemas/`, `services/catalog/`, `services/inbound/` (el inbound vive en `runtime/agent-runtime/src/inbound/`). |
| 33 | Orden de implementación | Cubierto | Implementado distinto | [Sección 3.4](#34-orden-de-implementación-v02-12). |
| 34 | Master prompt para Codex | Pospuesto | Pendiente | Ninguna fuente lo menciona como hecho. |

Resumen de los 34 puntos tras la tanda 7: **2 implementados igual** (09 y 25), **23 implementados distinto** y **9 pendientes** (11, 12, 15, 16, 22, 23, 26, 30 y 34). Frente a la primera edición (2 iguales, 21 distintos y 11 pendientes), los puntos **10** (skills) y **19** (n8n) han dejado de estar pendientes.

### 3.2 Secciones relevantes del v0.2

| Sección del v0.2 | Estado | Realidad |
|---|---|---|
| §2.1 Stack fijado | Implementado distinto | Node 22, zod en lugar de Ajv; resto igual. [ADR-02](#adr-02) |
| §2.2 Convenciones de nombres | Implementado distinto | API en `snake_case`; eventos en camelCase; tablas y columnas en `snake_case`. |
| §2.3 Idempotencia | Implementado distinto | Persistida en tareas y ejecuciones; en Twenty, por clave natural. [ADR-04](#adr-04) |
| §2.3 Multi-tenancy `[C6]` | Implementado igual | `tenant_id` en todas las tablas; el `tenantId` también se escribe en Twenty. |
| §3 Objetos Twenty | Implementado distinto | [ADR-03](#adr-03) |
| §3.4 Regla de transición por `humanFeedback` | Implementado distinto | Sustituida por el webhook sobre `status`. [ADR-13](#adr-13) |
| §3.8 Permisos en Twenty | Implementado distinto | Una sola API key del runtime, con el rol restringido «Agent runtime»: objetos en lectura y escritura, ninguna tool ([ADR-28](#adr-28)). El alcance por objeto sigue `[POR COMPLETAR]`; «solo lectura» solo se aplica en la UI. |
| §4 Esquema de BD | Implementado distinto | [ADR-01](#adr-01). Sin `audit_log`. Sin `config_snapshot` en `agent_executions`; el run guarda versión del agente, versiones de skills, harness y entorno en `task_runs` (`processor.ts`). Sin `retention_until` (`schema.ts`). |
| §5.2 Tool | Implementado igual | Registry, riesgos, allowlist y executor con límites. |
| §5.5 Evaluator | Implementado distinto | Solo `human-v1`, con el mapeo D14. |
| §5.6 TaskScheduler | Implementado distinto | [ADR-05](#adr-05) |
| §5.7 Registro de tools | Implementado distinto | Existen `find_company`, `get_company`, `upsert_company`, `create_signal`, `create_research`, `create_hypothesis`, `fetch_url`, y además `create_agent_run_summary`, `get_hypothesis`, `create_note`, `render_url`, `get_note`, `update_note` y `set_hypothesis_draft` (14 en total). **No existen** `search_web`, `create_activity` ni las 5 tools del Catalog Service. |
| §6 API del runtime | Implementado distinto | [ADR-02](#adr-02). Desde la tanda 7, también `/skills`, `/events/external` y `/event-subscriptions` ([ADR-29](#adr-29), [ADR-30](#adr-30)). |
| §6.4 `POST /evaluations/human` | Implementado distinto | Existe y acepta la forma del v0.2; el camino principal es el webhook. Responde con `event_id`. |
| §7 Eventos y esquemas | Implementado distinto | [ADR-11](#adr-11). Los 6 JSON Schema (`research.result.v1`, `commercial.hypothesis.v1`, `agent.task.*`, `evaluation.human.v1`) no se han materializado. |
| §8 Trace schema | Implementado distinto | Parcial, consulta punto 17. |
| §9 Agentes y skills | Implementado distinto | [ADR-07](#adr-07). El pipeline de grafo fijo y el embudo 120 → 87 → 31 → 14 no existen. |
| §10.1 Clases de riesgo | Implementado igual | Registry rechaza `DESTRUCTIVE`; no existen tools `HIGH_WRITE` ni `EXTERNAL_SIDE_EFFECT`. Las tools de escritura nuevas (`update_note`, `set_hypothesis_draft`) son `LOW_WRITE`. |
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
| D9 | Autenticación Bearer estática | **No implementada** | Sin autenticación en la API, salvo el Bearer de `POST /events/external` ([ADR-30](#adr-30)). |
| D10 | Event bus BullMQ con outbox mínimo | **Confirmada y ampliada** | Tabla `events` append-only; puente con n8n desde la tanda 7. [ADR-11](#adr-11), [ADR-30](#adr-30) |
| D11 | Solo hipótesis `HOT` en Twenty | **Modificada** | Se escriben todas las relevantes con confianza ≥ 0,5 como `PROPOSED`. [ADR-07](#adr-07), [ADR-08](#adr-08) |
| D12 | Pesos, umbrales (HOT ≥ 70) y `minSignalConfidence` 0,5 | **Parcial** | Solo se aplica el 0,5. [ADR-08](#adr-08) |
| D13 | Signal Classifier como skill del Researcher | **Sin objeto** | No hay Researcher; la clasificación va en la llamada del Prospector. |
| D14 | Mapeo `ACCEPTED` 1.0, `EDITED` 0.5, `DISCARDED` 0.0 | **Confirmada** | Tabla `evaluations`. |
| D15 | Tools nuevas y clases de riesgo | **Confirmada y ampliada** | Se añaden `create_agent_run_summary`, `get_hypothesis`, `create_note`, `render_url`, `get_note`, `update_note` y `set_hypothesis_draft`. |
| D16 | Umbrales de aceptación | **Parcial** | Medibles hoy: AC-15 y AC-16. [Sección 4.2](#42-criterios-de-aceptación-del-v02-11) |
| D17 | Retención de trazas de 90 días | **No implementada** | Sin columna ni job de retención. |
| D18 | Tipos de campo de Twenty sin contrastar | **Cerrada** | Contrastados con Twenty 2.45 (`LINKS`, `CURRENCY`, `SELECT` en mayúsculas, relaciones por columna `companyId`…). |

### 3.4 Orden de implementación (v0.2 §12)

| Paso | Entregable | Realidad |
|---|---|---|
| S0 | Infra Docker | Hecho (más `pxos-renderer`). |
| S0b | Dominio, DNS y warm-up | Hecho; warm-up en curso hasta 2026-11-02. [ADR-20](#adr-20) |
| S1 | Esquemas JSON en `schemas/` | **Pendiente.** Contratos en zod, sin export. |
| S2 | Migraciones Drizzle | Hecho (`0000` a `0006`). Regla de fusión: [ADR-31](#adr-31). |
| S3 | Twenty App | Hecho, con desviaciones. [ADR-03](#adr-03) |
| S4 | Runtime base | Hecho, sin autenticación. |
| S5 | `ModelProvider` y tools `READ` web | Hecho (Gemini, `fetch_url`, `render_url`); sin `search_web`. |
| S6 | `TraceRecorder` y trazas | Hecho. |
| S7 | Harness mínimo | **Pendiente.** |
| S8 | Integración con Twenty | Hecho. |
| S9 | Catalog Service stub y tools | **Pendiente.** Falta el contrato con el backend de publiexpe. |
| S10 | 5 skills y 3 agentes | **Distinto.** Prospector, EmailDrafter y BajasAgent; 4 skills versionadas en BD. [ADR-07](#adr-07), [ADR-24](#adr-24), [ADR-29](#adr-29) |
| S11 | Pipeline de grafo fijo y scheduler | Scheduler hecho; pipeline de tres etapas **no**. |
| S12 | Eventos y `agentRunSummary` | Hecho. |
| S13 | Validador semántico y evaluador `rules-v1` | **Pendiente.** |
| S14 | Feedback humano | Hecho por webhook. [ADR-13](#adr-13) |
| S15 | Batería de prompt injection (≥ 10 casos) | **Pendiente** como batería formal; hay tests de inyección en el scout y en PDF. |
| S16 | n8n | **Parcial.** Puente de eventos y workflow de ejemplo; sin workflows de negocio. [ADR-30](#adr-30) |
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
| 6 | 433 (la bitácora escribe «433 tests×2», mismo «×2» sin explicar) |
| 7 | 510 |

**Costes medidos**

| Concepto | Valor | Origen |
|---|---|---|
| Prospector, modo directo, fixture de 3 expositores | ~0,005 a 0,006 € por run | Tanda 2 |
| EmailDrafter | ~0,0018 a 0,002 € por borrador, ~5 s | Tanda 4 |
| Scout e2e en Docker (catálogo JS) | 0,06 € | Tanda 4 |
| Scout sobre `gastronoma.es` (prueba de aceptación) | 0,139 € (63 llamadas al LLM, ~8 min) | Tanda 5 |
| Búsqueda con grounding (7 consultas) | 0,098 USD | 2026-10-07 |
| Scout sobre `gastronoma.es`, catálogo completo (91 expositores evaluados, 29 empresas con dominio) | 0,195 € (93 llamadas al LLM, 16,4 min) | Tanda 6 |
| Estimación de la ejecución semanal (3 ferias de 60 expositores) | hasta ~0,45 € | README del runtime (tanda 5) |
| Estimación de la ejecución semanal con tres catálogos de 100 expositores | hasta ~0,7 € | README del runtime (tanda 6) |
| Coste acumulado en el dashboard | 0,19 € | Tanda 4 |
| Coste por feria de 60 expositores (sin grounding) | ~0,14 € | README del runtime |

**Aceptación humana y volumen**

| Concepto | Valor | Origen |
|---|---|---|
| Tasa de aceptación humana | 66,7 % | Tanda 4 (datos reales del dashboard) |
| Ciclo real con el usuario | 5 validaciones → 5 borradores | Tanda 5 |
| Catálogo JS de Gastrónoma, primera página | 20 de 20 expositores (de 91) | Tanda 4 |
| Scout de Gastrónoma | 60 evaluados, 56 relevantes, 10 fichas abiertas, 6 dominios, 6 empresas creadas (señal `FAIR` e hipótesis `PROPOSED`) | Tanda 5 |
| Scout de Gastrónoma, catálogo completo | 91 evaluados, 87 relevantes, 60 fichas abiertas, 29 dominios, 23 empresas nuevas (más 6 ya existentes) | Tanda 6 |
| Primer envío real desde Twenty | 1 correo recibido correctamente (confirmación del PM) | 2026-10-07 |
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
| AC-10 | Cumplimiento de políticas | Parcial | Allowlist y techo de riesgo impuestos por el executor; no existe `send_email` en el runtime y la API key de Twenty no accede a las tools de correo ([ADR-28](#adr-28)); sin `audit_log`. |
| AC-11 | `CRM_CORRECTNESS ≥ 0,95` | No medido | Sin muestreo semanal. |
| AC-12 | Resistencia a prompt injection | Parcial | Tests con inyección en HTML y PDF; sin batería de ≥ 10 páginas. |
| AC-13 | `agentRunSummary` por ejecución | Parcial | El Prospector lo escribe siempre; el EmailDrafter no lo escribe. |
| AC-14 | Feedback llega al Agent OS en ≤ 1 minuto | Parcial | Probado en vivo con HMAC (tanda 3) y ciclo real (tanda 5); latencia sin medir. |
| AC-15 | Coste por run ≤ 3,00 € | **Cumplido** | Observado ~0,14 € por feria y 0,195 € con el catálogo completo; ~0,24 € con grounding (estimación); semanal máxima estimada ~0,7 €. |
| AC-16 | Duración ≤ 30 min | **Cumplido** | Scout de Gastrónoma: ~8 min (60 expositores) y 16,4 min con el catálogo completo; el presupuesto de tiempo corta en 20 min ([ADR-26](#adr-26)). |
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

> **Importante:** **harness, memoria, evaluación formal y optimizadores no han empezado.** Las skills ya son objetos versionados ([ADR-29](#adr-29)), pero sin optimizador. Lo construido hasta ahora es un runtime de agentes con código propio, trazas, métricas, feedback humano y envío con un clic por una persona. Es la base del MVP-0 y un primer paso del MVP-1, no el MVP-1.

| Capacidad (v0.1 §26) | Fase | Estado real |
|---|---|---|
| Twenty + App (4 objetos) | MVP-0 | Hecho, con desviaciones. |
| `Agent` + `AgentVersion` | MVP-0 | Hecho. El seed añade una versión nueva del agente si cambia su configuración y deprecia la anterior. |
| `TaskDefinition` + `TaskRun` + `Trace` | MVP-0 | Hecho. |
| Evaluador HUMAN | MVP-0 | Hecho (webhook). |
| Catalog Service (search y match, solo lectura) | MVP-0 | **Pendiente.** A la espera del contrato del conector con el equipo del backend de publiexpe. |
| 1 agente compuesto Prospector → Researcher → Scorer | MVP-0 | **No como se diseñó.** [ADR-07](#adr-07) |
| `publiexpe.info` y warm-up | Requisito previo | En curso. |
| Skills + `SkillVersion` | MVP-1 | **Primer paso hecho.** Tablas inmutables, resolución con fallback, API de activación y rollback, 4 skills v1 ([ADR-29](#adr-29)). Faltan optimizador, `workflow`, `optimization_budget` y la comprobación de `content_hash`. |
| Harness + `HarnessVersion` | MVP-1 | **Sin empezar.** |
| Memory (episódica y semántica básica) | MVP-1 | **Sin empezar.** |
| Inbound Manager (clasificación y borradores con aprobación) | MVP-1 | **Parcial.** El `BajasAgent` lee el buzón y alimenta la lista de supresión ([ADR-24](#adr-24)); existen los borradores de **primer** email y su envío con un clic ([ADR-27](#adr-27)). No hay clasificación general ni borradores de respuesta. |
| Experiments, datasets validation y test | MVP-2 | **Sin empezar.** |
| Release Gates, canary, rollback | MVP-2 | **Sin empezar.** Endpoints en `501`. |
| Skill, Harness y Router Optimizer | MVP-3 | Sin empezar. |
| Entornos dinámicos y puente de entrenamiento | MVP-4 | Sin empezar. |

Qué existe y adelanta trabajo de MVP-2: la tabla `evaluations` (veredictos humanos ligados a la ejecución de origen), las métricas por versión de agente, el archivo de agentes de prueba y la versión exacta de cada skill en el trace de cada ejecución. Son insumo para construir el primer dataset, no el dataset.

### 5.2 Decisiones de diseño abiertas

1. **¿Se construyen Researcher y Scorer o se acepta el Prospector único?** Hoy no hay investigación con fuentes ni scoring. Afecta a AC-18 y a la calidad de la hipótesis.
2. **¿Autenticación del runtime?** El v0.2 propone Bearer; hoy la defensa es escuchar solo en loopback.
3. **¿Fuente real para la tarea diaria?** `daily-event-prospecting` sigue sobre datos de demostración.
4. **Idioma y mercados de prospección** (v0.1 §27, pendiente).
5. **Datos registrales completos del aviso legal** (folio y hoja GR-xxxxx, v0.1 §27).
6. **Contrato del Catalog Service y de `create_quote_request`** con el equipo del backend de publiexpe.
7. **¿Se automatiza el rol restringido de la API key** (un script que lo cree y lo compruebe) para no depender de la UI de Twenty al rotar la key? ([ADR-28](#adr-28))
8. **¿Qué comprueba el journal de migraciones antes de fusionar?** Hoy es una revisión manual del PM ([ADR-31](#adr-31)).

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
- Las fichas de expositor se abren de 2 en 2 (~10 a 12 s por ficha); con muchos relevantes, el presupuesto de tiempo deja sin dominio a los de menor confianza ([ADR-26](#adr-26)). La API JSON de la ficha (Feria Valencia: `/api/exhibitor/get?exhiid=`) podría dar la web sin renderizar la ficha.
- Grounding sin metadatos de fuentes en `gemini-3.8-flash`: se verifica por descarga.
- `GeminiProvider.stream()` no es incremental.
- Precio de Gemini 3.8 Flash: se duplica desde 2027-01-01.

**Plataforma**

- Export de los contratos zod a JSON Schema versionado en `schemas/`.
- `audit_log`, `config_snapshot`, `retention_until` y política de retención de trazas.
- Alcance de la API key de Twenty **por objeto** (`[POR COMPLETAR]` del v0.2 §10.2): el alcance por tools ya está resuelto ([ADR-28](#adr-28)).
- Skills: optimizador, `workflow`, `optimization_budget` y comprobación del `content_hash` al cargar ([ADR-29](#adr-29)).
- Puente de eventos: `EXTERNAL_EVENTS_TOKEN` y `EXTERNAL_WEBHOOK_ALLOW_PRIVATE` no están en `deployments/docker-compose.yml`, y la guardia anti-bucle no cubre ciclos a través de n8n ([ADR-30](#adr-30)).
- OpenTelemetry, CI/CD y n8n.
- `EntityLocks` listo pero sin tools que lo usen.
- Tools pendientes del registro del MVP-0: `search_web`, `create_activity` y las del Catalog Service.
- `/health` solo informa del servicio y de la base de datos; el v0.2 prevé también Redis y Twenty.

**Email y cumplimiento**

- Warm-up en curso (semanas 3 y 4: 2026-10-20 a 2026-11-02).
- Hito DMARC `p=none` → `p=quarantine` el **2026-11-03**, si los informes de `dmarc@publiexpe.info` salen limpios.
- Lista de supresión: las altas son automáticas ([ADR-24](#adr-24)); la comprobación previa al envío depende de la persona. `[TANDA 8, EN CURSO]` Hay una comprobación de red de seguridad en desarrollo ([ADR-27](#adr-27)).
- Envío desde Twenty: con solo SMTP no hay copia en *Enviados* de IONOS, Twenty no verifica el certificado TLS del servidor de correo y el remitente es la primera cuenta capaz de enviar del usuario ([ADR-27](#adr-27)).
- Rotar la API key de Twenty exige reasignar el rol restringido a la key nueva ([ADR-28](#adr-28)).
- Plantillas por sector. El estado de envío consta en `Email status` de la hipótesis; no hay métrica de envíos.
- Cerrado en la tanda 6: descriptor de PubliEXPE en los borradores ([ADR-23](#adr-23)).

**Documentación desactualizada**

- Los README y guías que contradicen la realidad figuran en la sección siguiente.

---

## 6. Contradicciones entre fuentes

Las fuentes se contradicen en estos puntos. Para cada uno se indica cuál está al día.

| # | Contradicción | Cuál es correcta |
|---|---|---|
| 1 | `runtime/agent-runtime/README.md` dice en «Tareas disparadas por evento» que el filtro «no hay operadores» y, en «Borradores de email», que un veredicto `EDITED` no dispara la tarea (el filtro no tiene OR). Su sección «Pendiente» también lista «disparar también con `EDITED`». | CHANGELOG (tanda 5), ESTADO y el seed: el operador `{in}` y la guarda `toStatus` existen, y `EDITED` validada genera borrador. |
| 2 | El README del runtime fija `scout.max_profile_lookups` en 60 (tabla de configuración, flujo del scout y «Coste esperado»). | El código (`prospector-seed.ts` y `prospector-core.ts`) y el CHANGELOG de la tanda 6: 100 ([ADR-26](#adr-26)). La primera edición de este documento recogía un 10 que ya se había corregido a 60 en el README. |
| 3 | El README del runtime («Pendiente») dice que falta integrar `pxos-renderer` en el compose y, opcionalmente, el seccomp. El README del renderer dice que Chromium corre «sin su sandbox» y describe la integración como pasos por hacer. | `deployments/docker-compose.yml`, CHANGELOG y ESTADO: renderer integrado, con seccomp, `SYS_CHROOT` y `RENDER_CHROMIUM_SANDBOX=true`. |
| 4 | El README del runtime («Pendiente») dice que el dashboard no filtra los agentes `[TEST]`. | CHANGELOG (tanda 5): el filtro existe y se ven con `include_archived=true`. |
| 5 | `deployments/README.md` no lista `pxos-renderer` ni el puerto `4030` (`docs/PORTS.md`, el runbook y el README raíz ya los listan). | `deployments/docker-compose.yml` define `pxos-renderer` y publica `127.0.0.1:4030` solo para desarrollo. |
| 6 | La bitácora ESTADO habla de «22 agentes [TEST] archivados»; el CHANGELOG, de «30+ agentes/tareas». | Sin resolver. Pueden contar cosas distintas (agentes frente a agentes y tareas). |
| 7 | La bitácora ESTADO anota «364 tests×2» en la tanda 5. | Sin resolver el sentido de «×2» (¿dos suites, dos ejecuciones?). |
| 8 | `docs/guia-comercial.md` dice que el Prospector «no busca por su cuenta» y que el scouting «debería» estar activo, y promete actualizar la guía. El `runbook-local.md` dice «en despliegue». | CHANGELOG (tanda 3) y README del runtime: el modo scout está implementado y programado; la guía y el runbook no se actualizaron. |
| 9 | LLD v0.2 §9 y §12 describen tres agentes y un grafo fijo; LLD v0.1 §26 pide el mismo pipeline para MVP-0. | Es divergencia de diseño frente a realidad, no un error documental. [ADR-07](#adr-07) |
| 10 | `docs/CHANGELOG.md` coloca la sección «Sin publicar» entre la tanda 7 y la tanda 2, y la tanda 1 figura la última. | Orden de lectura incoherente; no cambia ningún dato. |
| 11 | El README del runtime («Borradores de email») dice que `send_from_twenty.enabled` es `false` en el seed. `docs/twenty-envio-email.md` repite «hoy `false`» (paso 3.3) y su tabla de estado dice «Preparado. Pendiente de que conectes el buzón». | El seed (`email-drafter-seed.ts`) tiene `enabled: true` desde el commit `c786084`, y el envío con un clic está operativo desde el 2026-10-07 ([ADR-27](#adr-27)). |
| 12 | `docs/email-warmup.md` dice que el sistema no envía ningún correo y que, hasta el Inbound Manager, la gestión de bajas es manual. | Desde la tanda 6 el `BajasAgent` añade las bajas a la lista ([ADR-24](#adr-24)) y desde la tanda 7 una persona puede enviar con un clic desde Twenty ([ADR-27](#adr-27)). El runtime sigue sin enviar. |
| 13 | El CHANGELOG describe el filtro del workflow de envío como «READY+VALIDATED»; las guías dicen «Reviewed» y «Validated». | Es el mismo estado: `READY` es el valor interno y *Reviewed* su etiqueta en la UI. |
> **Nota:** este documento **no corrige** esas fuentes (solo toca `docs/` y el README raíz por encargo). Las filas 1, 2, 3, 4, 5 y 11 afectan a ficheros que esta pasada no ha tocado (README del runtime, `deployments/`, `twenty-envio-email.md`). Cada fila es una tarea de mantenimiento documental pendiente.

---

## 7. Calendario de hitos

| Fecha | Hito |
|---|---|
| 2026-10-06 | Tandas 1 y 2 (PR #1 y #2). Inicio del warm-up de `publiexpe.info`. SPF, DKIM y DMARC `p=none` verificados. |
| 2026-10-07 | Tandas 3, 4, 5, 6 y 7 (PR #3 a #7). Primer ciclo real: 5 validaciones → 5 borradores. Catálogo completo de Gastrónoma (91 de 91). Envío con un clic desde Twenty operativo: primer envío real recibido (confirmación del PM). |
| 2026-10-12 (deducido) | Primera ejecución automática del scout (`weekly-event-scouting`, 07:30): el lunes siguiente al 2026-10-07. |
| 2026-10-20 a 2026-11-02 | Semanas 3 y 4 del warm-up (30 a 40 correos por buzón y día). |
| 2026-11-03 | Revisión de informes DMARC y, si están limpios, paso a `p=quarantine`. |
| 2027-01-01 | El precio de `gemini-3.8-flash` se duplica según la tabla del runtime. |
| `[TANDA 8, EN CURSO]` | Comprobación de red de seguridad contra la lista de supresión en el flujo de envío y otros trabajos de la tanda 8, no recogidos aún en las fuentes. |
