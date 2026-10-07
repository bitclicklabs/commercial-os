# PubliEXPE Commercial OS

Sistema comercial multiagente sobre [Twenty CRM](https://twenty.com) self-hosted: prospección, research, scoring e hipótesis comerciales con evaluación y evolución versionada.

Principio rector: **el CRM es el system of record; el Agent OS es el system of intelligence.**

## Arquitectura

| Componente | Ruta | Descripción |
|---|---|---|
| Twenty App | `apps/twenty-app/` | Extensión CRM: objetos comerciales, vistas y UI |
| Agent Runtime | `runtime/` | Ejecución de agentes: scheduler, tools, skills versionadas, event bus, trazas y métricas. Harness y memoria aún no existen |
| Servicios | `services/` | [`renderer/`](services/renderer/README.md): render JavaScript con Playwright para el scout de ferias. El Catalog Service y el Inbound Manager aún no existen como servicios (el lector de bajas vive en el runtime) |
| Integraciones | `integrations/` | Ejemplo importable para n8n del [puente de eventos](docs/n8n-integracion.md) |
| Despliegue | `deployments/` | Docker Compose local |
| Scripts | `scripts/` | Utilidades de operación, como `sync-twenty-app.ps1` |
| Documentación | `docs/` | LLD y guías |

## Puertos (desarrollo local)

Reservados para no colisionar con otras instancias Docker del host. Consulta [docs/PORTS.md](docs/PORTS.md) antes de añadir servicios.

| Servicio | Puerto host |
|---|---|
| Twenty (UI + API) | 3020 |
| PostgreSQL (Agent OS) | 5440 |
| Redis (Agent OS) | 6391 |
| Agent Runtime API | 4020 |
| Renderer (solo desarrollo; interno sin él) | 4030 |

## Inicio rápido

```bash
cd deployments
cp .env.example .env   # revisa los valores
docker compose up -d
```

Twenty queda disponible en `http://localhost:3020`. El runtime queda en `http://127.0.0.1:4020`.

Para el arranque completo, las migraciones, el flujo de prueba y la parada segura, sigue el [runbook de operación local](docs/runbook-local.md).

### Sincronizar la Twenty App desde Windows

`yarn twenty apply` falla en Windows. Usa el script, que ejecuta el `apply` en un contenedor efímero conectado a `pxos-net`:

```powershell
.\scripts\sync-twenty-app.ps1
```

Detalles en el [runbook](docs/runbook-local.md#windows-workaround-del-cli-de-twenty) y en el [README de la App](apps/twenty-app/README.md#windows-sincronizar-con-el-script).

## Documentación

- [LLD v0.1 — arquitectura](docs/LLD-0.1-publiexpe-commercial-os.md)
- [LLD v0.2 — especificación del MVP-0](docs/LLD-0.2-especificacion.md)
- [LLD v0.3 — estado real: 31 decisiones (ADR) y mapa del diseño frente a lo construido](docs/LLD-0.3-estado-real.md)
- [Guía de contribución](docs/CONTRIBUTING.md)
- [Guía del equipo comercial](docs/guia-comercial.md)
- [Runbook de operación local](docs/runbook-local.md)
- [Plan de warm-up del canal de email](docs/email-warmup.md)
- [Enviar los borradores desde Twenty](docs/twenty-envio-email.md)
- [Integración de eventos con n8n](docs/n8n-integracion.md)
- [Estado del proyecto por tandas](docs/ESTADO.md)
- [Registro de cambios](docs/CHANGELOG.md)
- [Script de sincronización de la Twenty App (Windows)](scripts/sync-twenty-app.ps1)
- [Puertos reservados](docs/PORTS.md)

## Reglas del repositorio

- Las ramas de trabajo salen de `main`; la integración se hace vía PR.
- Prohibido el borrado destructivo: nada de `docker compose down -v`, `rm -rf` fuera del propio worktree, ni eliminar contenedores o volúmenes ajenos al prefijo `pxos`.
