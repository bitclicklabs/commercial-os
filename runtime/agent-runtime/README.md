# Agent Runtime

Servicio del Agent OS de PubliEXPE Commercial OS (LLD v0.1, sección 8). Expone la API HTTP del runtime, planifica tareas (`ONCE`, `CRON`, `INTERVAL`) y ejecuta un worker BullMQ que lanza agentes y persiste `TaskRun`, `AgentExecution`, `Trace` y `TraceStep` en PostgreSQL.

Estado: MVP. Además de `StubAgent` (sin LLM) y `SmokeAgent` (tools reales contra Twenty, consulta [Tools](#tools)), el runtime ejecuta el **Prospector** con Gemini (consulta [Prospector](#prospector)), que también trabaja sobre ferias reales con búsqueda de Google y `fetch_url` ([modo scout](#modo-scout-ferias-reales)). `AnthropicProvider` existe como esqueleto y no se llama en los tests.

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
│   ├── agents/               Interfaz de agente, StubAgent, SmokeAgent y ProspectorAgent (modos directo y scout, prompts, SourceLedger)
│   ├── integrations/twenty/  TwentyClient REST tipado y mapeo de objetos de la App
│   ├── tools/                Interfaz Tool, registry, tool_policy, executor, tools de Twenty y web/ (fetch_url y guarda SSRF)
│   ├── db/                   Esquema Drizzle, cliente y migrador
│   ├── domain/               Estados, máquina de estados e idempotency keys
│   ├── providers/            ModelProvider, StubProvider, AnthropicProvider, GeminiProvider y tabla de precios
│   ├── queue/                RunQueue (BullMQ y en memoria)
│   ├── scheduler/            TaskScheduler sobre BullMQ, parseo de schedules y rutas
│   ├── seed/                 Seed idempotente del Prospector y sus tareas (pnpm seed)
│   ├── services/             Lanzamiento idempotente de TaskRuns
│   └── worker/               RunProcessor, worker BullMQ, locks por entidad y reconciliador
└── test/
    ├── unit/                 Corren siempre, sin BD ni Redis
    ├── integration/          API, worker, scheduler, locks y tools (PostgreSQL, Redis y Twenty); se saltan si falta el servicio
    ├── helpers/              FakeTwenty (API REST de Twenty en memoria) y FakeWeb (DNS y HTTP simulados)
    ├── fixtures/             feria-ejemplo.json: evento de demo con 3 expositores
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
| `FETCH_URL_ALLOWLIST` | vacío | Dominios que `fetch_url` puede descargar, separados por comas (incluye subdominios). Vacío = cualquier host público |
| `FETCH_URL_DENYLIST` | vacío | Dominios que `fetch_url` nunca descarga. Gana sobre la allowlist |
| `FETCH_URL_ALLOWED_PORTS` | `80,443,8080,8443` | Puertos permitidos en las URL de `fetch_url` |

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

Las de Twenty usan `TWENTY_BASE_URL` y `TWENTY_API_KEY` y tienen `outputTrust = trusted`. `fetch_url` descarga de la web y su salida es `untrusted`.

| Tool | Riesgo | Efectos | Idempotencia |
|---|---|---|---|
| `find_company` | `READ` | No | — |
| `get_company` | `READ` | No | — |
| `upsert_company` | `LOW_WRITE` | Sí | Por dominio normalizado: `publi:company:create:domain:{domain}` |
| `create_signal` | `LOW_WRITE` | Sí | Empresa + tipo + `eventDate` + `sourceDomain` |
| `create_research` | `LOW_WRITE` | Sí | Ejecución + empresa + `researchType` |
| `create_hypothesis` | `LOW_WRITE` | Sí | Empresa + `name` (por defecto `{empresa} — {need}`) |
| `create_agent_run_summary` | `LOW_WRITE` | Sí | `agentExecutionId` |
| `fetch_url` | `READ` | No | — (consulta [Seguridad del contenido web](#seguridad-del-contenido-web)) |

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

`ProspectorAgent` (`configuration.implementation = "prospector"`) evalúa los expositores de un evento y propone hipótesis de merchandising para PubliEXPE. Tiene dos modos, que elige por la forma de la entrada:

| Modo | Entrada | Tarea | Qué hace |
|---|---|---|---|
| Directo | `{ event, exhibitors[] }` | `daily-event-prospecting` | Evalúa los expositores ya extraídos (fixture de demo) |
| Scout | `{ sector, region?, horizon_months? }` o `{ event_url }` | `weekly-event-scouting` | Busca ferias reales, descarga su página de expositores y evalúa los expositores reales. Consulta [Modo scout](#modo-scout-ferias-reales) |

El modo scout es un modo del mismo agente, no un agente hermano: el LLD v0.2 asigna al Prospector tanto el descubrimiento de eventos (`search_web`, `fetch_url`) como la evaluación de expositores, y así los dos modos comparten versión, prompt de evaluación, pipeline por expositor, tool policy y trazas.

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

`max_events` (1-3) y `max_exhibitors` (1-50) bajan los límites de la configuración para una ejecución; nunca los suben. Se elige este modo si `mode = "scout"` o si la entrada tiene `sector` o `event_url` y no tiene `event` ni `exhibitors`.

Flujo:

1. **Búsqueda con grounding** (solo con `sector`): una llamada a Gemini con la tool nativa `google_search`. El modelo devuelve hasta `max_events` ferias con `website_url` y `exhibitors_url`. Se descartan las que caen fuera del horizonte.
1. **Verificación de las URL** antes de descargarlas:
   - si el grounding devuelve fuentes, solo se descargan URL cuyo dominio está en esas fuentes (si una fuente solo trae la URL de redirección de `vertexaisearch`, se resuelve con `fetch_url` para conocer su dominio);
   - si el modelo ejecutó búsquedas pero la API no devolvió fuentes (comportamiento observado con `gemini-3.8-flash` el 2026-10-07), la URL se descarga y **la página tiene que corroborar la feria** (el nombre aparece en el dominio o en el título y el texto); si no, se descarta sin escribir nada. `scout.verify_unsourced_by_fetch = false` desactiva esta vía (modo estricto);
   - con `event_url`, la URL la da el operador.
1. **`fetch_url`** de la página de expositores (o de la portada y, después, del enlace de expositores que aparezca entre sus enlaces). Máximo `max_pages_per_event` páginas por feria y `max_fetches` descargas por ejecución.
1. **Extracción**: el LLM extrae `{name, domain?, description?, sector?}` solo del texto descargado. El código descarta los nombres que no aparecen en la página y los dominios que no están en su texto o sus enlaces (ni el de la propia feria ni redes sociales).
1. **Pipeline por expositor**, el mismo del modo directo, con `source_url` = la página de expositores visitada.
1. **Sin lista de expositores** (catálogo dinámico, PDF, página vacía): la feria se registra como señal `FAIR` a nivel de evento (`create_signal` sin `companyId`, con la URL visitada) y el `outcome` es `PARTIAL` con el motivo en `partial_reasons` y en el `agentRunSummary`.

`outcome`: `FAILED` si falla la búsqueda o todos los expositores; `PARTIAL` si hay errores, ninguna feria verificable o alguna feria sin lista de expositores; `SUCCESS` en otro caso. La salida incluye `events[]` (páginas leídas, verificación, expositores descartados), `discarded_events[]` con el motivo, `sources` (URL visitadas y fuentes de grounding) y el coste de búsqueda.

### Seguridad del contenido web

Regla del LLD v0.1 §22 y v0.2 §10.4: `WEB CONTENT ≠ INSTRUCTIONS`.

- **Separación de canales.** El contenido web (páginas descargadas, respuesta de la búsqueda, datos extraídos de ellas) entra **solo** en mensajes `user`, nunca en `systemInstruction`.
- **Delimitación.** Siempre va dentro de un bloque `<<<DATOS_NO_CONFIABLES id=… origen="…">>> … <<<FIN_DATOS_NO_CONFIABLES id=…>>>` con un id aleatorio por bloque, precedido de la instrucción de ignorar cualquier orden que contenga. Las secuencias que imitan los marcadores se neutralizan, así que el contenido no puede cerrar el bloque. Los prompts de sistema (texto fijo, de confianza) repiten la regla.
- **El modelo no elige tools.** El código decide qué tool llamar y con qué argumentos; el modelo solo devuelve JSON validado con zod. Una instrucción inyectada no puede provocar una llamada.
- **Fuentes verificadas.** Todo `sourceUrl` que se escribe en Twenty se comprueba contra el registro de fuentes de la ejecución (`SourceLedger`): URL visitadas por `fetch_url` o devueltas por el grounding. Las URL propuestas por el modelo solo se descargan si su dominio está respaldado por el grounding, si son enlaces de una página ya descargada o, sin fuentes, si la página corrobora la feria. Los textos libres que van a Twenty (descripción, necesidad, por qué ahora, evidencias) pierden cualquier URL que no sea una fuente conocida (`[enlace omitido]`).
- **Elementos ocultos.** `fetch_url` elimina `script`, `style`, `template`, `svg`, `iframe` y los elementos con `hidden`, `aria-hidden="true"` o `display:none`, vehículos habituales de inyección.

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
| Tipos | Solo texto (HTML, XHTML, XML, JSON, `text/*`); un PDF devuelve `UNSUPPORTED_CONTENT_TYPE` |
| Cabeceras | `User-Agent: PubliexpeCommercialOS/0.1` (solo ASCII: un carácter no ASCII provocaba 403 en ifema.es y alimentaria.com), sin cookies ni cabeceras de autenticación |

Códigos de error de `fetch_url`: `URL_NOT_ALLOWED`, `REDIRECT_NOT_ALLOWED`, `SSRF_BLOCKED`, `DNS_ERROR`, `TOO_MANY_REDIRECTS`, `FETCH_TIMEOUT`, `HTTP_ERROR`, `UNSUPPORTED_CONTENT_TYPE`, `NETWORK_ERROR`.

### Trace y coste

Cada llamada al LLM es un paso `MODEL` con `model` (el modelo real que respondió, por ejemplo `gemini-3.8-flash`), tokens y `output.cost` (`amount`, `currency` y, con grounding, `grounding` y `grounding_units`). La llamada con búsqueda guarda además `output.grounding` (consultas, fuentes, `source_trust = untrusted`). Cada tool es un paso `TOOL` con `output.costEur`. `AgentExecution.model_cost` y `TaskRun.cost` acumulan el coste del proveedor en USD; `output.cost.eur` y el `agentRunSummary` lo convierten a EUR con `configuration.usd_to_eur` (por defecto `0.86`).

### Configuración de la versión

| Clave de `configuration` | Por defecto | Uso |
|---|---|---|
| `implementation` | — | `prospector` |
| `tool_policy` | — | `find_company`, `upsert_company`, `create_signal`, `create_hypothesis`, `create_agent_run_summary`, `fetch_url` (máximo 15 llamadas); techo `LOW_WRITE`; 240 llamadas por ejecución |
| `min_confidence` | `0.5` | Umbral para escribir en Twenty |
| `usd_to_eur` | `0.86` | Conversión del coste para Twenty |
| `model_options` | `{}` | `thinking_level` (Gemini 3.x), `thinking_budget` (Gemini 2.5), `temperature` |
| `max_output_tokens` | `4096` | Por llamada; incluye los tokens de razonamiento |
| `task_name` | `daily-event-prospecting` | Campo `task` del `agentRunSummary` (modo directo) |
| `scout.task_name` | `weekly-event-scouting` | Campo `task` del `agentRunSummary` (modo scout) |
| `scout.max_events` | `3` | Ferias por ejecución (máximo 3) |
| `scout.max_exhibitors_per_event` | `20` | Expositores evaluados por feria |
| `scout.max_fetches` | `12` | Descargas por ejecución |
| `scout.max_pages_per_event` | `2` | Páginas leídas por feria |
| `scout.max_redirect_resolutions` | `3` | Redirecciones de grounding resueltas para conocer su dominio |
| `scout.event_signal_confidence` | `0.5` | Confianza de la señal de evento sin expositores |
| `scout.verify_unsourced_by_fetch` | `true` | Sin fuentes de grounding, aceptar la URL si la página corrobora la feria. `false` = estricto |

### Seed

```sh
pnpm seed                                        # tenant DEFAULT_TENANT_ID (publiexpe)
pnpm seed -- --tenant=otro --input=evento.json
```

Es idempotente:

- **Agente `Prospector`**: si no existe, lo crea con la versión 1 `ACTIVE` (`model_provider = gemini`, `model = gemini-flash-latest`, `thinking_level = low`, la tool policy anterior y el prompt en español con los diferenciales de PubliEXPE: ofertas, trato cercano, taller propio y precio). Si existe y su versión activa es distinta, añade una versión nueva, la activa y pasa la anterior a `DEPRECATED`. Si es igual, no cambia nada.
- **Tarea `daily-event-prospecting`**: `CRON 0 8 * * *` en `Europe/Madrid`, `timeout_ms = 900000`, sin reintentos, con `test/fixtures/feria-ejemplo.json` como `default_input`. Si cambia, se actualiza y se guarda una `TaskDefinitionVersion` nueva.
- **Tarea `weekly-event-scouting`** (modo scout): `CRON 30 7 * * 1` (lunes 07:30) en `Europe/Madrid`, `timeout_ms = 1800000`, sin reintentos, `default_input = { "sector": "alimentación y bebidas", "region": "España", "horizon_months": 6 }`.

Las dos tareas usan la misma versión del agente. La versión del seed añade `fetch_url` a la tool policy, la configuración `scout` y la skill `event-source-discovery` v1, y sube la skill `prospector-event-exhibitors` a v2 (datos en bloques `DATOS_NO_CONFIABLES`): al ejecutar el seed sobre una BD existente se crea una versión nueva del agente.

> **Importante:** ejecuta el seed después de desplegar este código. Un runtime anterior trataría la entrada de `weekly-event-scouting` como entrada directa no válida y cerraría la ejecución del lunes como `FAILED`.

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

- `test/unit/fetch-url.test.ts`: guardas SSRF (rangos IPv4/IPv6, URL internas, allow/denylist, IP privada en DNS, DNS mixto, redirección a IP privada o a host privado, límite de redirecciones), truncado de texto y de bytes (también tras gzip, con un servidor local real), timeout, tipos de contenido, charset y `htmlToText`.
- `test/unit/gemini-grounding.test.ts`: cuerpo con `google_search`, parseo de `groundingMetadata` y de las partes `toolCall` / `toolResponse`, y precio por consulta.
- `test/unit/event-scout.test.ts`: modo scout con `StubProvider`, `FakeWeb` (DNS y transporte simulados) y `FakeTwenty`: extracción y verificación de expositores, delimitación del contenido web e intento de inyección, validación de `source_url`, URL no respaldadas, señal de evento, redirecciones de grounding, verificación por corroboración, horizonte y fallos.
- `test/integration/event-scout-live.test.ts`: **en vivo**, con grounding real. No ejecuta el seed: usa su propio agente (`Prospector Scout (live test)`) y una tarea `MANUAL` (`event-scouting-live-test`), así no programa nada. Limitado a 1 feria y 5 expositores; cuesta unos 0,10 USD (casi todo, búsquedas). `SKIP_LLM_TESTS=1` lo salta. Con `SCOUT_LIVE_EVENT_URL=https://…` (y `-t event_url`) ejecuta el modo `event_url`, sin grounding.

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

## Pendiente

- Triggers `EVENT`, `DEPENDENCY` y `CONDITION` (hoy no registran nada).
- Columna `trigger` (`SCHEDULE`, `MANUAL`...) en `task_runs` para distinguir el origen de cada run (LLD v0.2, AC-04).
- Exponer `EntityLocks` a las tools (el helper está listo en `RunProcessor.locks`).
- Política de catch-up si el scheduler estuvo parado: hoy, al volver, se procesa el slot pendiente (tarde, con su `scheduled_at` original) y los demás slots perdidos se omiten.
- Harness, skills, memoria y verificador reales; promote, rollback y evaluate.
- Tools pendientes del registro del MVP-0: `search_web` (hoy la búsqueda es el grounding de Gemini, un paso `MODEL`; el LLD prevé fuentes ligadas a pasos `TOOL`), `create_activity` y las del Catalog Service.
- Modo scout: muchas ferias publican el catálogo de expositores como aplicación JavaScript o PDF, que `fetch_url` no lee (queda como señal de evento). Falta extracción de PDF o render de JavaScript.
- `GeminiProvider.stream()` no es incremental: devuelve la respuesta completa en un solo fragmento.
- Validación de URL en campos de texto libre contra las fuentes del trace (LLD v0.2 sección 10.4, punto 4) en el modo directo: el modo scout ya la aplica con su `SourceLedger`.
- Publicación de eventos (`task.started`, `task.completed`...) en el event bus.
- Export de los contratos zod a JSON Schema versionado en `schemas/`.
