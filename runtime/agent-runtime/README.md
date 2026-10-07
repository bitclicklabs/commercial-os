# Agent Runtime

Servicio del Agent OS de PubliEXPE Commercial OS (LLD v0.1, sección 8). Expone la API HTTP del runtime, planifica tareas (`ONCE`, `CRON`, `INTERVAL`) y ejecuta un worker BullMQ que lanza agentes y persiste `TaskRun`, `AgentExecution`, `Trace` y `TraceStep` en PostgreSQL.

Estado: MVP. Además de `StubAgent` (sin LLM) y `SmokeAgent` (tools reales contra Twenty, consulta [Tools](#tools)), el runtime ejecuta el **Prospector v1** con Gemini (consulta [Prospector](#prospector)). `AnthropicProvider` existe como esqueleto y no se llama en los tests.

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
│   ├── agents/               Interfaz de agente, StubAgent, SmokeAgent y ProspectorAgent (+ prompt)
│   ├── integrations/twenty/  TwentyClient REST tipado y mapeo de objetos de la App
│   ├── tools/                Interfaz Tool, registry, tool_policy, executor y tools de Twenty
│   ├── db/                   Esquema Drizzle, cliente y migrador
│   ├── domain/               Estados, máquina de estados e idempotency keys
│   ├── evaluations/          Evaluador HUMAN: mapeo de feedback, vínculo con la ejecución de origen y webhook de Twenty
│   ├── providers/            ModelProvider, StubProvider, AnthropicProvider, GeminiProvider y tabla de precios
│   ├── queue/                RunQueue (BullMQ y en memoria)
<<<<<<< HEAD
│   ├── scheduler/            TaskScheduler sobre BullMQ, parseo de schedules y rutas
=======
│   ├── seed/                 Seed idempotente del Prospector y su tarea (pnpm seed)
>>>>>>> feat/prospector
│   ├── services/             Lanzamiento idempotente de TaskRuns
│   └── worker/               RunProcessor, worker BullMQ, locks por entidad y reconciliador
└── test/
    ├── unit/                 Corren siempre, sin BD ni Redis
    ├── integration/          API, worker, scheduler, locks y tools (PostgreSQL, Redis y Twenty); se saltan si falta el servicio
    ├── helpers/              FakeTwenty: API REST de Twenty en memoria para los unitarios
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
| `DEFAULT_TENANT_ID` | `publiexpe` | Tenant si la petición no envía `x-tenant-id` |
| `DEFAULT_MODEL_PROVIDER` | `stub` | Proveedor para agentes creados sin `model_provider`: `stub`, `anthropic` o `gemini` |
| `ANTHROPIC_API_KEY` | vacío | Solo para agentes con `model_provider=anthropic` |
| `GEMINI_API_KEY` | vacío | API key de Google AI Studio para agentes con `model_provider=gemini` |
| `GEMINI_MODEL` | `gemini-flash-latest` | Modelo de Gemini si la versión del agente no fija uno |
| `TWENTY_BASE_URL` | `http://localhost:3020` | API REST de Twenty. En el contenedor: `http://pxos-twenty:3000` |
| `TWENTY_API_KEY` | vacío | API key de Twenty. Sin ella, las tools de Twenty responden `TWENTY_NOT_CONFIGURED` |
| `TWENTY_TIMEOUT_MS` | `10000` | Timeout por petición a Twenty |
| `TWENTY_WEBHOOK_SECRET` | vacío | Secreto del webhook de Twenty (mínimo 16 caracteres). Sin él, `POST /webhooks/twenty` responde `503` |
| `TWENTY_WEBHOOK_TARGET_URL` | `http://pxos-runtime:4020/webhooks/twenty` | Destino que registra `pnpm register:webhook` si no pasas `--url` |
| `EVALUATION_DEDUPE_WINDOW_MS` | `600000` | Ventana en la que no se repite el mismo veredicto (sujeto, feedback y estado destino) |

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
| `0003_evaluations` | Tabla `evaluations` del evaluador HUMAN. El `0002` lo reserva la rama del event bus. El SQL es idempotente (`IF NOT EXISTS`) |

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
| `GET /scheduler/status` | Job schedulers y jobs `ONCE` registrados del tenant, y contadores de la cola |
| `GET /tasks/:id/runs` | Historial de ejecuciones de la tarea |
| `GET /task-runs/:id` | `TaskRun` con su ejecución, trace y pasos |
| `POST /executions` | Ejecuta un agente sin tarea (idempotente con `idempotency_key`) |
| `GET /executions`, `GET /executions/:id` | Lista o detalle con trace y pasos |
| `POST /executions/:id/cancel` | `QUEUED` o `RUNNING` a `CANCELLED` |
| `POST /executions/:id/{pause,resume}` | `501`, requiere harness con checkpoints |
| `POST /webhooks/twenty` | Webhook de Twenty firmado. Convierte cambios de `commercialHypothesis` en evaluaciones HUMAN |
| `POST /evaluations/human` | Registra un veredicto manual: `201` nuevo, `200` duplicado |
| `GET /evaluations` | Lista evaluaciones. Filtros: `subject_id`, `subject_type`, `feedback`, `agent_execution_id`, `since`, `limit` |

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

Todas usan Twenty (`TWENTY_BASE_URL`, `TWENTY_API_KEY`) y tienen `outputTrust = trusted`.

| Tool | Riesgo | Efectos | Idempotencia |
|---|---|---|---|
| `find_company` | `READ` | No | — |
| `get_company` | `READ` | No | — |
| `upsert_company` | `LOW_WRITE` | Sí | Por dominio normalizado: `publi:company:create:domain:{domain}` |
| `create_signal` | `LOW_WRITE` | Sí | Empresa + tipo + `eventDate` + `sourceDomain` |
| `create_research` | `LOW_WRITE` | Sí | Ejecución + empresa + `researchType` |
| `create_hypothesis` | `LOW_WRITE` | Sí | Empresa + `name` (por defecto `{empresa} — {need}`) |
| `create_agent_run_summary` | `LOW_WRITE` | Sí | `agentExecutionId` |

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

`src/integrations/twenty/client.ts` es un cliente REST tipado sobre `/rest/{objeto}` con `list`, `get`, `create`, `update` y `ping`. **No tiene método de borrado.**

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

`ProspectorAgent` (`configuration.implementation = "prospector"`) evalúa los expositores de un evento y propone hipótesis de merchandising para PubliEXPE. Es la versión 1: recibe el evento y los expositores ya extraídos (todavía no busca en la web).

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

### Trace y coste

Cada llamada al LLM es un paso `MODEL` con `model` (el modelo real que respondió, por ejemplo `gemini-3.8-flash`), tokens y `output.cost` (`amount`, `currency`). Cada tool es un paso `TOOL` con `output.costEur`. `AgentExecution.model_cost` y `TaskRun.cost` acumulan el coste del proveedor en USD; `output.cost.eur` y el `agentRunSummary` lo convierten a EUR con `configuration.usd_to_eur` (por defecto `0.86`).

### Configuración de la versión

| Clave de `configuration` | Por defecto | Uso |
|---|---|---|
| `implementation` | — | `prospector` |
| `tool_policy` | — | `find_company`, `upsert_company`, `create_signal`, `create_hypothesis`, `create_agent_run_summary`; techo `LOW_WRITE` |
| `min_confidence` | `0.5` | Umbral para escribir en Twenty |
| `usd_to_eur` | `0.86` | Conversión del coste para Twenty |
| `model_options` | `{}` | `thinking_level` (Gemini 3.x), `thinking_budget` (Gemini 2.5), `temperature` |
| `max_output_tokens` | `4096` | Por llamada; incluye los tokens de razonamiento |
| `task_name` | `daily-event-prospecting` | Campo `task` del `agentRunSummary` |

### Seed

```sh
pnpm seed                                        # tenant DEFAULT_TENANT_ID (publiexpe)
pnpm seed -- --tenant=otro --input=evento.json
```

Es idempotente:

- **Agente `Prospector`**: si no existe, lo crea con la versión 1 `ACTIVE` (`model_provider = gemini`, `model = gemini-flash-latest`, `thinking_level = low`, la tool policy anterior y el prompt en español con los diferenciales de PubliEXPE: ofertas, trato cercano, taller propio y precio). Si existe y su versión activa es distinta, añade una versión nueva, la activa y pasa la anterior a `DEPRECATED`. Si es igual, no cambia nada.
- **Tarea `daily-event-prospecting`**: `CRON 0 8 * * *` en `Europe/Madrid`, `timeout_ms = 900000`, sin reintentos, con `test/fixtures/feria-ejemplo.json` como `default_input`. Si cambia, se actualiza y se guarda una `TaskDefinitionVersion` nueva. El scheduler que la dispara a las 08:00 llega en otra rama; mientras tanto, lánzala con `POST /tasks/:id/run`.

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

### Tests del Prospector

- `test/unit/prospector-agent.test.ts` y `test/unit/gemini-provider.test.ts`: con `StubProvider` (respuestas guionizadas) y `FakeTwenty`. Cubren el parseo, el reintento por JSON inválido, el flujo de tools, la idempotencia y la agregación de coste.
- `test/integration/prospector-live.test.ts`: **en vivo**. Ejecuta el seed y un `TaskRun` con la fixture contra Gemini, Twenty y PostgreSQL reales, y comprueba empresa, señal, hipótesis y `agentRunSummary` en Twenty. Se salta si falta `GEMINI_API_KEY`, `TWENTY_API_KEY`, Twenty o PostgreSQL, o si `SKIP_LLM_TESTS=1`. Usa los nombres de la fixture (datos de demo, sin prefijo `[TEST]`) en el tenant `publiexpe`; como todas las escrituras son idempotentes, repetirlo solo añade un `agentRunSummary`. Cuesta unos 0,005 € por ejecución.

Para ejecutarlo en local, copia también la clave de Gemini a tu `.env`:

```sh
grep '^GEMINI_API_KEY=' ../../deployments/.env >> .env
pnpm vitest run test/integration/prospector-live.test.ts
```

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

Si no envías `agent_execution_id` (o `agentExecutionId`), el runtime resuelve el vínculo como en el webhook. Si lo envías, debe existir en el tenant (si no, `404`). Responde con `evaluatorId`, `executionId`, `scores.TASK_SUCCESS`, `passed`, `deduplicated` y la evaluación guardada.

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

## Pendiente

<<<<<<< HEAD
- Triggers `EVENT`, `DEPENDENCY` y `CONDITION` (hoy no registran nada).
- Columna `trigger` (`SCHEDULE`, `MANUAL`...) en `task_runs` para distinguir el origen de cada run (LLD v0.2, AC-04).
- Exponer `EntityLocks` a las tools (el helper está listo en `RunProcessor.locks`).
- Política de catch-up si el scheduler estuvo parado: hoy, al volver, se procesa el slot pendiente (tarde, con su `scheduled_at` original) y los demás slots perdidos se omiten.
- Tools pendientes del registro del MVP-0: `search_web`, `fetch_url`, `create_activity` y las del Catalog Service.
=======
- Scheduler (`CRON`, `INTERVAL`, `EVENT`...): hoy solo hay lanzamiento manual con `POST /tasks/:id/run`.
- `max_concurrency` por tarea y locks por entidad (LLD sección 21).
- Recuperación de jobs atascados (`RUNNING` tras caída del worker).
- Harness, skills, memoria y verificador reales; promote, rollback y evaluate.
- Tools pendientes del registro del MVP-0: `search_web`, `fetch_url`, `create_activity` y las del Catalog Service. Con ellas, el Prospector descubrirá eventos y expositores por sí mismo y recomendará productos reales del catálogo.
- `GeminiProvider.stream()` no es incremental: devuelve la respuesta completa en un solo fragmento.
>>>>>>> feat/prospector
- Validación de URL en campos de texto libre contra las fuentes del trace (LLD v0.2 sección 10.4, punto 4).
- Harness, skills, memoria y verificador reales; promote, rollback y evaluate.
- Publicación de eventos (`task.started`, `task.completed`...) en el event bus.
- Export de los contratos zod a JSON Schema versionado en `schemas/`.
