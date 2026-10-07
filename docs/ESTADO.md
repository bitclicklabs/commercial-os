# Estado del proyecto — bitácora del PM

Tablero de avance por tandas. Lo actualiza el PM en cada rama de integración; el histórico fino está en los PR.

## Tanda 1 — MVP-0 bootstrap ✅ (PR #1, fusionado 2026-10-06)

- [x] Stack Docker local `pxos`: Twenty v2.45.6 (:3020), Postgres pgvector (:5440), Redis (:6391)
- [x] Workspace PubliEXPE + API key (en `deployments/.env`, fuera de git)
- [x] Twenty App `publiexpe-commercial-os`: 4 objetos custom, navegación y vistas, sincronizada
- [x] Agent Runtime (:4020): API agents/tasks/executions, worker BullMQ, agente stub, traces, idempotencia, tests 27/27
- [x] LLD v0.2, CONTRIBUTING, runbook (con huecos), PORTS
- [x] Slice e2e: CommercialSignal por REST visible en la vista Signals

## Tanda 2 — Scheduler, tools reales y Prospector ✅ (PR #2, 2026-10-06)

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Scheduler (CRON/INTERVAL/ONCE), `max_concurrency`, locks por entidad, recuperación de runs huérfanos | `feat/scheduler-locks` | Opus | ✅ fusionado (57/57 tests; integración combinada con tools: 107/107) |
| Tools reales contra Twenty (7 tools) + registry con clases de riesgo y allowlist | `feat/twenty-tools` | Opus | ✅ fusionado (77/77 tests, e2e real contra Twenty) |
| Runbook completado, script de sync de la App (workaround Windows), CHANGELOG | `docs/runbook-ops` | Sonnet | ✅ fusionado en feat/tanda2 (+ fix de README/.env.example de deployments por el PM) |
| Prospector v1 con LLM (hipótesis desde datos de evento; HITL por estados) + GeminiProvider | `feat/prospector` | Opus | ✅ fusionado (probado en vivo: ~0,005 €/run con gemini-flash-latest) |
| Integración, pruebas e2e y PR | `feat/tanda2` | PM | ✅ 131/131 tests; e2e en contenedor COMPLETED (0,006 €); tarea diaria programada 08:00 Europe/Madrid; tarea antigua de demo ARCHIVED |

Notas:
- Decisión (2026-10-06): el proveedor LLM de trabajo es **Gemini** (`gemini-flash-latest`, clave verificada en vivo), con arquitectura multi-proveedor intacta: `ModelProvider` conmutable por agente/entorno (stub | gemini | anthropic) y evaluador con proveedor distinto al ejecutor cuando llegue MVP-2 (LLD §18). `GEMINI_API_KEY`/`GEMINI_MODEL` cableadas en el compose.
- Alcance del Prospector en esta tanda: clasificación y generación de hipótesis desde datos de entrada (fixture/manual). La búsqueda web real es de la tanda 3.

## Tanda 3 — previsto

- Búsqueda web del Prospector (fuentes de ferias/expositores) y deduplicación
- Event bus + AgentRunSummary automático en Twenty
- Catalog Service (conector con el backend de publiexpe — contrato por definir con su equipo)
- Evaluador HUMAN (feedback aceptar/editar/descartar desde Twenty)
