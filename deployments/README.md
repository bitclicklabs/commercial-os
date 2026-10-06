# Despliegue local — PubliEXPE Commercial OS

Stack Docker Compose de desarrollo: Twenty CRM self-hosted más la infraestructura base del Agent OS (PostgreSQL con pgvector y Redis).

> **Precaución:** en este host corren otras instancias Docker en producción. Nunca ejecutes `docker compose down -v`, `docker volume rm` ni `docker system prune`, y no toques contenedores, redes o volúmenes que no empiecen por `pxos`.

## Servicios

| Contenedor | Imagen | Puerto host | Descripción |
|---|---|---|---|
| `pxos-twenty` | `twentycrm/twenty:v2.45.6` | `127.0.0.1:3020` | Twenty: UI + API (GraphQL/REST) |
| `pxos-twenty-worker` | `twentycrm/twenty:v2.45.6` | — | Worker de colas de Twenty |
| `pxos-twenty-db` | `postgres:16` | — (interno) | Base de datos de Twenty |
| `pxos-twenty-redis` | `redis:7.4` | — (interno) | Cache y colas de Twenty |
| `pxos-postgres` | `pgvector/pgvector:pg16` | `127.0.0.1:5440` | PostgreSQL del Agent OS (extensiones `vector` y `pgcrypto`) |
| `pxos-redis` | `redis:7.4` | `127.0.0.1:6391` | Redis del Agent OS (BullMQ, AOF activado) |
| `pxos-runtime` | pxos/agent-runtime:0.1.0 | `127.0.0.1:4020` | Agent Runtime (API + worker) |

Red: `pxos-net`. Volúmenes: `pxos-twenty-db-data`, `pxos-twenty-local-data`, `pxos-postgres-data`, `pxos-redis-data`.

La base de datos de Twenty y la del Agent OS están separadas a propósito (LLD §4): un upgrade o un fallo de Twenty no afecta a los datos del Agent OS.

## Requisitos

- Docker Engine 24 o posterior con Docker Compose v2.
- Unos 3 GB libres para imágenes y 2 GB de RAM para el stack.
- `openssl` para generar secretos (incluido en Git Bash).
- Puertos `3020`, `5440` y `6391` libres en `127.0.0.1`. Consulta [docs/PORTS.md](../docs/PORTS.md).

## Arranque

1. Crea el archivo de entorno y genera los secretos:

   ```bash
   cd deployments
   cp .env.example .env
   openssl rand -base64 32   # pega el resultado en ENCRYPTION_KEY
   openssl rand -base64 32   # pega el resultado en APP_SECRET
   ```

   `.env` está en `.gitignore`; no lo subas nunca al repositorio.

2. Levanta el stack:

   ```bash
   docker compose up -d
   ```

   El primer arranque descarga unos 2 GB e inicializa la base de datos de Twenty; tarda 1–3 minutos.

3. Comprueba el estado:

   ```bash
   docker compose ps
   curl http://localhost:3020/healthz
   ```

   Todos los servicios deben aparecer `healthy` (el worker no tiene healthcheck; basta con `Up`) y `/healthz` devuelve `{"status":"ok",...}`.

> **Nota:** `curl http://localhost:3020/` devuelve 404 en JSON porque Twenty solo sirve la aplicación web a peticiones con `Accept: text/html`. Desde el navegador funciona; con curl usa `curl -H "Accept: text/html" http://localhost:3020/`.

## Parada y reinicio

```bash
docker compose stop      # para los contenedores, conserva datos
docker compose start     # vuelve a arrancarlos
docker compose restart pxos-twenty   # reinicia un servicio concreto
docker compose logs -f pxos-twenty   # sigue los logs
```

> **Importante:** usa siempre `docker compose stop`. **NUNCA** `docker compose down -v`: borra los volúmenes y con ellos todo el CRM y la base de datos del Agent OS. Si necesitas recrear contenedores tras cambiar el compose, `docker compose up -d` basta.

## URLs y credenciales (solo desarrollo)

| Recurso | Valor |
|---|---|
| Twenty (navegador) | http://localhost:3020 |
| Twenty health | http://localhost:3020/healthz |
| Twenty GraphQL | http://localhost:3020/graphql |
| Twenty REST | http://localhost:3020/rest |
| Agent OS PostgreSQL | `postgres://agentos:agentos_dev@localhost:5440/agentos` |
| Agent OS Redis | `redis://localhost:6391` |
| Postgres interno de Twenty | `twenty` / `twenty_dev`, BD `twenty` (sin puerto al host) |

Para abrir una consola SQL en la base del Agent OS:

```bash
docker exec -it pxos-postgres psql -U agentos -d agentos
```

## Crear el primer workspace

Twenty no trae usuarios precargados: el primer usuario se crea en el navegador.

1. Abre http://localhost:3020. Te redirige a `/welcome` ("Inicia sesión o crea una cuenta").
2. Elige **Continuar con email**, introduce tu email y una contraseña. No se envía email de verificación porque no hay SMTP configurado.
3. Completa el onboarding: nombre del workspace (por ejemplo `PubliEXPE`), tu perfil y, si lo pide, la invitación de miembros (puedes omitirla).
4. Para que el Agent OS acceda a la API, crea una API key en **Settings → MCP y API → API** y guárdala como `TWENTY_API_KEY` en este `deployments/.env` (el compose se la pasa a `pxos-runtime`).

## Variables que debes revisar

| Variable | Por qué |
|---|---|
| `ENCRYPTION_KEY`, `APP_SECRET` | Genéralas con `openssl rand -base64 32`. Si cambias `ENCRYPTION_KEY` con datos existentes, pon la anterior en `FALLBACK_ENCRYPTION_KEY`. |
| `TWENTY_PG_PASSWORD`, `AGENTOS_PG_PASSWORD` | Valores de desarrollo; cámbialos fuera de local. Solo se aplican al crear el volumen por primera vez. |
| `SERVER_URL` | Debe coincidir con la URL del navegador. Si la cambias, reinicia `pxos-twenty` y `pxos-twenty-worker`. |
| `TWENTY_TAG` | Versión de Twenty. Para actualizar, cambia el tag y ejecuta `docker compose pull && docker compose up -d`; el server aplica las migraciones al arrancar. Haz antes un backup. |

## Backup rápido

```bash
docker exec pxos-twenty-db pg_dump -U twenty twenty > backup-twenty.sql
docker exec pxos-postgres pg_dump -U agentos agentos > backup-agentos.sql
```

## Referencias

- Compose oficial de Twenty: https://github.com/twentyhq/twenty/tree/main/packages/twenty-docker
- Documentación de self-hosting: https://docs.twenty.com
