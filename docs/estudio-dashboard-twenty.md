# Estudio: el dashboard del Agent OS dentro de Twenty

**Fecha:** 2026-10-07 · **Rama:** `feat/twenty-dashboard` · **Instancia estudiada:** `pxos-twenty` (`twentycrm/twenty:v2.45.6`) en `http://localhost:3020`, SDK de Apps `twenty-sdk 2.45.0`.

Este documento responde a una pregunta: ¿puede el dashboard del runtime (`http://127.0.0.1:4020/dashboard`) vivir dentro de Twenty aprovechando sus funciones nativas? Recoge la evidencia obtenida de la instancia real, compara cuatro vías y describe la que se implementa.

**Resumen:** sí es viable y de forma nativa. Twenty 2.45 trae dashboards con gráficos sobre registros y deja que una App declare una página propia con esos mismos widgets. Lo que solo sabe el runtime (coste real por run, envíos, objetivo de warm-up, aceptación humana) se sincroniza a un objeto nuevo, `agentOsDailyMetric`, y se grafica con widgets nativos. No hace falta CORS ni exponer la API del runtime.

## 1. Qué ofrece Twenty 2.45 self-hosted (evidencia)

### 1.1 Dashboards nativos: sí, sobre cualquier objeto

- El objeto estándar `dashboard` existe y la instancia ya tiene uno: «My First Dashboard» (`GET /graphql { dashboards }`), con `pageLayoutId` → page layout de tipo `DASHBOARD`.
- Su page layout (`/metadata getPageLayout`) contiene widgets `GRAPH` de los cuatro tipos que valida el servidor (`VALID_GRAPH_CONFIGURATION_TYPES`): `AGGREGATE_CHART` (KPI, con filtro de fecha relativo `THIS_1_MONTH`), `BAR_CHART`, `LINE_CHART` y `PIE_CHART`, más `IFRAME` y `STANDALONE_RICH_TEXT`.
- Los gráficos agregan sobre **cualquier objeto con campos agregables**, también los custom: `objectMetadataId` + `aggregateFieldMetadataId` + `aggregateOperation` (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `COUNT_*`, `PERCENTAGE_*`), con agrupación por campo y granularidad de fecha (`DAY`, `WEEK`, `MONTH`…). `SUM` sobre CURRENCY funciona (el ejemplo «Deal value created this month» suma `opportunity.amount`).
- Filtros de los gráficos: `recordFilters` + `recordFilterGroups` (AND/OR), con operandos `IS_TODAY`, `IS_RELATIVE` (`PAST_6_DAY;;Europe/Madrid;;MONDAY;;`), etc. El servidor los valida al sincronizar (`validate-chart-filter.util`). Comprobado con `twenty-shared` dentro del contenedor: `PAST_6_DAY` resuelve a `2026-10-01 … 2026-10-07` **excluyendo hoy**, así que «7 días con hoy» se escribe como `IS_TODAY OR PAST_6_DAY`.

### 1.2 Front Components de Apps: renderizan en widgets, pero no pueden leer el runtime

- El SDK define `defineFrontComponent` y el widget `FRONT_COMPONENT` (dashboards, record pages, side panel, command menu, ajustes de la App).
- Sandbox: el código corre en un Web Worker con Remote DOM, dentro de un iframe de **origen opaco**. La documentación oficial (front-components) lo dice explícitamente: las peticiones a otros orígenes salen con `Origin: null` y solo funcionan si el servidor responde `Access-Control-Allow-Origin: *`; la recomendación es llamar desde una logic function.
- Las **logic functions están desactivadas** en esta instancia: `LOGIC_FUNCTION_TYPE` vale `DISABLED` cuando `NODE_ENV=production` (`config-variables.js`, línea 119), el contenedor tiene `NODE_ENV=production` y no hay override en `core.keyValuePair`. Activar el driver `LOCAL` ejecutaría código de Apps dentro del proceso del servidor: cambio de compose y de postura de seguridad.
- Además: sin `canvas`, sin `ResizeObserver`; habría que dibujar gráficos con SVG a mano.

### 1.3 Página propia de la App: sí, `STANDALONE_PAGE`

- El SDK expone `definePageLayout` con `type: STANDALONE_PAGE | DASHBOARD | RECORD_PAGE | …` y `defineNavigationMenuItem` con `type: PAGE_LAYOUT`.
- El servidor exige que una entrada `PAGE_LAYOUT` apunte a un `STANDALONE_PAGE` («PAGE_LAYOUT navigation menu item must reference a STANDALONE_PAGE page layout», `validate-navigation-menu-item-page-layout-reference-cross-entity.util`). Un `DASHBOARD` declarado por la App solo sería visible creando además un registro `dashboard`, algo que el manifiesto no puede hacer.
- El front (`StandalonePageLayoutPage`) usa el mismo `PageLayoutRenderer` que los dashboards; para `STANDALONE_PAGE` respeta el `layoutMode` de la pestaña (`GRID` = rejilla de dashboard). El servidor solo rechaza el widget `VIEW` para Apps; `GRAPH`, `RECORD_TABLE`, `IFRAME` y `STANDALONE_RICH_TEXT` se aceptan.
- `RECORD_TABLE` usa una vista de tipo `TABLE_WIDGET`, que no sale en el selector de vistas del objeto.

### 1.4 Los datos que ya están en Twenty no bastan

| Fuente | Runs | Coste |
|---|---|---|
| Runtime, `GET /metrics/summary` | 58 | 0,966 € |
| Twenty, `agentRunSummaries` (todos) | 90 | 3,16 € |
| Twenty, `agentRunSummaries` sin `[TEST]` | 48 | 1,36 € |

`agentRunSummary` lo publica el agente al terminar: faltan tareas que no publican resumen (p. ej. `process-unsubscribes`), sobran los resúmenes de los tests de integración y el coste no siempre coincide con el de `agent_executions` (todos los intentos). Los envíos (`email_sends`), el calendario de warm-up y los veredictos humanos (`evaluations`) **solo existen en el runtime**.

## 2. Vías comparadas

| Vía | Qué es | Mantenimiento | Seguridad | Ecosistema Twenty | Veredicto |
|---|---|---|---|---|---|
| 1. Front Component que consume `/metrics/*` | Componente React de la App que hace `fetch` a `127.0.0.1:4020` | Alto: UI y gráficos SVG propios, build de front components | **Malo**: el sandbox envía `Origin: null`, el runtime tendría que responder `ACAO: *` (o `null`), y cualquier página abierta en el navegador podría leer las métricas. Vía logic function: desactivadas en producción | Medio | Descartada |
| 1b. Widget IFRAME con `/dashboard` | Embeber la página actual | Bajo | Hay que relajar `X-Frame-Options: DENY` y `frame-ancestors 'none'`; no funciona si Twenty se sirve por HTTPS remoto (contenido mixto) | Bajo: es la misma página, no se integra con filtros ni datos de Twenty | Descartada |
| 2. Dashboards nativos sobre los datos actuales | Gráficos sobre `agentRunSummary` | Nulo | Bueno | Alto | Insuficiente: cifras distintas (sección 1.4); sin envíos, warm-up ni aceptación |
| 3. Sincronizar métricas agregadas a un objeto y graficar nativo | El runtime escribe un registro diario; la App declara la página con widgets nativos | Bajo: un módulo pequeño y declaraciones de la App | Bueno: el runtime **sale** hacia Twenty con su API key, como ya hace; no se abre nada nuevo | **Máximo**: gráficos, filtros, permisos, vistas y Dashboards de usuario | **Elegida**, combinada con 2 para la tabla de últimos runs |
| 4. No viable | Mantener `/dashboard` y enlazarlo | Nulo | Bueno | Bajo | Se conserva como complemento (enlace) |

## 3. Solución implementada (vías 3 + 2 + 4)

```text
runtime (rol scheduler)                         Twenty
  metricsSummary(día local) ──cada 15 min──►  agentOsDailyMetric (1 registro/día)
                                                    │  widgets GRAPH nativos
  agentRunSummary (lo publican los agentes) ──►     │  RECORD_TABLE (últimos runs)
                                                    ▼
                                    Commercial OS › Métricas  (STANDALONE_PAGE)
                                    Commercial OS › Agent OS (detalle técnico) → 127.0.0.1:4020/dashboard
```

### 3.1 Twenty App (`apps/twenty-app`, cambios aditivos)

- `src/objects/agent-os-daily-metric.object.ts`: objeto `agentOsDailyMetric` (solo lectura en la UI) con `day` (DATE), `dayKey` único, `runs`, `runsSucceeded`, `runsFailed`, `cost` (CURRENCY EUR), `hypothesesCreated`, `emailSends`, `warmupTarget`, `warmupStage`, `warmupPhase`, `humanReviewed`, `humanAccepted`, `acceptanceRate` (% acumulado) y `syncedAt`.
- `src/page-layouts/agent-os-metrics.page-layout.ts`: página «Agent OS · Métricas», pestaña GRID de 12 columnas:

  | Fila | Widgets |
  |---|---|
  | 1 | Runs hoy · Runs 7 días · Coste hoy · Coste 7 días (KPI) |
  | 2 | Tasa de aceptación · Envíos hoy · Objetivo warm-up hoy · Envíos 7 días (KPI) |
  | 3 | Envíos por día · Objetivo warm-up por día (barras, 14 días) |
  | 4 | Coste por día · Runs por día (barras, 14 días) |
  | 5 | Últimos runs (tabla de `agentRunSummary`, 10 filas, sin `[TEST]`, con enlace a la traza) |
  | 6 | Cómo leer esta página (texto) |

- `src/views/latest-agent-runs.view.ts`: vista `TABLE_WIDGET` de la tabla.
- `src/navigation-menu-items/`: **Métricas** (`PAGE_LAYOUT`) y **Agent OS (detalle técnico)** (`LINK` a `http://127.0.0.1:4020/dashboard`) dentro de la carpeta Commercial OS.
- No se modifica ningún objeto ni campo existente. `AgentRunSummary` no necesita campos nuevos: la página no agrega sobre él.

### 3.2 Runtime (`runtime/agent-runtime`)

- `src/metrics/twenty-sync.ts`: para cada día local (Europe/Madrid, consciente del cambio de hora) llama a `metricsSummary` con la ventana `[00:00, 00:00 del día siguiente)` y una segunda vez sin `since` para la aceptación acumulada. Upsert por `dayKey` (busca, PATCH o POST; una carrera perdida se resuelve como PATCH). Nunca borra.
- Degradación: sin API key, con Twenty caído o sin la App sincronizada, la pasada devuelve `ok: false`, registra **un** aviso por error distinto (con la pista «is the Twenty App synced?») y lo reintenta en la siguiente. La API, `/dashboard` y los agentes no se ven afectados.
- `src/main.ts`: arranca el sync en el rol scheduler solo si `METRICS_TWENTY_SYNC_ENABLED=true`.
- `pnpm metrics:sync-twenty [--days=30] [--tenant=publiexpe] [--dry-run]`: una pasada manual para rellenar el histórico.
- `src/metrics/queries.ts` no se toca: el sync reutiliza `metricsSummary`, así que las cifras de Twenty y de `/metrics/summary` no pueden divergir.
- Sin CORS: el runtime no recibe peticiones nuevas. `/dashboard` mantiene `frame-ancestors 'none'` y la comprobación de petición local.

### 3.3 Variables nuevas (`runtime/agent-runtime/.env.example`)

| Variable | Por defecto | Uso |
|---|---|---|
| `METRICS_TWENTY_SYNC_ENABLED` | `false` | `true` activa el sync en el rol scheduler |
| `METRICS_TWENTY_SYNC_INTERVAL_MS` | `900000` (15 min) | Frecuencia; mínimo 60 000 |
| `METRICS_TWENTY_SYNC_DAYS` | `2` | Días refrescados por pasada, hoy incluido (1 a 62) |

## 4. Despliegue (PM)

1. Previsualiza y sincroniza la App:

   ```powershell
   .\scripts\sync-twenty-app.ps1 -Action plan
   .\scripts\sync-twenty-app.ps1
   ```

   El plan debe mostrar solo creaciones: 1 objeto, 1 vista, 1 page layout con 1 pestaña y 14 widgets, y 2 entradas de navegación.

2. Añade las variables al servicio `pxos-runtime` de `deployments/docker-compose.yml` (bloque `environment`):

   ```yaml
         METRICS_TWENTY_SYNC_ENABLED: ${METRICS_TWENTY_SYNC_ENABLED:-true}
         METRICS_TWENTY_SYNC_INTERVAL_MS: ${METRICS_TWENTY_SYNC_INTERVAL_MS:-900000}
         METRICS_TWENTY_SYNC_DAYS: ${METRICS_TWENTY_SYNC_DAYS:-2}
   ```

   `TWENTY_BASE_URL` (`http://pxos-twenty:3000`) y `TWENTY_API_KEY` ya están cableadas.

3. Reconstruye y reinicia el runtime (`docker compose up -d --build pxos-runtime`). En el log debe aparecer `metrics sync to Twenty started`.
4. Rellena el histórico una vez:

   ```bash
   docker exec pxos-runtime node dist/maintenance/sync-metrics-to-twenty.js --days=30
   ```

   En desarrollo: `pnpm metrics:sync-twenty --days=30`.

5. Abre **Commercial OS › Métricas** en Twenty y comprueba que «Runs 7 días» y «Coste 7 días» coinciden con `/dashboard`.

> **Importante:** si sincronizas el runtime antes que la App, el log muestra un único aviso `metrics sync to Twenty failed … (is the Twenty App synced? …)` y el sync se recupera solo en la primera pasada después del sync de la App.

## 5. Verificación realizada

- App: `typecheckApp` y `buildAppSnapshot` del SDK 2.45 (sin conexión) sin diagnósticos; el manifiesto contiene el objeto, la vista `TABLE_WIDGET`, el page layout `STANDALONE_PAGE` con 14 widgets y las 7 entradas de navegación. `tsgo`, `oxlint` y 13 tests unitarios en verde (rejilla sin solapes, referencias a campos, un grupo de filtros por widget, «7 días» = hoy OR `PAST_6_DAY`).
- Runtime: `tsc` limpio, 498 tests unitarios (17 nuevos) e integración con PostgreSQL (`metrics-twenty-sync.test.ts`: registros iguales a `metricsSummary` del día, día local frente a UTC, upsert en la segunda pasada).
- Ensayo en seco contra la base real del runtime (`--dry-run --days=3`, solo lectura):

  ```text
  2026-10-05 · publiexpe  runs 0   coste 0,000 €  objetivo —   fase BEFORE
  2026-10-06 · publiexpe  runs 5   coste 0,022 €  objetivo 10  Semana 1
  2026-10-07 · publiexpe  runs 53  coste 0,945 €  objetivo 10  Semana 1  aceptación 90,9 % (10/11)
  ```

  La suma (58 runs, 0,966 €) y la aceptación (90,9 %) coinciden con `GET /metrics/summary`.

## 6. Limitaciones y riesgos

- **Sin verificación visual todavía:** la App no se ha desplegado (lo hace el PM). El servidor valida tipos de widget, filtros y referencias al sincronizar; el render se ha comprobado en el código del front 2.45, no en pantalla.
- **Envíos frente a objetivo en dos gráficos:** un gráfico nativo agrega un solo campo; no hay serie doble «envíos vs objetivo» en el mismo eje.
- **Retraso:** hasta 15 minutos (configurable). El detalle en tiempo real sigue en `/dashboard`.
- **Tabla por agente y versión:** no se replica; queda en el enlace «Agent OS (detalle técnico)». Si se quiere nativa, la evolución natural es un segundo objeto `agentOsAgentVersionMetric` con el mismo patrón.
- **Enlace al runtime:** solo funciona en el equipo que ejecuta el runtime (el puerto se publica en `127.0.0.1`), como hoy.
- **Ventaja adicional:** al ser un objeto normal, el equipo puede montar sus propios Dashboards de Twenty (menú Dashboards) sobre `Agent OS metrics` sin tocar código.
