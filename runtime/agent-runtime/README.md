# Agent Runtime

Servicio del Agent OS de PubliEXPE Commercial OS (LLD v0.1, sección 8). Expone la API HTTP del runtime, planifica tareas (`ONCE`, `CRON`, `INTERVAL`) y ejecuta un worker BullMQ que lanza agentes y persiste `TaskRun`, `AgentExecution`, `Trace` y `TraceStep` en PostgreSQL.

Estado: MVP. Además de `StubAgent` (sin LLM) y `SmokeAgent` (tools reales contra Twenty, consulta [Tools](#tools)), el runtime ejecuta el **Prospector** con Gemini (consulta [Prospector](#prospector)), que también trabaja sobre ferias reales con búsqueda de Google, `fetch_url` (HTML y PDF) y `render_url` (catálogos JavaScript, con el servicio [`pxos-renderer`](../../services/renderer/README.md)) ([modo scout](#modo-scout-ferias-reales)). `AnthropicProvider` existe como esqueleto y no se llama en los tests.

## Stack

- Node.js 22 y TypeScript estricto
- Fastify 5 (API HTTP) y zod 4 (validación de contratos)
- Drizzle ORM sobre PostgreSQL (`pg`) y drizzle-kit para migraciones
- BullMQ sobre Redis
- Vitest

## Estructura

```
runtime/agent-runtime/
├── drizzle/                  Migraciones SQL generadas por drizzle-kit
├── src/
│   ├── main.ts               Entrada: API, worker y/o scheduler según RUNTIME_ROLE o --role=
│   ├── config.ts             Configuración desde variables de entorno
│   ├── api/                  Servidor Fastify, contratos zod y rutas
│   ├── agents/               Interfaz de agente, StubAgent, SmokeAgent, ProspectorAgent (modos directo y scout, prompts, SourceLedger) EmailDrafterAgent (borradores, nunca envía) y BajasAgent (inbound de bajas, sin LLM)
│   ├── inbound/              Inbound de bajas: lector IMAP de solo lectura, clasificador determinista, lista de supresión y cursor (inbound_state)
│   ├── integrations/twenty/  TwentyClient REST tipado y mapeo de objetos de la App
│   ├── tools/                Interfaz Tool, registry, tool_policy, executor, tools de Twenty y web/ (fetch_url con texto de PDF, render_url y guarda SSRF)
│   ├── db/                   Esquema Drizzle, cliente y migrador
│   ├── events/               Event bus: sobre event.envelope.v1, EventBus, payloads, triggers EVENT y GET /events
│   ├── domain/               Estados, máquina de estados e idempotency keys
│   ├── evaluations/          Evaluador HUMAN: mapeo de feedback, vínculo con la ejecución de origen, webhook de Twenty y evento evaluation.recorded
│   ├── metrics/              Consultas SQL de métricas (solo lectura) y HTML del dashboard
│   ├── providers/            ModelProvider, StubProvider, AnthropicProvider, GeminiProvider y tabla de precios
│   ├── queue/                RunQueue (BullMQ y en memoria)
│   ├── scheduler/            TaskScheduler sobre BullMQ, parseo de schedules y rutas
│   ├── seed/                 Seed idempotente de las skills, el Prospector, el EmailDrafter, el BajasAgent y sus tareas (pnpm seed)
│   ├── skills/               Skills versionadas (MVP-1): render, resolución desde la BD con fallback a las constantes, ciclo de estados
│   ├── services/             Lanzamiento idempotente de TaskRuns
│   └── worker/               RunProcessor, worker BullMQ, locks por entidad y reconciliador
└── test/
    ├── unit/                 Corren siempre, sin BD ni Redis
    ├── integration/          API, worker, scheduler, locks y tools (PostgreSQL, Redis y Twenty); se saltan si falta el servicio
    ├── helpers/              FakeTwenty (API REST de Twenty en memoria), FakeWeb (DNS y HTTP simulados), FakeRenderer (pxos-renderer simulado), FakeImapServer (servidor IMAP en proceso) y makePdf (PDF de prueba en memoria)
    ├── fixtures/             feria-ejemplo.json (evento de demo) y payloads reales de webhooks de Twenty 2.45
    └── setup-env.ts          Carga .env (si existe) antes de los tests
```

## Arranque en desarrollo

Requisitos: Node.js 22, pnpm, y los contenedores `pxos-postgres` (127.0.0.1:5440) y `pxos-redis` (127.0.0.1:6391) de `deployments/`.

1. Instala dependencias:

   ```sh
   cd runtime/agent-runtime
   pnpm install
   ```

1. Copia la configuración de ejemplo. Los valores por defecto ya apuntan a los puertos de desarrollo:

   ```sh
   cp .env.example .env
   ```

1. Aplica las migraciones:

   ```sh
   pnpm db:migrate
   ```

1. Arranca API y worker en el mismo proceso, con recarga en caliente:

   ```sh
   pnpm dev
   ```

   La API escucha en `http://127.0.0.1:4020`. Para separar procesos, usa `pnpm dev:api`, `pnpm dev:worker` y `pnpm dev:scheduler`.

### Variables de entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `RUNTIME_ROLE` | `all` | `all`, `api`, `worker` o `scheduler` |
| `RUNTIME_HOST` / `RUNTIME_PORT` | `127.0.0.1` / `4020` | Escucha de la API |
| `DATABASE_URL` | `postgres://agentos:agentos_dev@127.0.0.1:5440/agentos` | PostgreSQL del Agent OS |
| `REDIS_URL` | `redis://127.0.0.1:6391` | Redis de BullMQ |
| `QUEUE_NAME` | `pxos-agent-runs` | Cola BullMQ |
| `WORKER_CONCURRENCY` | `4` | Jobs simultáneos por worker |
| `SCHEDULER_SYNC_INTERVAL_MS` | `60000` | Cada cuánto el scheduler reconcilia todas las tareas con BullMQ |
| `RECONCILE_INTERVAL_MS` | `60000` | Cada cuánto el worker busca `TaskRun` huérfanos |
| `RECONCILE_GRACE_MS` | `120000` | Antigüedad mínima de un `TaskRun` para considerarlo huérfano |
| `CONCURRENCY_DEFER_MS` | `2000` | Espera antes de reintentar un job aplazado por `max_concurrency` |
| `STALLED_INTERVAL_MS` | `30000` | Frecuencia del chequeo de jobs stalled de BullMQ |
| `MAX_STALLED_COUNT` | `1` | Veces que un job puede quedar stalled antes de que BullMQ lo marque `failed` |
| `EVENT_CHAIN_MAX_DEPTH` | `5` | Profundidad máxima de una cadena de tareas disparadas por eventos |
| `EVENT_REPUBLISH_INTERVAL_MS` | `30000` | Cada cuánto el re-publicador encola los eventos sin despachar |
| `EVENT_REPUBLISH_GRACE_MS` | `15000` | Antigüedad mínima de un evento sin despachar para re-publicarlo |
| `EVENT_CONSUMER_CONCURRENCY` | `4` | Eventos simultáneos que procesa el consumidor de triggers `EVENT` |
| `DEFAULT_TENANT_ID` | `publiexpe` | Tenant si la petición no envía `x-tenant-id` |
| `DEFAULT_MODEL_PROVIDER` | `stub` | Proveedor para agentes creados sin `model_provider`: `stub`, `anthropic` o `gemini` |
| `ANTHROPIC_API_KEY` | vacío | Solo para agentes con `model_provider=anthropic` |
| `GEMINI_API_KEY` | vacío | API key de Google AI Studio para agentes con `model_provider=gemini` |
| `GEMINI_MODEL` | `gemini-flash-latest` | Modelo de Gemini si la versión del agente no fija uno |
| `TWENTY_BASE_URL` | `http://localhost:3020` | API REST de Twenty. En el contenedor: `http://pxos-twenty:3000` |
| `TWENTY_API_KEY` | vacío | API key de Twenty. Sin ella, las tools de Twenty responden `TWENTY_NOT_CONFIGURED` |
| `TWENTY_TIMEOUT_MS` | `10000` | Timeout por petición a Twenty |
| `TWENTY_WAIT_MAX_MS` | `600000` | Tiempo máximo que el worker retiene un run que usa tools de Twenty mientras Twenty no responde a `/healthz`. `0` desactiva la espera |
| `TWENTY_WEBHOOK_SECRET` | vacío | Secreto del webhook de Twenty (mínimo 16 caracteres). Sin él, `POST /webhooks/twenty` responde `503` |
| `TWENTY_WEBHOOK_TARGET_URL` | `http://pxos-runtime:4020/webhooks/twenty` | Destino que registra `pnpm register:webhook` si no pasas `--url` |
| `EVALUATION_DEDUPE_WINDOW_MS` | `600000` | Ventana en la que no se repite el mismo veredicto (sujeto, feedback y estado destino) |
| `FETCH_URL_ALLOWLIST` | vacío | Dominios que `fetch_url` puede descargar, separados por comas (incluye subdominios). Vacío = cualquier host público |
| `FETCH_URL_DENYLIST` | vacío | Dominios que `fetch_url` nunca descarga. Gana sobre la allowlist |
| `FETCH_URL_ALLOWED_PORTS` | `80,443,8080,8443` | Puertos permitidos en las URL de `fetch_url` |
| `IONOS_IMAP_HOST` / `IONOS_IMAP_PORT` | `imap.ionos.es` / `993` | Servidor IMAP del buzón de bajas (siempre TLS) |
| `IONOS_IMAP_USER` / `IONOS_IMAP_PASSWORD` | vacío | Buzón que lee el BajasAgent (`jesus.abril@publiexpe.info`). Sin ellas, `process-unsubscribes` termina `SKIPPED` |
| `IONOS_IMAP_MAILBOX` | `INBOX` | Carpeta que lee el BajasAgent |
| `RENDERER_URL` | `http://pxos-renderer:3000` | Servicio de render JavaScript de `render_url`. En desarrollo, `http://127.0.0.1:4030` si el renderer está publicado ahí. Vacío u `off` = desactivado (`render_url` devuelve `RENDERER_NOT_CONFIGURED`) |

## Migraciones

El esquema vive en `src/db/schema.ts`. Todas las tablas llevan `tenant_id` (C6).

- Genera una migración tras cambiar el esquema (no necesita BD):

  ```sh
  pnpm db:generate
  ```

- Aplícalas:

  ```sh
  pnpm db:migrate
  ```

| Migración | Contenido |
|---|---|
| `0000_init` | Esquema inicial (agentes, tareas, runs, ejecuciones, traces) |
| `0001_scheduler_locks` | Tabla `entity_locks` e índice `task_runs (status, updated_at)` para el reconciliador |
| `0002_events` | Tabla `events` (log de eventos de dominio, *append-only* con trigger anti-`DELETE`) |
| `0003_evaluations` | Tabla `evaluations` del evaluador HUMAN. SQL idempotente (`IF NOT EXISTS`) |
| `0004_inbound` | Tabla `inbound_state` (cursor IMAP del inbound de bajas). SQL idempotente (`IF NOT EXISTS`) |
| `0005_skills` | Tablas `skills` y `skill_versions` (triggers anti-`DELETE` y de contenido inmutable) y columna `traces.skill_versions`. SQL idempotente |

Importante: el migrador de Drizzle aplica solo las migraciones con fecha posterior a la última aplicada. Si dos ramas generan migraciones en paralelo contra la misma BD de desarrollo, aplica primero la más antigua o regenera la nueva tras el merge.

El contenedor aplica las migraciones al arrancar si `RUN_MIGRATIONS=true`.

## Tests

```sh
pnpm test              # todo
pnpm test:unit         # sin dependencias externas
pnpm test:integration  # necesita PostgreSQL; los tests del scheduler también Redis
pnpm typecheck
pnpm build
```

Los tests de integración comprueban la conexión a `DATABASE_URL` (y a `REDIS_URL` los del scheduler) y, si falla, se saltan con un aviso. Para forzar el salto, define `SKIP_DB_TESTS=1` o `SKIP_REDIS_TESTS=1`. Cada ejecución usa un tenant nuevo (`it-xxxxxxxx`), así que no borran datos. Los tests del scheduler usan colas BullMQ propias (`it-runs-xxxxxxxx`) y las eliminan al terminar.

Para no interferir con otras ramas que comparten la BD de desarrollo, puedes apuntar los tests a una base propia del mismo servidor:

```sh
DATABASE_URL=postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt2_scheduler pnpm test
```

`test/setup-env.ts` carga `runtime/agent-runtime/.env` antes de cada fichero de test, sin sobrescribir variables ya definidas. Los tests de Twenty (`test/integration/twenty-tools.test.ts`) se saltan si `TWENTY_API_KEY` está vacía o si `TWENTY_BASE_URL` no responde. Para ejecutarlos en local:

1. Copia la API key de Twenty a tu `.env` local (está en `.gitignore`):

   ```sh
   grep '^TWENTY_API_KEY=' ../../deployments/.env >> .env
   echo 'TWENTY_BASE_URL=http://localhost:3020' >> .env
   ```

1. Ejecuta los tests:

   ```sh
   pnpm vitest run test/integration/twenty-tools.test.ts
   ```

Los tests crean registros de prueba reconocibles (`[TEST] pxos-it …`, dominio `test-{uuid}.example`) y **no borran nada**: el borrado en el CRM está prohibido. Si además hay PostgreSQL, el último bloque ejecuta el camino completo API → worker → `SmokeAgent` → tools reales → trace.

## API

Cabecera opcional `x-tenant-id` en todas las rutas. Las respuestas usan `snake_case`.

| Método y ruta | Descripción |
|---|---|
| `GET /health` | Estado del servicio y de la BD |
| `POST /agents` | Crea el agente y su versión 1 (`ACTIVE` por defecto) |
| `GET /agents`, `GET /agents/:id` | Lista o detalle con versiones |
| `PATCH /agents/:id` | Metadatos y estado (`ARCHIVED` es definitivo) |
| `POST /agents/:id/pause` | `ACTIVE` a `PAUSED` |
| `POST /agents/:id/{evaluate,promote,rollback}` | `501`, pendiente de MVP-2 |
| `POST /tasks` | Crea la `TaskDefinition` y su versión 1 |
| `GET /tasks`, `GET /tasks/:id` | Lista o detalle con versiones |
| `PATCH /tasks/:id` | Cada cambio crea una `TaskDefinitionVersion` nueva |
| `POST /tasks/:id/run` | Lanza un `TaskRun` idempotente: `202` nuevo, `200` duplicado |
| `POST /tasks/:id/pause`, `/resume`, `/archive` | Ciclo de vida. No hay `DELETE`. Registran o retiran el schedule |
| `GET /tasks/:id/schedule` | Schedule deseado frente al registrado en BullMQ y próximos disparos |
| `GET /scheduler/status` | Job schedulers, jobs `ONCE` y triggers `EVENT` registrados del tenant, y contadores de la cola |
| `GET /events` | Eventos de dominio del tenant (filtros `type`, `since`, `correlation_id`, `limit`, `order`) |
| `GET /tasks/:id/runs` | Historial de ejecuciones de la tarea |
| `GET /task-runs/:id` | `TaskRun` con su ejecución, trace y pasos |
| `POST /executions` | Ejecuta un agente sin tarea (idempotente con `idempotency_key`) |
| `GET /executions`, `GET /executions/:id` | Lista o detalle con trace y pasos |
| `POST /executions/:id/cancel` | `QUEUED` o `RUNNING` a `CANCELLED` |
| `POST /executions/:id/{pause,resume}` | `501`, requiere harness con checkpoints |
| `POST /webhooks/twenty` | Webhook de Twenty firmado. Convierte cambios de `commercialHypothesis` en evaluaciones HUMAN |
| `POST /evaluations/human` | Registra un veredicto manual: `201` nuevo, `200` duplicado |
| `GET /evaluations` | Lista evaluaciones. Filtros: `subject_id`, `subject_type`, `feedback`, `agent_execution_id`, `since`, `limit` |
| `GET /metrics/summary` | Runs por estado, tarea y outcome; coste, tokens, latencia, embudo comercial y feedback. Filtros `since`, `until` |
| `GET /metrics/agents` | Por agente y versión: runs, coste medio, outcome y tasa de aceptación humana. Filtros `since`, `until` |
| `GET /metrics/evaluations` | Veredictos por día y por sujeto. Filtros `since`, `until`, `tz`, `subject_limit` |
| `GET /metrics/runs` | Últimos `TaskRun` (`limit`, 10 por defecto) con coste, duración y enlace al trace |
| `GET /dashboard` | Mini dashboard HTML. Solo para peticiones locales |
| `GET /skills`, `GET /skills/:id` | Lista de skills o detalle con versiones. `:id` admite el uuid o el nombre |
| `POST /skills` | Crea la skill y su versión 1 en `DRAFT` |
| `POST /skills/:id/versions` | Versión nueva en `DRAFT`, desde texto o copiando la activa (`copy_from`) |
| `POST /skills/:id/versions/:v/activate` | La versión pasa a `ACTIVE` y la anterior a `DEPRECATED`, en una transacción |
| `POST /skills/:id/versions/:v/deprecate` | `DRAFT` a `DEPRECATED`; sobre la `ACTIVE`, vuelve a la versión activa anterior. No hay `DELETE` |

### Idempotencia

`POST /tasks/:id/run` calcula `taskrun:{task_id}:{scheduled_at}` (LLD sección 21), con `scheduled_at` normalizado a UTC con precisión de segundo. Si omites `scheduled_at`, se usa el instante actual.

- El índice único `(tenant_id, idempotency_key)` de `task_runs` impide un segundo `TaskRun`.
- El job de BullMQ usa un id derivado de la misma clave, así que un re-encolado no duplica el job.
- Si Redis no responde, el `TaskRun` queda `QUEUED` y la API devuelve `503`. Repite la misma petición para re-encolarlo.

### Estados de TaskRun y AgentExecution

```
QUEUED  -> RUNNING | CANCELLED
RUNNING -> COMPLETED | FAILED | TIMED_OUT | CANCELLED | QUEUED (reintento)
COMPLETED, FAILED, TIMED_OUT, CANCELLED: terminales e inmutables
```

Cada intento crea una `AgentExecution` nueva. `task_runs.execution_id` apunta al último intento.

## Scheduler

`TaskDefinition.schedule` admite estos tipos con disparo temporal:

| Tipo | Campos | Ejemplo |
|---|---|---|
| `ONCE` | `run_at` (o `at`), ISO 8601 | `{"type":"ONCE","run_at":"2026-10-07T08:00:00+02:00"}` |
| `CRON` | `expression` (o `cron`), 5 o 6 campos; `timezone` opcional | `{"type":"CRON","expression":"0 8 * * 1-5"}` |
| `INTERVAL` | `every_seconds` (o `interval_seconds`) | `{"type":"INTERVAL","every_seconds":900}` |

`EVENT` se registra como trigger de eventos (consulta [Tareas disparadas por evento](#tareas-disparadas-por-evento)). `MANUAL`, `DEPENDENCY` y `CONDITION` no registran nada en el scheduler. La zona horaria de `CRON` es `schedule.timezone`, si existe, o `task.timezone` (por defecto `Europe/Madrid`). `POST /tasks` y `PATCH /tasks/:id` devuelven `400 invalid_schedule` si el schedule no es válido.

### Funcionamiento

- El registro vive en la cola `{QUEUE_NAME}-schedule`. `CRON` e `INTERVAL` usan un Job Scheduler de BullMQ por tarea (`task__{task_id}`). `ONCE` usa un job diferido (`once__{task_id}__{run_at_ms}`).
- Una tarea tiene schedule registrado solo si está `ACTIVE`, `enabled` y su schedule es temporal y válido.
- La API sincroniza tras `POST /tasks`, `PATCH /tasks/:id` (versión nueva), `pause`, `resume` y `archive`. Si Redis no responde, la petición no falla: la sincronización periódica lo corrige.
- El proceso con rol `scheduler` (o `all`) consume los disparos y ejecuta `syncAll` al arrancar y cada `SCHEDULER_SYNC_INTERVAL_MS`. `syncAll` registra lo que falte, actualiza lo que haya cambiado y retira los schedules de tareas que ya no cumplen. Solo toca BullMQ si el estado deseado difiere del registrado.
- Cada disparo pasa por `requestTaskRun`, el mismo camino que `POST /tasks/:id/run`, con `scheduled_at` igual al instante planificado del slot (no al de entrega). Un disparo repetido por un reinicio o un job stalled genera la misma clave `taskrun:{task_id}:{scheduled_at}` y no duplica el `TaskRun`.
- Si la tarea ya no está activa cuando llega el disparo, se descarta y se retira el schedule. Si el agente no está `ACTIVE`, el slot se omite con un aviso en el log.

### max_concurrency por tarea

El worker aplica `max_concurrency` antes de pasar un `TaskRun` de `QUEUED` a `RUNNING`:

1. Abre una transacción y toma `pg_advisory_xact_lock` con una clave derivada del `task_id`. Así dos workers no ven el mismo hueco libre.
1. Cuenta los `TaskRun` `RUNNING` de la tarea. Si hay `max_concurrency` o más, el run sigue `QUEUED` y el job pasa a `delayed` durante `CONCURRENCY_DEFER_MS` (con un pequeño jitter) mediante `moveToDelayed` + `DelayedError`. No consume intentos.
1. Si hay hueco, hace la transición guardada a `RUNNING` dentro de la misma transacción.

Se eligió un advisory lock en vez de `SELECT ... FOR UPDATE` sobre `task_definitions` para no bloquear los `PATCH` de la tarea, y en vez de grupos de BullMQ porque son de la versión Pro.

### Locks por entidad

`EntityLocks` (`src/worker/entity-locks.ts`) gestiona arrendamientos sobre la tabla `entity_locks` (`tenant_id`, `entity_type`, `entity_id`, `locked_by_execution`, `expires_at`):

- `acquire({ tenantId, entityType, entityId, executionId, ttlMs })` es un único `INSERT ... ON CONFLICT DO UPDATE ... WHERE` atómico. Devuelve el lock si estaba libre, caducado o ya era de la misma ejecución (reentrante, renueva el TTL). Devuelve `null` si lo tiene otra ejecución. No espera.
- `release(...)`, `releaseAll(executionId)`, `holder(...)` y `withLock(..., fn)`.
- Usa el reloj de PostgreSQL (`now()`). Liberar pone `expires_at = now()`; no hay `DELETE` físico.
- El worker llama a `releaseAll` al terminar cada intento. Si el worker cae, el lock caduca por TTL.

Aún no hay tools que lo usen. El processor expone la instancia en `RunProcessor.locks`.

### Recuperación de huérfanos

El rol `worker` (o `all`) ejecuta `OrphanReconciler` al arrancar y cada `RECONCILE_INTERVAL_MS`. Para cada `TaskRun` `QUEUED` o `RUNNING` sin cambios durante `RECONCILE_GRACE_MS`, consulta el estado de su job en BullMQ:

| Estado del run | Job de BullMQ | Acción |
|---|---|---|
| Cualquiera | `waiting`, `delayed`, `active`, `prioritized` | Nada: BullMQ sigue siendo dueño del job |
| `QUEUED` | No existe, `completed` o `failed` | Re-encola con la misma idempotency key |
| `RUNNING` | No existe, `completed` o `failed` | `RUNNING -> QUEUED` y re-encola, o `RUNNING -> FAILED` si `attempts >= max_attempts` |

La ejecución (`AgentExecution`) del intento muerto pasa a `FAILED` con `error.name = "OrphanedRun"`. Todas las transiciones son `UPDATE` guardados por estado en SQL, así que el reconciliador nunca pisa a un worker que haya terminado entre medias.

Los jobs `active` de un worker caído los gestiona el chequeo de stalled de BullMQ (`STALLED_INTERVAL_MS`, `MAX_STALLED_COUNT`): los devuelve a `wait`. Cuando el processor recibe un job cuyo run sigue `RUNNING`, sabe que el intento anterior murió y aplica la misma recuperación antes de continuar. Si BullMQ lo marca `failed` por superar `MAX_STALLED_COUNT`, lo recoge el reconciliador.

### Espera a Twenty al arrancar

Al encender el host, Docker arranca todos los contenedores a la vez y el catch-up del scheduler puede encolar el slot pendiente mientras `pxos-twenty` aún está en `health: starting`. Para que ese run no gaste sus tools en `TWENTY_NETWORK_ERROR`, el worker aplica una espera antes de pasar un `TaskRun` de `QUEUED` a `RUNNING`:

1. Si la `tool_policy` de la versión del agente permite alguna tool de Twenty (las que declaran permisos `twenty:*`), el worker llama a `TwentyClient.health()`: un `GET /healthz` sin API key, con timeout de 3 s y sin reintentos. El resultado se cachea 5 s y se comparte entre jobs concurrentes del mismo proceso.
1. Si Twenty no responde, el run sigue `QUEUED` y el job pasa a `delayed` con `moveToDelayed` + `DelayedError`, igual que con `max_concurrency`. No consume intentos. Las esperas crecen: 5 s, 15 s, 30 s y luego 60 s. Cada aplazamiento queda en el log (`Twenty not healthy; deferring task run`) y la ventana de espera viaja en los datos del job (`twentyWait`), así que sobrevive a un reinicio del worker.
1. Si pasa `TWENTY_WAIT_MAX_MS` (10 min por defecto) y Twenty sigue sin responder, el run arranca igualmente con un aviso en el log. Las tools fallan y el agente reporta `PARTIAL`, que es el resultado honesto.

Los agentes sin tools de Twenty y las instalaciones sin `TWENTY_API_KEY` no esperan. Las ejecuciones directas (`POST /executions`) tampoco pasan por esta espera.

## Eventos

El runtime publica eventos de dominio (LLD v0.1 sección 21, LLD v0.2 sección 7) y permite disparar tareas con ellos. El código vive en `src/events/` (sobre, bus, payloads, matching y ruta) y en `src/scheduler/event-triggers.ts` (registro y consumidor de triggers `EVENT`).

### Sobre `event.envelope.v1`

Todos los eventos viajan con este sobre. Los campos del sobre y de `data` usan `camelCase` (convención del LLD v0.2 para payloads).

```json
{
  "id": "2f6c1e9a-8b34-4d0f-b5a1-93d7c0e2a611",
  "type": "task.completed",
  "schemaVersion": "task.completed.v1",
  "tenantId": "publiexpe",
  "occurredAt": "2026-10-07T08:00:20.512Z",
  "producer": "agent-runtime",
  "correlationId": "5d2f9c1e-3b6a-4e8f-a1c7-2f9e0b4d6a33",
  "idempotencyKey": "evt:task.completed:5d2f9c1e-3b6a-4e8f-a1c7-2f9e0b4d6a33",
  "data": { "taskRunId": "5d2f9c1e-...", "taskDefinitionId": "a41c7e20-...", "status": "COMPLETED", "costEur": 0.0431, "chainDepth": 0 }
}
```

- `producer`: `agent-runtime`, `scheduler`, `twenty-app` o `n8n`. Se guarda también como `source` (`runtime`, `twenty`, `n8n`).
- `correlationId`: el `TaskRun` raíz, o la ejecución si es directa (`POST /executions`).
- `schemaVersion`: `{type}.v1`. Los payloads son compactos; nunca incluyen el trace ni la salida completa del agente.

### Catálogo emitido

| Evento | Dónde se emite | `data` |
|---|---|---|
| `task.scheduled` | `requestTaskRun`, solo si crea el `TaskRun` (API, ticks del scheduler y triggers `EVENT`) | `taskRunId`, `taskDefinitionId`, `scheduledAt`, `trigger` (`MANUAL`, `SCHEDULE`, `EVENT`), `chainDepth` |
| `task.started` | Processor, tras `QUEUED -> RUNNING` y crear la ejecución del intento | `taskRunId`, `taskDefinitionId`, `executionId`, `attempt`, `startedAt`, `chainDepth` |
| `task.completed` | Processor, al cerrar el run en `COMPLETED` | `taskRunId`, `taskDefinitionId`, `executionId`, `status`, `costEur`, `latencyMs`, `attempts`, `finishedAt`, `outcome` y `funnel` si la salida los trae, `chainDepth` |
| `task.failed` | Processor, al cerrar el run en `FAILED` o `TIMED_OUT` (no en un reintento) | Igual, con `error` (`name`, `code`, `message`) en lugar de coste |
| `agent.execution.started` | Processor, al arrancar cada intento o ejecución directa | `executionId`, `taskRunId`, `taskDefinitionId`, `agentId`, `agentVersionId`, `agentVersion`, `stage`, `chainDepth` |
| `agent.execution.completed` / `.failed` | Processor, al persistir el resultado (si no se canceló antes) | Lo anterior más `status`, `costEur`, `inputTokens`, `outputTokens`, `latencyMs` y `outcome` o `error` |
| `evaluation.recorded` | Servicio de evaluaciones, tras guardar un veredicto humano (webhook de Twenty o `POST /evaluations/human`) | `evaluationId`, `evaluatorId`, `subjectType`, `subjectId`, `feedback`, `score`, `toStatus`, `source`, `agentExecutionId`, `taskRunId`, `companyId` (o `null` si no se pudo resolver), `occurredAt` |

Cada evento del runtime lleva una `idempotencyKey` (`evt:{type}:{task_run_id}`, `evt:task.started:{task_run_id}:{attempt}`, `evt:{type}:{execution_id}`, `evt:evaluation.recorded:{evaluation_id}`): publicar dos veces el mismo hecho devuelve la fila existente.

`evaluation.recorded` no habla de un run: no lleva `taskDefinitionId` y su `chainDepth` es 0. Su `correlationId` es el `TaskRun` de origen de la hipótesis, o la evaluación si no se resolvió. `companyId` sale del registro del webhook o, en `POST /evaluations/human`, de la propuesta original del agente (entrada de `create_hypothesis` en el trace). Se emite también cuando la llamada se deduplica: la clave es la de la evaluación existente, así que no crea otro evento y vuelve a despachar uno que no llegó a la cola.

### Publicación

`EventBus.publish(event)` hace dos pasos (outbox mínimo):

1. `INSERT` en la tabla `events`.
1. Añade un job a la cola `{QUEUE_NAME}-events` con `jobId` igual al id del evento y marca `dispatched_at`.

La publicación es *best-effort*: si Redis falla, la fila queda con `dispatched_at = null` y el re-publicador (rol `scheduler` o `all`, cada `EVENT_REPUBLISH_INTERVAL_MS`) la encola cuando han pasado `EVENT_REPUBLISH_GRACE_MS`. Los puntos de emisión usan `emit()`, que nunca lanza: un fallo del bus no rompe un run. Los consumidores deben tolerar duplicados.

Tabla `events` (migración `0002_events`): `id`, `tenant_id`, `type`, `schema_version`, `occurred_at`, `payload` (el `data` del sobre), `source`, `producer`, `correlation_id`, `idempotency_key` (única por tenant), `dispatched_at`, `dispatch_attempts`, `created_at`. Índices por `(tenant_id, type, occurred_at)`, `(tenant_id, occurred_at)`, `(tenant_id, correlation_id)` y parcial sobre las filas sin despachar. Un trigger rechaza `DELETE`: el log es *append-only*.

### Tareas disparadas por evento

```json
{ "type": "EVENT", "event_type": "task.completed", "filter": { "taskDefinitionId": "a41c7e20-...", "status": "COMPLETED" } }
```

- `event_type` (alias `event`) debe coincidir con el `type` del evento.
- `filter` es opcional. Cada clave es una ruta con puntos dentro de `data` (`funnel.out`, `results.0.status`; se acepta el prefijo `$.`) y el valor se compara por igualdad estricta (objetos y arrays, en profundidad), o con el operador `{"in": [v1, v2, ...]}` (máx. 50 valores) para aceptar varios.
- El registro sigue el mismo camino que `CRON`: la API sincroniza tras `POST /tasks`, `PATCH`, `pause`, `resume` y `archive`, y `syncAll` lo corrige periódicamente. Solo se registran tareas `ACTIVE`, `enabled` y con un `EVENT` válido, en el hash de Redis `pxos:{QUEUE_NAME}-events:triggers`. `GET /tasks/:id/schedule` devuelve `event_trigger` (deseado y registrado) y `GET /scheduler/status` lista los triggers con `kind = "event"`.
- El consumidor (rol `scheduler` o `all`) recibe cada evento, busca los triggers del mismo tenant y tipo, vuelve a leer la tarea en PostgreSQL (un registro obsoleto se retira), aplica el filtro y la guardia anti-bucle y llama a `requestTaskRun` con la clave `taskrun:{task_id}:event:{event_id}`. El mismo evento entregado dos veces devuelve el `TaskRun` existente.
- El `input` del run es `default_input` más el sobre completo bajo la clave `event` (`input.event.data` es el payload).
- `POST /tasks` y `PATCH /tasks/:id` devuelven `400 invalid_schedule` si falta `event_type`, tiene un formato inválido o el filtro no es un objeto.

### Guardia anti-bucle

- Un evento sobre un run de la tarea T (`data.taskDefinitionId = T`) nunca vuelve a disparar T. Aplica a `task.*` y a `agent.execution.*`.
- Profundidad de cadena: un run que no viene de un evento tiene profundidad 0. Un run disparado por un evento tiene `event.data.chainDepth + 1`, y todos los eventos sobre ese run llevan esa profundidad en `chainDepth`. Un evento con `chainDepth >= EVENT_CHAIN_MAX_DEPTH` (por defecto 5) no dispara nada y deja un aviso en el log. Los eventos externos sin `chainDepth` cuentan como 0.

### Consulta

`GET /events` devuelve los eventos del tenant (`x-tenant-id`) como sobres, más `source`, `dispatched_at` y `dispatch_attempts`.

| Parámetro | Uso |
|---|---|
| `type` | Tipo exacto (`task.completed`) o prefijo (`task.*`) |
| `since` | ISO 8601: `occurred_at >= since` |
| `correlation_id` | Eventos de un `TaskRun` o de una ejecución |
| `limit` | 1 a 500, por defecto 50 |
| `order` | `desc` (por defecto) o `asc`, útil para sondear con `since` |

```sh
curl -s "http://127.0.0.1:4020/events?type=task.*&limit=10" -H 'x-tenant-id: publiexpe'
```

## Ejemplo end-to-end con curl

Necesitas `jq` y el runtime arrancado (`pnpm dev`).

```sh
B=http://127.0.0.1:4020
H='x-tenant-id: publiexpe'
J='Content-Type: application/json'

# 1. Crea un agente (versión 1 ACTIVE, proveedor stub)
AGENT_ID=$(curl -s -X POST $B/agents -H "$H" -H "$J" \
  -d '{"name":"Prospector","role":"prospecting","version":{"model_provider":"stub","system_prompt":"Eres el prospector de PubliEXPE"}}' \
  | jq -r .agent.id)

# 2. Crea una tarea para ese agente
TASK_ID=$(curl -s -X POST $B/tasks -H "$H" -H "$J" \
  -d "{\"name\":\"Prospeccion diaria\",\"agent_id\":\"$AGENT_ID\",\"schedule\":{\"type\":\"CRON\",\"expression\":\"0 8 * * *\"},\"default_input\":{\"query\":\"ferias 2027\"}}" \
  | jq -r .task.id)

# 3. Lanza la ejecución del slot de las 08:00 (202). Repetirla devuelve 200 y el mismo TaskRun.
RUN_ID=$(curl -s -X POST $B/tasks/$TASK_ID/run -H "$H" -H "$J" \
  -d '{"scheduled_at":"2026-10-07T08:00:00Z"}' | jq -r .task_run.id)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/tasks/$TASK_ID/run -H "$H" -H "$J" \
  -d '{"scheduled_at":"2026-10-07T08:00:00Z"}'

# 4. Consulta el TaskRun y su trace
curl -s $B/task-runs/$RUN_ID -H "$H" | jq '{status: .task_run.status, cost: .task_run.cost,
  execution: .execution.status, steps: [.trace.steps[] | {sequence, type, tool}]}'
```

Salida esperada del paso 4:

```json
{
  "status": "COMPLETED",
  "cost": 0,
  "execution": "COMPLETED",
  "steps": [
    { "sequence": 1, "type": "THINK", "tool": null },
    { "sequence": 2, "type": "TOOL", "tool": "stub.lookup" },
    { "sequence": 3, "type": "FINAL", "tool": null }
  ]
}
```

Nota: `POST /agents` devuelve `409` si el nombre ya existe en el tenant. Para repetir el ejemplo, cambia el nombre o el valor de `x-tenant-id`.

## Skills

Las skills son objetos versionados en la BD (LLD v0.1 §6.3, MVP-1, sin optimizador). Hasta el MVP-0 eran constantes de TypeScript. Ahora la fuente de verdad es la BD y las constantes quedan como fallback.

| Skill | Agente | Texto de la v1 |
|---|---|---|
| `prospector-event-exhibitors` | Prospector (evaluación de cada expositor) | `PROSPECTOR_SYSTEM_PROMPT` |
| `event-source-discovery` | Prospector, modo scout (búsqueda de ferias) | `SCOUT_SEARCH_SYSTEM_PROMPT` |
| `exhibitor-list-extraction` | Prospector, modo scout (extracción de expositores) | `SCOUT_EXTRACT_SYSTEM_PROMPT` |
| `email-first-contact-draft` | EmailDrafter | `EMAIL_DRAFTER_SYSTEM_PROMPT` |

`exhibitor-list-extraction` formaba parte de `event-source-discovery` v4 en el código; en la BD es una skill propia para poder versionarla por separado.

### Tablas

- `skills`: `id`, `tenant_id`, `name` (kebab-case, único por tenant), `description`, `domain`, `status` (`DRAFT` hasta que se activa una versión, `ACTIVE`, `DEPRECATED`), `active_version_id`, `created_at`, `updated_at`.
- `skill_versions`: `id`, `tenant_id`, `skill_id`, `version` (1, 2, 3… por skill), `status` (`DRAFT`, `ACTIVE`, `DEPRECATED`), `instructions`, `constraints`, `examples` (jsonb), `anti_patterns`, `metadata` (jsonb), `content_hash`, `activated_at`, `deprecated_at`, `created_at`, `created_by`.

Reglas que aplica la BD:

- No hay `DELETE` físico en ninguna de las dos tablas (trigger).
- El contenido de una versión es inmutable (trigger): solo cambian `status`, `activated_at` y `deprecated_at`. Para cambiar una skill, crea una versión nueva.
- Como mucho una versión `ACTIVE` por skill (índice único parcial).

El texto que se inyecta es `instructions` tal cual, seguido de `constraints`, `anti_patterns` y `examples` como secciones (`## Restricciones`, `## Antipatrones (no lo hagas)`, `## Ejemplos`) si existen. `content_hash` es el sha256 de ese texto.

### Referencias desde `agent_versions.skill_refs`

| Ref | Resolución |
|---|---|
| `{"name": "x"}` | Versión `ACTIVE` de la skill `x`, leída al arrancar cada ejecución |
| `{"name": "x", "version": 3}` | Exactamente la versión 3, sea cual sea su estado (sirve para probar un `DRAFT`) |
| `{"skill_id": "x", "version": 2}` | Ref del MVP-0 a una constante de código. No se busca en la BD: su `version` es la del código, no la de `skill_versions` |

Activar una versión no toca los agentes en marcha: las ejecuciones nuevas la recogen al resolver sus skills.

### Fallback

Si una ref no se resuelve (la skill no existe, la versión no existe, no hay versión `ACTIVE` o la BD falla), el agente usa el mismo prompt que en el MVP-0 (su `system_prompt` si no está vacío o la constante) y el runtime registra un aviso (`skill not found in the database; falling back to the code constant`). Una skill que falta no hace fallar ninguna ejecución.

> **Importante:** el código necesita la migración `0005_skills` (añade `traces.skill_versions`). Con `RUN_MIGRATIONS=true` se aplica al arrancar. Si aplicas las migraciones a mano en la BD compartida, aplica la `0005` antes de desplegar.

### Qué guarda la ejecución

`traces.skill_versions` guarda qué se inyectó exactamente (LLD P4). Cada elemento tiene `name`, `version`, `skill_version_id`, `content_hash`, `source` y `requested` (la ref de la versión del agente):

- `source: "db"`: versión de la BD (`skill_version_id` y `content_hash` del texto inyectado).
- `source: "code"`: fallback. Incluye `fallback_reason` y el texto exacto en `text`, porque las constantes no están versionadas en la BD. `version` es la versión de código de la constante.
- `source: "none"`: la ref no se resolvió y el agente no la usó.

`task_runs.skill_versions` guarda lo mismo sin `text`.

### Ciclo de vida por API

1. Crea una versión nueva a partir de la activa, cambiando lo que necesites:

   ```sh
   curl -s -X POST localhost:4020/skills/prospector-event-exhibitors/versions \
     -H 'content-type: application/json' \
     -d '{"copy_from": "active", "instructions": "…texto nuevo…", "change_reason": "Prioriza lanzamientos", "created_by": "jesus"}'
   ```

   La versión se crea en `DRAFT`. La respuesta incluye `warnings` si `instructions` no contiene la regla de contenido web no confiable (`UNTRUSTED_SYSTEM_RULE`).

1. Actívala. La versión anterior pasa a `DEPRECATED` en la misma transacción:

   ```sh
   curl -s -X POST localhost:4020/skills/prospector-event-exhibitors/versions/2/activate
   ```

1. Para volver atrás, depreca la versión activa. Se reactiva la versión anterior con número menor que se activó más recientemente:

   ```sh
   curl -s -X POST localhost:4020/skills/prospector-event-exhibitors/versions/2/deprecate
   ```

   Si no hay ninguna versión anterior que restaurar, la llamada devuelve `409`. También puedes activar directamente una versión `DEPRECATED`.

Las transiciones son idempotentes: repetir `activate` o `deprecate` devuelve `200` con `changed: false`.

## Tools

Capa de tools del LLD v0.2 (secciones 5.2, 5.7 y 10). Los agentes no llaman a Twenty directamente: reciben un `AgentToolbox` (`ctx.tools`) que solo ejecuta las tools permitidas por la versión del agente.

### Contrato

Cada tool (`src/tools/types.ts`) declara `id` (snake_case, el que se usa en la allowlist), `name`, `version`, `description`, `inputSchema` y `outputSchema` (zod), `riskLevel`, `sideEffects`, `approvalPolicy`, `permissions`, `timeoutMs`, `outputTrust` y `enabled`. `toToolSpec()` exporta el `inputSchema` a JSON Schema para el proveedor LLM.

Clases de riesgo: `READ`, `LOW_WRITE`, `HIGH_WRITE`, `EXTERNAL_SIDE_EFFECT` y `DESTRUCTIVE`.

El `ToolRegistry` rechaza al registrar:

- ids que no son snake_case o que ya existen;
- **cualquier tool `DESTRUCTIVE`**, aunque declare `NEVER_AUTONOMOUS`;
- tools con efectos de `HIGH_WRITE` o superior sin `approvalPolicy`.

### Tools disponibles

Las de Twenty usan `TWENTY_BASE_URL` y `TWENTY_API_KEY` y tienen `outputTrust = trusted`. `fetch_url` y `render_url` leen la web y su salida es `untrusted`.

| Tool | Riesgo | Efectos | Idempotencia |
|---|---|---|---|
| `find_company` | `READ` | No | — |
| `get_company` | `READ` | No | — |
| `upsert_company` | `LOW_WRITE` | Sí | Por dominio normalizado: `publi:company:create:domain:{domain}` |
| `create_signal` | `LOW_WRITE` | Sí | Empresa + tipo + `eventDate` + `sourceDomain` |
| `create_research` | `LOW_WRITE` | Sí | Ejecución + empresa + `researchType` |
| `create_hypothesis` | `LOW_WRITE` | Sí | Empresa + `name` (por defecto `{empresa} — {need}`) |
| `create_agent_run_summary` | `LOW_WRITE` | Sí | `agentExecutionId` |
| `get_hypothesis` | `READ` | No | — (hipótesis con empresa, señal y decision maker, `depth=1`) |
| `create_note` | `LOW_WRITE` | Sí | Empresa + título; adopta una nota huérfana con el mismo título |
| `get_note` | `READ` | No | — (título y markdown de una nota; salida `untrusted`) |
| `update_note` | `LOW_WRITE` | Sí | Solo añade líneas al final; las que ya están (coincidencia exacta) se omiten. Nunca edita ni borra contenido |
| `fetch_url` | `READ` | No | — (consulta [Seguridad del contenido web](#seguridad-del-contenido-web)) |
| `render_url` | `READ` | No | — (consulta [Render de JavaScript](#render-de-javascript-render_url)) |

`create_signal` acepta `companyId` opcional: sin él crea una **señal a nivel de evento** (una feria sin empresa asociada todavía), deduplicada entre las señales sin empresa por tipo + `eventDate` + `sourceDomain`.

Los objetos de la App no tienen campo `idempotencyKey`, así que cada tool de escritura busca primero un registro con su clave natural. Si existe, devuelve `created: false` y el registro existente en vez de crear un duplicado. Todos los `create_*` escriben `tenantId` (el tenant de la ejecución, `publiexpe` por defecto) y aceptan `companyId` y, según el objeto, `signalId` o `decisionMakerId`.

`upsert_company` nunca sobrescribe una empresa existente: los datos que edita el equipo comercial prevalecen. Si pierde una carrera contra otra escritura (Twenty tiene un índice único sobre `domainName`), devuelve la empresa ganadora.

### Política de tools del agente

La allowlist vive en `configuration.tool_policy` de la `agent_version`. Sin `tool_policy`, el agente no puede usar ninguna tool.

```json
{ "tool_policy": ["find_company", "upsert_company", "create_signal"] }
```

Forma completa (también acepta camelCase):

```json
{
  "tool_policy": {
    "allow": ["find_company", "upsert_company", "create_signal"],
    "max_calls_per_execution": 60,
    "max_calls_per_tool": { "upsert_company": 20 },
    "max_risk_level": "LOW_WRITE"
  }
}
```

El techo de riesgo por defecto es `LOW_WRITE` y nunca puede ser `DESTRUCTIVE`.

### Ejecución y trace

El `ToolExecutor` (uno por ejecución) aplica, en orden: allowlist, registro, `enabled`, techo de riesgo, límites de llamadas, validación de entrada, timeout y validación de salida. Cada llamada, incluidos los rechazos, genera un paso `TOOL` en el trace con `tool`, `tool_input`, `tool_output`, `output` (`status`, `riskLevel`, `sourceTrust`, `idempotencyKey`) y, si falla, `error.code`:

| Código | Causa |
|---|---|
| `TOOL_NOT_ALLOWED` | Fuera de la allowlist, por encima del techo de riesgo o `DESTRUCTIVE` |
| `TOOL_NOT_FOUND` / `TOOL_DISABLED` | No registrada o deshabilitada |
| `TOOL_CALL_LIMIT` | Superado `max_calls_per_execution` o `max_calls_per_tool` |
| `INVALID_INPUT` / `INVALID_OUTPUT` | No cumple el esquema zod |
| `TOOL_TIMEOUT` / `TOOL_ERROR` | Timeout de la tool o excepción |
| `TWENTY_*` | Error de Twenty (`TWENTY_NOT_CONFIGURED`, `TWENTY_BAD_REQUEST`, `TWENTY_RATE_LIMITED`...) |

### TwentyClient

`src/integrations/twenty/client.ts` es un cliente REST tipado sobre `/rest/{objeto}` con `list`, `get`, `create`, `update`, `ping` y `health` (`GET /healthz`, sin API key, para la espera al arrancar). **No tiene método de borrado.**

- Timeout por petición (`TWENTY_TIMEOUT_MS`) combinado con la cancelación de la ejecución.
- Reintentos con backoff exponencial para `429` y `5xx`; respeta `Retry-After`.
- Los errores de red y los timeouts solo se reintentan en `GET`. Un `POST` ambiguo no se repite a ciegas: la tool vuelve a buscar antes de crear.
- La API key no aparece en logs, errores ni trace.

Formas de campo verificadas contra Twenty 2.45:

| Tipo | Forma en la API REST |
|---|---|
| `LINKS` | `{ primaryLinkUrl, primaryLinkLabel, secondaryLinks: [] }`. En `Company.domainName`, Twenty quita el esquema al guardar (`https://acme.com` → `acme.com`) |
| `CURRENCY` | `{ amountMicros, currencyCode: "EUR" }`, con 1 EUR = 1 000 000 micros |
| `SELECT` | Valor en MAYÚSCULAS; cualquier otro valor devuelve `400` |
| `DATE` / `DATE_TIME` | `YYYY-MM-DD` / ISO 8601 |
| `ARRAY` / `RAW_JSON` | `string[]` / JSON libre |
| `RELATION` N:1 | Columna de unión: `companyId`, `commercialSignalId`, `decisionMakerId` |

### Probar una tool real con SmokeAgent

`SmokeAgent` (`configuration.implementation = "smoke"`) no usa LLM: ejecuta la lista `input.tool_calls` con el executor real. Un valor `{ "$ref": "0.company.id" }` toma el resultado de una llamada anterior.

```sh
AGENT_ID=$(curl -s -X POST $B/agents -H "$H" -H "$J" -d '{"name":"Smoke tools","version":{"configuration":
  {"implementation":"smoke","tool_policy":["upsert_company","create_signal"]}}}' | jq -r .agent.id)

curl -s -X POST $B/executions -H "$H" -H "$J" -d "{\"agent_id\":\"$AGENT_ID\",\"input\":{\"tool_calls\":[
  {\"tool\":\"upsert_company\",\"input\":{\"domain\":\"test-smoke.example\",\"name\":\"[TEST] Smoke\"}},
  {\"tool\":\"create_signal\",\"input\":{\"companyId\":{\"\$ref\":\"0.company.id\"},\"title\":\"[TEST] Smoke\",
   \"signalType\":\"OTHER\",\"sourceUrl\":\"https://test-smoke.example\",\"confidence\":0.5}}]}}"
```

El `StubAgent` sigue usando su tool simulada (`stub.lookup`), que no pasa por el registry.

## Prospector

`ProspectorAgent` (`configuration.implementation = "prospector"`) evalúa los expositores de un evento y propone hipótesis de merchandising para PubliEXPE. Tiene dos modos, que elige por la forma de la entrada:

| Modo | Entrada | Tarea | Qué hace |
|---|---|---|---|
| Directo | `{ event, exhibitors[] }` | `daily-event-prospecting` | Evalúa los expositores ya extraídos (fixture de demo) |
| Scout | `{ sector, region?, horizon_months? }` o `{ event_url }` | `weekly-event-scouting` | Busca ferias reales, descarga su página de expositores y evalúa los expositores reales. Consulta [Modo scout](#modo-scout-ferias-reales) |

El modo scout es un modo del mismo agente, no un agente hermano: el LLD v0.2 asigna al Prospector tanto el descubrimiento de eventos (`search_web`, `fetch_url`, `render_url`) como la evaluación de expositores, y así los dos modos comparten versión, prompt de evaluación, pipeline por expositor, tool policy y trazas.

### Entrada

```json
{
  "event": { "name": "Expo Alimentaria Ibérica 2026", "type": "FAIR", "date": "2026-11-24",
             "location": "Madrid (IFEMA)", "source_url": "https://expoalimentariaiberica.example/expositores" },
  "exhibitors": [{ "name": "Conservas Marineras del Cantábrico", "domain": "conservasdelcantabrico.example",
                   "sector": "Alimentación gourmet", "description": "..." }]
}
```

- `event.type` es un `signalType` de Twenty (`FAIR`, `CONGRESS`, `EVENT`...). También acepta `feria`, `congreso` y `evento`.
- `date` es `YYYY-MM-DD`. Entre 1 y 50 expositores; `domain`, `description` y `sector` son opcionales.

### Flujo por expositor

1. Una llamada al LLM con salida JSON estructurada (`responseJsonSchema`), validada con zod. Si la respuesta no es válida, se hace **un** reintento con el error de validación en el prompt.
1. El modelo decide `relevant`, `confidence` (0-1) y `reason`. Si es relevante, genera la hipótesis: `need`, `why_now`, `quantity_min/max`, `budget_min_eur/max_eur`, `recommended_products` (genéricos, aún sin catálogo), `timing` y los diferenciales de PubliEXPE que aplican.
1. Si `relevant` y `confidence >= min_confidence` (por defecto `0.5`):
   - `upsert_company` por dominio. Sin dominio, solo reutiliza una empresa con el mismo nombre exacto (`find_company`); nunca crea una empresa sin dominio verificado.
   - `create_signal`: el evento, con su `signalType`, `status = NEW` y la confianza.
   - `create_hypothesis` con `status = PROPOSED` y nombre `{empresa} — {evento}`, para que repetir el mismo evento no duplique la hipótesis.
1. Al final, **siempre**, `create_agent_run_summary` con `outcome` (`SUCCESS`, `PARTIAL` si algún expositor falló, `FAILED` si fallaron todos o la entrada no es válida), un `resultSummary` en español con contadores y el coste real del modelo en EUR.

Un error en un expositor (modelo o Twenty) no detiene la ejecución: queda en `output.results[]` y cuenta como error. El agente devuelve su resultado aunque el `outcome` sea `FAILED`, para que el trace conserve todos los pasos y el coste; el estado de negocio está en `output.outcome` y en el `agentRunSummary` de Twenty.

### Modo scout (ferias reales)

Entrada (`ScoutInput`):

```json
{ "sector": "alimentación y bebidas", "region": "España", "horizon_months": 6 }
{ "event_url": "https://www.gastronoma.es", "event_name": "Mediterránea Gastrónoma 2026" }
```

`max_events` (1-3), `max_exhibitors` (1-200), `max_catalog_pages` (1-20), `max_profile_lookups` (0-100) y `scout_time_budget_ms` (10 000-1 500 000) bajan los límites de la configuración para una ejecución; nunca los suben. Se elige este modo si `mode = "scout"` o si la entrada tiene `sector` o `event_url` y no tiene `event` ni `exhibitors`.

Flujo:

1. **Búsqueda con grounding** (solo con `sector`): una llamada a Gemini con la tool nativa `google_search`. El modelo devuelve hasta `max_events` ferias con `website_url` y `exhibitors_url`. Se descartan las que caen fuera del horizonte.
1. **Verificación de las URL** antes de descargarlas:
   - si el grounding devuelve fuentes, solo se descargan URL cuyo dominio está en esas fuentes (si una fuente solo trae la URL de redirección de `vertexaisearch`, se resuelve con `fetch_url` para conocer su dominio);
   - si el modelo ejecutó búsquedas pero la API no devolvió fuentes (comportamiento observado con `gemini-3.8-flash` el 2026-10-07), la URL se descarga y **la página tiene que corroborar la feria** (el nombre aparece en el dominio o en el título y el texto); si no, se descarta sin escribir nada. `scout.verify_unsourced_by_fetch = false` desactiva esta vía (modo estricto);
   - con `event_url`, la URL la da el operador.
1. **Lectura de cada página** de la feria (la de expositores; o la portada y, después, el enlace de expositores que aparezca entre sus enlaces), en tres pasos:
   1. **`fetch_url`**. Lee HTML, texto y **PDF** (si la URL de expositores es directamente un PDF, se lee su texto). Si la página es el esqueleto vacío de una app JavaScript (`js_app_likely` y menos de 200 caracteres), no se gasta una llamada al LLM en ella (`code: JS_APP_SHELL`).
   1. **`render_url`** si la página parece una app JavaScript (`js_app_likely`: poco texto, mucho script, punto de montaje de SPA vacío o aviso `<noscript>`) o si la extracción no da expositores y no hay un enlace de expositores que seguir antes (o el modelo la clasifica como lista de expositores). El texto renderizado pasa por la misma extracción. El scout pide al renderer `min_text_chars = 300` (espera a que la app pinte su contenido y deje de crecer); si el render vuelve casi vacío (menos de 200 caracteres: la app no hidrató a tiempo), lo repite **una** vez con `wait_ms = 8000`, `wait_until = networkidle` y `min_text_chars = 400`, si queda presupuesto. Si sigue vacío, no se llama al LLM sobre él (`code: RENDER_EMPTY`) y el motivo de la señal de feria lo indica. Los enlaces de la página renderizada también sirven para seguir al enlace de expositores (cadena real de Gastrónoma: `gastronoma.es` → app del catálogo en `apps.feriavalencia.com` → `/exhibitors`). Si el renderer no está desplegado (`RENDERER_NOT_CONFIGURED`) o `render_url` no está en la tool policy, el render se desactiva para toda la ejecución y el flujo sigue sin él.
   1. **PDF de catálogo enlazados**: hasta `max_pdfs_per_event` enlaces a `.pdf` de la página (estática o renderizada) cuyo texto o URL sugiere catálogo o listado (`expositores`, `exhibitors`, `catálogo`, `listado`, `participantes`, `marcas`, `directorio`, `plano`…) se descargan con `fetch_url` y se extraen también, aunque la página ya haya dado expositores.

   Máximo `max_pages_per_event` páginas por feria (sin contar renders ni PDF enlazados), `max_fetches` descargas y `max_renders` renders por ejecución.
1. **Paginación del listado hasta el final**, hasta `max_catalog_pages` páginas (10 por defecto, tope 20; Gastrónoma tiene 5 de 20 expositores):
   - **en el cliente**: si la URL renderizada parece un listado (`expositores`, `exhibitors`, `catalog`, `directorio`, `participantes`, `empresas`, `marcas`, `listado`…), el scout pide al renderer `maxPages`. El renderer pulsa el control "siguiente" del paginador y devuelve todas las páginas en un solo `render_url` (consulta [Paginación](../../services/renderer/README.md#paginación)). Es el caso de Gastrónoma: los botones no son enlaces y la URL no cambia. El renderer para antes si no encuentra el control, si la lista no cambia o si la página nueva no aporta ninguna línea nueva (`pagination_stop` en la página leída);
   - **por enlaces**: si no, el scout sigue los enlaces de la misma ruta que solo cambian un parámetro de página (`?page=2`, `offset`, `start`…), los segmentos `/page/2` o los enlaces "Siguiente"/"Next", y lee cada página igual que la primera (`fetch_url` o `render_url`). **Parada temprana**: la primera página sin expositores nuevos termina la paginación (`pagination_stop = no_new_exhibitors`).

   Un renderer sin `max_pages` ignora el parámetro y el scout sigue con la primera página. Un renderer anterior a pxos-renderer 0.2 (máximo 5 páginas) responde `INVALID_INPUT` a `max_pages` mayor: el scout repite el render con 5.
1. **Atajo de la API JSON** (`scout.capture_json`, activo por defecto): los renders de catálogo piden `captureJson`. Si entre las respuestas JSON capturadas (mismo origen que la página, como máximo 5 de 200 KB) hay una lista de expositores, es la **fuente preferente**: da la lista completa, también más allá de las páginas renderizadas, sin llamada de extracción al LLM. Consulta [Atajo de la API JSON](#atajo-de-la-api-json).
1. **Extracción**: el LLM extrae `{name, domain?, description?, sector?}` solo del texto leído (HTML, página renderizada o PDF; el prompt indica el tipo). Un listado renderizado de varias páginas se extrae en **trozos de hasta 5 páginas** (una llamada por trozo, unos 100 expositores; cada expositor se extrae una sola vez). Si un trozo después del primero no aporta expositores nuevos, no se extraen los siguientes (`pagination_stop = no_new_exhibitors`). El código descarta los nombres que no aparecen en **ese** texto y los dominios que no están en su texto o sus enlaces (ni el de la propia feria ni redes sociales). Los expositores de varias páginas de la misma feria se fusionan sin duplicados (por nombre), hasta `max_exhibitors_per_event` (100 por defecto, tope 200).
1. **Evaluación con el LLM de todos los expositores**, antes de escribir nada (`decideExhibitor`): relevancia, confianza e hipótesis, igual que en el modo directo.
1. **Fichas de los relevantes sin dominio**: solo los que se van a escribir (relevantes y con confianza ≥ `min_confidence`), de mayor a menor confianza, hasta `max_profile_lookups` por ejecución (60 por defecto, tope 100; el límite real lo pone el presupuesto de tiempo), `profile_concurrency` a la vez (2, los renders simultáneos del renderer). Para cada uno:
   1. La ficha es el enlace de la lista cuyo texto es el nombre del expositor, en el mismo sitio que la lista (Gastrónoma: `/catalog/gastronoma/exhibitors/{id}`). Con la lista de la API JSON, si el expositor no salió en las páginas renderizadas, la URL se construye con la plantilla aprendida de los enlaces (`profile.url_source = json_template`). Sin enlace: `profile.status = no_profile_link`.
   1. Se lee con `fetch_url`; si es una app JavaScript (o su host ya dio un esqueleto JS en esta ejecución), se renderiza directamente con `render_url`. Los renders de fichas no gastan `max_renders`.
   1. La ficha tiene que ser del expositor: su nombre aparece antes de secciones como "Empresas similares" (`profile_mismatch` si no).
   1. La web es, por orden: el valor junto a la etiqueta "Web", "Website", "Sitio web" o "Página web"; el único enlace externo de la ficha; o el único dominio `www.` del texto. Nunca vale el dominio de la propia feria (web del evento, host del catálogo y páginas leídas, por dominio registrable), las redes sociales ni las plataformas genéricas (`gmail.com`, `linktr.ee`…). Facebook, Instagram, LinkedIn, X, YouTube, TikTok y Pinterest se guardan en `profile.social` como metadato.
   1. El dominio tiene que resolver a IP públicas: `fetch_url` de `https://{dominio}/` con las mismas guardas SSRF. `DNS_ERROR`, `SSRF_BLOCKED` o `URL_NOT_ALLOWED` lo rechazan (`domain_rejected`). Un 403 de un WAF, un error TLS o un timeout ocurren después de la comprobación de DNS y no lo rechazan.
1. **Presupuesto de tiempo** (`scout.time_budget_ms`, 20 min por defecto; consulta [Presupuesto de tiempo](#presupuesto-de-tiempo)): se comprueba antes de cada página, render, extracción, evaluación y ficha.
1. **Pipeline por expositor** (`writeExhibitor`), el mismo del modo directo, con `source_url` = la página de la que sale cada expositor (página de expositores, página renderizada o PDF), siempre una URL visitada. Con el dominio de la ficha se crea o reutiliza la empresa por dominio, y la hipótesis añade la evidencia "Web … tomada de la ficha del expositor" con la URL de la ficha. Sin dominio después de intentar la ficha, sigue como antes: `skipped_no_domain`.
1. **Sin lista de expositores** (catálogo ilegible, página vacía, renderer no disponible): la feria se registra como señal `FAIR` a nivel de evento (`create_signal` sin `companyId`, con la URL visitada) y el `outcome` es `PARTIAL` con el motivo en `partial_reasons` y en el `agentRunSummary` (incluye `render JavaScript no disponible (…)` cuando el render se necesitaba y no se pudo hacer).

`outcome`: `FAILED` si falla la búsqueda o todos los expositores; `PARTIAL` si hay errores, ninguna feria verificable o alguna feria sin lista de expositores; `SUCCESS` en otro caso. La salida incluye `events[]` (páginas leídas con `via` = `fetch` | `render` | `pdf`, `content_kind`, `js_app_likely`, expositores extraídos y verificados por página; verificación; expositores descartados), `discarded_events[]` con el motivo, `sources` (URL visitadas y fuentes de grounding), `render` (`calls`, `ok`, `retries`, `max`, `disabled` con el motivo si se desactivó), los contadores `fetches`, `renders`, `renders_ok`, `render_retries`, `pdfs_read`, `catalog_pages` (páginas del listado de las que salen expositores), `profile_lookups` (fichas abiertas), `profile_renders`, `domain_checks` y `domains_resolved` (dominios obtenidos de la ficha), `profiles` (resumen y límites), `profile` en cada resultado (`url`, `status`, `via`, `domain`, `domain_source`, `social`, `error`) y el coste de búsqueda.

El catálogo JavaScript de Gastrónoma lista nombres, sector y país, pero no la web de cada expositor: está en su ficha (`/exhibitors/{id}`, etiqueta "Website"). Hasta la tanda 4 el scout solo leía la primera página (20 de 91) y los relevantes acababan como `skipped_no_domain`. La tanda 5 leía 3 páginas (60) y 20 fichas. Ahora lee el catálogo entero (o su API JSON) y abre las fichas de los relevantes mientras quede tiempo.

#### Atajo de la API JSON

Muchos catálogos SPA descargan la lista completa como JSON y la paginan en el navegador. En Feria Valencia es `POST https://apps.feriavalencia.com/api/puisearch` (sesión anónima de la propia app): devuelve los 91 expositores de Gastrónoma en una respuesta de 52 KB con `name`, `exhibitor` (id), `country`, `province` y `sectorsname`, sin web.

`src/agents/catalog-json.ts` busca, entre las respuestas capturadas con el render, el array que es la lista de expositores:

- array de al menos 3 objetos con un campo de nombre (`name`, `nombre`, `companyName`, `*name`…; nunca `country`, `province`, `sector`…) presente en el 80 % y con valores distintos;
- el que tiene más nombres en el texto de la página renderizada (la página muestra al menos su primera página de expositores), con un mínimo de 3. Las listas de provincias, sectores o países de las mismas respuestas no ganan;
- de cada elemento toma `name` (sin HTML, entidades decodificadas) y, si existen, la web (`web`, `website`, `url`…) como dominio, la descripción, el sector y el id.

Con la lista, el scout:

- la valida igual que una página: los nombres se comprueban contra el contenido JSON, el dominio tiene que estar en él y nunca puede ser el de la feria ni una red social;
- cita como fuente la página del listado renderizada (visitada, en el `SourceLedger`), nunca la URL de la API; la salida guarda la API usada en `events[].json_api` y `events[].catalog_source = json_api`;
- no hace la extracción con el LLM del listado. Si aún no conoce el nombre o la fecha de la feria, hace una extracción sobre los primeros 6 000 caracteres de la página;
- aprende la plantilla de URL de las fichas a partir de al menos 2 enlaces cuyo texto es un nombre de la lista y cuya URL contiene su id, y la aplica a los expositores que no salieron en las páginas renderizadas.

El JSON es contenido web **no confiable** como cualquier página: no se ejecuta nada, sus textos solo llegan al LLM dentro de bloques `DATOS_NO_CONFIABLES` (evaluación) y las URL que se escriben en Twenty pasan por el `SourceLedger`. Sin captura (renderer anterior, `scout.capture_json = false` o ninguna lista reconocible), el flujo es el de antes: extracción del texto renderizado.

#### Presupuesto de tiempo

`scout.time_budget_ms` (20 min por defecto; tope 25 min, el timeout de 30 min de `weekly-event-scouting` menos 5 min para las escrituras y el resumen) gobierna toda la ejecución desde su inicio. La entrada `scout_time_budget_ms` puede bajarlo. El agente no recibe el timeout de la tarea: una tarea con un timeout menor necesita un `time_budget_ms` menor.

Se comprueba antes de cada feria, página, render, extracción, evaluación y ficha. Al agotarse, la ejecución se corta limpia donde esté:

- lo ya evaluado se escribe igualmente en Twenty: las escrituras no se cortan y no se pierde ninguna evaluación pagada;
- los expositores leídos y no evaluados cuentan en `exhibitors_not_evaluated` (`events[].not_evaluated` guarda los 50 primeros nombres);
- las fichas no abiertas quedan con `profile.status = time_budget_exhausted` y el expositor como `skipped_no_domain`; se cuentan en `profiles_skipped_time_budget`;
- una feria de la que aún no se leyó ningún expositor queda en `status = time_budget_exhausted` y no se escribe nada para ella (ni la señal de feria sin lista, que sería engañosa);
- el `outcome` es `PARTIAL` con el motivo `presupuesto de tiempo agotado (N min, en la fase de …)` y los contadores de lo conseguido. `output.time_budget` guarda `budget_ms`, `elapsed_ms`, `exhausted` y la fase.

El corte llega en el siguiente punto de control: una ficha en curso (10-15 s) o un render de catálogo (hasta 60 s) terminan antes.

El `agentRunSummary` pone primero los totales, el tiempo, el coste y los motivos, y después una línea por expositor: con un catálogo entero, las líneas por expositor superan los 4 000 caracteres del resumen y antes desplazaban los totales.

Prueba en vivo del catálogo completo (2026-10-07, `event_url = https://www.gastronoma.es`, Gemini y Twenty reales, pxos-renderer 0.2 en Docker, configuración por defecto): un render de 5 páginas (19 s, `pagination_stop = not_changed`) con la lista tomada de la API JSON (`POST /api/puisearch`, 91 de 91 nombres en la página, sin extracción del listado con el LLM); 91 expositores evaluados, 87 relevantes, 60 fichas abiertas (2 a la vez; las 22 restantes quedaron fuera por `max_profile_lookups`, no por tiempo), 29 dominios obtenidos: 23 empresas nuevas en Twenty con señal `FAIR` e hipótesis `PROPOSED` y 6 ya existentes (5 de ellas ya `VALIDATED` por un comercial). 93 llamadas al LLM, 0,195 €, 16,4 min de 20 (lectura 43 s, evaluación 7,5 min, fichas 7,1 min, escrituras 1,1 min).

Prueba anterior (2026-10-07, tanda 5, renderer en Docker): 3 páginas de catálogo, 60 expositores evaluados, 56 relevantes, 10 fichas abiertas (las de mayor confianza), 6 dominios obtenidos y 6 empresas creadas en Twenty con señal `FAIR` e hipótesis `PROPOSED`. Las otras 4 fichas no publican web (`no_website`). Coste: 0,139 € (63 llamadas al LLM), unos 8 minutos.

#### Coste esperado por feria

Con la configuración por defecto (`max_catalog_pages` 10, `max_exhibitors_per_event` 100, `max_profile_lookups` 60, presupuesto de 20 min, `gemini-flash-latest` con `thinking_level = low`), para un catálogo de unos 90 expositores como Gastrónoma:

| Paso | Llamadas | Coste |
|---|---|---|
| Lectura de la feria (portada, catálogo y listado entero en un solo render) | 3 `fetch_url`, 2 `render_url`, 1-2 extracciones con el LLM (con la API JSON, la del listado no se hace) | ~0,01 € |
| Evaluación con el LLM de cada expositor | ~90 llamadas | ~0,002 € cada una, ~0,2 € |
| Fichas de los relevantes | hasta 60 `render_url` (o `fetch_url`) + otras tantas `fetch_url` de comprobación del dominio, 2 a la vez | 0 € de modelo; unos 10-12 s por ficha renderizada |
| Escritura en Twenty | 3 llamadas por expositor escrito | 0 € |
| **Total por feria** | | **~0,2-0,25 €** (en modo `sector`, la búsqueda con grounding suma ~0,10 €) |

El coste de modelo crece con los expositores evaluados, no con las páginas: cada expositor se extrae una vez (por trozos de 5 páginas, o ninguna con la API JSON) y se evalúa una vez. La ejecución semanal (`max_events` 3) con tres catálogos de 100 expositores puede llegar a unos 0,7 €; el presupuesto de tiempo la acota. Para bajar el coste, reduce `max_exhibitors_per_event` (cada expositor evaluado cuesta unos 0,002 €). Las fichas no tienen coste de modelo, solo tiempo: el presupuesto de tiempo decide cuántas se abren.

### Seguridad del contenido web

Regla del LLD v0.1 §22 y v0.2 §10.4: `WEB CONTENT ≠ INSTRUCTIONS`.

- **Separación de canales.** El contenido web (páginas descargadas, respuesta de la búsqueda, datos extraídos de ellas) entra **solo** en mensajes `user`, nunca en `systemInstruction`.
- **Delimitación.** Siempre va dentro de un bloque `<<<DATOS_NO_CONFIABLES id=… origen="…">>> … <<<FIN_DATOS_NO_CONFIABLES id=…>>>` con un id aleatorio por bloque, precedido de la instrucción de ignorar cualquier orden que contenga. Las secuencias que imitan los marcadores se neutralizan, así que el contenido no puede cerrar el bloque. Los prompts de sistema (texto fijo, de confianza) repiten la regla.
- **El modelo no elige tools.** El código decide qué tool llamar y con qué argumentos; el modelo solo devuelve JSON validado con zod. Una instrucción inyectada no puede provocar una llamada.
- **Fuentes verificadas.** Todo `sourceUrl` que se escribe en Twenty se comprueba contra el registro de fuentes de la ejecución (`SourceLedger`): URL visitadas por `fetch_url` o `render_url`, o devueltas por el grounding. Las URL propuestas por el modelo solo se descargan si su dominio está respaldado por el grounding, si son enlaces de una página ya descargada o, sin fuentes, si la página corrobora la feria. Los textos libres que van a Twenty (descripción, necesidad, por qué ahora, evidencias) pierden cualquier URL que no sea una fuente conocida (`[enlace omitido]`).
- **Elementos ocultos.** `fetch_url` elimina `script`, `style`, `template`, `svg`, `iframe` y los elementos con `hidden`, `aria-hidden="true"` o `display:none`, vehículos habituales de inyección. El renderer hace lo mismo sobre el DOM final (`innerText` ya excluye lo que no se ve).
- **Mismas reglas para todo el texto.** El texto de un PDF o de una página renderizada entra igual que el HTML: en bloques `DATOS_NO_CONFIABLES`, sin elegir tools, con la verificación de nombres y dominios contra esa misma página y con el `SourceLedger`.

Controles de egreso de `fetch_url` (protección SSRF), aplicados a la primera petición **y a cada redirección**:

| Control | Valor |
|---|---|
| Esquemas | Solo `http` y `https`; sin credenciales en la URL |
| Puertos | `FETCH_URL_ALLOWED_PORTS` (por defecto 80, 443, 8080, 8443) |
| Hosts | Allowlist y denylist (`FETCH_URL_ALLOWLIST`, `FETCH_URL_DENYLIST`); siempre bloqueados `localhost`, `*.local`, `*.internal`, `metadata.google.internal` y nombres de una sola etiqueta |
| DNS | **Todas** las IP resueltas deben ser públicas. Se rechazan loopback, privadas, link-local (169.254.169.254 incluida), CGNAT, multicast, documentación, benchmark y reservadas, también incrustadas en IPv6 (`::ffff:`, NAT64, 6to4, Teredo) |
| Rebinding | El socket se conecta a la IP ya comprobada (`lookup` fijado): no hay segunda resolución DNS |
| Redirecciones | Máximo 3 |
| Tiempo | 15 s en total |
| Tamaño | 2 MB, contado tras descomprimir (gzip, deflate, br) |
| Texto devuelto | 40 000 caracteres como máximo; también título y enlaces absolutos |
| Tipos | Texto (HTML, XHTML, XML, JSON, `text/*`) y **PDF** (`application/pdf` o firma `%PDF-`, también como `application/octet-stream`). El resto devuelve `UNSUPPORTED_CONTENT_TYPE` |
| PDF | Texto extraído en memoria con `unpdf` (PDF.js sin binarios nativos, sin `eval`, sin fuentes del sistema ni peticiones externas), máximo 300 páginas, dentro de los mismos 2 MB / 40 000 caracteres / 15 s. Salida con `content_kind = "pdf"`, `pdf_pages`, título de los metadatos y enlaces `http(s)` de las anotaciones |
| Detección de app JS | `js_app_likely` en las páginas HTML: poco texto visible con scripts, mucho más script que texto, punto de montaje de SPA vacío (`#app`, `#root`, `app-root`…), aviso `<noscript>` de JavaScript o marcadores de framework con poco texto |
| Cabeceras | `User-Agent: PubliexpeCommercialOS/0.1` (solo ASCII: un carácter no ASCII provocaba 403 en ifema.es y alimentaria.com), sin cookies ni cabeceras de autenticación |

Códigos de error de `fetch_url`: `URL_NOT_ALLOWED`, `REDIRECT_NOT_ALLOWED`, `SSRF_BLOCKED`, `DNS_ERROR`, `TOO_MANY_REDIRECTS`, `FETCH_TIMEOUT`, `HTTP_ERROR`, `UNSUPPORTED_CONTENT_TYPE`, `NETWORK_ERROR`, `PDF_UNREADABLE`, `PDF_ENCRYPTED` y `PDF_TOO_LARGE` (PDF cortado por el límite de 2 MB que no se puede leer).

### Render de JavaScript (`render_url`)

`render_url` no ejecuta un navegador en el runtime: llama por HTTP al servicio interno `pxos-renderer` (`services/renderer/`, Playwright + Chromium en su propio contenedor), así que la imagen del runtime no crece. Consulta [services/renderer/README.md](../../services/renderer/README.md) para la API, los controles de seguridad del navegador y la integración en Docker.

| Aspecto | Comportamiento |
|---|---|
| Destino | `RENDERER_URL` + `/render` (por defecto `http://pxos-renderer:3000`, dentro de `pxos-net`). Es configuración de confianza: no pasa por la guarda SSRF |
| Antes de llamar | La URL a renderizar pasa `checkUrl` con la misma política de hosts que `fetch_url` (esquema, credenciales, puertos, allow/denylist, nombres internos, IP literales). El renderer repite la comprobación con DNS y la aplica a cada petición del navegador |
| Entrada | `url`, y opcionales `waitMs`, `maxChars`, `minTextChars` (espera de hidratación), `waitUntil` (`domcontentloaded`, `load`, `networkidle`), `maxPages` (1-20, paginación en el cliente) y `captureJson` (respuestas JSON de la página) |
| Respuesta | Validada con zod: texto recortado a 40 000 caracteres, título, hasta 200 enlaces `http(s)`, `finalUrl` comprobada otra vez con `checkUrl`, `content_kind = "rendered"`, `renderMs`, `hydrated`, `pagesRead` y `pageUrls` (también comprobadas con `checkUrl`), `paginationStop` y, con `captureJson`, `jsonResponses` (otra vez filtradas aquí: mismo origen que `finalUrl`, `checkUrl`, 200 KB y 5 como máximo) y `jsonSkipped` (con `refused_here`). Hasta 600 enlaces; los que tienen la misma URL se fusionan conservando el primer texto no vacío |
| Tiempo | 25 s de JavaScript en el renderer, más 3 s por página adicional de `maxPages` (máximo 60 s); 40 s de espera en el cliente, más lo mismo (`RENDER_TIMEOUT`) |
| Sin renderer | `RENDERER_URL` vacío u `off`, o el servicio no responde (DNS, conexión rechazada): `RENDERER_NOT_CONFIGURED`. El scout lo trata como "sin render" y sigue |

Códigos de error de `render_url`: `RENDERER_NOT_CONFIGURED`, `INVALID_URL`, `URL_NOT_ALLOWED`, `REDIRECT_NOT_ALLOWED`, `RENDER_TIMEOUT`, `RENDERER_BAD_RESPONSE` y los del renderer (`SSRF_BLOCKED`, `NAVIGATION_BLOCKED`, `DOWNLOAD_BLOCKED`, `HTTP_ERROR`, `RENDERER_BUSY`…).

### Trace y coste

Cada llamada al LLM es un paso `MODEL` con `model` (el modelo real que respondió, por ejemplo `gemini-3.8-flash`), tokens y `output.cost` (`amount`, `currency` y, con grounding, `grounding` y `grounding_units`). La llamada con búsqueda guarda además `output.grounding` (consultas, fuentes, `source_trust = untrusted`). Cada tool es un paso `TOOL` con `output.costEur`. `AgentExecution.model_cost` y `TaskRun.cost` acumulan el coste del proveedor en USD; `output.cost.eur` y el `agentRunSummary` lo convierten a EUR con `configuration.usd_to_eur` (por defecto `0.86`).

### Configuración de la versión

| Clave de `configuration` | Por defecto | Uso |
|---|---|---|
| `implementation` | — | `prospector` |
| `tool_policy` | — | `find_company`, `upsert_company`, `create_signal`, `create_hypothesis`, `create_agent_run_summary`, `fetch_url` (máximo 230 llamadas: páginas, PDF, redirecciones, fichas y comprobación de dominios) y `render_url` (máximo 115: catálogo y fichas); techo `LOW_WRITE`; 1 500 llamadas por ejecución (el límite real de una ejecución scout es su presupuesto de tiempo) |
| `min_confidence` | `0.5` | Umbral para escribir en Twenty |
| `usd_to_eur` | `0.86` | Conversión del coste para Twenty |
| `model_options` | `{}` | `thinking_level` (Gemini 3.x), `thinking_budget` (Gemini 2.5), `temperature` |
| `max_output_tokens` | `4096` | Por llamada; incluye los tokens de razonamiento |
| `task_name` | `daily-event-prospecting` | Campo `task` del `agentRunSummary` (modo directo) |
| `scout.task_name` | `weekly-event-scouting` | Campo `task` del `agentRunSummary` (modo scout) |
| `scout.max_events` | `3` | Ferias por ejecución (máximo 3) |
| `scout.max_exhibitors_per_event` | `100` | Expositores evaluados por feria (máximo 200) |
| `scout.max_fetches` | `18` | Descargas por ejecución (páginas y PDF) |
| `scout.max_pages_per_event` | `3` | Páginas leídas por feria (portada → catálogo → lista); los renders y los PDF enlazados no cuentan |
| `scout.max_renders` | `4` | Renders JavaScript (`render_url`) por ejecución. `0` = nunca renderizar |
| `scout.max_pdfs_per_event` | `2` | PDF de catálogo o listado enlazados que se leen por feria (máximo 2) |
| `scout.max_catalog_pages` | `10` | Páginas del listado de expositores por feria, la primera incluida (máximo 20). `1` = solo la primera |
| `scout.max_profile_lookups` | `60` | Fichas de expositor abiertas por ejecución para buscar la web de los relevantes sin dominio (máximo 100). `0` = no abrir fichas |
| `scout.profile_concurrency` | `2` | Fichas abiertas a la vez (1-4; el renderer hace 2 renders simultáneos) |
| `scout.time_budget_ms` | `1200000` | Presupuesto de tiempo de la ejecución scout, en ms (20 min; mínimo 10 s, máximo 25 min) |
| `scout.capture_json` | `true` | Pedir al renderer las respuestas JSON de las páginas de catálogo (atajo de la API JSON). `false` = solo el texto |
| `scout.max_redirect_resolutions` | `3` | Redirecciones de grounding resueltas para conocer su dominio |
| `scout.event_signal_confidence` | `0.5` | Confianza de la señal de evento sin expositores |
| `scout.verify_unsourced_by_fetch` | `true` | Sin fuentes de grounding, aceptar la URL si la página corrobora la feria. `false` = estricto |

### Seed

```sh
pnpm seed                                        # tenant DEFAULT_TENANT_ID (publiexpe)
pnpm seed -- --tenant=otro --input=evento.json
```

Es idempotente:

- **Skills** (primero): crea las que faltan con su versión 1 `ACTIVE` y el texto exacto de las constantes de código. No modifica las que ya existen. Consulta [Skills](#skills).
- **Agente `Prospector`**: si no existe, lo crea con la versión 1 `ACTIVE` (`model_provider = gemini`, `model = gemini-flash-latest`, `thinking_level = low`, la tool policy anterior y el prompt en español con los diferenciales de PubliEXPE: ofertas, trato cercano, taller propio y precio). Si existe y su versión activa es distinta, añade una versión nueva, la activa y pasa la anterior a `DEPRECATED`. Si es igual, no cambia nada.
- **Tarea `daily-event-prospecting`**: `CRON 0 8 * * *` en `Europe/Madrid`, `timeout_ms = 900000`, sin reintentos, con `test/fixtures/feria-ejemplo.json` como `default_input`. Si cambia, se actualiza y se guarda una `TaskDefinitionVersion` nueva.
- **Tarea `weekly-event-scouting`** (modo scout): `CRON 30 7 * * 1` (lunes 07:30) en `Europe/Madrid`, `timeout_ms = 1800000`, sin reintentos, `default_input = { "sector": "alimentación y bebidas", "region": "España", "horizon_months": 6 }`.
- **Agente `BajasAgent` y tarea `process-unsubscribes`**: `CRON 0 */2 * * *` en `Europe/Madrid`, sin LLM (`model_provider = stub`), tool policy `get_note` + `update_note` (una escritura por ejecución). Consulta [Inbound de bajas](#inbound-de-bajas).

Las dos tareas usan la misma versión del agente. La versión del seed añade `fetch_url` a la tool policy, la configuración `scout` y la skill `event-source-discovery` v1, y sube la skill `prospector-event-exhibitors` a v2 (datos en bloques `DATOS_NO_CONFIABLES`): al ejecutar el seed sobre una BD existente se crea una versión nueva del agente.

La versión actual del seed añade `render_url` a la tool policy, sube los límites del scout (`max_fetches` 18, `max_pages_per_event` 3, `max_renders` 4, `max_pdfs_per_event` 2) y la skill `event-source-discovery` a v2 (PDF y páginas renderizadas): ejecuta `pnpm seed` después de desplegar para crear la versión nueva. Hasta entonces, la versión activa no tiene `render_url` en su política: el scout lee PDF pero no renderiza (`render.disabled = TOOL_NOT_ALLOWED`).

La versión de la tanda 5 sube `max_exhibitors_per_event` a 60, añade `max_catalog_pages` (3) y `max_profile_lookups` (10), amplía la tool policy (`fetch_url` 42, `render_url` 15, 640 llamadas) y sube la skill `event-source-discovery` a v3 (paginación y fichas). Necesita el renderer con `max_pages` (imagen `pxos-renderer` reconstruida desde esta rama). Con un renderer anterior, el scout lee solo la primera página y, como los enlaces del listado llegan sin texto, no encuentra las fichas.

La versión de la tanda 6 (catálogo completo) sube `max_catalog_pages` a 10, `max_profile_lookups` a 60 y `max_exhibitors_per_event` a 100, añade `time_budget_ms` (20 min), `profile_concurrency` (2) y `capture_json` (`true`), amplía la tool policy (`fetch_url` 230, `render_url` 115, 1 500 llamadas) y sube la skill `event-source-discovery` a v4. Para el atajo JSON y más de 5 páginas necesita pxos-renderer 0.2 (imagen reconstruida desde esta rama); con uno anterior, el scout lee 5 páginas y extrae el texto.

> **Importante:** ejecuta el seed después de desplegar este código. Un runtime anterior trataría la entrada de `weekly-event-scouting` como entrada directa no válida y cerraría la ejecución del lunes como `FAILED`.

La versión MVP-1 del seed deja `system_prompt` vacío y referencia las skills de la BD por nombre y sin versión (`[{"name": "prospector-event-exhibitors"}, {"name": "event-source-discovery"}, {"name": "exhibitor-list-extraction"}]`; en el EmailDrafter, `[{"name": "email-first-contact-draft"}]`): al ejecutar el seed se crea una versión nueva de los dos agentes. El texto que recibe el modelo no cambia.

La fixture tiene tres expositores ficticios: uno claramente relevante (fabricante de conservas con stand propio), uno dudoso (distribuidor de envases que también imprime bolsas promocionales) y uno irrelevante (organismo público que compra por licitación).

### Gemini

`GeminiProvider` usa la API REST v1beta (`models/{model}:generateContent`) con la cabecera `x-goog-api-key`:

- `system` va a `systemInstruction` y los mensajes `assistant` se envían con el rol `model`.
- `options.responseSchema` activa `responseMimeType: application/json` y `responseJsonSchema`.
- Tokens desde `usageMetadata`. Los tokens de razonamiento (`thoughtsTokenCount`) se facturan como salida y los de caché se restan de la entrada.
- Reintenta `429`, `5xx`, errores de red y timeouts con backoff exponencial (1 s, 2 s, 4 s; máximo 3 reintentos) y respeta `Retry-After` y `RetryInfo.retryDelay`.
- Prioridad del modelo: `agent_version.model` (si empieza por `gemini`) > `GEMINI_MODEL` > `gemini-flash-latest`.

El coste se calcula con la tabla editable de `src/providers/gemini-pricing.ts`, por el modelo concreto de `modelVersion` (los alias `*-latest` se resuelven a su modelo real). Precios de la capa de pago, USD por millón de tokens, consultados el 2026-10-06 en [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing):

| Modelo | Entrada | Salida (incluye razonamiento) | Caché |
|---|---|---|---|
| `gemini-3.8-flash` (servía `gemini-flash-latest` el 2026-10-06) | 0,75 (1,50 desde 2027-01-01) | 3,75 (7,50 desde 2027-01-01) | 0,075 (0,15) |
| `gemini-3.5-flash` | 1,50 | 9,00 | 0,15 |
| `gemini-2.5-flash` | 0,30 | 2,50 | 0,03 |
| `gemini-2.5-flash-lite` | 0,10 | 0,40 | 0,01 |

Cuando Google cambie un precio, añade un periodo nuevo con su fecha `from` en vez de sobrescribir el anterior.

**Grounding con Google Search.** `options.grounding = true` (por llamada, desactivado por defecto) añade `tools: [{ google_search: {} }]` y `toolConfig.includeServerSideToolInvocations = true`. El resultado trae `grounding` con las consultas ejecutadas y las fuentes web, leídas de `groundingMetadata` (`webSearchQueries`, `groundingChunks[].web`) y de las partes `toolCall` / `toolResponse` de tipo `GOOGLE_SEARCH_WEB`. El coste de búsqueda se suma a `cost.modelCost` y se desglosa en `cost.groundingCost` y `cost.groundingUnits`. Tabla `GEMINI_GROUNDING_PRICING`, consultada el 2026-10-07 en la misma página de precios:

| Familia | Precio (capa de pago) | Unidad facturada |
|---|---|---|
| Gemini 3.x (3.8, 3.7, 3.6, 3.5 Flash, Flash-Lite, 3 Flash Preview) | 5 000 búsquedas gratis al mes compartidas entre modelos 3.x; después **14 USD por 1 000 búsquedas** | Cada consulta a Google que ejecuta el modelo (una llamada puede lanzar varias) |
| Gemini 2.5 Flash / Flash-Lite | 1 500 RPD gratis; después 35 USD por 1 000 prompts con grounding | Cada prompt con grounding |

El runtime cobra al precio de lista y no descuenta la cuota gratuita (no la puede ver): el coste registrado es una cota superior. En la capa gratuita el grounding de Gemini 3.x no está disponible.

Observado el 2026-10-07 con `gemini-3.8-flash`: el modelo ejecuta las búsquedas (7 consultas en una llamada, 0,098 USD) pero la respuesta no incluye `groundingMetadata` y la `toolResponse` solo trae las sugerencias de búsqueda (HTML con enlaces a google.com), sin URL de resultados. Por eso existe la verificación por descarga del modo scout.

### Tests del Prospector

- `test/unit/prospector-agent.test.ts` y `test/unit/gemini-provider.test.ts`: con `StubProvider` (respuestas guionizadas) y `FakeTwenty`. Cubren el parseo, el reintento por JSON inválido, el flujo de tools, la idempotencia y la agregación de coste.
- `test/integration/prospector-live.test.ts`: **en vivo**. Ejecuta el seed y un `TaskRun` con la fixture contra Gemini, Twenty y PostgreSQL reales, y comprueba empresa, señal, hipótesis y `agentRunSummary` en Twenty. Se salta si falta `GEMINI_API_KEY`, `TWENTY_API_KEY`, Twenty o PostgreSQL, o si `SKIP_LLM_TESTS=1`. Usa los nombres de la fixture (datos de demo, sin prefijo `[TEST]`) en el tenant `publiexpe`; como todas las escrituras son idempotentes, repetirlo solo añade un `agentRunSummary`. Cuesta unos 0,005 € por ejecución.

- `test/unit/fetch-url.test.ts`: guardas SSRF (rangos IPv4/IPv6, URL internas, allow/denylist, IP privada en DNS, DNS mixto, redirección a IP privada o a host privado, límite de redirecciones), truncado de texto y de bytes (también tras gzip, con un servidor local real), timeout, tipos de contenido, charset y `htmlToText`; PDF (detección por tipo y por firma, texto, título y enlaces de una fixture generada con `test/helpers/make-pdf.ts`, recorte, PDF corrupto o cortado) y detección de app JavaScript.
- `test/unit/render-url.test.ts`: `render_url` con `FakeRenderer` y con un servidor HTTP local: configuración (`RENDERER_URL`), renderer no configurado o caído, URL rechazadas antes de llamar (privadas, internas, puertos, denylist), validación y recorte de la respuesta, mapeo de errores y timeout.
- `test/unit/gemini-grounding.test.ts`: cuerpo con `google_search`, parseo de `groundingMetadata` y de las partes `toolCall` / `toolResponse`, y precio por consulta.
- `test/unit/event-scout.test.ts`: modo scout con `StubProvider`, `FakeWeb` (DNS y transporte simulados), `FakeRenderer` y `FakeTwenty`: extracción y verificación de expositores, delimitación del contenido web e intento de inyección, validación de `source_url`, URL no respaldadas, señal de evento, redirecciones de grounding, verificación por corroboración, horizonte y fallos; catálogo JavaScript renderizado (y cadena portada → app → lista de Gastrónoma), renderer no configurado o fuera de la tool policy, PDF de catálogo enlazado (inyección incluida) y fusión de expositores de HTML y PDF.
- `test/unit/exhibitor-domains.test.ts`: paginación del listado (en el cliente con `FakeRenderer` y por enlaces con `FakeWeb`), extracción de la web de la ficha (etiqueta, enlace único, texto), redes sociales como metadato, dominio de la feria y plataformas rechazados, ficha de otra empresa, DNS que no resuelve y dominio con IP privada, presupuestos (`max_profile_lookups`, `max_catalog_pages`), orden de coste (todas las evaluaciones antes de la primera ficha y todas las fichas antes de la primera escritura) y renderer sin `max_pages`.
- Integración del renderer (Chromium real): consulta [services/renderer/README.md](../../services/renderer/README.md#tests).
- `test/integration/event-scout-live.test.ts`: **en vivo**, con grounding real. No ejecuta el seed: usa su propio agente (`Prospector Scout (live test)`) y una tarea `MANUAL` (`event-scouting-live-test`), así no programa nada. Limitado a 1 feria y 5 expositores; cuesta unos 0,10 USD (casi todo, búsquedas). `SKIP_LLM_TESTS=1` lo salta. Con `SCOUT_LIVE_EVENT_URL=https://…` (y `-t event_url`) ejecuta el modo `event_url`, sin grounding. Con `SCOUT_LIVE_DOMAINS=1` y `-t "exhibitor domains"` ejecuta la prueba de aceptación de la tanda 5 sobre esa URL (paginación + fichas): exige al menos 5 empresas con dominio de su ficha, cada una con señal `FAIR` e hipótesis `PROPOSED`; cuesta unos 0,14 €. La prueba lleva el agente a la configuración actual del seed (versión nueva si cambió). `SCOUT_LIVE_AGENT_NAME` y `SCOUT_LIVE_TASK_NAME` cambian los nombres del agente y la tarea (un agente archivado no se puede modificar).

Para ejecutarlo en local, copia también la clave de Gemini a tu `.env`:

```sh
grep '^GEMINI_API_KEY=' ../../deployments/.env >> .env
pnpm vitest run test/integration/prospector-live.test.ts
```

## Inbound de bajas

Primera pieza del Inbound Manager ([LLD v0.1, sección 10.2](../../docs/LLD-0.1-publiexpe-commercial-os.md#102-inbound-y-conversaciones)): procesa las peticiones de baja de forma automática, sin LLM y sin aprobación (cumplimiento). Todo lo que no es una baja se ignora; el triaje general del inbound llegará después.

> **Importante:** este componente solo **lee** correo y solo **añade** líneas a la lista de supresión. No envía, responde, reenvía, mueve ni borra mensajes, y el runtime no usa SMTP en ningún sitio.

### Cómo funciona

La tarea `process-unsubscribes` (`CRON 0 */2 * * *`, `Europe/Madrid`, `max_concurrency = 1`) ejecuta el **BajasAgent** (`implementation = "inbound_bajas"`):

1. Conecta por IMAP con TLS a `IONOS_IMAP_HOST` y abre la carpeta con `EXAMINE` (solo lectura).
1. Busca los mensajes con UID mayor que el último procesado (tabla `inbound_state`). En la primera ejecución, o si el servidor cambia `UIDVALIDITY`, busca los recibidos desde `initial_since` (`2026-10-06`, inicio del warm-up).
1. Descarga cada mensaje con `BODY.PEEK[]` (no lo marca como leído), hasta `max_message_bytes` (256 KB) y `max_messages_per_run` (200) por ejecución. Si hay más, la siguiente ejecución continúa.
1. Clasifica cada mensaje con reglas fijas (consulta [Señales](#señales-de-baja)).
1. Si hay bajas, lee la nota `Lista de supresión — NO contactar` (`get_note`), descarta las direcciones que ya están (o cuyo `@dominio` está) y añade al final una línea por dirección nueva con `update_note`:

   ```
   email — AAAA-MM-DD — baja solicitada (asunto: "...")
   ```

   La fecha es la de recepción en el servidor (`INTERNALDATE`), en `Europe/Madrid`. El asunto se limpia (sin comillas, `@`, ni sintaxis markdown o HTML) y se recorta a 80 caracteres.

1. Solo si la escritura en Twenty ha ido bien, guarda el último UID. Si Twenty falla, el cursor no avanza y la siguiente ejecución lo reintenta (la deduplicación lo hace idempotente).

El TaskRun y su trace guardan los contadores (`messages_reviewed`, `bajas_detected`, `new_entries`, `duplicates`, `ignored_*`, `parse_errors`, `marked_seen`). Del correo ignorado el trace solo guarda el UID y el motivo; de la nota, solo su tamaño.

Sin `IONOS_IMAP_USER` o `IONOS_IMAP_PASSWORD`, la ejecución termina `COMPLETED` con `outcome = SKIPPED` y el motivo (`IMAP no configurado: faltan ...`), sin leer nada.

### Señales de baja

El cuerpo del correo es **dato no confiable**: no se interpreta como instrucciones. La dirección que se añade sale siempre de la cabecera `From` parseada, nunca del cuerpo ni de `Reply-To`.

| Señal | Regla |
|---|---|
| `recipient_baja_address` | `baja@publiexpe.info` aparece en `To`, `Cc`, `Delivered-To`, `X-Forwarded-To`, `X-Original-To`, `Envelope-To` o `Resent-To` |
| `subject_keyword` | El asunto, sin prefijos `Re:`/`RV:`/`Fwd:`, es exactamente `baja`, `stop`, `unsubscribe`, `no contactar`... o contiene la palabra `baja` o `unsubscribe`, o una de las frases de baja |
| `body_phrase` | El texto que escribió el remitente contiene una frase como "darme de baja", "me deis de baja", "solicito la baja", "quitarme de la lista", "no me contactéis", "no volváis a escribir", "unsubscribe", "remove me from" |
| `body_keyword_only` | La primera línea del texto es solo `BAJA`, `STOP` o `Unsubscribe` |

Reglas comunes:

- Las frases se comparan en minúsculas, sin tildes y con límites de palabra.
- Del cuerpo se descarta el texto citado (líneas `>`, el bloque "El ... escribió:" y la cabecera "De: / Enviado:" de Outlook), nuestro pie de baja y la firma `-- `. Se analizan como máximo 4.000 caracteres.
- Nunca es baja: el correo automático (`Auto-Submitted`, `List-Unsubscribe`, `List-Id`, `Precedence: bulk`, rebotes `multipart/report`, remitentes `mailer-daemon`, `no-reply`...), el de nuestros dominios (`publiexpe.info`, `publiexpe.com`) y el que no tiene un `From` válido.

### Buzón: lo único que se modifica

Por defecto, nada. Con `mark_seen: true` en la configuración de la versión, el agente añade el flag `\Seen` (y solo ese) a los mensajes que ha procesado como baja. El resto no se toca nunca. El valor por defecto es `false` para que un falso positivo no oculte la respuesta de un cliente en la bandeja.

### Configuración de la versión

| Clave | Por defecto | Uso |
|---|---|---|
| `suppression_note_id` | `6658e882-60f9-427f-808d-dc5c255570dc` | Nota de Twenty con la lista |
| `suppression_note_title` | `Lista de supresión — NO contactar` | `update_note` se niega a escribir si el título no coincide |
| `unsubscribe_addresses` | `["baja@publiexpe.info"]` | Destinatarios que significan baja |
| `own_domains` | `["publiexpe.info", "publiexpe.com"]` | Remitentes que nunca son baja |
| `imap_mailbox` | `INBOX` | Carpeta (gana sobre `IONOS_IMAP_MAILBOX`) |
| `initial_since` | `2026-10-06` | Fecha desde la que se lee la primera vez |
| `max_messages_per_run` / `max_message_bytes` | `200` / `262144` | Límites por ejecución y por mensaje |
| `mark_seen` | `false` | Marca `\Seen` en las bajas procesadas |

### Tabla `inbound_state`

Migración `0004_inbound`. Un cursor por `(tenant_id, consumer, mailbox)`; se actualiza en sitio (el historial son los TaskRuns).

| Columna | Tipo | Uso |
|---|---|---|
| `tenant_id` | `text` | Tenant |
| `consumer` | `text` | Lector del buzón: `bajas` (el triaje general tendrá el suyo) |
| `mailbox` | `text` | `usuario@host/CARPETA` (sin contraseña) |
| `uid_validity` | `bigint` | `UIDVALIDITY` de la carpeta cuando se guardó el cursor |
| `last_uid` | `bigint` | Último UID procesado; nunca retrocede con el mismo `UIDVALIDITY` |
| `last_run_at` | `timestamptz` | Última ejecución que avanzó el cursor |
| `last_summary` | `jsonb` | Contadores de esa ejecución (sin contenido de correos) |

### Puesta en marcha

1. Añade `IONOS_IMAP_USER` y `IONOS_IMAP_PASSWORD` (y, si cambian, `IONOS_IMAP_HOST`/`IONOS_IMAP_PORT`) al entorno del runtime. En Docker, el servicio `pxos-runtime` de `deployments/docker-compose.yml` tiene que pasarlas en `environment` (consulta [Docker](#docker)).
1. Ejecuta `pnpm db:migrate` (o arranca con `RUN_MIGRATIONS=true`) y `pnpm seed`.
1. Revisa la primera ejecución: `GET /task-runs/{id}` muestra los contadores y las direcciones añadidas.

### Tests

- `test/unit/inbound-bajas.test.ts`: clasificación con fixtures RFC 822 (incluidos citas, Outlook, HTML en base64, newsletters, rebotes, autorrespuestas e intentos de inyección), formato y deduplicación de la lista, cursor, degradación sin credenciales y el cliente imapflow real contra `FakeImapServer` (comprueba que solo se envían `EXAMINE`, `UID SEARCH` y `UID FETCH ... BODY.PEEK[]`).
- `test/integration/inbound-bajas.test.ts` (PostgreSQL): seed, `process-unsubscribes` → `RunProcessor` → BajasAgent → servidor IMAP falso → nota en FakeTwenty → `inbound_state` y trace.
- `test/integration/inbound-bajas-live.test.ts`: con `IONOS_IMAP_*` en el entorno o en `.env`, conecta al buzón real en solo lectura, lista y clasifica **sin escribir nada** (ni en el buzón ni en Twenty) e imprime lo que añadiría. Con `TWENTY_API_KEY`, prueba además `update_note` sobre una nota de prueba `[TEST] pxos-it ...` (nunca sobre la lista real). Sin credenciales se salta.

## Docker

El `Dockerfile` es multi-stage (build con pnpm, imagen final solo con dependencias de producción, usuario `node`, healthcheck sobre `/health`).

`docker-compose.runtime.yml` es un fragmento de ejemplo con el servicio `pxos-runtime` publicado en `127.0.0.1:4020`. No sustituye a `deployments/docker-compose.yml`.

### Integración en deployments/docker-compose.yml

Quien mantenga `deployments/` puede añadir este servicio a la red `pxos-net`:

```yaml
  pxos-runtime:
    build:
      context: ../runtime/agent-runtime
    image: pxos/agent-runtime:0.1.0
    container_name: pxos-runtime
    environment:
      RUNTIME_ROLE: all
      RUNTIME_HOST: 0.0.0.0
      RUNTIME_PORT: "4020"
      DATABASE_URL: postgres://${AGENTOS_PG_USER:-agentos}:${AGENTOS_PG_PASSWORD:-agentos_dev}@pxos-postgres:5432/${AGENTOS_PG_DB:-agentos}
      REDIS_URL: redis://pxos-redis:6379
      RUN_MIGRATIONS: "true"
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      GEMINI_MODEL: ${GEMINI_MODEL:-}
      TWENTY_BASE_URL: http://pxos-twenty:3000
      TWENTY_API_KEY: ${TWENTY_API_KEY:-}
      # Inbound de bajas (solo lectura IMAP). Sin ellas, process-unsubscribes sale SKIPPED.
      IONOS_IMAP_HOST: ${IONOS_IMAP_HOST:-imap.ionos.es}
      IONOS_IMAP_USER: ${IONOS_IMAP_USER:-}
      IONOS_IMAP_PASSWORD: ${IONOS_IMAP_PASSWORD:-}
    ports:
      - "127.0.0.1:4020:4020"
    depends_on:
      pxos-postgres:
        condition: service_healthy
      pxos-redis:
        condition: service_started
    restart: unless-stopped
    networks: [pxos-net]
```

`render_url` necesita el servicio `pxos-renderer` en la misma red (fragmento y pasos en [services/renderer/README.md](../../services/renderer/README.md#integración-en-deploymentsdocker-composeyml)). El runtime no necesita ninguna variable nueva: `RENDERER_URL` vale por defecto `http://pxos-renderer:3000`. Sin el servicio, el scout funciona como antes.

Para escalar, separa roles: un servicio con `RUNTIME_ROLE=api`, N réplicas con `RUNTIME_ROLE=worker` y `RUN_MIGRATIONS=false`, y un servicio con `RUNTIME_ROLE=scheduler`. Puedes tener varias réplicas del scheduler: los disparos se deduplican por idempotency key.

## Evaluador HUMAN

Primera señal de calidad del MVP-0 (LLD v0.2 secciones 5.5 y 6.4, decisión D14). Cuando un comercial acepta, edita o descarta una hipótesis en Twenty, el runtime guarda una evaluación en la tabla `evaluations` ligada a la ejecución que generó la hipótesis.

| Cambio en `commercialHypothesis` | `feedback` | `score` (`TASK_SUCCESS`) |
|---|---|---|
| `PROPOSED` a `VALIDATED` sin cambios de contenido | `ACCEPTED` | 1.0 |
| `PROPOSED` a `VALIDATED` tras editar (o en la misma edición) | `EDITED` | 0.5 |
| Edición de `need`, `whyNow`, `budget*`, `quantity*`, `recommendedProducts` o `timing` en `PROPOSED` | `EDITED` | 0.5 |
| `PROPOSED` o `VALIDATED` a `REJECTED` | `DISCARDED` | 0.0 |

Se ignoran (respuesta `200` con `status: "ignored"`): el paso a `EXPIRED` o de vuelta a `PROPOSED`, las transiciones desde `EXPIRED`, las ediciones de campos que no son de negocio y las ediciones después de validar.

### Webhook de Twenty

Twenty 2.45 envía un `POST` por cada registro cambiado (`CallWebhookJob`). Payload real capturado en `test/fixtures/twenty-webhook-hypothesis-*.json`:

```json
{
  "targetUrl": "http://pxos-runtime:4020/webhooks/twenty",
  "eventName": "commercialHypothesis.updated",
  "objectMetadata": { "id": "9994b775-...", "nameSingular": "commercialHypothesis" },
  "workspaceId": "36d3d8e2-...",
  "webhookId": "be4bd4df-...",
  "eventDate": "2026-10-07T06:39:44.257Z",
  "record": { "id": "0a6e5044-...", "status": "PROPOSED", "need": "...", "budgetMin": { "amountMicros": 600000000, "currencyCode": "EUR" }, "tenantId": "publiexpe", "updatedBy": { "source": "API", "workspaceMemberId": null, "name": "agent-runtime" } },
  "updatedFields": ["need", "budgetMax", "recommendedProducts"]
}
```

- `record` es el registro **después** del cambio. `userId` y `workspaceMemberId` solo aparecen si el cambio lo hizo un usuario de la interfaz (no con API key).
- `updatedFields` trae **solo los nombres** de los campos cambiados, **nunca los valores anteriores**. Por eso:
  - el estado origen sale de la última evaluación guardada para esa hipótesis; si no hay ninguna, se asume `PROPOSED` (`details.from_status_source = "assumed"`);
  - el "antes" del diff de `EDITED` es la propuesta original del agente: el input de la llamada a `create_hypothesis` en el trace (`details.edited_fields_before_source = "agent_proposal"`). Si la hipótesis no tiene trace, el diff lista los campos cambiados con `before: null` (`"unknown"`), y una validación cuenta como `EDITED` si antes se registró una edición.
- Seguridad: si el webhook tiene `secret`, Twenty firma cada envío. `X-Twenty-Webhook-Signature` es el HMAC-SHA256 en hexadecimal de `` `${X-Twenty-Webhook-Timestamp}:${body}` `` (timestamp en milisegundos), y también envía `X-Twenty-Webhook-Nonce`. El runtime comprueba la firma sobre el cuerpo crudo y rechaza timestamps con más de 5 minutos de desfase. Como alternativa para emisores que no firman, acepta el secreto en la cabecera `x-pxos-webhook-secret` o en `?secret=`. Evita la forma `?secret=` con Twenty: Twenty escribe la URL completa en sus logs (`SecureHttpClientService`). Sin credenciales válidas responde `401`, y sin `TWENTY_WEBHOOK_SECRET` responde `503`.
- Twenty no reintenta: un fallo de entrega se pierde. Para recuperar un veredicto perdido, usa `POST /evaluations/human`.

Importante: Twenty bloquea por protección SSRF los webhooks hacia IPs privadas, y `pxos-runtime` y `host.docker.internal` lo son. Para que entregue los webhooks, el servidor y el worker de Twenty necesitan `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS=pxos-runtime,host.docker.internal`. Sin esa variable, Twenty descarta el envío sin registrar ningún error.

### Registrar el webhook

```sh
pnpm register:webhook                                                   # http://pxos-runtime:4020/webhooks/twenty
pnpm register:webhook --url http://host.docker.internal:4024/webhooks/twenty   # runtime en el host
pnpm register:webhook --pause                                           # operations = [], no se entrega nada
pnpm register:webhook --dry-run
```

- Desde los contenedores de Twenty, el runtime se alcanza como `http://pxos-runtime:4020` (misma red `pxos-net`). Es el destino por defecto.
- Si el runtime corre en el host (`pnpm dev`), usa `http://host.docker.internal:<puerto>/webhooks/twenty` y escucha en `RUNTIME_HOST=0.0.0.0`.
- El script es idempotente: identifica el webhook por la marca `pxos-runtime:human-feedback` en la descripción, lo crea si no existe y si no lo actualiza. Suscribe solo `commercialHypothesis.updated`. Guarda `TWENTY_WEBHOOK_SECRET` como `secret` del webhook (Twenty firma con él) y nunca lo pone en la URL.
- Twenty no tiene un estado "inactivo" para los webhooks: `--pause` deja `operations` vacío. El script nunca borra webhooks.
- El runtime que recibe el webhook necesita el mismo `TWENTY_WEBHOOK_SECRET` en su entorno.

### Vínculo con la ejecución de origen

La hipótesis no guarda `agentExecutionId` en Twenty, así que el runtime lo busca en las trazas del Agent OS, en este orden:

1. `trace_output`: el paso `create_hypothesis` cuyo `tool_output.record.id` es la hipótesis. Las re-ejecuciones idempotentes devuelven el mismo id con `created: false`; gana el paso con `created: true` y, después, el más antiguo.
2. `execution_output`: una ejecución cuyo `output` final contiene el id.
3. `company_name`: una llamada a `create_hypothesis` de la misma empresa cuyo nombre (explícito o `{empresa} — {need}`) coincide. Cubre la tool que expiró después de que Twenty aplicase la escritura.

Si nada coincide, la evaluación se guarda sin `agent_execution_id` y con `details.link.resolved = false`. Las hipótesis creadas a mano en Twenty o por tests que llaman a las tools sin ejecución nunca se vinculan, y es lo correcto.

### Deduplicación

- Por `idempotency_key`: en el webhook, `twenty:{webhookId}:{evento}:{recordId}:{record.updatedAt}`; en `POST /evaluations/human`, la cabecera `Idempotency-Key`.
- Por ventana: no se repite el mismo `(subject_id, feedback, estado destino)` dentro de `EVALUATION_DEDUPE_WINDOW_MS`. Así, el webhook y una llamada manual (o la futura logic function de la App) que informan del mismo veredicto cuentan una vez. En `POST /evaluations/human` el estado destino es `details.to_status` o, para hipótesis, `VALIDATED` (`ACCEPTED`, `EDITED`) o `REJECTED` (`DISCARDED`).

### `POST /evaluations/human`

Acepta la forma del runtime o la del LLD v0.2 (sección 6.4):

```sh
curl -s -X POST localhost:4020/evaluations/human -H 'content-type: application/json' \
  -H 'Idempotency-Key: fb-123' \
  -d '{"subject_type":"hypothesis","subject_id":"<id en Twenty>","feedback":"EDITED","details":{"note":"Cambié el decisor"}}'

curl -s -X POST localhost:4020/evaluations/human -H 'content-type: application/json' \
  -d '{"hypothesisId":"<id en Twenty>","feedback":"ACCEPTED","reviewerId":"twenty-user-3f2a"}'
```

Si no envías `agent_execution_id` (o `agentExecutionId`), el runtime resuelve el vínculo como en el webhook. Si lo envías, debe existir en el tenant (si no, `404`). Responde con `evaluatorId`, `executionId`, `scores.TASK_SUCCESS`, `passed`, `deduplicated`, `event_id` (el `evaluation.recorded`, o `null` si no se pudo publicar) y la evaluación guardada.

### Tabla `evaluations`

| Columna | Contenido |
|---|---|
| `kind`, `evaluator_id` | `HUMAN`, `human-v1` |
| `subject_type`, `subject_id` | `hypothesis` e id del registro en Twenty |
| `agent_execution_id`, `task_run_id` | Ejecución y `TaskRun` de origen, o `null` |
| `feedback`, `score` | `ACCEPTED` 1.0, `EDITED` 0.5, `DISCARDED` 0.0 |
| `details` | `from_status`, `to_status`, `edited_fields` (`{campo: {before, after}}`, presupuestos en EUR), `updated_fields`, `link`, `actor` y metadatos del evento de Twenty |
| `source` | `twenty_webhook` o `api` |
| `idempotency_key`, `evaluated_by`, `occurred_at`, `created_at` | |

Índices: `(tenant_id, subject_type, subject_id, occurred_at)`, `(tenant_id, agent_execution_id)` y único `(tenant_id, idempotency_key)`. La tabla es solo de inserción.

## Métricas y dashboard

Primeras métricas del sistema (LLD v0.1 secciones 17.2 y 17.3, criterios AC-15 a AC-20 del LLD v0.2). Son consultas SQL de solo lectura sobre las tablas del runtime (`src/metrics/queries.ts`): no hay almacén nuevo ni escrituras. Todas filtran por el tenant de `x-tenant-id`.

### Endpoints

`since` y `until` son fechas ISO 8601 con zona (`2026-10-07T00:00:00+02:00`). `since` es inclusivo y `until` exclusivo. Cada respuesta indica en `window.field` la columna que filtra.

- **`GET /metrics/summary`** filtra por `task_runs.created_at` y devuelve:
  - `runs`: total, `by_status`, `by_outcome` (`SUCCESS`, `PARTIAL`, `FAILED` del `output.outcome` del agente, o `NONE`) y `by_task`.
  - `cost`: total, medio y máximo por run en EUR, y `cost_model_currency` (la suma de `total_cost` en la moneda del proveedor).
  - `tokens` y `latency_ms` (media, p95 y máximo de `finished_at - started_at`).
  - `funnel`: suma de los `output.counters` de los resúmenes de ejecución (`exhibitors`, `evaluated`, `relevant`, `hypotheses_created`, `hypotheses_existing`...). `counters` incluye todas las claves numéricas.
  - `human_feedback`: veredictos del periodo (por `evaluations.occurred_at`), con `acceptance_rate` y `useful_rate`.
  - `acceptance`: AC-15 (coste por run, umbral 3,00 EUR), AC-16 (duración, umbral 30 min) y AC-17 (coste por hipótesis nueva).
  - `direct_executions` (ejecuciones sin `TaskRun`) y `last_run`.
- **`GET /metrics/agents`** filtra por `agent_executions.created_at` y agrupa por agente y versión (`version_label` `v1`, `v2`...): runs, estados, `completion_rate`, outcome y `success_rate`, coste medio, tokens, latencia y `human_feedback` de los sujetos que produjeron esas ejecuciones (cruce por `evaluations.agent_execution_id`). Es la métrica para comparar versiones: «¿el agente mejora?».
- **`GET /metrics/evaluations`** filtra por `evaluations.occurred_at`: `totals`, `by_day` (serie diaria en la zona `tz`, `Europe/Madrid` por defecto), `by_subject_type` y `subjects` (último veredicto, historial y ejecución vinculada de cada sujeto, hasta `subject_limit`).
- **`GET /metrics/runs`** devuelve los últimos `TaskRun` con tarea, agente, versión, estado, outcome, coste, duración y `trace_url` (`/task-runs/:id`).

Ejemplo:

```sh
curl -s "http://127.0.0.1:4020/metrics/agents?since=2026-10-01T00:00:00%2B02:00" -H 'x-tenant-id: publiexpe'
```

### Definiciones

| Métrica | Cálculo |
|---|---|
| Coste de una ejecución en EUR | `output.cost.eur` si el agente lo informa; si no, `total_cost × output.cost.usd_to_eur` o `× 0.86` (`DEFAULT_USD_TO_EUR`). Si `output.cost.currency` es `EUR`, `total_cost` tal cual |
| Coste de un `TaskRun` | Suma de sus `agent_executions`, todos los intentos incluidos (AC-15). La columna `task_runs.cost` solo guarda el último intento correcto |
| Duración de un `TaskRun` | `finished_at - started_at` (AC-16) |
| `acceptance_rate` | `ACCEPTED / (ACCEPTED + EDITED + DISCARDED)` |
| `useful_rate` | `(ACCEPTED + EDITED) / revisadas` (AC-20) |
| `avg_score` | Media del `score` (1.0, 0.5, 0.0) |

Las tasas usan el **último veredicto de cada sujeto** (`subject_type`, `subject_id`): una hipótesis editada y después descartada cuenta una vez, como `DISCARDED`. `verdicts` cuenta todas las filas. En `/metrics/agents` solo cuentan los veredictos vinculados a una ejecución; en `/metrics/summary` cuentan todos.

### Dashboard

Abre `http://127.0.0.1:4020/dashboard`. Para otro tenant, añade `?tenant=<id>`. Muestra:

- Tarjetas: runs de hoy y de los últimos 7 días (desde la medianoche local del navegador), coste acumulado en EUR, tasa de aceptación y última ejecución.
- Tabla por agente y versión: runs, éxito, coste medio, latencia, veredictos, aceptación, utilidad (AC-20) y score medio.
- Últimos 10 runs, con enlace a su trace JSON (`GET /task-runs/:id`).

La página es HTML, CSS y JavaScript inline, sin frameworks ni CDN. Todas sus llamadas usan rutas relativas (`metrics/...`, `task-runs/...`). Sigue el tema claro u oscuro del sistema (`prefers-color-scheme`).

Solo se sirve a peticiones locales: la IP del cliente es loopback o privada (el puerto que Docker publica en `127.0.0.1` llega desde la pasarela del bridge) **y** la cabecera `Host` es `localhost`, `127.0.0.1`, `[::1]` o `*.localhost`, para cortar el DNS rebinding. Si no, responde `403`. No añade autenticación: el runtime sigue escuchando solo en `127.0.0.1`.

> **Nota:** el enlace al trace es un enlace normal y no envía `x-tenant-id`, así que con `?tenant=` distinto del tenant por defecto devuelve `404`.

### Índices

No hace falta migración. Con `EXPLAIN ANALYZE` sobre la BD de desarrollo (219 `task_runs`, 280 `agent_executions`, 16 `evaluations`) todas las consultas tardan menos de 1 ms. El coste por run usa `agent_executions_task_run_idx`, el filtro por tenant usa `agent_executions_tenant_status_idx` y el último veredicto por sujeto usa `evaluations_tenant_subject_idx`. `task_runs` se recorre entero (seq scan) porque es pequeña. Con una ejecución diaria por tarea, el volumen tardará en importar. Cuando `task_runs` o `agent_executions` superen unas decenas de miles de filas por tenant, añade `(tenant_id, created_at)` a ambas.

### Tests

`test/integration/metrics.test.ts` siembra dos tenants (versiones `v1` y `v2` de un mismo agente, un run con reintento y veredictos encadenados) y comprueba la tasa de aceptación por versión, el coste medio, la serie diaria por zona horaria, el aislamiento entre tenants y el HTML del dashboard. Usa por defecto su propia base `agentos_wt4_metrics`:

```sh
docker exec pxos-postgres psql -U agentos -d postgres -c "create database agentos_wt4_metrics"   # una vez
pnpm vitest run test/integration/metrics.test.ts test/unit/metrics-local.test.ts
```

## Borradores de email

> **Importante:** el sistema **no envía emails**. No hay dependencia SMTP, ni API de correo, ni tool de envío en el registro. Solo genera **borradores** que el comercial revisa y envía a mano desde su buzón (modelo HITL del LLD v0.1, sección 10, y *human gates* de la sección 15: las notas internas son automáticas; enviar un email exige a una persona).

Cuando un comercial valida una hipótesis, el agente `EmailDrafter` prepara un borrador del primer email y lo deja en Twenty como nota sobre la empresa y sobre la hipótesis.

```
veredicto ACCEPTED (webhook de Twenty o POST /evaluations/human)
  -> evaluation.recorded
  -> tarea draft-email-on-validated (trigger EVENT)
  -> EmailDrafter: get_hypothesis -> 1 llamada a Gemini {asunto, cuerpo} -> create_note
  -> Note "Borrador email — {hipótesis}" en la empresa y en la hipótesis
```

### Tarea y agente

- **Tarea `draft-email-on-validated`**: `{"type": "EVENT", "event_type": "evaluation.recorded", "filter": {"feedback": "ACCEPTED", "subjectType": "hypothesis"}}`, `timeout_ms = 120000`, 2 intentos y `max_concurrency = 2`. Un veredicto `EDITED` (validada con cambios) no dispara la tarea: el filtro no tiene operador OR.
- **Agente `EmailDrafter`** (`implementation = "email_drafter"`, `gemini-flash-latest`, `thinking_level = low`): tool policy `find_company`, `get_company`, `get_hypothesis` y `create_note`, techo `LOW_WRITE`, máximo 6 llamadas y una sola `create_note` por ejecución.
- Entrada: el sobre del evento bajo `input.event`, o `{ "hypothesis_id": "<id en Twenty>" }` para lanzarlo a mano con `POST /tasks/:id/run`.
- `pnpm seed` crea o actualiza el agente y la tarea (idempotente, igual que el Prospector).

### Flujo

1. Lee la hipótesis con `get_hypothesis` (empresa, señal y decision maker en una sola petición). Si la hipótesis no existe o está `REJECTED` o `EXPIRED`, si el veredicto no es `ACCEPTED` ni `EDITED` o si el sujeto no es una hipótesis, termina con `outcome = SKIPPED` sin llamar al modelo.
1. Hace **una** llamada a Gemini con la necesidad, el porqué ahora, el evento, los productos recomendados y los diferenciales que anotó el Prospector. Los datos del CRM entran en un bloque `DATOS_NO_CONFIABLES`. La respuesta se valida con zod (`{asunto, cuerpo}`); si no es válida, el run termina con `outcome = FAILED` y sin nota (no hay ronda de reparación).
1. Post-procesa el texto por código (`finalizeDraft`).
1. Guarda la nota con `create_note`.

El prompt pide español de España, tuteo, tono cercano y sin humo comercial, de 120 a 180 palabras, 1 o 2 diferenciales (taller propio, ofertas, trato cercano, precios) y nada inventado: sin nombres de contacto si la hipótesis no tiene decision maker, sin presupuestos ni cantidades estimadas y sin mencionar el CRM ni la IA.

### Cumplimiento (LSSI art. 21)

El modelo **no** escribe la firma ni la línea de baja: las añade el código siempre.

- Quita cualquier línea de baja o de privacidad que haya escrito el modelo y termina el cuerpo con exactamente `Si no quieres recibir más mensajes, respóndeme o escribe a baja@publiexpe.info`.
- Añade la firma (`Jesús Abril`, `PubliEXPE · Merchandising y regalo promocional personalizado`, `www.publiexpe.com`) si no está, y la despedida si falta.
- Sin decision maker, sustituye un nombre propio inventado en el saludo por `Hola:`.
- Cuenta las palabras y avisa (en la nota y en la salida) si el cuerpo sale de 120-180 palabras o el asunto pasa de 70 caracteres.

El remitente, los buzones (`jesus.abril@publiexpe.info` y `j.abril@publiexpe.info`) y el buzón de baja salen de `configuration.sender` y `configuration.unsubscribe_email` de la versión del agente.

### La nota en Twenty

Título `Borrador email — {nombre de la hipótesis}`. El cuerpo empieza con la cabecera **BORRADOR — revísalo y envíalo desde tu correo; el sistema no envía nada.**, sigue con `De`, `Para` (el decision maker si existe; si no, un aviso para que el comercial ponga una dirección corporativa de rol) y `Asunto`, el cuerpo listo para copiar y un pie con la hipótesis, el veredicto y la ejecución.

Formato de Twenty 2.45 (verificado contra la API REST):

```http
POST /rest/notes        { "title": "...", "bodyV2": { "markdown": "..." } }
POST /rest/noteTargets  { "noteId": "<note>", "targetCompanyId": "<company>" }
POST /rest/noteTargets  { "noteId": "<note>", "targetCommercialHypothesisId": "<hypothesis>" }
```

- `bodyV2` es un campo `RICH_TEXT_V2` (`{ markdown, blocknote }`). Basta con enviar `markdown`: el servidor genera `blocknote`.
- Cada registro enlazado es una fila de `noteTarget` con su columna (`targetCompanyId`, `targetPersonId`, `targetOpportunityId` y, para los objetos de la App, `targetCommercialHypothesisId`, `targetCommercialSignalId`, `targetResearchId` y `targetAgentRunSummaryId`).
- `create_note` es idempotente por empresa + título: busca notas con ese título (`title[eq]`) y sus `noteTargets` (`noteId[eq]`). Si una ya apunta a la empresa, la devuelve con `created: false` y crea solo los targets que falten. Si encuentra una con ese título y sin ningún target (una llamada que murió entre los dos `POST`), la adopta. Las comillas y barras invertidas del título se eliminan porque los filtros de Twenty no las escapan.

### Coste

Una llamada a Gemini por borrador. En la prueba en vivo: 0,0021 USD (0,0018 €) y unos 5 s por run.

## Pendiente

- Triggers `DEPENDENCY` y `CONDITION` (hoy no registran nada).
- Columna `trigger` (`SCHEDULE`, `MANUAL`...) en `task_runs` para distinguir el origen de cada run (LLD v0.2, AC-04).
- Exponer `EntityLocks` a las tools (el helper está listo en `RunProcessor.locks`).
- Política de catch-up si el scheduler estuvo parado: hoy, al volver, se procesa el slot pendiente (tarde, con su `scheduled_at` original) y los demás slots perdidos se omiten.
- Tools pendientes del registro del MVP-0: `search_web` (hoy la búsqueda es el grounding de Gemini, un paso `MODEL`; el LLD prevé fuentes ligadas a pasos `TOOL`), `create_activity` y las del Catalog Service.
- Modo scout: cada ficha renderizada tarda unos 10-12 s (2 a la vez). Con muchos relevantes, el presupuesto de tiempo deja sin dominio a los de menor confianza. La API JSON de la ficha (Feria Valencia: `/api/exhibitor/get?exhiid=`) podría dar la web sin renderizar la ficha. El agente no recibe el timeout de su tarea: `time_budget_ms` se configura aparte.
- Integrar `pxos-renderer` en `deployments/docker-compose.yml` (fragmento en `services/renderer/docker-compose.renderer.yml`) y, opcionalmente, el perfil seccomp de Playwright para el sandbox de Chromium.
- `GeminiProvider.stream()` no es incremental: devuelve la respuesta completa en un solo fragmento.
- Validación de URL en campos de texto libre contra las fuentes del trace (LLD v0.2 sección 10.4, punto 4) en el modo directo: el modo scout ya la aplica con su `SourceLedger`.
- Eventos aún no emitidos: `task.failed` cuando el reconciliador cierra un huérfano, cancelaciones y `signal.detected`.
- Borradores de email: disparar también con `EDITED` (necesita una segunda tarea o un operador OR en el filtro), plantillas por sector y registro de si el comercial envió el borrador. Entrada de eventos externos (Twenty, n8n) por HTTP y entrega a n8n por webhook.
- Harness, memoria y verificador reales; promote, rollback y evaluate. Skills: versionadas en BD (MVP-1), falta el optimizador (operaciones acotadas, experimentos y gate de validación), `workflow` y `optimization_budget` del LLD §6.3 y la comprobación del `content_hash` al cargar.
- Export de los contratos zod a JSON Schema versionado en `schemas/`.
- Métricas: AC-17 y AC-18 piden hipótesis `HOT`, pero el resumen de ejecución solo cuenta hipótesis creadas; falta el desglose por prioridad (en Twenty o en `output.counters`). El dashboard oculta por defecto los agentes `ARCHIVED` (los de prueba se archivan con `pnpm cleanup:archive-test-agents`); `include_archived=true` los muestra.
