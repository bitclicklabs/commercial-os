# Agent Runtime

Servicio del Agent OS de PubliEXPE Commercial OS (LLD v0.1, sección 8). Expone la API HTTP del runtime y ejecuta un worker BullMQ que lanza agentes y persiste `TaskRun`, `AgentExecution`, `Trace` y `TraceStep` en PostgreSQL.

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
│   ├── main.ts               Entrada: API y/o worker según RUNTIME_ROLE o --role=
│   ├── config.ts             Configuración desde variables de entorno
│   ├── api/                  Servidor Fastify, contratos zod y rutas
│   ├── agents/               Interfaz de agente, StubAgent, SmokeAgent y ProspectorAgent (+ prompt)
│   ├── integrations/twenty/  TwentyClient REST tipado y mapeo de objetos de la App
│   ├── tools/                Interfaz Tool, registry, tool_policy, executor y tools de Twenty
│   ├── db/                   Esquema Drizzle, cliente y migrador
│   ├── domain/               Estados, máquina de estados e idempotency keys
│   ├── providers/            ModelProvider, StubProvider, AnthropicProvider, GeminiProvider y tabla de precios
│   ├── queue/                RunQueue (BullMQ y en memoria)
│   ├── seed/                 Seed idempotente del Prospector y su tarea (pnpm seed)
│   ├── services/             Lanzamiento idempotente de TaskRuns
│   └── worker/               RunProcessor y worker BullMQ
└── test/
    ├── unit/                 Corren siempre, sin BD ni Redis
    ├── integration/          API + worker contra PostgreSQL y tools contra Twenty; se saltan si no hay servicio
    ├── helpers/              FakeTwenty: API REST de Twenty en memoria para los unitarios
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

   La API escucha en `http://127.0.0.1:4020`. Para separar procesos, usa `pnpm dev:api` y `pnpm dev:worker`.

### Variables de entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `RUNTIME_ROLE` | `all` | `all`, `api` o `worker` |
| `RUNTIME_HOST` / `RUNTIME_PORT` | `127.0.0.1` / `4020` | Escucha de la API |
| `DATABASE_URL` | `postgres://agentos:agentos_dev@127.0.0.1:5440/agentos` | PostgreSQL del Agent OS |
| `REDIS_URL` | `redis://127.0.0.1:6391` | Redis de BullMQ |
| `QUEUE_NAME` | `pxos-agent-runs` | Cola BullMQ |
| `WORKER_CONCURRENCY` | `4` | Jobs simultáneos por worker |
| `DEFAULT_TENANT_ID` | `publiexpe` | Tenant si la petición no envía `x-tenant-id` |
| `DEFAULT_MODEL_PROVIDER` | `stub` | Proveedor para agentes creados sin `model_provider`: `stub`, `anthropic` o `gemini` |
| `ANTHROPIC_API_KEY` | vacío | Solo para agentes con `model_provider=anthropic` |
| `GEMINI_API_KEY` | vacío | API key de Google AI Studio para agentes con `model_provider=gemini` |
| `GEMINI_MODEL` | `gemini-flash-latest` | Modelo de Gemini si la versión del agente no fija uno |
| `TWENTY_BASE_URL` | `http://localhost:3020` | API REST de Twenty. En el contenedor: `http://pxos-twenty:3000` |
| `TWENTY_API_KEY` | vacío | API key de Twenty. Sin ella, las tools de Twenty responden `TWENTY_NOT_CONFIGURED` |
| `TWENTY_TIMEOUT_MS` | `10000` | Timeout por petición a Twenty |

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

El contenedor aplica las migraciones al arrancar si `RUN_MIGRATIONS=true`.

## Tests

```sh
pnpm test              # todo
pnpm test:unit         # sin dependencias externas
pnpm test:integration  # necesita PostgreSQL; Redis no
pnpm typecheck
pnpm build
```

Los tests de integración comprueban la conexión a `DATABASE_URL` y, si falla, se saltan con un aviso. Para forzar el salto, define `SKIP_DB_TESTS=1`. Cada ejecución usa un tenant nuevo (`it-xxxxxxxx`), así que no borran datos.

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
| `POST /tasks/:id/pause`, `/resume`, `/archive` | Ciclo de vida. No hay `DELETE` |
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

Para escalar, separa roles: un servicio con `RUNTIME_ROLE=api` y N réplicas con `RUNTIME_ROLE=worker` y `RUN_MIGRATIONS=false`.

## Pendiente

- Scheduler (`CRON`, `INTERVAL`, `EVENT`...): hoy solo hay lanzamiento manual con `POST /tasks/:id/run`.
- `max_concurrency` por tarea y locks por entidad (LLD sección 21).
- Recuperación de jobs atascados (`RUNNING` tras caída del worker).
- Harness, skills, memoria y verificador reales; promote, rollback y evaluate.
- Tools pendientes del registro del MVP-0: `search_web`, `fetch_url`, `create_activity` y las del Catalog Service. Con ellas, el Prospector descubrirá eventos y expositores por sí mismo y recomendará productos reales del catálogo.
- `GeminiProvider.stream()` no es incremental: devuelve la respuesta completa en un solo fragmento.
- Validación de URL en campos de texto libre contra las fuentes del trace (LLD v0.2 sección 10.4, punto 4).
- Publicación de eventos (`task.started`, `task.completed`...) en el event bus.
- Export de los contratos zod a JSON Schema versionado en `schemas/`.
