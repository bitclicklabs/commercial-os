# Agent Runtime

Servicio del Agent OS de PubliEXPE Commercial OS (LLD v0.1, sección 8). Expone la API HTTP del runtime, planifica tareas (`ONCE`, `CRON`, `INTERVAL`) y ejecuta un worker BullMQ que lanza agentes y persiste `TaskRun`, `AgentExecution`, `Trace` y `TraceStep` en PostgreSQL.

Estado: esqueleto MVP. Los agentes se ejecutan con `StubAgent` (sin LLM). `AnthropicProvider` existe como esqueleto y no se llama en los tests.

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
│   ├── agents/               Interfaz de agente y StubAgent
│   ├── db/                   Esquema Drizzle, cliente y migrador
│   ├── domain/               Estados, máquina de estados e idempotency keys
│   ├── providers/            ModelProvider, StubProvider y AnthropicProvider
│   ├── queue/                RunQueue (BullMQ y en memoria)
│   ├── scheduler/            TaskScheduler sobre BullMQ, parseo de schedules y rutas
│   ├── services/             Lanzamiento idempotente de TaskRuns
│   └── worker/               RunProcessor, worker BullMQ, locks por entidad y reconciliador
└── test/
    ├── unit/                 Corren siempre, sin BD ni Redis
    └── integration/          API, worker, scheduler y locks contra PostgreSQL (y Redis); se saltan si no hay
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
| `DEFAULT_TENANT_ID` | `publiexpe` | Tenant si la petición no envía `x-tenant-id` |
| `DEFAULT_MODEL_PROVIDER` | `stub` | Proveedor para agentes creados sin `model_provider` |
| `ANTHROPIC_API_KEY` | vacío | Solo para agentes con `model_provider=anthropic` |

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
| `GET /scheduler/status` | Job schedulers y jobs `ONCE` registrados del tenant, y contadores de la cola |
| `GET /tasks/:id/runs` | Historial de ejecuciones de la tarea |
| `GET /task-runs/:id` | `TaskRun` con su ejecución, trace y pasos |
| `POST /executions` | Ejecuta un agente sin tarea (idempotente con `idempotency_key`) |
| `GET /executions`, `GET /executions/:id` | Lista o detalle con trace y pasos |
| `POST /executions/:id/cancel` | `QUEUED` o `RUNNING` a `CANCELLED` |
| `POST /executions/:id/{pause,resume}` | `501`, requiere harness con checkpoints |

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

`MANUAL`, `EVENT`, `DEPENDENCY` y `CONDITION` no registran nada en el scheduler. La zona horaria de `CRON` es `schedule.timezone`, si existe, o `task.timezone` (por defecto `Europe/Madrid`). `POST /tasks` y `PATCH /tasks/:id` devuelven `400 invalid_schedule` si el schedule no es válido.

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

Para escalar, separa roles: un servicio con `RUNTIME_ROLE=api`, N réplicas con `RUNTIME_ROLE=worker` y `RUN_MIGRATIONS=false`, y un servicio con `RUNTIME_ROLE=scheduler`. Puedes tener varias réplicas del scheduler: los disparos se deduplican por idempotency key.

## Pendiente

- Triggers `EVENT`, `DEPENDENCY` y `CONDITION` (hoy no registran nada).
- Columna `trigger` (`SCHEDULE`, `MANUAL`...) en `task_runs` para distinguir el origen de cada run (LLD v0.2, AC-04).
- Exponer `EntityLocks` a las tools del harness cuando existan.
- Política de catch-up si el scheduler estuvo parado: hoy, al volver, se procesa el slot pendiente (tarde, con su `scheduled_at` original) y los demás slots perdidos se omiten.
- Harness, skills, memoria, tools y verificador reales; promote, rollback y evaluate.
- Publicación de eventos (`task.started`, `task.completed`...) en el event bus.
- Export de los contratos zod a JSON Schema versionado en `schemas/`.
