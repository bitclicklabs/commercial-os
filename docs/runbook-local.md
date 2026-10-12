# Runbook de operación local

Guía para arrancar, parar y diagnosticar el entorno local de Commercial OS: Twenty CRM, la infraestructura del Agent OS y el Agent Runtime.

Los huecos que siguen abiertos están marcados con `[POR COMPLETAR]`. Cuando cierres uno, sustituye el texto por el valor real y quita la marca.

> **Precaución:** el host ejecuta otras instancias Docker en producción. Trabaja solo con recursos cuyo nombre empiece por `pxos`. **Nunca** ejecutes `docker compose down -v`, `docker volume rm`, `docker system prune` ni `rm -rf` fuera de tu worktree.

## Mapa del entorno

| Servicio | Contenedor | Puerto host |
|---|---|---|
| Twenty (UI + API) | `pxos-twenty` | `127.0.0.1:3020` |
| Worker de Twenty | `pxos-twenty-worker` | — |
| Postgres de Twenty | `pxos-twenty-db` | — (interno) |
| Redis de Twenty | `pxos-twenty-redis` | — (interno) |
| PostgreSQL del Agent OS (BD `agentos`) | `pxos-postgres` | `127.0.0.1:5440` |
| Redis del Agent OS (BullMQ) | `pxos-redis` | `127.0.0.1:6391` |
| Agent Runtime (API + worker) | `pxos-runtime` | `127.0.0.1:4020` |
| Renderer (Playwright + Chromium, lee catálogos JavaScript) | `pxos-renderer` | interno; `127.0.0.1:4030` en desarrollo |

Red: `pxos-net`. Volúmenes: `pxos-twenty-db-data`, `pxos-twenty-local-data`, `pxos-postgres-data`, `pxos-redis-data`. Puertos reservados y ocupados por otros proyectos: [PORTS.md](PORTS.md).

Todos los comandos `docker compose` de este runbook se ejecutan desde `deployments/`.

## Antes de empezar

1. Comprueba que tienes Docker Engine 24 o posterior con Docker Compose v2:

   ```bash
   docker --version
   docker compose version
   ```

2. Comprueba que los puertos del proyecto están libres:

   ```bash
   docker ps --format "table {{.Names}}\t{{.Ports}}"
   ```

   Si alguno de `3020`, `5440`, `6391` o `4020` aparece en un contenedor que no empieza por `pxos`, detente y revisa [PORTS.md](PORTS.md).

3. Verifica que existe el archivo `deployments/.env`. Si no existe, créalo desde `deployments/.env.example` y genera los secretos:

   ```bash
   cd deployments
   cp .env.example .env
   openssl rand -base64 32   # pega el resultado en ENCRYPTION_KEY
   openssl rand -base64 32   # pega el resultado en APP_SECRET
   ```

   `.env` está en `.gitignore`. No lo subas nunca al repositorio.

4. Añade al final de `deployments/.env` las variables del runtime que `.env.example` todavía no incluye. El compose las lee con `${...}` y las pasa a `pxos-runtime`:

   ```bash
   TWENTY_API_KEY=
   ANTHROPIC_API_KEY=
   GEMINI_API_KEY=
   ```

   Déjalas vacías en el primer arranque. Rellena `TWENTY_API_KEY` después de crear el workspace (paso 5 de [Arranque](#arranque)). `GEMINI_API_KEY` (clave de Google AI Studio) hace falta para el Prospector, que usa `model_provider=gemini`. `ANTHROPIC_API_KEY` solo hace falta si un agente usa `model_provider=anthropic`; con el proveedor `stub` (valor por defecto) puedes dejarla vacía.

   Si `deployments/.env.example` ya incluye alguna de estas variables, no las dupliques.

   Para que el BajasAgent lea el buzón de bajas, rellena también `IONOS_IMAP_USER` y `IONOS_IMAP_PASSWORD` (ya figuran en `.env.example`; la contraseña del buzón no se sube al repositorio).

### Variables del runtime

`pxos-runtime` recibe su configuración del bloque `environment` de `deployments/docker-compose.yml`. Para el runtime fuera de Docker, las mismas variables viven en `runtime/agent-runtime/.env`.

| Variable | Valor en el compose | Uso |
|---|---|---|
| `RUNTIME_ROLE` | `all` | `all` (API y worker), `api` o `worker` |
| `RUNTIME_HOST` / `RUNTIME_PORT` | `0.0.0.0` / `4020` | Escucha de la API dentro del contenedor |
| `DATABASE_URL` | `postgres://agentos:…@pxos-postgres:5432/agentos` | PostgreSQL del Agent OS, por la red `pxos-net` |
| `REDIS_URL` | `redis://pxos-redis:6379` | Redis de BullMQ |
| `QUEUE_NAME` | `pxos-agent-runs` | Cola BullMQ |
| `WORKER_CONCURRENCY` | `4` | Jobs simultáneos por worker |
| `DEFAULT_TENANT_ID` | `publiexpe` | Tenant si la petición no envía `x-tenant-id` |
| `DEFAULT_MODEL_PROVIDER` | `stub` | Proveedor para agentes creados sin `model_provider` |
| `RUN_MIGRATIONS` | `true` | El contenedor aplica las migraciones de Drizzle al arrancar |
| `LOG_LEVEL` | `info` | Nivel de log |
| `ANTHROPIC_API_KEY` | `${ANTHROPIC_API_KEY:-}` | Solo para agentes con `model_provider=anthropic` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | `${GEMINI_API_KEY:-}` / `${GEMINI_MODEL:-}` | Proveedor del Prospector (`model_provider=gemini`). `GEMINI_MODEL` vacío usa `gemini-flash-latest` |
| `TWENTY_BASE_URL` | `http://pxos-twenty:3000` | URL de Twenty por la red `pxos-net` |
| `TWENTY_API_KEY` | `${TWENTY_API_KEY:-}` | API key de Twenty para que el runtime escriba en el CRM. Debe tener el rol restringido «Agent runtime» ([Rol de la API key](#rol-de-la-api-key-de-twenty)) |
| `IONOS_IMAP_HOST` / `IONOS_IMAP_USER` / `IONOS_IMAP_PASSWORD` | `${IONOS_IMAP_*:-}` | Buzón que lee el BajasAgent, **solo lectura**. Sin usuario o contraseña, la tarea `process-unsubscribes` termina `SKIPPED` y no lee nada |
| `RENDERER_URL` | `http://pxos-renderer:3000` | Servicio de render de JavaScript del scout |
| `TRACE_RETENTION_DAYS` | `${TRACE_RETENTION_DAYS:-90}` | Antigüedad (en días) a partir de la cual se archivan los payloads pesados, tanto en `pnpm traces:archive` (si no se indica `--older-than`) como en el archivado programado. Consulta [Archivado de trazas](#archivado-de-trazas) |
| `TRACE_ARCHIVE_DIR` | `/data/trace-archive` | Directorio donde se escriben los JSONL comprimidos (volumen `pxos_trace_archive`). Debe estar en un volumen persistente (consulta [Archivado de trazas](#archivado-de-trazas)) |
| `TRACE_ARCHIVE_ENABLED` | `false` por defecto | Activa el [archivado programado](#archivado-programado): un job interno del runtime. Solo `true` lo enciende. Tanda 13 |
| `TRACE_ARCHIVE_INTERVAL_MS` | `86400000` (24 h) por defecto | Cada cuántos milisegundos corre el archivado programado. Solo tiene efecto con `TRACE_ARCHIVE_ENABLED=true`. Tanda 13 |
| `MODEL_ROUTE_EXECUTOR_CHEAP`, `MODEL_ROUTE_EXECUTOR_REASONER`, `MODEL_ROUTE_JUDGE`, `MODEL_ROUTE_TRIAGE`, `MODEL_ROUTE_OPTIMIZER` | vacías | Override del modelo de un rol, con el formato `proveedor:modelo` (por ejemplo `gemini:gemini-2.5-flash`). Vacía o ausente: el modelo por defecto del rol. Consulta [Model routing](model-routing.md). Tanda 13 |
| `CATALOG_ENABLED` | `false` por defecto | Interruptor del [Catalog Service](catalog-service.md). Con `false`, las tools `catalog_*` no se exponen y no se comprueba la salud del conector. Solo `true` lo enciende. Tanda 14 |
| `CATALOG_PROVIDER` | `stub` por defecto | `stub` (datos de muestra fieles al contrato) o `http` (el conector real de publiexpe). Solo tiene efecto con `CATALOG_ENABLED=true`. Tanda 14 |
| `CATALOG_BASE_URL` | vacía | Dirección del conector por la VPN. Obligatoria con `CATALOG_PROVIDER=http`. Es el único host exento del guard anti-SSRF. Tanda 14 |
| `CATALOG_API_TOKEN` | vacía | Token Bearer de solo lectura del catálogo (`pxcat_…`), que da de alta el backend de publiexpe. Es un secreto: solo en `deployments/.env`. Tanda 14 |
| `OPTIMIZER_SCHEDULE_ENABLED` | `false` por defecto | Activa la ejecución [programada](skill-optimizer.md#programado) del Skill Optimizer (por defecto, `0 9 * * 3` en `Europe/Madrid`). Solo `true` la enciende; solo encola y nunca promueve nada. Tanda 14 |
| `OPTIMIZER_SCHEDULE_CRON` | `0 9 * * 3` (miércoles 09:00 Europe/Madrid) | Cadencia del optimizador programado. Solo con `OPTIMIZER_SCHEDULE_ENABLED=true` |
| `OPTIMIZER_SCHEDULE_SKILLS` | `prospector-event-exhibitors` | Skills que encola el programado, separadas por comas |
| `SCHEDULER_TENANTS` | `publiexpe` por defecto | Allowlist de tenants cuyas tasks registra y recupera el scheduler, separados por comas. `*` admite todos y **solo** es para entornos de test: con una base compartida, ejecutaría las tasks de test. Tanda 16, tras el [incidente del 2026-10-12](incidentes/2026-10-12-catchup-tenants-test.md) |
| `CATCHUP_MAX_SLOTS` | `1` por defecto | Máximo de slots perdidos que el scheduler recupera por task tras una parada ([Después de una parada larga](#después-de-una-parada-larga)). Tanda 16 |
| `CATCHUP_MAX_AGE_MS` | `172800000` (48 h) por defecto | Antigüedad máxima, en milisegundos, de un slot perdido para recuperarlo. Los más viejos se omiten. Tanda 16 |
| `ALLOW_SHARED_TEST_DB` | sin definir | Solo para los tests de integración, no para el runtime. `1` permite ejecutarlos contra la base llamada `agentos`, que por defecto el guard rechaza ([Tests de integración](#tests-de-integración-base-aislada)). No lo definas en `deployments/.env`. Tanda 16 |
| `ENRICH_PROVIDER` | vacía (apagado) | Proveedor de la **fase 2** de la [búsqueda de contactos](contactos.md#fase-2-enriquecimiento-externo): `stub` (datos ficticios, sin red) o `hunter`. Vacía: la fase 2 no hace nada. La fase 1 (web de la propia empresa) no depende de esta variable. Tanda 17 |
| `ENRICH_API_KEY` | vacía | Clave del proveedor. Obligatoria con `ENRICH_PROVIDER=hunter`. Es un secreto: solo en `deployments/.env`. Tanda 17 |
| `ENRICH_MAX_LOOKUPS_PER_DAY` | `25` | Tope diario de consultas al proveedor. Al agotarse, las hipótesis sin email esperan al día siguiente. Tanda 17 |

> **Nota:** el bloque `environment` de `pxos-runtime` pasa hoy `TRACE_RETENTION_DAYS` y `TRACE_ARCHIVE_DIR`. Si tu `docker-compose.yml` todavía no pasa `TRACE_ARCHIVE_ENABLED`, `TRACE_ARCHIVE_INTERVAL_MS`, las `MODEL_ROUTE_*`, las `CATALOG_*`, `OPTIMIZER_SCHEDULE_ENABLED` o las `ENRICH_*`, añádelas con la forma `${NOMBRE:-}` antes de usarlas: una variable que no llega al contenedor no tiene ningún efecto. Lo mismo vale para `SCHEDULER_TENANTS`, `CATCHUP_MAX_SLOTS` y `CATCHUP_MAX_AGE_MS`: si no las pasas, rigen los valores por defecto (solo `publiexpe`, 1 slot, 48 h), que son los seguros. Con `pxos-runtime` ya levantado, recréalo (`docker compose up -d pxos-runtime`) para que lea los valores nuevos.



> **Nota:** el puente de eventos con n8n ([`docs/n8n-integracion.md`](n8n-integracion.md)) necesita `EXTERNAL_EVENTS_TOKEN` y, para destinos privados, `EXTERNAL_WEBHOOK_ALLOW_PRIVATE`. El `docker-compose.yml` actual no las pasa a `pxos-runtime`: sin ellas, `POST /events/external` responde `503`. Añádelas al bloque `environment` solo si vas a usar el puente.

## Credenciales de desarrollo

Son valores de desarrollo. Cámbialos fuera de local.

| Recurso | Valor |
|---|---|
| Twenty (navegador) | `http://localhost:3020`. No trae usuarios: el primero se crea en el onboarding |
| PostgreSQL del Agent OS | `postgres://agentos:agentos_dev@localhost:5440/agentos` |
| Redis del Agent OS | `redis://localhost:6391` (sin contraseña) |
| Postgres interno de Twenty | `twenty` / `twenty_dev`, BD `twenty` (sin puerto al host) |
| `ENCRYPTION_KEY`, `APP_SECRET` | Los generas tú en `deployments/.env` |
| `TWENTY_API_KEY` | La creas tú en Twenty y la guardas en `deployments/.env` |

Las contraseñas de Postgres solo se aplican al crear el volumen por primera vez. Si cambias `ENCRYPTION_KEY` con datos existentes, copia la anterior en `FALLBACK_ENCRYPTION_KEY`.

## Arranque

1. Levanta el stack completo desde `deployments/`:

   ```bash
   cd deployments
   docker compose up -d
   ```

   El primer arranque descarga imágenes (unos 2 GB), construye la imagen `pxos/agent-runtime:0.1.0` e inicializa la base de datos de Twenty. Tarda entre 3 y 6 minutos. El runtime espera a que `pxos-postgres` y `pxos-redis` estén `healthy` antes de arrancar.

   Si cambias el código del runtime, reconstruye la imagen:

   ```bash
   docker compose up -d --build pxos-runtime
   ```

2. Espera a que los servicios estén en estado `healthy`:

   ```bash
   docker compose ps
   ```

   El worker de Twenty no tiene healthcheck; basta con `Up`.

3. Comprueba cada servicio:

   | Comprobación | Comando | Resultado esperado |
   |---|---|---|
   | Twenty | `curl http://localhost:3020/healthz` | `{"status":"ok",...}` |
   | PostgreSQL del Agent OS | `docker exec pxos-postgres pg_isready -U agentos -d agentos` | `accepting connections` |
   | Redis del Agent OS | `docker exec pxos-redis redis-cli ping` | `PONG` |
   | Runtime | `curl http://127.0.0.1:4020/health` | `{"status":"ok","db":"ok"}` |

   > **Nota:** el `/health` actual del runtime solo comprueba PostgreSQL. El contrato del [LLD v0.2, sección 6.3](LLD-0.2-especificacion.md#63-endpoints) prevé también `redis` y `twenty`; llegará con una versión posterior del runtime.

4. Aplica las migraciones del Agent OS.

   En el contenedor no tienes que hacer nada: `pxos-runtime` las aplica al arrancar porque `RUN_MIGRATIONS=true`. Las migraciones son idempotentes (journal de Drizzle).

   Hoy hay diecisiete migraciones, `0000` a `0016` (la lista completa, con lo que añade cada una, está en el [README del runtime](../runtime/agent-runtime/README.md#migraciones)). Todas se aplican solas al arrancar, sin pasos extra. Las más antiguas con pasos manuales históricos:

   | Migración | Qué añade |
   |---|---|
   | `0004_inbound` | Tabla `inbound_state` (cursor del BajasAgent) |
   | `0005_skills` | Tablas `skills` y `skill_versions` (inmutables por trigger) y la columna `traces.skill_versions` |
   | `0006_event_subscriptions` | Tabla `event_subscriptions` (webhooks salientes hacia n8n) |
   | `0007_email_sends` | Tabla `email_sends` (envíos observados desde Twenty) |
   | `0008_harness` | Tablas `harnesses` y `harness_versions` (inmutables por trigger) y las columnas `agent_versions.harness_ref` y `traces.harness` |

   Las posteriores: `0009_knowledge`, `0010_eval_datasets`, `0011_experiments`, `0012_skill_canaries`, `0013_optimization_runs`, `0014_inbound_triage` (triaje del buzón), `0015_audit_retention` (`audit_log` y los triggers de archivado de trazas) y `0016_experiment_revalidations` (revalidación de `PASS_FORM`). Si dos ramas generan migraciones en paralelo, comprueba las fechas del journal antes de fusionar (el migrador solo avanza por `when`). Para comprobar cuáles están aplicadas (la tabla es la que crea Drizzle por defecto `[NO VERIFICADO]` en esta instancia):

   ```bash
   docker exec pxos-postgres psql -U agentos -d agentos -c "SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY id"
   ```

   > **Importante:** si aplicas las migraciones a mano en una base compartida, aplica la `0005` **antes** de desplegar el código que resuelve skills: usa la columna `traces.skill_versions`. Lo mismo con la `0008` y el código que resuelve el harness: escribe `traces.harness`.

   Tras aplicar la `0008`, ejecuta `pnpm seed`: crea el harness `default-commercial` v1 `ACTIVE` con los valores vigentes y añade a cada agente del seed una versión nueva que lo referencia. El comportamiento no cambia. Consulta [Harness](../runtime/agent-runtime/README.md#harness).

   > **Precaución:** antes de fusionar una rama con migraciones nuevas, comprueba que las fechas (`when`) del journal crecen con el índice. Si no, Drizzle puede saltarse una migración en silencio (consulta [ADR-31](LLD-0.3-estado-real.md#adr-31)). Desde `runtime/agent-runtime/`:

   ```bash
   node -e "const j=require('./drizzle/meta/_journal.json').entries;let ok=true;j.forEach((e,i)=>{if(i&&e.when<=j[i-1].when){ok=false;console.error('when no creciente:',e.tag)}});console.log(ok?'OK':'KO');process.exit(ok?0:1)"
   ```

   Si imprime `KO`, no fusiones: refecha la migración afectada y reencadena su snapshot.

   Para aplicarlas a mano, por ejemplo tras añadir una migración o con el runtime fuera de Docker, ejecuta desde `runtime/agent-runtime/`:

   ```bash
   cd runtime/agent-runtime
   pnpm install
   pnpm db:migrate
   ```

   `pnpm db:migrate` usa `DATABASE_URL` de `runtime/agent-runtime/.env` (copia `.env.example`; el valor por defecto apunta a `127.0.0.1:5440`). Tras un cambio de esquema, genera la migración con `pnpm db:generate` y revisa el SQL antes de aplicarla.

5. Crea el workspace de Twenty y la API key:

   1. Abre `http://localhost:3020`. Te redirige a `/welcome`.
   2. Elige **Continuar con email**, introduce tu email y una contraseña. No se envía email de verificación porque no hay SMTP configurado.
   3. Completa el onboarding: nombre del workspace (por ejemplo `PubliEXPE`) y tu perfil. Puedes omitir la invitación de miembros.
   4. Ve a **Settings → APIs & Webhooks → Create API key**, copia la clave y pégala en `TWENTY_API_KEY` de `deployments/.env`.
   5. Recrea el runtime para que reciba la clave:

      ```bash
      docker compose up -d pxos-runtime
      ```

      Compose detecta el cambio de entorno y recrea solo `pxos-runtime`.

6. Instala la Twenty App con los objetos comerciales. Consulta [Sincronizar la Twenty App](#sincronizar-la-twenty-app).

7. Registra el agente Prospector y las tareas de prospección con el seed. Ejecútalo desde `runtime/agent-runtime/`, con las migraciones aplicadas y `DATABASE_URL` apuntando a `127.0.0.1:5440` (valor por defecto de `.env.example`):

   ```bash
   cd runtime/agent-runtime
   pnpm install    # solo si no lo has hecho
   pnpm seed
   ```

   El seed es idempotente: puedes repetirlo sin duplicar nada. Desde la tanda 7 también siembra el `EmailDrafter`, el `BajasAgent` y las 4 skills como v1 `ACTIVE` (consulta [Skills](#skills-comprobar-que-están-activas)).

   - Crea el agente `Prospector` (versión 1 `ACTIVE`, proveedor `gemini`). Si ya existe y su versión activa difiere, añade una versión nueva y depreca la anterior.
   - Crea o actualiza la tarea `daily-event-prospecting`: `CRON 0 8 * * *` en `Europe/Madrid`. Desde la tanda 15 (versión 2) trabaja en [modo señales](prospeccion-por-senales.md#prospectar-a-diario-en-modo-señales): reparte su presupuesto entre las señales de feria `QUALIFIED` y ya **no lleva la feria de ejemplo** (`feria-ejemplo.json`) como entrada. En una BD existente, `pnpm seed` añade una versión nueva de la tarea; la anterior no se borra.
   - Crea la tarea `EVENT` `prospect-on-qualified`, que prospecta una feria en cuanto el comercial la califica (requiere el [webhook de `commercialSignal`](#webhook-de-commercialsignal-en-twenty)).
   - Deja desactivada la tarea de test huérfana que quedó de pruebas anteriores. Desactivar no borra: el registro y sus ejecuciones se conservan.

   Opciones: `pnpm seed -- --tenant=otro --input=evento.json`. Detalles en el [README del runtime](../runtime/agent-runtime/README.md#seed).

   > **Nota:** el seed solo escribe en la base del Agent OS. Para que la tarea de las 08:00 produzca hipótesis, el runtime necesita `GEMINI_API_KEY` y `TWENTY_API_KEY` en `deployments/.env`, y el proceso con rol `scheduler` (o `all`, que es el valor por defecto) debe estar en marcha.

### Runtime fuera de Docker

Durante el desarrollo del runtime puedes ejecutarlo en tu máquina con recarga en caliente. El puerto `4020` es el mismo, así que para primero el contenedor:

```bash
cd deployments
docker compose stop pxos-runtime

cd ../runtime/agent-runtime
pnpm install
cp .env.example .env     # los valores por defecto apuntan a 127.0.0.1:5440 y 127.0.0.1:6391
pnpm db:migrate
pnpm dev                 # API y worker en un proceso; escucha en http://127.0.0.1:4020
```

Para separar procesos, usa `pnpm dev:api` y `pnpm dev:worker` en terminales distintas. Cuando termines, vuelve al contenedor con `docker compose start pxos-runtime`.

## Flujo de prueba end-to-end

Comprueba que el runtime crea un agente y una tarea, lanza una ejecución idempotente y guarda el trace. Necesitas `jq` y el runtime en `127.0.0.1:4020`, sea en Docker o con `pnpm dev`. En Windows, ejecuta el bloque en Git Bash.

```bash
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

El paso 3 imprime `200` en la segunda llamada. El paso 4 debe devolver:

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

> **Nota:** `POST /agents` devuelve `409` si el nombre ya existe en el tenant. Para repetir el flujo, cambia el nombre del agente o el valor de `x-tenant-id`.

Si el paso 4 devuelve `QUEUED` de forma sostenida, el worker no está procesando la cola. Revisa `docker compose logs pxos-runtime` y que `pxos-redis` esté `healthy`.

## Operación diaria

Una vez desplegado el stack y hecho el seed, la operación del día a día es automática: el scheduler lanza la tarea `daily-event-prospecting` cada día a las 08:00 (Europe/Madrid) y, además, el scout de los lunes (07:30) alimenta la cola de señales de feria. Desde la tanda 15 el trabajo lo guían las señales que califica el comercial ([ciclo completo](prospeccion-por-senales.md)): la tarea de las 08:00 reparte su presupuesto entre las señales `QUALIFIED` vigentes y deja señales de expositor, hipótesis y un resumen de ejecución en Twenty; calificar una señal dispara además la prospección de esa feria al momento. El equipo comercial trabaja con ese resultado según la [guía del equipo comercial](guia-comercial.md).

Tu parte como operador es comprobar que la ejecución ha ocurrido:

1. Abre Twenty y revisa **Commercial OS → Agent runs**. Debe haber una ejecución de hoy: con `Outcome` `Success` si hay señales `QUALIFIED` vigentes, o `Skipped` (coste 0) si no hay ninguna. Un `Skipped` por falta de señales calificadas es normal, no un fallo.
1. Si no la hay o es `Failed` o `Partial`, consulta la run con `curl "http://127.0.0.1:4020/tasks/<TASK_ID>/runs" -H 'x-tenant-id: publiexpe'` y los [logs](#dónde-mirar-los-logs) del runtime. Causas habituales: falta `GEMINI_API_KEY` o `TWENTY_API_KEY`, o el proceso `scheduler` no está en marcha. Consulta [Problemas frecuentes](#problemas-frecuentes).
1. El coste de cada ejecución aparece en el campo **Cost** del resumen. Ahora depende del número de ferias calificadas y de sus expositores; con el run `Skipped`, es 0.
1. Tras calificar una señal, comprueba que el disparo inmediato ha quedado auditado como `prospect.on_qualified` en `GET /audit` ([comprobación](prospeccion-por-senales.md#comprobar-que-funciona)). Si no aparece, revisa el [webhook de `commercialSignal`](#webhook-de-commercialsignal-en-twenty).

1. El canal de email de prospección en frío (`publiexpe.info`) tiene su propia operación diaria y semanal: checklists, vigilancia de informes DMARC y Postmaster Tools, y el calendario de warm-up. Sigue el [plan de warm-up del canal de email](email-warmup.md). El sistema solo deja borradores en Twenty; los envíos los hace una persona, con un clic desde Twenty ([Enviar los borradores desde Twenty](twenty-envio-email.md)) o a mano desde el webmail.

1. Comprueba que la tarea `process-unsubscribes` (cada 2 horas) se ejecuta: `curl "http://127.0.0.1:4020/tasks/<TASK_ID>/runs" -H 'x-tenant-id: publiexpe'`. Un `outcome` `SKIPPED` con el motivo `IMAP no configurado` indica que faltan `IONOS_IMAP_USER` o `IONOS_IMAP_PASSWORD`. Desde la tanda 12 la tarea no solo procesa bajas: clasifica todo el buzón (respuestas, rebotes y automáticos). Consulta [Triaje del inbound](inbound-triaje.md#operación).
1. Si el comercial avisa de que una hipótesis se queda en `Email status` = `Sending`, abre **Workflows → Runs** en Twenty y revisa la ejecución de **Enviar borrador de email**. No relances el envío hasta saber si el correo salió.

> **Nota:** desde la tanda 15 la tarea diaria ya no usa la entrada de ejemplo del seed. Los registros con dominio `.example` que haya en Twenty son anteriores, de demostración. El scouting semanal de ferias (lunes 07:30) y la captura del feedback del comercial están activos.

## Skills: comprobar que están activas

Los prompts de los agentes viven en la BD como skills versionadas ([ADR-29](LLD-0.3-estado-real.md#adr-29)). Consulta cuáles están activas:

```bash
curl -s http://127.0.0.1:4020/skills -H 'x-tenant-id: publiexpe' | jq '.items[] | {name, status, active_version}'
```

Resultado esperado tras el seed: cuatro skills, todas `ACTIVE` y con `active_version` `1` (o la versión que hayas activado después): `prospector-event-exhibitors`, `event-source-discovery`, `exhibitor-list-extraction` y `email-first-contact-draft`.

- **Ver las versiones de una skill:** `curl -s http://127.0.0.1:4020/skills/<nombre> -H 'x-tenant-id: publiexpe'`.
- **Cambiar una skill:** crea una versión nueva (`POST /skills/<nombre>/versions`) y actívala (`POST /skills/<nombre>/versions/<n>/activate`). Las ejecuciones en marcha no cambian; las nuevas usan la versión activa. Los ejemplos están en el [README del runtime](../runtime/agent-runtime/README.md#ciclo-de-vida-por-api).
- **Volver atrás:** depreca la versión activa (`POST /skills/<nombre>/versions/<n>/deprecate`) y se reactiva la anterior.
- **No se puede borrar ni editar el contenido** de una versión: un trigger de la BD lo impide. Para corregir, crea una versión nueva.
- **Qué versión usó una ejecución:** `GET /task-runs/<id>` o `GET /executions/<id>` incluyen `skill_versions` en el trace.

Si una skill no se resuelve (no existe, no hay versión activa o falla la BD), el agente usa el prompt de código como fallback y el runtime registra el aviso `skill not found in the database; falling back to the code constant`. La ejecución no falla. Si lo ves en los [logs](#dónde-mirar-los-logs), ejecuta `pnpm seed` y vuelve a consultar `GET /skills`.

## Rol de la API key de Twenty

La API key del runtime (`TWENTY_API_KEY`) tiene el rol restringido **Agent runtime** en Twenty: lectura y escritura de objetos, **ninguna tool**. Es lo que impide que el runtime pueda enviar correo a través de las tools MCP de Twenty ([ADR-28](LLD-0.3-estado-real.md#adr-28)).

Comprueba que el rol sigue aplicado. Este comando solo lee el catálogo de tools; no envía nada. El resultado esperado es `0`:

```bash
curl -s http://localhost:3020/mcp \
  -H "Authorization: Bearer $TWENTY_API_KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_tool_catalog","arguments":{"categories":["ACTION"]}}}' \
  | grep -c send_email
```

> **Importante:** si el resultado es mayor que `0`, la API key tiene permisos de más. Reasígnale el rol **Agent runtime** en **Settings → APIs & Webhooks** antes de seguir enviando desde Twenty.

El procedimiento completo para crear el rol está en [Enviar los borradores desde Twenty](twenty-envio-email.md#paso-1-restringir-la-api-key-del-runtime). `scripts/sync-twenty-app.ps1` y `pnpm twenty:send-workflow` necesitan una API key con permisos de administración: ejecútalos con una key temporal de rol Admin y revócala después.

## Webhook de `commercialSignal` en Twenty

Desde la tanda 15, calificar una señal de feria dispara la prospección de esa feria al momento. Para que Twenty avise al runtime hay que dar de alta **una vez** un webhook del objeto `commercialSignal`. Es un paso manual del operador: ni el seed ni el runtime lo crean.

> **Nota:** si no lo das de alta, el sistema sigue funcionando: la señal calificada recibe trabajo en el run de las 08:00 del día siguiente. Lo que se pierde es el disparo inmediato.

Requisitos:

- `TWENTY_WEBHOOK_SECRET` (16 caracteres o más) definido en `pxos-runtime`. Es el mismo que usa el webhook de feedback de hipótesis; no hay variable nueva.
- `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS=pxos-runtime,host.docker.internal` en el servidor y el worker de Twenty. Sin ella, Twenty descarta el envío sin registrar ningún error.

Pasos:

1. Abre Twenty y ve a **Settings → APIs & Webhooks → Webhooks → Create webhook**.
1. En **URL**, escribe `http://pxos-runtime:4020/webhooks/twenty` (con el runtime en el host, `http://host.docker.internal:<puerto>/webhooks/twenty`).
1. En **Operations**, añade `commercialSignal.updated` y `commercialSignal.created`. La vía recomendada es `pnpm register:webhook` (con `--dry-run` primero), que actualiza el webhook existente con las tres suscripciones.
1. En **Secret**, pega el valor de `TWENTY_WEBHOOK_SECRET`. No lo pongas en la URL.
1. En **Description**, escribe `pxos-runtime:signal-qualified`.
1. Guarda y comprueba el disparo con una señal de prueba: [Comprobar que funciona](prospeccion-por-senales.md#comprobar-que-funciona).

Reglas:

- Es el **mismo webhook** del feedback (`pxos-runtime:human-feedback`): `register:webhook` lo amplía en el sitio; no crees uno duplicado salvo que lo prefieras separado.
- Twenty no tiene estado "inactivo" para los webhooks: para pausar el disparo inmediato, vacía **Operations**. No borres el webhook.
- Twenty no reintenta entregas fallidas. Un disparo perdido no se recupera, pero el run diario recoge la señal calificada.

Detalle del ciclo, de la idempotencia y de las limitaciones: [Prospección guiada por señales](prospeccion-por-senales.md).

## Backfill de contactos

Desde la tanda 17, al validar una hipótesis el sistema [busca el contacto](contactos.md) y rellena **Email to**. Las hipótesis validadas **antes** de esa tanda no pasaron por ese flujo y siguen sin destinatario. El backfill las recorre y les aplica el mismo proceso (fase 1 y, si `ENRICH_PROVIDER` está configurado, fase 2).

Cuándo ejecutarlo:

- **Una vez**, tras desplegar la tanda 17, para sacar del bloqueo las hipótesis validadas existentes.
- **Después**, solo si quieres reprocesar hipótesis validadas que quedaron sin contacto (por ejemplo, tras activar la fase 2 o tras corregir un fallo de red durante una pasada).

Cómo:

```bash
# Desde runtime/agent-runtime/, con DATABASE_URL apuntando a 127.0.0.1:5440
cd runtime/agent-runtime
pnpm contacts:backfill

# Equivalente por API
curl -s -X POST http://127.0.0.1:4020/contacts/backfill -H 'x-tenant-id: publiexpe'
```

Qué garantiza:

- Solo toca hipótesis `VALIDATED` con **Email to** vacío. **Nunca pisa** una dirección ya escrita.
- Es idempotente: repetirlo no duplica Research ni cambia destinatarios.
- No envía nada y no cambia el **Email status** de ningún borrador.
- La fase 2 respeta `ENRICH_MAX_LOOKUPS_PER_DAY`: si hay más huecos que cupo, el resto espera al día siguiente.

Para comprobar el resultado, abre **Commercial OS → Research** y filtra por «Contacto» (candidatos con su fuente) y «Sin contacto público» (las que no han dado nada). En **Hypotheses**, las validadas con **Email to** relleno ya pueden pasar por la revisión del comercial.

> **Precaución:** el backfill visita las webs de las empresas (hasta unas 6 páginas por empresa). Con muchas hipótesis, tarda; no lo lances en paralelo ni lo repitas sin necesidad.

> **Nota:** que el backfill rellene destinatarios no significa que salgan los correos. El volumen real lo limita el [calendario de warm-up](email-warmup.md#cuánto-enviar-cuando-hay-destinatarios).

## Sincronizar la Twenty App

La Twenty App vive en `apps/twenty-app/` y añade los objetos `commercialSignal`, `research`, `commercialHypothesis` y `agentRunSummary` (criterio AC-01 del LLD v0.2). Necesitas una API key de Twenty (paso 5 de [Arranque](#arranque)).

Elige la variante según tu sistema:

| Sistema | Variante |
|---|---|
| Linux o macOS | Ejecuta `yarn twenty apply` directamente. Pasos en el [README de la App](../apps/twenty-app/README.md#sincronizar-con-la-instancia-de-twenty) |
| Windows | Usa `scripts/sync-twenty-app.ps1` |

### Windows: workaround del CLI de Twenty

En Windows, `yarn twenty apply` falla por dos motivos:

- Aborta con `Resource path must not contain backslashes` porque el CLI compone rutas de recursos con `\`.
- La subida de archivos usa la `SERVER_URL` del servidor (`http://localhost:3020`). Dentro de un contenedor, `localhost` no apunta a Twenty y la subida falla.

El script `scripts/sync-twenty-app.ps1` evita ambos problemas. Ejecuta el `apply` en un contenedor efímero `node:24` conectado a la red `pxos-net`:

1. Copia `apps/twenty-app` a un directorio temporal, sin `node_modules`, `.twenty` ni `.yarn`.
2. Lee `TWENTY_API_KEY` de `deployments/.env`.
3. Lanza `docker run --rm` con la copia montada. Dentro, `socat` reenvía `127.0.0.1:3020` a `pxos-twenty:3000`, de modo que `http://localhost:3020` resuelve como en el host.
4. En el contenedor ejecuta `corepack enable`, `yarn install`, `yarn twenty remote:add --url http://localhost:3020 --api-key $TWENTY_API_KEY --as pxos-tunnel`, `yarn twenty remote:use pxos-tunnel` y `yarn twenty apply`.
5. Elimina el directorio temporal.

Para usarlo, desde la raíz del repositorio en PowerShell (Windows PowerShell 5.1 o posterior):

```powershell
.\scripts\sync-twenty-app.ps1              # apply
.\scripts\sync-twenty-app.ps1 -Action plan # solo previsualiza los cambios
.\scripts\sync-twenty-app.ps1 -Force       # apply --force, tras revisar los borrados con plan
```

Requisitos: Docker Desktop en marcha, el stack levantado (`pxos-twenty` en ejecución y red `pxos-net`) y `TWENTY_API_KEY` definida en `deployments/.env`. La primera ejecución descarga `node:24`, instala `socat` e instala las dependencias de la App; tarda varios minutos. La salida del contenedor aparece en tu terminal.

> **Nota:** si ya tienes `TWENTY_API_KEY` como variable de entorno de la sesión, el script usa esa y no lee `deployments/.env`.

Para comprobar el resultado:

1. Abre `http://localhost:3020/settings/applications#developer` y verifica que aparece `publiexpe-commercial-os`.
2. Abre la barra lateral y verifica la carpeta **Commercial OS** con **Signals**, **Research**, **Hypotheses** y **Agent runs**.
3. En **Settings → Data model**, verifica que existen los cuatro objetos.

## Rotar la API key de Twenty

Rota la clave si se filtra, caduca o el runtime recibe `401` de Twenty.

1. En Twenty, abre **Settings → APIs & Webhooks** y crea una API key nueva. Cópiala.
2. Sustituye el valor de `TWENTY_API_KEY` en `deployments/.env`.
3. Recrea el runtime para que cargue la clave nueva:

   ```bash
   cd deployments
   docker compose up -d pxos-runtime
   ```

4. Comprueba que el runtime arranca sano: `curl http://127.0.0.1:4020/health`.
5. **Reasigna el rol restringido «Agent runtime» a la clave nueva.** Hazlo en **Settings → APIs & Webhooks**, dentro de la clave nueva, **antes** de dejarla en producción: la asignación de la clave anterior no se hereda. Comprueba con el comando de [Rol de la API key de Twenty](#rol-de-la-api-key-de-twenty) que `send_email` no aparece (resultado `0`).
6. En Twenty, revoca la clave anterior desde **Settings → APIs & Webhooks**.

`scripts/sync-twenty-app.ps1` lee la clave de `deployments/.env`, así que usa la nueva automáticamente. Si tienes un remote guardado en `~/.twenty/config.json` (por ejemplo `pxos-local`), actualízalo con `yarn twenty remote:add ... --as pxos-local` y la clave nueva.

> **Precaución:** una clave nueva que conserve el rol Admin permitiría al runtime usar las tools de correo de Twenty en cuanto haya un buzón conectado. No la uses sin reasignar el rol. Con qué rol nace una clave nueva no consta en las fuentes `[NO VERIFICADO]`: comprueba el rol siempre.

> **Nota:** el runtime usa `TWENTY_API_KEY` en cada escritura (tools de Twenty del Prospector). Si la clave es inválida, la ejecución registra el error `TWENTY_NOT_CONFIGURED` (sin clave) o `TWENTY_UNAUTHORIZED` (clave rechazada) en el trace.

## Archivado de trazas

Las trazas (`trace_steps`) guardan los payloads de cada paso: prompts, respuestas del modelo y resultados de herramientas. Con el tiempo son lo que más pesa en la base del Agent OS. La política de retención del [LLD v0.1, sección 22](LLD-0.1-publiexpe-commercial-os.md) se aplica **sin pérdida**: los payloads pesados se exportan a un fichero y el paso conserva un puntero, de modo que la traza sigue siendo legible.

> **Importante:** el archivado es **manual por defecto**. Desde la tanda 13 existe además un [archivado programado](#archivado-programado), que está **apagado** hasta que lo actives con `TRACE_ARCHIVE_ENABLED=true`. Los dos hacen lo mismo y con las mismas garantías; solo cambia quién los lanza.

### Variables

| Variable | Uso |
|---|---|
| `TRACE_RETENTION_DAYS` | Antigüedad por defecto, en días, de lo que se archiva (90 si no la defines). El argumento `--older-than` la sustituye en el comando manual |
| `TRACE_ARCHIVE_DIR` | Directorio de destino de los ficheros JSONL comprimidos |
| `TRACE_ARCHIVE_ENABLED` | `true` enciende el archivado programado. Por defecto, apagado |
| `TRACE_ARCHIVE_INTERVAL_MS` | Intervalo del archivado programado, en milisegundos. Por defecto 24 h (`86400000`) |

> **Precaución:** `TRACE_ARCHIVE_DIR` debe apuntar a un volumen que sobreviva al contenedor. Si el comando corre dentro de `pxos-runtime` y el directorio está en el sistema de ficheros efímero, perderás el archivo al recrear el contenedor y los punteros quedarán rotos. El `docker-compose.yml` actual fija `TRACE_ARCHIVE_DIR=/data/trace-archive` y lo monta en el volumen persistente `pxos_trace_archive`; no lo quites. Incluye el volumen en tus copias de seguridad: [Backup](#backup) solo cubre las bases de datos.

### Archivar

Desde `runtime/agent-runtime/`, con `DATABASE_URL` apuntando a `127.0.0.1:5440`:

```bash
cd runtime/agent-runtime
pnpm traces:archive --older-than 90
```

El comando, por cada traza más antigua que el umbral:

1. Escribe los payloads pesados de sus pasos en un fichero JSONL comprimido dentro de `TRACE_ARCHIVE_DIR`.
1. **Verifica lo escrito**: vuelve a leer el fichero y comprueba que cada línea coincide con el original.
1. Solo si la verificación es correcta, sustituye el payload del paso por un puntero `{archived, file, line}`.

Si la verificación falla, el paso no se toca y el comando lo indica. Nada se borra antes de comprobar que está a salvo en el archivo.

> **Nota:** las trazas son inmutables por triggers de la base de datos (migración `0015`), con una única excepción: un payload pesado solo puede pasar a su puntero exacto y verificado. Cualquier otro cambio sobre `trace_steps` falla, y no hay `DELETE` físico en `traces` ni en `trace_steps`. Consulta el [README del runtime](../runtime/agent-runtime/README.md#retención-de-trazas-sin-pérdida-pnpm-tracesarchive) para el detalle.

### Archivado programado

El archivado programado ejecuta por sí solo el mismo proceso que `pnpm traces:archive`, para que la base no crezca sin que nadie se acuerde de lanzarlo. Es un job interno del runtime; no hace falta una tarea en el scheduler ni un cron del sistema.

| Aspecto | Comportamiento |
|---|---|
| **Activación** | Solo con `TRACE_ARCHIVE_ENABLED=true`. Por defecto está **apagado**: sin la variable, el runtime no archiva nada por su cuenta |
| **Frecuencia** | Cada `TRACE_ARCHIVE_INTERVAL_MS` milisegundos; por defecto, cada 24 h |
| **Qué archiva** | Lo mismo que el comando manual: los pasos de trazas más antiguas que `TRACE_RETENTION_DAYS` (90 por defecto), exportados a `TRACE_ARCHIVE_DIR`, verificados y sustituidos por un puntero |
| **Garantías** | Las del archivado manual: nunca se borra una fila ni un fichero, y un paso solo se aligera tras verificar su copia |
| **Auditoría** | Cuando una pasada aligera algo, deja una fila `traces.archive` en el `audit_log`. Si no había nada que archivar, no deja ninguna |

Para activarlo:

1. Comprueba que el volumen del archivo es persistente y que lo cubre tu copia de seguridad (consulta la precaución anterior).
1. Añade la variable a `deployments/.env` (y al bloque `environment` de `pxos-runtime` si el compose no la pasa, consulta [Variables del runtime](#variables-del-runtime)):

   ```bash
   TRACE_ARCHIVE_ENABLED=true
   # Opcional: cada 12 horas en lugar de cada 24
   TRACE_ARCHIVE_INTERVAL_MS=43200000
   ```

1. Recrea el contenedor para que lea los valores:

   ```bash
   cd deployments
   docker compose up -d pxos-runtime
   ```

Para comprobar que funciona, consulta el `audit_log` tras la primera pasada:

```bash
curl -s "http://127.0.0.1:4020/audit?action=traces.archive" -H 'x-tenant-id: publiexpe' | jq '.items[:3]'
```

Para pararlo, quita la variable o ponla en `false` y recrea `pxos-runtime`. Los ficheros ya escritos y los punteros siguen siendo válidos; el comando manual sigue disponible en cualquier momento.

> **Nota:** el archivado programado puede aligerar trazas que aún quieras cosechar para un dataset. Si vas a ejecutar `pnpm dataset:build`, hazlo antes de activar el archivado o ajusta `TRACE_RETENTION_DAYS` a una antigüedad que cubra tu ventana de cosecha (consulta el aviso del [README del runtime](../runtime/agent-runtime/README.md#retención-de-trazas-sin-pérdida-pnpm-tracesarchive)).

### Comprobar y leer una traza archivada

Una traza archivada sigue siendo legible: el runtime lee el JSONL en el momento de consultarla y devuelve el payload completo (rehidratación bajo demanda). No necesitas hacer nada especial:

```bash
curl -s "http://127.0.0.1:4020/executions/<EXECUTION_ID>" -H 'x-tenant-id: publiexpe' | jq '.trace.steps[0]'
```

Para ver qué ficheros se han generado, lista el directorio de archivo (`ls -lh "$TRACE_ARCHIVE_DIR"`); el puntero de un paso archivado indica el fichero y la línea que contienen su payload.

> **Nota:** si un fichero archivado falta, la traza no se puede rehidratar y el paso devuelve el puntero tal cual. Restaura el archivo desde la copia de seguridad.

## Consultar el audit log

Desde la tanda 12 toda acción mutante de la API deja una fila en la tabla `audit_log` (migración `0015`), de solo añadir: activaciones, `force` con su motivo, canario (arranque, promoción, rollback), cierres del optimizador y altas en la lista de supresión. No se edita ni se borra.

Consúltalo con la API:

```bash
curl -s "http://127.0.0.1:4020/audit" -H 'x-tenant-id: publiexpe' | jq '.items[:5]'
```

Para qué sirve:

- **Saber quién forzó una activación**: busca las entradas con motivo (`force`). El motivo tiene un mínimo de 10 caracteres.
- **Reconstruir qué pasó con una versión**: activación, canario, promoción y rollback aparecen en orden.
- **Auditar las supresiones**: cada alta en la lista (baja o rechazo explícito) consta con su origen.

La respuesta admite filtros y paginación; los nombres exactos de los parámetros y de los campos están en el [README del runtime](../runtime/agent-runtime/README.md).

> **Nota:** `GET /audit` solo lee, y el runtime escucha en `127.0.0.1` sin autenticación propia, como el resto de la API de administración. No expongas el puerto fuera del host.

## Parada segura

1. Comprueba si hay ejecuciones en curso antes de parar:

   ```bash
   curl -H 'x-tenant-id: publiexpe' "http://127.0.0.1:4020/executions?status=RUNNING"
   ```

   Si hay una run activa, espera a que termine, o pausa la tarea con `POST /tasks/:id/pause` y cancela la ejecución con `POST /executions/:id/cancel`. El runtime no exige token en esta versión.

2. Para el runtime primero y la infraestructura después:

   ```bash
   cd deployments
   docker compose stop pxos-runtime
   docker compose stop
   ```

   `docker compose stop` detiene los contenedores y **conserva los datos**.

3. Comprueba que solo se han parado contenedores `pxos`:

   ```bash
   docker ps -a --filter "name=pxos" --format "table {{.Names}}\t{{.Status}}"
   ```

4. Para volver a arrancar:

   ```bash
   docker compose start
   ```

> **Importante:** nunca uses `docker compose down -v`. Borra los volúmenes (`pxos-twenty-db-data`, `pxos-twenty-local-data`, `pxos-postgres-data`, `pxos-redis-data`) y con ellos el CRM y toda la base de datos del Agent OS.

### Reinicio de un servicio

```bash
docker compose restart pxos-twenty
```

Si cambias `SERVER_URL`, reinicia `pxos-twenty` y `pxos-twenty-worker`. Debe coincidir con la URL del navegador.

> **Nota:** si cambias un webhook de Twenty directamente por SQL, reinicia `pxos-twenty`: el servidor cachea la lista de webhooks y no la relee de la base ([apéndice del postmortem del 2026-10-12](incidentes/2026-10-12-catchup-tenants-test.md#apéndice-el-webhook-cacheado-de-twenty)).

## Después de una parada larga

Cuando el host o el runtime han estado parados (un fin de semana, una avería), el scheduler hace *catch-up* al arrancar: recupera slots perdidos de las tasks. Desde la tanda 16 esa recuperación está acotada y limitada a los tenants permitidos. El motivo es el [incidente del 2026-10-12](incidentes/2026-10-12-catchup-tenants-test.md), en el que un catch-up sin allowlist ejecutó 485 runs de tasks de test.

Qué esperar con los valores por defecto:

| Aspecto | Comportamiento |
|---|---|
| **Qué tenants** | Solo los de `SCHEDULER_TENANTS` (`publiexpe`). Las tasks de otros tenants no se registran ni se recuperan, aunque sigan `ACTIVE` en la base |
| **Cuántos slots por task** | Como máximo `CATCHUP_MAX_SLOTS` (1). Una task diaria que perdió tres días ejecuta un solo run, no tres |
| **Hasta qué antigüedad** | Los slots perdidos hace más de `CATCHUP_MAX_AGE_MS` (48 h) se omiten. Tras una parada de más de dos días, los slots viejos no se recuperan |
| **`scheduled_at`** | El del slot original, aunque el run empiece tarde |
| **Espera a Twenty** | Igual que antes: el run espera a que `pxos-twenty` esté sano ([Espera a Twenty al arrancar](../runtime/agent-runtime/README.md#espera-a-twenty-al-arrancar)) |

Después de arrancar, comprueba:

1. **Qué se ha ejecutado.** Revisa las task runs recientes (consulta SQL de [diagnóstico](#consultas-sql-de-diagnóstico)) o `GET /tasks/<TASK_ID>/runs`. Deben ser solo tasks de `publiexpe`, con un run por task como mucho.
1. **Qué se ha omitido.** Un slot omitido por antigüedad no genera run. Si necesitas el resultado, lánzalo a mano con `POST /tasks/<TASK_ID>/run`. El caso típico es el scout semanal (lunes 07:30): tras una parada de más de dos días, su slot se pierde y hay que lanzarlo a mano o esperar al lunes siguiente.
1. **Que no hay gasto anómalo.** Más runs que tasks activas de `publiexpe` es una señal de alarma: revisa `SCHEDULER_TENANTS` y [Tests de integración](#tests-de-integración-base-aislada).

> **Precaución:** no pongas `SCHEDULER_TENANTS=*` en una base que contenga tenants de test. El valor `*` existe para entornos de test aislados.

## Tests de integración: base aislada

> **Importante:** ejecuta los tests de integración **siempre contra una base aislada**, nunca contra `agentos`. Cada ejecución crea tenants de test (`it-*`, `e2e-*`, `ev-*`, `ar-*`) con tasks que, si el scheduler de esa base está en marcha, se ejecutan con credenciales reales. Así se originó el [incidente del 2026-10-12](incidentes/2026-10-12-catchup-tenants-test.md).

Un guard lo impide por código: los tests de integración se niegan a empezar si `DATABASE_URL` apunta a la base llamada `agentos`. `ALLOW_SHARED_TEST_DB=1` salta el guard; úsalo solo si sabes que ningún scheduler lee esa base.

Para crear una base de test en el mismo servidor, aplicar las migraciones y ejecutar los tests:

```bash
docker exec pxos-postgres psql -U agentos -d agentos -c "CREATE DATABASE agentos_test"

cd runtime/agent-runtime
export DATABASE_URL=postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_test
pnpm db:migrate
pnpm test:integration
```

Reglas:

- El nombre de la base no puede ser `agentos`. Los nombres con sufijo (`agentos_test`, `agentos_wt16_scheduler`) son los habituales en el repositorio.
- Si defines `DATABASE_URL` en `runtime/agent-runtime/.env`, comprueba que apunta a la base aislada: `test/setup-env.ts` carga ese `.env`.
- El scheduler del entorno local lee `agentos`, así que las tasks de una base aislada nunca se ejecutan.
- Los tests que usan Twenty (`twenty-tools.test.ts`) siguen escribiendo registros `[TEST]` en el Twenty real si hay `TWENTY_API_KEY` en el `.env`: la base aislada no protege el CRM.

### Limpiar tenants de test con `--dry-run`

Si una base ya tiene tasks de tenants de test activas, archívalas por patrón de tenant. El cleanup **archiva, nunca borra**, y con `--dry-run` informa de lo que cambiaría sin escribir nada. Ejecútalo siempre primero con `--dry-run`:

```bash
cd runtime/agent-runtime
pnpm cleanup:archive-test-tenants --dry-run
pnpm cleanup:archive-test-tenants --protect=otro-tenant-a-conservar   # patrones fijos: it-*, e2e-*, ev-*, ar-*, mt-/ms-/n8n-+hex, *-run/-empty/-seed/-trig/-skip
```

Es idempotente y nunca toca `publiexpe`, `DEFAULT_TENANT_ID`, los tenants de `SCHEDULER_TENANTS` ni los de `--protect`. Para los agentes `[TEST]` sigue vigente `pnpm cleanup:archive-test-agents`.

## Dónde mirar los logs

| Qué buscas | Dónde |
|---|---|
| Logs de Twenty | `docker compose logs -f pxos-twenty` |
| Logs del worker de Twenty (colas, importaciones, webhooks) | `docker compose logs -f pxos-twenty-worker` |
| Logs de PostgreSQL de Twenty | `docker compose logs -f pxos-twenty-db` |
| Logs de PostgreSQL del Agent OS | `docker compose logs -f pxos-postgres` |
| Logs de Redis del Agent OS | `docker compose logs -f pxos-redis` |
| Logs del runtime (API y worker) | `docker compose logs -f pxos-runtime`, o la salida de `pnpm dev` si corre en local |
| Salida de la sincronización de la Twenty App | La terminal donde ejecutas `scripts/sync-twenty-app.ps1` (el contenedor es efímero y no deja logs) |
| Qué hizo un agente en una ejecución | `GET /executions/:id`, que incluye el trace y sus pasos ([LLD v0.2 sección 8](LLD-0.2-especificacion.md#8-trace-schema)) |
| Resultado de una run y su trace | `GET /task-runs/:id` |
| Qué skills están activas | `GET /skills` |
| Envíos desde Twenty (workflow) | **Workflows → Runs** en Twenty |
| Bajas detectadas por el BajasAgent | `GET /tasks/:id/runs` de `process-unsubscribes` y la nota `Lista de supresión — NO contactar` |
| Resumen comercial de una ejecución | Objeto `agentRunSummary` en Twenty (**Agent runs**), con enlace al trace |
| Historial de una tarea | `GET /tasks/:id/runs` |
| Quién hizo una acción mutante (activación, `force`, canario, supresión) | `GET /audit`: [Consultar el audit log](#consultar-el-audit-log) |

Opciones útiles de `docker compose logs`:

```bash
docker compose logs --since 30m pxos-twenty     # últimos 30 minutos
docker compose logs --tail 200 pxos-runtime     # últimas 200 líneas
```

### Consultas SQL de diagnóstico

Abre una consola en la base del Agent OS:

```bash
docker exec -it pxos-postgres psql -U agentos -d agentos
```

Últimas task runs:

```sql
SELECT id, status, scheduled_at, started_at, finished_at, cost
FROM task_runs
ORDER BY scheduled_at DESC
LIMIT 10;
```

Ejecuciones fallidas en las últimas 24 horas:

```sql
SELECT id, status, error, created_at
FROM agent_executions
WHERE status IN ('FAILED','TIMED_OUT')
  AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;
```

> **Nota:** las consultas usan el esquema real de `runtime/agent-runtime/src/db/schema.ts`. Funcionan cuando las migraciones están aplicadas. Difieren en nombres de columna del esquema teórico del [LLD v0.2, sección 4](LLD-0.2-especificacion.md#4-esquema-de-bd-del-agent-os).

## Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `docker compose up` falla con "port is already allocated" | Otro contenedor del host usa el puerto | Identifica el contenedor con `docker ps`. No lo toques. Revisa [PORTS.md](PORTS.md) y, si es un conflicto real, cambia el puerto de este proyecto y documéntalo. |
| `pnpm dev` falla con `EADDRINUSE` en el `4020` | El contenedor `pxos-runtime` sigue en ejecución | `docker compose stop pxos-runtime` y repite. |
| `curl http://localhost:3020/` devuelve 404 en JSON | Twenty solo sirve la web a peticiones con `Accept: text/html` | Abre la URL en el navegador, o usa `curl -H "Accept: text/html" ...`. |
| `/health` del runtime devuelve `503` con `"db":"unreachable"` | `pxos-postgres` caído o `DATABASE_URL` incorrecta | Comprueba `docker compose ps` y arranca `pxos-postgres`. |
| `pxos-runtime` se reinicia en bucle | Falla la migración al arrancar o falta una dependencia | Lee `docker compose logs --tail 200 pxos-runtime`. |
| `docker compose up` falla con "Define ENCRYPTION_KEY en deployments/.env" | Falta `ENCRYPTION_KEY` en `deployments/.env` | Genera el valor con `openssl rand -base64 32`. |
| El runtime no consigue escribir en Twenty | API key ausente, caducada o con alcance insuficiente | Rota la clave: [Rotar la API key de Twenty](#rotar-la-api-key-de-twenty). Si la clave es nueva, comprueba que tiene el rol «Agent runtime» con permisos de objetos ([Rol de la API key](#rol-de-la-api-key-de-twenty)). |
| `yarn twenty apply` falla con `Resource path must not contain backslashes` | Limitación del CLI de Twenty en Windows | Usa `scripts/sync-twenty-app.ps1`: [workaround](#windows-workaround-del-cli-de-twenty). |
| `apply` falla subiendo archivos a `localhost:3020` desde un contenedor | La `SERVER_URL` de Twenty no resuelve dentro del contenedor | Usa el script, que reenvía `127.0.0.1:3020` con `socat`. |
| `sync-twenty-app.ps1` dice que no existe la red `pxos-net` | El stack no está levantado | `docker compose up -d` en `deployments/`. |
| Una ejecución se queda en `RUNNING` | Llamada colgada o límite de tiempo no aplicado | Cancela con `POST /executions/:id/cancel` y revisa el trace. |
| La tarea de las 08:00 no se ejecutó | No se ha hecho el seed, la tarea no está `ACTIVE`/`enabled`, el agente no está `ACTIVE` o el proceso con rol `scheduler` (o `all`) no está en marcha | Haz `pnpm seed`, revisa `GET /tasks` y los logs del runtime, y lanza una run manual con `POST /tasks/:id/run` si necesitas el resultado ya. |
| La tarea de las 08:00 termina `SKIPPED` | No hay señales de feria `QUALIFIED` vigentes (caso normal desde la tanda 15) | Nada que arreglar. Si el comercial dice que ha calificado una feria, comprueba que la señal es de feria (no una señal histórica por expositor), que su fecha no ha pasado y que no está ya `EXPIRED`. |
| Calificar una señal no dispara nada en el momento | Falta el [webhook de `commercialSignal`](#webhook-de-commercialsignal-en-twenty), falla la firma (`401`), falta `TWENTY_WEBHOOK_SECRET` (`503`), a Twenty le falta `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS`, o cae dentro de la ventana de 24 h de una calificación anterior | Revisa el webhook en **Settings → APIs & Webhooks**, los [logs](#dónde-mirar-los-logs) y `GET /audit` (`prospect.on_qualified`). Mientras tanto, el run de las 08:00 la recoge. |
| `GET /skills` devuelve una lista vacía, o los logs avisan de `falling back to the code constant` | No se ha hecho el seed tras aplicar la `0005_skills`, o la BD falló al resolver | `pnpm seed` y vuelve a consultar `GET /skills`. El agente sigue funcionando con el prompt de código. |
| El runtime arranca pero falta una tabla (`event_subscriptions`, `skills`...) | Una migración no se aplicó (por ejemplo, fechas del journal en desorden) | Revisa las migraciones aplicadas y el journal: [Arranque, paso 4](#arranque). No edites tablas a mano. |
| `POST /events/external` devuelve `503` | `EXTERNAL_EVENTS_TOKEN` no está definido en el runtime (el compose actual no lo pasa) | Añádelo al `environment` de `pxos-runtime` y recrea el servicio. |
| Una hipótesis se queda en `Email status` = `Sending` | El envío falló o sigue en curso | Revisa **Workflows → Runs**. No pulses de nuevo hasta saber si el correo salió: si salió, pon `Sent` a mano; si falló, corrige la causa y vuelve a poner `Reviewed`. |
| `process-unsubscribes` termina `SKIPPED` | Faltan `IONOS_IMAP_USER` o `IONOS_IMAP_PASSWORD` en el runtime | Añádelas a `deployments/.env` y recrea `pxos-runtime`. |
| Un intento sano muere con un error de `stalled` de BullMQ tras una re-entrega | Camino de stall de la cola (deuda documentada de la tanda 11) | Desde la tanda 12, una re-entrega con latido fresco ya no mata el intento en curso. Si lo ves en una versión anterior, actualiza el runtime. |
| Tras arrancar hay muchas ejecuciones de tasks que no reconoces, o el gasto de LLM se dispara | El scheduler registró tasks de tenants de test (`it-*`, `e2e-*`…): `SCHEDULER_TENANTS=*` o un runtime anterior a la tanda 16 | Archiva las tasks de test por patrón de tenant (con `--dry-run` primero: [Limpiar tenants de test](#limpiar-tenants-de-test-con---dry-run)), comprueba `SCHEDULER_TENANTS` y marca como descartado lo que haya llegado a Twenty (no lo borres). Detalle en el [postmortem del 2026-10-12](incidentes/2026-10-12-catchup-tenants-test.md) |
| `pnpm test:integration` se niega a ejecutarse y menciona la base compartida | El guard de la tanda 16: `DATABASE_URL` apunta a la base `agentos` | Usa una base aislada ([Tests de integración](#tests-de-integración-base-aislada)). `ALLOW_SHARED_TEST_DB=1` solo si ningún scheduler lee esa base |
| Un cambio de webhook hecho por SQL en Twenty no tiene efecto | El servidor de Twenty cachea la lista de webhooks | `docker compose restart pxos-twenty`. Prefiere la interfaz o `pnpm register:webhook` |
| Una hipótesis `Validated` no tiene **Email to** | La web de la empresa no publica ningún email del dominio (Research «Sin contacto público»); la hipótesis se validó antes de la tanda 17 y no se ha pasado el backfill; la fase 2 está apagada (`ENRICH_PROVIDER` vacío), sin cupo (`ENRICH_MAX_LOOKUPS_PER_DAY`) o devolvió confianza menor de 0,7 | Abre el Research «Contacto — empresa» o «Sin contacto público» de esa empresa para ver qué pasó. Si es anterior a la tanda 17, ejecuta el [backfill](#backfill-de-contactos). Si no hay nada publicado, que el comercial escriba la dirección a mano o activa la fase 2 ([variables](#variables-del-runtime)). |

| Hipótesis duplicadas en Twenty | Fallo de idempotencia | Conserva los datos, anota las `idempotencyKey` afectadas y abre una incidencia. No borres registros sin revisión. |

## Backup

Haz un volcado antes de actualizar Twenty, aplicar migraciones o cambiar de versión de esquema:

```bash
docker exec pxos-twenty-db pg_dump -U twenty twenty > backup-twenty.sql
docker exec pxos-postgres pg_dump -U agentos agentos > backup-agentos.sql
```

Guarda los volcados **fuera** del repositorio. `[POR COMPLETAR]` Ubicación y rotación de backups, y procedimiento de restauración (a definir en v0.3, punto "Rollback / disaster recovery" del LLD).

## Actualización de Twenty

1. Haz un backup (sección anterior).
2. Cambia `TWENTY_TAG` en `deployments/.env`.
3. Ejecuta:

   ```bash
   docker compose pull
   docker compose up -d
   ```

   El servidor aplica las migraciones de Twenty al arrancar.
4. Verifica `/healthz` y que la Twenty App sigue funcionando. Vuelve a sincronizar la App con `yarn twenty plan` (o `.\scripts\sync-twenty-app.ps1 -Action plan` en Windows) para detectar diferencias. `[POR COMPLETAR]` Procedimiento de migración de la App tras un cambio de versión mayor de Twenty (paridad de versión pendiente de validar, LLD v0.1 sección 27, decisión 3). La App usa `twenty-sdk` 2.45.0.

## Referencias

- [README de despliegue](../deployments/README.md)
- [README del Agent Runtime](../runtime/agent-runtime/README.md)
- [README de la Twenty App](../apps/twenty-app/README.md)
- [Script de sincronización de la Twenty App (Windows)](../scripts/sync-twenty-app.ps1)
- [LLD v0.2](LLD-0.2-especificacion.md)
- [Puertos reservados](PORTS.md)
- [Guía de contribución](CONTRIBUTING.md)
- [Plan de warm-up del canal de email](email-warmup.md)
- [Enviar los borradores desde Twenty](twenty-envio-email.md)
- [Integración de eventos con n8n](n8n-integracion.md)
- [Triaje del inbound](inbound-triaje.md)
- [Búsqueda de contactos](contactos.md)
- [LLD v0.3: estado real y ADR](LLD-0.3-estado-real.md)
- [Incidente 2026-10-12: catch-up sobre tenants de test](incidentes/2026-10-12-catchup-tenants-test.md)
