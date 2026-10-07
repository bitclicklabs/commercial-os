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

## Tanda 3 — Web real, event bus y feedback humano ✅ (PR #3, 2026-10-07)

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Fix carrera de arranque: gate de salud de Twenty antes de runs con tools | `fix/boot-health-gate` | Opus | ✅ fusionado (espera 5/15/30/60s sin gastar intentos, tope 10 min; 138 tests OK) |
| Búsqueda web real: Gemini grounding + `fetch_url` (contenido untrusted) + Prospector sobre ferias reales | `feat/web-search` | Opus | ✅ fusionado (riesgos abiertos: grounding sin metadatos de fuentes en Gemini 3.8 → fallback por descarga; catálogos JS/PDF ilegibles → señal a nivel de feria) |
| Event bus: tabla `events`, publicación task.*/execution.* y trigger EVENT del scheduler | `feat/event-bus` | Opus | ✅ fusionado (anti-bucle con chainDepth≤5; integración combinada 170/170) |
| Evaluador HUMAN: webhook de Twenty → tabla `evaluations` (ACCEPTED/EDITED/DISCARDED) | `feat/human-feedback` | Opus | ✅ fusionado (probado en vivo con HMAC; suite combinada 201/201) |
| Guía del comercial (Twenty: señales, hipótesis, estados y feedback) + runbook | `docs/guia-comercial` | Sonnet | ✅ fusionado (+ fix PM: marcadores de conflicto en el README del runtime que venían de main) |
| Integración, e2e y PR | `feat/tanda3` | PM | ✅ 278 tests; contenedor redesplegado; seed v3; webhook ACCEPTED vía contenedor; eventos publicados; scout programado lunes 07:30 |

Contexto del fix de arranque: el 2026-10-07 el catch-up disparó el slot de las 08:00 al encender el host antes de que `pxos-twenty` estuviera healthy → `TWENTY_NETWORK_ERROR` y run `PARTIAL`.

Fuera de esta tanda: Catalog Service (a la espera del contrato del conector con el equipo del backend de publiexpe).

## Tanda 4 — Catálogos legibles, borradores de email y métricas ✅ (PR #4, 2026-10-07)

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Lector de catálogos: extracción de PDF y render de JavaScript (servicio pxos-renderer interno) para el scout | `feat/catalog-reader` | Opus | ✅ fusionado (+ afinado de hidratación; e2e Docker: 20/20 expositores del catálogo JS real, SUCCESS) |
| Borradores de email HITL: hipótesis VALIDATED → evento → borrador personalizado como nota en Twenty. NUNCA envía | `feat/email-drafts` | Opus | ✅ fusionado (e2e en vivo: nota con borrador de 150 palabras, 0,0018 €; línea de baja garantizada por código) |
| Métricas: tasa de aceptación por versión de agente, coste por run y embudo (`GET /metrics` + mini dashboard) | `feat/eval-metrics` | Opus | ✅ fusionado (merge limpio; datos reales: €0.19 acumulado, aceptación 66,7%, AC-15/16 cumplidos) |
| Plan operativo del warm-up de publiexpe.info + guía del comercial (sección borradores) | `docs/email-warmup` | Sonnet | ✅ fusionado (+ fix PM: LLD §10.1 alineado con la realidad del canal) |
| Integración, e2e y PR | `feat/tanda4` | PM | ✅ 342 tests; pxos-renderer desplegado; Prospector v4; e2e scout SUCCESS en Docker (0,06 €) |

Canal de email (recordatorio operativo): warm-up iniciado el 2026-10-06; DMARC pasa a `p=quarantine` hacia el 2026-11-03 si los informes llegan limpios a dmarc@publiexpe.info.

## Tanda 5 — Dominios de expositores y afinado ✅ (PR #5, 2026-10-07)

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Dominios de expositores: paginación del catálogo (91) + fichas individuales → empresas reales con dominio en Twenty | `feat/exhibitor-domains` | Opus | ✅ fusionado (run real: 60 evaluados, 6 empresas con dominio + señal + hipótesis, 0,14 €) |
| Triggers EVENT con OR (EDITED también genera borrador) + archivo de agentes [TEST] y filtro en métricas | `feat/event-or-archive` | Opus | ✅ fusionado (filtro {in:[...]} + guarda toStatus; 22 agentes [TEST] archivados en real; dashboard limpio) |
| Sandbox seccomp de Chromium en pxos-renderer | `feat/tanda5` | PM | ✅ activo (perfil Playwright + cap_add SYS_CHROOT; render real verificado con sandbox) |
| SNDS, procedimiento de lista de supresión y actualización de guía/changelog | `docs/email-ops` | Sonnet | ✅ fusionado (SNDS no aplica con IP compartida de IONOS: documentada la alternativa; lista de supresión decidida como nota en Twenty) |
| Integración, e2e y PR | `feat/tanda5` | PM | ✅ 364 tests×2; desplegado; seed v5 (lookups 20); ciclo real con el usuario: 5 validaciones → 5 borradores; tenant limpio (solo Prospector y EmailDrafter) |

## Tanda 6 — Catálogo completo, inbound de bajas y LLD v0.3 🔄 (en curso, 2026-10-07)

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Catálogo completo: paginación hasta el final (91) y fichas de todos los relevantes con presupuesto por tiempo | `feat/catalog-full` | Opus | 🔄 en curso |
| Afinado: el borrador presenta qué es PubliEXPE (garantizado por código) + fix del flaky de events | `fix/afinado` | Opus | 🔄 en curso |
| Inbound de bajas: lector IMAP del buzón → alta automática en la lista de supresión (HITL para el resto) | `feat/inbound-bajas` | Opus | 🔄 en curso (necesita credenciales IMAP en .env) |
| LLD v0.3: consolidación de todas las decisiones de implementación | `docs/lld-0.3` | Sonnet | 🔄 en curso |
| Integración, e2e y PR | `feat/tanda6` | PM | ⏸️ |
