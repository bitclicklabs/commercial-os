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

## Tanda 6 — Catálogo completo, inbound de bajas y LLD v0.3 ✅ (PR #6, 2026-10-07)

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Catálogo completo: paginación hasta el final (91) y fichas de todos los relevantes con presupuesto por tiempo | `feat/catalog-full` | Opus | ✅ fusionado (run real: 91/91 evaluados, 29 empresas con dominio —23 nuevas—, 0,195 €, 16,4 min; atajo JSON operativo) |
| Afinado: el borrador presenta qué es PubliEXPE (garantizado por código) + fix del flaky de events | `fix/afinado` | Opus | ✅ fusionado (descriptor inyectable; flaky = carrera del test, outbox correcto; 4 pasadas limpias) |
| Inbound de bajas: lector IMAP del buzón → alta automática en la lista de supresión (HITL para el resto) | `feat/inbound-bajas` | Opus | ✅ fusionado (solo-lectura verificado a nivel de comandos IMAP; live contra el buzón real OK; task cada 2 h) |
| LLD v0.3: consolidación de todas las decisiones de implementación | `docs/lld-0.3` | Sonnet | ✅ fusionado (22 ADRs, 34 puntos mapeados, 9 contradicciones de docs — reconciliadas por el PM salvo README del runtime, pendiente del cierre) |
| Integración, e2e y PR | `feat/tanda6` | PM | ✅ 433 tests×2; desplegado y sembrado (Prospector v6 lookups=100, EmailDrafter v2 con descriptor, BajasAgent cada 2 h — primer run en Docker: 4 revisados, 0 bajas) |

## Tanda 7 — Envío desde Twenty, puente n8n y skills versionadas ✅ (PR #7, 2026-10-07)

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Cuenta de correo conectada en Twenty: envío HITL con un clic + historial en ficha (hallazgo del usuario) | `feat/twenty-email-account` | Opus | ✅ fusionado (2.45 = solo IMAP/SMTP genérico; workflow manual creado en borrador; campos de email en la hipótesis; HALLAZGO: la API key tenía rol Admin con send_email vía MCP → rol restringido "Agent runtime" creado y asignado, verificado send_email=0) |
| Puente de eventos con n8n: ingesta de eventos externos + reenvío saliente por webhook | `feat/n8n-events` | Opus | ✅ fusionado (ext.* firmados HMAC; journal 0005/0006 refechado por el PM — evitado salto silencioso de migración) |
| Skills versionadas en BD (primer paso MVP-1): tablas, loader, seed de las skills actuales, API sin DELETE | `feat/skills-versionadas` | Opus | ✅ fusionado (4 skills migradas byte a byte; versiones inmutables por trigger SQL; rollback por API; 461 tests) |
| Docs de cierre (guía, runbook, ADRs nuevos en LLD v0.3) | — | — | ✅ ADRs 23-31 añadidas al LLD v0.3 en la tanda 8 (rama docs/adrs-tanda7) |
| Integración, e2e y PR | `feat/tanda7` | PM | ✅ 510 tests; App sincronizada (script ps1 estrenado OK); workflow en borrador validado; rol restringido; 4 skills v1 ACTIVE en BD; Prospector v7/EmailDrafter v3; e2e: hipótesis Tuawa con borrador en campos (DRAFT) |

Fuera de la tanda: Catalog Service (sigue a la espera del contrato del conector con el backend de publiexpe).

## Tanda 8 — Operación de envío y ciclo de mejora ✅ (PR #8, 2026-10-07)

Contexto: el usuario conectó el SMTP, activó el workflow y el primer email real llegó bien ("buena lectura y buen copy").

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Email-ops en el flujo: chequeo automático de la lista de supresión al marcar READY, tracking de envíos (SENT) y contadores de warm-up en el dashboard | `feat/email-ops-flujo` | Opus | ✅ fusionado (probado en vivo: READY-suprimido vuelve a DRAFT con nota ⛔; doble chequeo en SENT; dashboard con fases del calendario; + fix PM: título de la nota de supresión reparado) |
| Ciclo de mejora de skills: playbook, tooling de comparación, y una v2 real del Prospector en DRAFT a partir de trazas/evaluaciones (sin activar: decide el humano) | `feat/skill-cycle` | Opus | ✅ fusionado (EXP-001: v2 mejora F1-F3 pero regresión de semántica de confianza en el holdout → veredicto ITERAR; v2 queda DRAFT; 0,09 € de validación) |
| Docs: ADRs de la tanda 7 al LLD v0.3, guía del comercial con el envío ya activo, runbook | `docs/adrs-tanda7` | Sonnet | ✅ fusionado (ADRs 23-31; guía y warm-up en presente; + fixes PM: guía de envío, README runtime, compose con token de eventos) |
| Integración, e2e y PR | `feat/tanda8` | PM | ✅ 560 tests; redeploy con 0007; bloque Email en métricas verificado (fase Semana 1 detectada); nota de supresión reparada; v2 NO activada siguiendo el gate |

## Tanda 9 — Cierre de MVP-1 y dashboard en Twenty ✅ (PR #9, 2026-10-07)

En paralelo, en sesiones aparte del usuario: desglose por versión de skill en métricas y fix del reconciliador con runs largos del scout. Esta tanda NO toca `src/metrics/queries.ts` ni `src/worker/recovery.ts`, y el checkout principal del repo queda para esa sesión (la integración de la tanda vive en el worktree wt9-integracion).

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Skill v3 del Prospector (EXP-002): corrige la semántica de confianza de la v2, holdout fresco | `feat/skill-v3` | Opus | ✅ fusionado y ACTIVADA por el PM (todos los criterios pre-declarados cumplidos; need con cantidades 20/20, confianza de descartes 0,05, +10,9% coste; rollback: deprecate v3) |
| Harness versionado v1: políticas consolidadas en `harness/harness_versions`, resolución con fallback y registro en el trace | `feat/harness-v1` | Opus | ✅ fusionado (semántica de techo sobre límites por agente; 7 fallbacks probados; comportamiento idéntico verificado; 577 tests) |
| Memoria semántica (KnowledgeEntry) + el Prospector escribe Research | `feat/knowledge-research` | Opus | ✅ fusionado (3 entries ACTIVE con evidencia del EXP-001 y tu feedback; MEMORY_READ en el trace; research real de ARCECARNE en Twenty; 597 tests) |
| Dashboard dentro de Twenty (estudio de viabilidad + implementación si procede) | `feat/twenty-dashboard` | Opus | ✅ fusionado (viable y NATIVO: objeto agentOsDailyMetric + página de KPIs/gráficos + sync cada 15 min; sin CORS ni aperturas; Front Components descartados con evidencia) |
| Integración, e2e y PR | `feat/tanda9` (worktree wt9-integracion) | PM | ✅ 615 tests; migraciones 0008+0009; seed (harness v1, 3 knowledge, Prospector v8/EmailDrafter v4); skill v3 ACTIVADA tras EXP-002; e2e: run con harness@1 + MEMORY_READ + research ✦ PENDIENTE DEL USUARIO: sync de la App (necesita rol Admin temporal en la key) y backfill de métricas |

## Tanda 10 — MVP-2: evaluación formal ✅ (PR #10, 2026-10-07)

Secuenciada: datasets y evaluadores primero; Experiments + Release Gate cuando aterricen. Siguen en curso las 2 sesiones paralelas del usuario (métricas por versión de skill; fix del reconciliador) — `src/metrics/queries.ts` y `src/worker/recovery.ts` siguen vetados.

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Datasets de evaluación desde trazas y veredictos reales (train/val/test sin contaminación, P5) | `feat/eval-datasets` | Opus | ✅ fusionado (prospeccion-v1: 94 casos, P5 operativo con markUsed; hallazgo honesto: 0 etiquetados limpios en VAL/TEST — los 5 veredictos reales están quemados como diseño del EXP-001) |
| Evaluadores RULE + LLM_JUDGE (juez con modelo distinto al ejecutor) + score COMPOSITE con restricciones duras (§11.3) | `feat/evaluators` | Opus | ✅ fusionado (11 evaluadores; composite reproduce el EXP-002: v1 0,706 / v3 0,978; juez ciego a versiones; 0,08 € de juez; 643 tests) |
| Experiments + Release Gate automático (§11.5-11.6, seesaw) integrado con la activación de skills | `feat/experiments-gate` | Opus | ✅ fusionado (EXP-003 automático: FAIL justificado de la v4, Δ 0,007 < 0,02 + riesgo cualitativo nuevo; candado verificado en vivo con 409) |
| Docs de cierre (ADRs, guía, runbook) | — | Sonnet (al final) | ⏸️ |
| Integración, e2e y PR | `feat/tanda10` (worktree wt10-integracion) | PM | ✅ 686 tests; migraciones 0010+0011; desplegado con el candado activo. INCIDENTE PM sin impacto: una verificación contra el runtime viejo (compose sin .env falló y no lo vi) activó la v2 ~3 min; v3 restaurada; 0 trazas afectadas. Lección: comprobar la salida del deploy antes de verificar |

## Tanda 11 — MVP-3: Skill Optimizer automático 🔄 (en curso, 2026-10-07)

Nota: las 2 sesiones paralelas del usuario (métricas por versión; fix del reconciliador) se cancelaron sin dejar PR → ese trabajo se recupera aquí y `src/metrics/queries.ts` / `src/worker/recovery.ts` dejan de estar vetados. Migraciones asignadas: 0012 optimizer, 0013 harness/canary.

| Pieza | Rama | Agente | Estado |
|---|---|---|---|
| Skill Optimizer (§18): harvest de fallos → clustering → candidata por edit-ops → experimento → gate; propuesta de promoción en Twenty, humano activa; BLOCKED_NO_DATA si no hay etiquetas frescas (P5) | `feat/skill-optimizer` | Opus | 🔄 |
| Experimentos de harness (activación con gate, adiós al force) + canario post-gate (% determinista, promote/rollback humanos) | `feat/harness-experiments` | Opus | 🔄 |
| Recuperación del trabajo huérfano: métricas solo con veredictos HUMAN + desglose por versión de skill en /metrics/agents + fix del reconciliador que marcaba FAILED scouts terminados | `feat/metrics-recovery` | Opus | 🔄 |
| Docs: skill-optimizer.md, ciclo-mejora-skills.md (modo automático), ROADMAP al día (MVP-2 ✅, MVP-3 🔄) | `docs/tanda11` | Sonnet | ✅ entregado (pendiente de fusión; detectó docs desfasados en README runtime y ADRs 22/29 — reconcilia el PM) |
| Integración, e2e y PR | `feat/tanda11` (worktree wt11-integracion) | PM | 🔄 worktree creado con .env copiado (lección tanda 10) |
