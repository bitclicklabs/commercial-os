# Registro de cambios

Cambios notables de PubliEXPE Commercial OS, agrupados por tanda de trabajo. Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Las fechas usan el formato `AAAA-MM-DD`.

## 2026-10-06 — Tanda 2 (PR #2)

- Scheduler (CRON/INTERVAL/ONCE, timezone Europe/Madrid) sobre BullMQ, con deduplicación por slot, `max_concurrency` por tarea, locks por entidad (`entity_locks`) y recuperación de runs huérfanos.
- Capa de tools contra Twenty: 7 tools (find/get/upsert company, create signal/research/hypothesis/run summary), registry con clases de riesgo, allowlist por agente y executor con límites.
- GeminiProvider (REST v1beta, salida JSON estructurada, tabla de precios por modelo real servido) y factory multi-proveedor stub | gemini | anthropic. Decisión: Gemini como proveedor de trabajo.
- Prospector v1: clasifica expositores de un evento y escribe en Twenty empresa + señal (NEW) + hipótesis (PROPOSED) + resumen de ejecución, con coste real por paso (~0,005 €/run). Seed de agente y tarea `daily-event-prospecting` (CRON 08:00).
- Runbook completo, `scripts/sync-twenty-app.ps1` (workaround Windows del CLI de Twenty) y fixes de `deployments/`.

## Sin publicar

### Documentación y herramientas

- Se completa el [runbook de operación local](runbook-local.md) con el comando de migraciones de Drizzle, las variables del runtime, el arranque del stack completo (incluido `pxos-runtime` en el `4020`), los logs por contenedor, el flujo de prueba end-to-end, las credenciales de desarrollo y la rotación de la API key de Twenty.
- Se añade `scripts/sync-twenty-app.ps1`, que sincroniza la Twenty App desde Windows. Ejecuta `yarn twenty apply` en un contenedor efímero `node:24` conectado a `pxos-net`, con `socat` reenviando `127.0.0.1:3020` a `pxos-twenty:3000`. Evita el error `Resource path must not contain backslashes` y el fallo de subida de archivos por `SERVER_URL`.
- Se documenta el workaround de Windows en el runbook y en el README de la Twenty App.

## 2026-10-06 — Tanda 1: bootstrap del MVP-0 (PR #1)

Integración de `feat/mvp0-bootstrap` en `main` (PR #1).

### Añadido

- **Infraestructura local** (`deployments/`): stack Docker Compose con Twenty CRM `v2.45.6` (servidor y worker), Postgres 16 y Redis 7.4 de Twenty, PostgreSQL con pgvector del Agent OS (`127.0.0.1:5440`) y Redis del Agent OS con AOF para BullMQ (`127.0.0.1:6391`). Red `pxos-net` y volúmenes con prefijo `pxos`.
- **Servicio `pxos-runtime`** integrado en el compose: build desde `runtime/agent-runtime`, puerto `127.0.0.1:4020`, healthcheck sobre `/health`, migraciones al arrancar con `RUN_MIGRATIONS=true` y variables `TWENTY_BASE_URL` y `TWENTY_API_KEY`.
- **Agent Runtime** (`runtime/agent-runtime/`): esqueleto ejecutable en Node.js 22 y TypeScript con API Fastify, worker BullMQ y persistencia con Drizzle ORM sobre PostgreSQL.
  - Endpoints para agentes, tareas, task runs y ejecuciones, con ciclo de vida de estados y trace con pasos.
  - Lanzamiento idempotente de `TaskRun` con la clave `taskrun:{task_id}:{scheduled_at}` e índice único `(tenant_id, idempotency_key)`.
  - `tenant_id` en todas las tablas (C6).
  - Agentes con `StubAgent` (sin LLM) y `AnthropicProvider` como esqueleto.
  - Tests unitarios y de integración con Vitest.
- **Twenty App** (`apps/twenty-app/`): App `publiexpe-commercial-os` con los objetos `commercialSignal`, `research`, `commercialHypothesis` y `agentRunSummary`, sus relaciones con `Company` y `Person`, la carpeta de navegación **Commercial OS** y las vistas kanban de hipótesis por estado y señales recientes.
- **Especificación**: LLD v0.2 del MVP-0 (`docs/LLD-0.2-especificacion.md`) junto al LLD v0.1.
- **Documentación**: guía de contribución (`docs/CONTRIBUTING.md`), runbook local (`docs/runbook-local.md`, esqueleto), puertos reservados (`docs/PORTS.md`) y README de despliegue.

### Conocido y pendiente

- El runtime todavía no tiene scheduler: las runs se lanzan a mano con `POST /tasks/:id/run`.
- `/health` del runtime solo comprueba PostgreSQL; el contrato del LLD v0.2 prevé también Redis y Twenty.
- El runtime recibe `TWENTY_API_KEY` pero aún no escribe en Twenty.
- No hay autenticación por token en la API del runtime.
- Promote, rollback y evaluate de agentes devuelven `501` (previstos para MVP-2).
