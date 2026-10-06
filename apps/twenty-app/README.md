# PubliEXPE Commercial OS — Twenty App

Extensión de Twenty CRM (`publiexpe-commercial-os`) que añade los objetos comerciales del Commercial OS: señales, research, hipótesis y resúmenes de ejecución de agentes. Implementa las secciones 4, 5 y 23 del [LLD v0.1](../../docs/LLD-0.1-publiexpe-commercial-os.md).

El Agent OS escribe los registros vía API; el equipo comercial los consulta y valida en Twenty.

## Requisitos

- Node.js 24.5 o superior (consulta `.nvmrc`). En este equipo, nvm-windows tiene instalada la v24.19.0.
- Yarn 4, mediante Corepack: `corepack enable`.
- Una instancia de Twenty 2.45 o superior. En desarrollo local: `http://localhost:3020` (consulta [docs/PORTS.md](../../docs/PORTS.md)).

> **Nota:** no uses `yarn twenty docker:start`. La instancia de Twenty de este proyecto se gestiona desde `deployments/`, no desde la CLI de la App.

## Estructura

```
apps/twenty-app/
├── package.json                    # nombre publiexpe-commercial-os, twenty-sdk 2.45.0
├── src/
│   ├── application-config.ts       # defineApplication
│   ├── default-role.ts             # rol de las logic functions de la App
│   ├── constants/                  # UUIDs estables (objetos, campos, navegación, vistas)
│   ├── objects/                    # los 4 objetos custom (defineObject)
│   ├── fields/                     # lado ONE_TO_MANY de las relaciones en Company y Person
│   ├── navigation-menu-items/      # carpeta "Commercial OS" + 4 entradas
│   ├── views/                      # vistas adicionales (kanban de hipótesis, señales recientes)
│   ├── logic-functions/            # health check (generado por el scaffold)
│   └── __tests__/                  # tests unitarios e integración (plantilla oficial)
└── locales/en.json
```

Todos los `universalIdentifier` viven en `src/constants/`. **No los cambies tras el primer sync**: Twenty los usa para reconciliar el esquema; cambiar uno equivale a borrar y recrear el objeto o campo.

## Modelo de datos

Twenty añade a cada objeto los campos de sistema `id`, `createdAt`, `updatedAt`, `deletedAt`, `createdBy` y `updatedBy`. No se declaran.

### CommercialSignal (`commercialSignal` / `commercialSignals`) — LLD §5.1

| Campo Twenty | Tipo | Campo LLD | Notas |
|---|---|---|---|
| `name` | TEXT (etiqueta "Title") | `title` | Etiqueta del registro |
| `description` | TEXT | `description` | |
| `signalType` | SELECT | `type` | FAIR, CONGRESS, EVENT, NEW_PRODUCT, HIRING, EXPANSION, REBRANDING, SPONSORSHIP, CAMPAIGN, ANNIVERSARY, OTHER (por defecto OTHER) |
| `sourceUrl` | LINKS | `source_url` | |
| `sourceDomain` | TEXT | `source_domain` | |
| `detectedAt` | DATE_TIME | `detected_at` | Por defecto `now` |
| `eventDate` | DATE | `event_date` | |
| `confidence` | NUMBER (float, 2 decimales) | `confidence` | Escala 0–1 |
| `status` | SELECT | `status` | NEW, REVIEWING, QUALIFIED, DISCARDED, EXPIRED (por defecto NEW) |
| `tenantId` | TEXT | `tenant_id` | |
| `company` | RELATION → Company (N:1) | `company_id` | Inverso: `Company.commercialSignals` |
| `researches` | RELATION ← Research (1:N) | — | Inverso de `Research.commercialSignal` |
| `commercialHypotheses` | RELATION ← CommercialHypothesis (1:N) | — | Inverso de `CommercialHypothesis.commercialSignal` |
| `createdBy` (sistema) | ACTOR | `created_by` | |

### Research (`research` / `researches`) — LLD §5.2

No se crea ni se edita desde la UI: una investigación nueva es un registro nuevo.

| Campo Twenty | Tipo | Campo LLD | Notas |
|---|---|---|---|
| `name` | TEXT (etiqueta "Title") | — | Etiqueta del registro (nuevo) |
| `researchType` | TEXT | `research_type` | |
| `query` | TEXT | `query` | |
| `summary` | TEXT | `summary` | |
| `structuredResult` | RAW_JSON | `structured_result` | |
| `sources` | ARRAY (texto) | `sources[]` | URLs |
| `confidence` | NUMBER (float, 2 decimales) | `confidence` | Escala 0–1 |
| `agentExecutionId` | TEXT | `agent_execution_id` | Referencia externa al Agent OS |
| `tenantId` | TEXT | `tenant_id` | |
| `company` | RELATION → Company (N:1) | `company_id` | Inverso: `Company.researches` |
| `commercialSignal` | RELATION → CommercialSignal (N:1) | `signal_id` | Inverso: `CommercialSignal.researches` |
| `createdAt` (sistema) | DATE_TIME | `created_at` | |

### CommercialHypothesis (`commercialHypothesis` / `commercialHypotheses`) — LLD §5.3

| Campo Twenty | Tipo | Campo LLD | Notas |
|---|---|---|---|
| `name` | TEXT (etiqueta "Hypothesis") | — | Titular corto, etiqueta del registro (nuevo) |
| `need` | TEXT | `need` | |
| `whyNow` | TEXT | `why_now` | |
| `quantityMin` / `quantityMax` | NUMBER (int) | `quantity_min` / `quantity_max` | |
| `budgetMin` / `budgetMax` | CURRENCY (EUR por defecto) | `budget_min` / `budget_max` | |
| `recommendedProducts` | ARRAY (texto) | `recommended_products[]` | Referencias del Catalog Service [C2] |
| `decisionMaker` | RELATION → Person (N:1) | `decision_maker_id` | Inverso: `Person.decisionMakerHypotheses` |
| `timing` | TEXT | `timing` | Texto libre |
| `confidence` | NUMBER (float, 2 decimales) | `confidence` | Escala 0–1 |
| `evidence` | RAW_JSON | `evidence[]` | Array de objetos, p. ej. `[{ "claim", "sourceUrl", "quote" }]` |
| `status` | SELECT | `status` | PROPOSED, VALIDATED, REJECTED, EXPIRED (por defecto PROPOSED) |
| `tenantId` | TEXT | `tenant_id` | |
| `company` | RELATION → Company (N:1) | `company_id` | Inverso: `Company.commercialHypotheses` |
| `commercialSignal` | RELATION → CommercialSignal (N:1) | `signal_id` | Inverso: `CommercialSignal.commercialHypotheses` |

### AgentRunSummary (`agentRunSummary` / `agentRunSummaries`) — LLD §4 [C1]

Solo lectura para el comercial: no se crea ni se edita desde la UI. El LLD no detalla sus campos; estos son la propuesta.

| Campo Twenty | Tipo | Notas |
|---|---|---|
| `name` | TEXT (etiqueta "Run") | Etiqueta del registro, p. ej. `PROSPECTOR v1.8 · ACME` |
| `task` | TEXT | Tarea ejecutada |
| `agentName` | TEXT | Agente |
| `agentVersion` | TEXT | Versión del agente |
| `outcome` | SELECT | SUCCESS, PARTIAL, FAILED, CANCELLED (por defecto SUCCESS) |
| `resultSummary` | TEXT | Resultado legible |
| `cost` | CURRENCY (EUR, 3 decimales) | Coste de la ejecución |
| `traceUrl` | LINKS | Enlace al trace completo en el Agent OS |
| `agentExecutionId` | TEXT | Referencia externa a `AgentExecution` |
| `startedAt` / `finishedAt` | DATE_TIME | |
| `tenantId` | TEXT | |
| `company` | RELATION → Company (N:1) | Inverso: `Company.agentRunSummaries` |

Todas las relaciones N:1 usan `onDelete: SET_NULL` para no perder histórico si se borra la empresa o la señal.

## Navegación y vistas (LLD §23)

- Carpeta **Commercial OS** en la barra lateral con **Signals**, **Research**, **Hypotheses** y **Agent runs**. Cada entrada abre la vista "All" que Twenty genera para el objeto.
- Vistas adicionales, disponibles en el selector de vistas de cada objeto:
  - Hypotheses → **By status**: kanban agrupado por `status`, para la validación humana (HITL) del MVP-0.
  - Signals → **Recent signals**: tabla ordenada por `detectedAt` descendente.

## Desviaciones respecto al LLD v0.1

| # | Desviación | Motivo |
|---|---|---|
| 1 | Nombres en camelCase (`source_url` → `sourceUrl`, etc.) | Convención de Twenty: los nombres de metadatos deben cumplir `^[a-z][a-zA-Z0-9]*$`. |
| 2 | `type` → `signalType` | `type` es palabra reservada en Twenty (`RESERVED_METADATA_NAME_KEYWORDS`). |
| 3 | `title` → `name` (etiqueta "Title") | El SDK inyecta un campo `name` en todo objeto que no lo declare, y la plantilla oficial (`dev:add object`) lo usa como etiqueta del registro. Así se evita una columna "Name" vacía. |
| 4 | Campo `name` añadido a Research, CommercialHypothesis y AgentRunSummary | Twenty exige un campo etiqueta (`labelIdentifierFieldMetadataUniversalIdentifier`) y el LLD no define uno para estos objetos. |
| 5 | `id`, `created_at`, `created_by` no se declaran | Son campos de sistema de Twenty (`createdBy` es de tipo ACTOR). |
| 6 | `company_id`, `signal_id`, `decision_maker_id` → relaciones `company`, `commercialSignal`, `decisionMaker` | Twenty modela las FK como relaciones bidireccionales; se declaran también los lados inversos en Company, Person y CommercialSignal. |
| 7 | `tenant_id` → `tenantId` TEXT opcional | Twenty ya aísla por workspace; se mantiene para reflejar el tenant del Agent OS, como pide [C6]. |
| 8 | Estados de CommercialSignal: NEW, REVIEWING, QUALIFIED, DISCARDED, EXPIRED | El LLD enumera `status` sin valores. **Pendiente de validar.** |
| 9 | `research_type` y `timing` como TEXT | El LLD no define sus valores. Se pueden convertir a SELECT cuando haya catálogo. |
| 10 | `confidence` como NUMBER 0–1 con 2 decimales | El LLD no fija la escala. |
| 11 | `evidence[]` como RAW_JSON; `sources[]` y `recommended_products[]` como ARRAY | La evidencia necesita estructura (afirmación, fuente, cita); las otras dos son listas de referencias. |
| 12 | Campos de AgentRunSummary definidos aquí | El LLD solo describe su propósito (agente, versión, tarea, resultado, coste, enlace al trace). |
| 13 | "Solo lectura" de Research y AgentRunSummary aplicado en la UI (`isUICreatable: false`, `isUIEditable: false`) | `writability: APPLICATION` bloquearía también las escrituras del Agent OS vía API. Para forzarlo en servidor, crea un rol de workspace "Sales" sin permiso de escritura sobre estos objetos. |
| 14 | `agentExecutionId` no es único | Los TEXT de Twenty usan `''` como valor vacío y chocarían en un índice único. La idempotencia la garantiza el Agent OS. |
| 15 | Sin entradas **Dashboard** ni **Knowledge** en la barra lateral | Dashboard queda para una iteración posterior (dashboards de Twenty); Knowledge vive en el Agent OS [C1]. |
| 16 | Etiquetas de UI en inglés | Coinciden con los nombres del LLD §23. La traducción al español va en `locales/`. |

## Verificación local (sin instancia)

```bash
corepack enable
yarn install
yarn twenty dev:typecheck   # tipos de la App
yarn typecheck              # tsgo sobre src/ y tests
yarn lint                   # oxlint
yarn test:unit              # tests unitarios (UUIDs válidos y únicos)
yarn twenty dev:build       # genera .twenty/output/manifest.json
```

## Sincronizar con la instancia de Twenty

La sincronización necesita un *remote* autenticado. Las credenciales se guardan en `~/.twenty/config.json` y nunca se versionan.

1. Inicia sesión en `http://localhost:3020` con un usuario administrador del workspace.
2. Crea una API key en **Settings > APIs & Webhooks > Create API key**. Guárdala en una variable de entorno, no en un fichero del repositorio.
3. Registra el remote y actívalo:

   ```bash
   cd apps/twenty-app
   yarn twenty remote:add --url http://localhost:3020 --api-key "$TWENTY_API_KEY" --as pxos-local
   yarn twenty remote:use pxos-local
   yarn twenty remote:status
   ```

   Alternativa sin API key: `yarn twenty remote:add --url http://localhost:3020 --as pxos-local` abre el navegador para autorizar la CLI por OAuth.

4. Aplica la App. El primer `apply` registra e instala la App en el workspace:

   ```bash
   yarn twenty apply
   ```

   En las siguientes iteraciones, previsualiza antes los cambios con `yarn twenty plan`. Si `apply` pide confirmación por cambios destructivos (borrados), revísalos antes de usar `--force`.

5. Comprueba el resultado en `http://localhost:3020/settings/applications#developer` y en la carpeta **Commercial OS** de la barra lateral.

> **Importante:** usa `yarn twenty apply` (una pasada, sale con código 0 o 1). Evita `yarn twenty dev` (modo watch) en agentes y CI.

### Windows: sincronizar con el script

En Windows, `yarn twenty apply` falla por dos motivos:

- Aborta con `Resource path must not contain backslashes`.
- La subida de archivos usa la `SERVER_URL` del servidor (`http://localhost:3020`), que dentro de un contenedor no resuelve.

Usa el script [`scripts/sync-twenty-app.ps1`](../../scripts/sync-twenty-app.ps1) en lugar de los pasos 3 y 4. El script copia la App a un directorio temporal (sin `node_modules`, `.twenty` ni `.yarn`) y ejecuta `yarn twenty apply` en un contenedor efímero `node:24` conectado a la red `pxos-net`. Dentro, `socat` reenvía `127.0.0.1:3020` a `pxos-twenty:3000`, y el script registra el remote `pxos-tunnel` con tu API key.

1. Guarda la API key (paso 2) como `TWENTY_API_KEY` en `deployments/.env`.
2. Levanta el stack (`docker compose up -d` en `deployments/`).
3. Ejecuta desde la raíz del repositorio, en PowerShell:

   ```powershell
   .\scripts\sync-twenty-app.ps1               # apply
   .\scripts\sync-twenty-app.ps1 -Action plan  # solo previsualiza los cambios
   .\scripts\sync-twenty-app.ps1 -Force        # apply --force, tras revisar los borrados con plan
   ```

El script no modifica `apps/twenty-app/` ni crea `node_modules` en él. Detalles y diagnóstico: [runbook, sección "Sincronizar la Twenty App"](../../docs/runbook-local.md#sincronizar-la-twenty-app).

### Despliegue en otros entornos

Para otro servidor, repite los pasos 2–4 con su URL y un nombre de remote distinto (`--as production`). En CI, configura `TWENTY_DEPLOY_URL` y `TWENTY_DEPLOY_API_KEY` como secretos. Los workflows de `.github/workflows/` son los de la plantilla oficial y solo se ejecutan si esta carpeta se convierte en la raíz de un repositorio.

## Referencias

- [Twenty Apps — Quick start](https://docs.twenty.com/developers/extend/apps/getting-started/quick-start)
- [Objects](https://docs.twenty.com/developers/extend/apps/data/objects) · [Relations](https://docs.twenty.com/developers/extend/apps/data/relations) · [Views](https://docs.twenty.com/developers/extend/apps/layout/views) · [Navigation menu items](https://docs.twenty.com/developers/extend/apps/layout/navigation-menu-items)
- Agent Skills oficiales de Twenty: `npx skills add https://github.com/twentyhq/twenty/tree/agent-skills --list` (código fuente en `packages/twenty-agent-skills`).
