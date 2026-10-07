# Puertos reservados — Commercial OS (desarrollo local)

El host ejecuta otras instancias Docker. Antes de exponer un puerto nuevo, compruébalo con `docker ps` y añádelo a esta tabla.

## Asignados a este proyecto (prefijo de contenedor `pxos`)

| Puerto host | Servicio | Contenedor |
|---|---|---|
| 3020 | Twenty (UI + API) | pxos-twenty |
| 5440 | PostgreSQL + pgvector (Agent OS) | pxos-postgres |
| 6391 | Redis (Agent OS) | pxos-redis |
| 4020 | Agent Runtime API | pxos-runtime |
| 4030 | Renderer (solo desarrollo; sin él, interno) | pxos-renderer |

Servicios internos sin puerto al host: `pxos-twenty-worker`, `pxos-twenty-db` (Postgres de Twenty) y `pxos-twenty-redis`. `pxos-renderer` solo publica 4030 en desarrollo local. Ver [deployments/README.md](../deployments/README.md).

## Ocupados por otros proyectos del host (2026-10-06 — NO usar)

80, 443, 1025, 3101, 5432, 5433, 5678, 5679, 6379, 6388, 7233, 8000, 8002, 8010, 8025, 8081, 9000, 9001

## Reglas

- Publica los puertos en `127.0.0.1`, no en `0.0.0.0`, salvo necesidad justificada.
- Los servicios internos del compose (Postgres de Twenty, workers) no exponen puerto al host salvo necesidad de desarrollo.
- Nunca pares ni elimines contenedores, redes o volúmenes que no empiecen por `pxos`.
