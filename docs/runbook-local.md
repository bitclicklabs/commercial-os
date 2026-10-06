# Runbook de operación local

Guía para arrancar, parar y diagnosticar el entorno local de Commercial OS. Es un esqueleto: los huecos marcados `[POR COMPLETAR]` dependen del trabajo de infra, del runtime y de la Twenty App. Cuando uno de esos trabajos se integre en `main`, sustituye el hueco por el valor real y quita la marca.

> **Precaución:** el host ejecuta otras instancias Docker en producción. Trabaja solo con recursos cuyo nombre empiece por `pxos`. **Nunca** ejecutes `docker compose down -v`, `docker volume rm`, `docker system prune` ni `rm -rf` fuera de tu worktree.

## Mapa del entorno

| Servicio | Contenedor | Puerto host | Estado documentado |
|---|---|---|---|
| Twenty (UI + API) | `pxos-twenty` | `127.0.0.1:3020` | Definido en la rama `feat/infra-docker` |
| Worker de Twenty | `pxos-twenty-worker` | — | Definido en la rama `feat/infra-docker` |
| Postgres de Twenty | `pxos-twenty-db` | — (interno) | Definido en la rama `feat/infra-docker` |
| Redis de Twenty | `pxos-twenty-redis` | — (interno) | Definido en la rama `feat/infra-docker` |
| PostgreSQL del Agent OS (BD `agentos`) | `pxos-postgres` | `127.0.0.1:5440` | Definido en la rama `feat/infra-docker` |
| Redis del Agent OS (BullMQ) | `pxos-redis` | `127.0.0.1:6391` | Definido en la rama `feat/infra-docker` |
| Agent Runtime API | `pxos-runtime` | `127.0.0.1:4020` | `[POR COMPLETAR]` Reservado; lo añade el trabajo del runtime |

Red: `pxos-net`. Puertos reservados y ocupados por otros proyectos: [PORTS.md](PORTS.md).

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

3. Verifica que existe el archivo `deployments/.env`. Si no existe, créalo desde `deployments/.env.example` y genera los secretos como indica `deployments/README.md`:

   ```bash
   cd deployments
   cp .env.example .env
   ```

   `[POR COMPLETAR]` Variables del runtime en `.env` (token de la API, `TWENTY_API_KEY`, proveedor de modelo). Las define el trabajo del runtime.

## Arranque

1. Levanta el stack desde `deployments/`:

   ```bash
   cd deployments
   docker compose up -d
   ```

   El primer arranque descarga imágenes e inicializa la base de datos de Twenty. Tarda entre 1 y 3 minutos.

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
   | Runtime | `curl http://127.0.0.1:4020/health` | `{"status":"ok",...}` con `postgres`, `redis` y `twenty` en `ok` (contrato en el [LLD v0.2, sección 6.3](LLD-0.2-especificacion.md#63-endpoints)) |

   `[POR COMPLETAR]` Si el runtime se arranca fuera de Docker (por ejemplo con `pnpm dev` durante el desarrollo), indica el comando y el directorio.

4. Aplica las migraciones del Agent OS (primer arranque y tras cada actualización):

   `[POR COMPLETAR]` Comando de migración de Drizzle del runtime (por ejemplo, `pnpm db:migrate`).

5. Primer uso de Twenty: crea el workspace en el navegador (`http://localhost:3020`) y genera una API key en **Settings → APIs & Webhooks**, como describe `deployments/README.md`.

6. Instala la Twenty App con los objetos comerciales:

   `[POR COMPLETAR]` Comando de despliegue de la Twenty App (`apps/twenty-app/`) y verificación de que existen `commercialSignal`, `research`, `commercialHypothesis` y `agentRunSummary` (criterio AC-01 del LLD v0.2).

7. Registra los agentes y la tarea `daily-event-prospecting`:

   `[POR COMPLETAR]` Script de *seed* o secuencia de llamadas a `POST /agents` y `POST /tasks`.

## Parada segura

1. Comprueba si hay una task run en curso antes de parar:

   ```bash
   curl -H "Authorization: Bearer $RUNTIME_API_TOKEN" "http://127.0.0.1:4020/tasks"
   ```

   `[POR COMPLETAR]` Nombre real de la variable del token y filtro para listar runs `RUNNING`. Si hay una run activa, espera a que termine o pausa la tarea con `POST /tasks/:id/pause` y cancela la ejecución con `POST /executions/:id/cancel`.

2. Para el runtime primero y la infraestructura después:

   ```bash
   cd deployments
   docker compose stop pxos-runtime      # [POR COMPLETAR] solo si el runtime corre en Docker
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

Si cambias `SERVER_URL`, reinicia `pxos-twenty` y `pxos-twenty-worker`.

## Dónde mirar los logs

| Qué buscas | Dónde |
|---|---|
| Logs de Twenty | `docker compose logs -f pxos-twenty` |
| Logs del worker de Twenty (colas, importaciones, webhooks) | `docker compose logs -f pxos-twenty-worker` |
| Logs de PostgreSQL del Agent OS | `docker compose logs -f pxos-postgres` |
| Logs de Redis del Agent OS | `docker compose logs -f pxos-redis` |
| Logs del runtime | `[POR COMPLETAR]` `docker compose logs -f pxos-runtime`, o la salida de `pnpm dev` si corre en local |
| Qué hizo un agente en una ejecución | `GET /executions/:id/trace` (trace estructurado, [LLD v0.2 sección 8](LLD-0.2-especificacion.md#8-trace-schema)) |
| Resumen comercial de una ejecución | Objeto `agentRunSummary` en Twenty (**Agent runs**), con enlace al trace |
| Historial de una tarea | `GET /tasks/:id/runs` |
| Cambios de versión, pausas y promociones | Tabla `audit_log` del Agent OS |

Opciones útiles de `docker compose logs`:

```bash
docker compose logs --since 30m pxos-twenty     # últimos 30 minutos
docker compose logs --tail 200 pxos-postgres    # últimas 200 líneas
```

### Consultas SQL de diagnóstico

Abre una consola en la base del Agent OS:

```bash
docker exec -it pxos-postgres psql -U agentos -d agentos
```

Últimas task runs:

```sql
SELECT id, status, scheduled_at, started_at, finished_at, cost_eur
FROM task_runs
ORDER BY scheduled_at DESC
LIMIT 10;
```

Ejecuciones fallidas en las últimas 24 horas:

```sql
SELECT id, stage, status, error, queued_at
FROM agent_executions
WHERE status IN ('FAILED','TIMED_OUT')
  AND queued_at > now() - interval '24 hours'
ORDER BY queued_at DESC;
```

> **Nota:** estas consultas asumen el esquema del [LLD v0.2, sección 4](LLD-0.2-especificacion.md#4-esquema-de-bd-del-agent-os). Funcionan cuando las migraciones del runtime están aplicadas.

## Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `docker compose up` falla con "port is already allocated" | Otro contenedor del host usa el puerto | Identifica el contenedor con `docker ps`. No lo toques. Revisa [PORTS.md](PORTS.md) y, si es un conflicto real, cambia el puerto de este proyecto y documéntalo. |
| `curl http://localhost:3020/` devuelve 404 en JSON | Twenty solo sirve la web a peticiones con `Accept: text/html` | Abre la URL en el navegador, o usa `curl -H "Accept: text/html" ...`. |
| `/health` del runtime devuelve `503` | Falla una dependencia (`postgres`, `redis` o `twenty`) | Lee el campo `checks` del cuerpo de la respuesta y arranca la dependencia que figure en error. |
| El runtime no consigue escribir en Twenty | API key ausente, caducada o con alcance insuficiente | `[POR COMPLETAR]` Procedimiento de rotación de la API key. |
| La tarea de las 08:00 no se ejecutó | Tarea en `PAUSED`, runtime parado a esa hora o `enabled = false` | Consulta `GET /tasks`, `task_runs` y los logs del runtime. Lanza una run manual con `POST /tasks/:id/run`. |
| Una ejecución se queda en `RUNNING` | Llamada colgada o límite de tiempo no aplicado | Cancela con `POST /executions/:id/cancel` y revisa el trace. |
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
4. Verifica `/healthz` y que la Twenty App sigue funcionando. `[POR COMPLETAR]` Procedimiento de reinstalación o migración de la App tras un cambio de versión (paridad de versión pendiente de validar, LLD v0.1 sección 27, decisión 3).

## Referencias

- [Runbook y README de despliegue](../deployments/README.md) `[POR COMPLETAR]` (se integra con la rama `feat/infra-docker`)
- [LLD v0.2](LLD-0.2-especificacion.md)
- [Puertos reservados](PORTS.md)
- [Guía de contribución](CONTRIBUTING.md)
