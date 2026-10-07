# Roadmap — LLD 0.1 frente a lo construido

Actualizado: 2026-10-07 (tanda 11). Contrasta la visión completa del [LLD v0.1](LLD-0.1-publiexpe-commercial-os.md) con el estado real. El detalle fino por decisión está en el [LLD v0.3 (estado real)](LLD-0.3-estado-real.md) y la bitácora por tandas en [ESTADO.md](ESTADO.md).

**Leyenda:** ✅ hecho · 🟡 parcial · 🔄 en curso (tanda 11) · ⬜ pendiente · ⛔ bloqueado por decisión externa

## Respuesta corta: ¿estamos llegando?

- **La capa de valor comercial (MVP-0 del LLD §26) está al 100% y en producción local**: prospección autónoma de ferias reales, hipótesis en el CRM, feedback humano capturado, borradores y envío HITL con un clic. Coste total de LLM del proyecto: < 1 €.
- **La plataforma evolutiva — lo que convierte esto en "no un CRM con ChatGPT pegado" — ya funciona de punta a punta salvo el último tramo**: MVP-1 ✅ (skills y harness versionados, memoria semántica, Research; tanda 9) y MVP-2 ✅ (datasets sin contaminación, evaluadores, Experiments y Release Gate con candado en la activación; tanda 10, con EXP-003 como primer experimento automático). La tanda 11 cierra el **MVP-3** 🔄: Skill Optimizer automático sobre el gate, gate también para harness y canario post-gate. MVP-4 (entornos sintéticos) ⬜.
- **Un solo bloqueo externo**: el Catalog Service espera el contrato del conector con el backend de publiexpe. Es la pieza que hará que las hipótesis recomienden productos reales.
- **Un límite honesto de los datos**: el optimizador necesita veredictos humanos frescos para validar. El `VALIDATION` de `prospeccion-v1` se quemó en EXP-003, así que hasta que el equipo comercial genere etiquetas nuevas una optimización puede terminar en `BLOCKED_NO_DATA` (consulta [Skill Optimizer](skill-optimizer.md)).

## Mapa por áreas del LLD 0.1

### Fundamentos (P1-P6) — ✅

| Principio | Estado | Dónde |
|---|---|---|
| P1 Twenty system of record | ✅ | [apps/twenty-app](../apps/twenty-app/README.md) |
| P2 Agent OS separado | ✅ | [runtime/agent-runtime](../runtime/agent-runtime/README.md) |
| P3 Todo lo evolutivo con versión | 🟡 agentes/tasks/skills/harness ✅; router/evaluator/environment ⬜ | [Skills](../runtime/agent-runtime/README.md#skills), [Harness](../runtime/agent-runtime/README.md#harness) |
| P4 Ejecución inmutable | ✅ (config del run + skill_version y harness exactas en el trace) | traces/trace_steps |
| P5 Nunca evaluar sobre lo que generó el cambio | ✅ operativo: `markUsed` y casos quemados en los datasets, reserva previa en `experiment:run` (tanda 10); el optimizador lo hereda 🔄 | [Datasets](../runtime/agent-runtime/README.md#datasets-de-evaluación) |
| P6 Plataforma fuera de Twenty | ✅ | ADR-01 del [LLD v0.3](LLD-0.3-estado-real.md) |

### Sistema comercial (§5, §10, §15, §23) — ✅ el motor funciona

| Pieza | Estado | Dónde |
|---|---|---|
| CommercialSignal / CommercialHypothesis | ✅ | [App](../apps/twenty-app/README.md) |
| Research | ✅ el Prospector escribe Research con hechos observados y fuentes (tanda 9) | README runtime, sección Research |
| Canal de email (dominio, DNS, warm-up) | ✅ (warm-up en curso, iniciado el 2026-10-06) | [email-warmup.md](email-warmup.md) |
| Borradores HITL + envío con un clic desde Twenty | ✅ (estrenado 2026-10-07) | [twenty-envio-email.md](twenty-envio-email.md) |
| Inbound: bajas automáticas | ✅ · triaje general de respuestas ⬜ | README runtime, sección Inbound |
| Supresión automática en el flujo de envío | ✅ (tanda 8: chequeo al marcar READY y en SENT) | README runtime |
| Tools con riesgo/allowlist/human gates | ✅ · faltan `create_activity` y las del catálogo | README runtime, sección Tools |
| UI comercial en Twenty + guía | ✅ | [guia-comercial.md](guia-comercial.md) |
| Catalog Service (§9) | ⛔ a la espera del contrato del conector (acción: usuario/equipo backend publiexpe) | LLD 0.1 §9 |

### Runtime y robustez (§8, §12, §21, §22) — ✅ sólido

| Pieza | Estado | Dónde |
|---|---|---|
| Runtime (API, colas, worker, recovery, gate de salud) | ✅ (el reconciliador de huérfanos corregido en la tanda 11 🔄) | README runtime |
| Scheduler CRON/INTERVAL/ONCE/EVENT | ✅ · DEPENDENCY/CONDITION ⬜ | README runtime |
| Idempotencia, locks, concurrencia | ✅ | — |
| Event bus + eventos externos (n8n) | ✅ | [n8n-integracion.md](n8n-integracion.md) |
| Seguridad: untrusted web, SSRF, sandbox Chromium, rol restringido de la API key | ✅ | ADRs del LLD v0.3 |
| Retención de trazas (purga §22) y `audit_log` como objeto | ⬜ tanda 12+ | LLD 0.1 §22 |
| Export de contratos a JSON Schema versionado (§21) | ⬜ | — |
| Multi-tenant | 🟡 columna `tenant_id` en todo (lo previsto para v0.x) | — |

### Observabilidad y evaluación (§11, §17) — ✅ con el canario en curso

| Pieza | Estado | Dónde |
|---|---|---|
| Traces estructurados + cost tracking | ✅ | README runtime |
| Dashboard y métricas (aceptación por versión de agente) | ✅ local y dentro de Twenty (tanda 9) · desglose por versión de skill y filtro `kind='HUMAN'` 🔄 tanda 11 | `GET /dashboard`, `GET /metrics/agents` |
| Evaluador HUMAN | ✅ | README runtime, sección Evaluador |
| Evaluadores EXACT/RULE/LLM_JUDGE/COMPOSITE | ✅ tanda 10 (11 evaluadores; juez con modelo distinto al ejecutor) | LLD 0.1 §11 |
| Datasets train/validation/test desde trazas | ✅ tanda 10 (`prospeccion-v1`, 94 casos; 0 etiquetados limpios en VAL/TEST) | [Datasets](../runtime/agent-runtime/README.md#datasets-de-evaluación) |
| Experiments formales + Release Gate | ✅ tanda 10 (EXP-003 automático; candado en la activación) | [Experiments y Release Gate](../runtime/agent-runtime/README.md#experiments-y-release-gate) |
| Canary y rollback (§11.7) | 🔄 tanda 11: canario post-gate con reparto determinista, una por skill, promote/rollback humano | [skill-optimizer.md](skill-optimizer.md#canario-despliegue-gradual-tras-el-gate) |
| Failure clustering (§17.4) | 🔄 tanda 11: agrupación de fallos con LLM en el optimizador (antes, manual en EXP-001) | [skill-optimizer.md](skill-optimizer.md) |

### Plataforma evolutiva (§6.3-6.4, §7, §13, §14, §16, §18) — el tramo que se cierra

| Pieza | Estado | Plan |
|---|---|---|
| Skills/SkillVersions versionadas e inmutables | ✅ tanda 7 | — |
| Ciclo de mejora de skills (manual, humano como gate) | ✅ tanda 8-10 (EXP-001, EXP-002 y EXP-003) | [ciclo-mejora-skills.md](ciclo-mejora-skills.md): sigue siendo el fallback |
| Harness versionado (§7) | ✅ v1 tanda 9 · con Release Gate para activarlo 🔄 tanda 11 (exige gate `PASS`/`PASS_FORM` o `force` con motivo) | [Harness](../runtime/agent-runtime/README.md#harness) |
| Memoria semántica / KnowledgeEntry (§6.4, §16) | ✅ tanda 9 (3 entradas ACTIVE con evidencia) | [Knowledge](../runtime/agent-runtime/README.md#knowledge-memoria-semántica) |
| Router/orquestación multi-agente (§14) | ⬜ decisión registrada: hoy un solo Prospector (+EmailDrafter); el grafo Researcher/Scorer se descartó de facto — revalidar si hace falta al crecer | ADR del LLD v0.3 |
| Environments sintéticos + curriculum (§13) | ⬜ MVP-4 | Tanda 12+ |
| Optimizadores automáticos (§18) | 🔄 Skill Optimizer en la tanda 11 (manual, sin tarea programada, el humano promueve) · Harness Optimizer y Router Optimizer ⬜ | [skill-optimizer.md](skill-optimizer.md) |
| Model routing por tarea (§18, barato/razonador/evaluador independiente) | 🟡 multi-proveedor ✅ y juez con modelo distinto ✅; routing por tarea ⬜ (el ejecutor es siempre gemini-flash) | Revisar antes del 2027-01-01 (sube el precio de 3.8-flash) |

## Ruta propuesta (tandas siguientes)

1. **Tanda 9 — cerrar MVP-1** ✅: harness v1, KnowledgeEntry y Research escrito por el Prospector, y dashboard dentro de Twenty.
2. **Tanda 10 — MVP-2, evaluación formal** ✅: datasets desde trazas anotadas, evaluadores RULE/LLM_JUDGE/COMPOSITE, Experiments y Release Gate con candado en la activación; EXP-003 fue el primer experimento automático.
3. **Tanda 11 — MVP-3** 🔄: [Skill Optimizer](skill-optimizer.md) automático sobre el gate (cosecha de fallos → clusters → candidata → experimento → propuesta de promoción en Twenty), Release Gate también para versiones de harness, canario post-gate, métricas por versión de skill (solo evaluaciones `HUMAN`) y reconciliador de huérfanos corregido. El humano sigue aprobando toda promoción.
4. **Tanda 12 y siguientes** (por orden de prioridad aproximado):
   - **MVP-4 — environments sintéticos**: entornos dinámicos y generación de curriculum para alimentar optimizaciones cuando faltan etiquetas reales (el cuello de botella que revela `BLOCKED_NO_DATA`).
   - **Triaje inbound general**: clasificar respuestas de clientes (hoy solo se detectan bajas).
   - **Retención de trazas y `audit_log`** (§22).
   - Export JSON Schema (§21) y triggers DEPENDENCY/CONDITION.
   - Optimización programada del Skill Optimizer, Harness Optimizer y Router Optimizer, cuando haya datos y confianza en el gate.
   - **Catalog Service**: sigue ⛔ a la espera del contrato del conector con el backend de publiexpe; se retoma cuando llegue.

## Hitos de calendario (no perder)

| Fecha | Hito |
|---|---|
| Cada lunes 07:30 | Scout semanal de ferias (próximo: 2026-10-12, el primero automático). Sus hipótesis, una vez revisadas, son los veredictos frescos que desbloquean al optimizador |
| Diario 08:00 | Prospección + rutina de 10 min del comercial ([guía](guia-comercial.md)) |
| 2026-11-03 | DMARC `p=none` → `p=quarantine` si los informes van limpios ([plan](email-warmup.md)) |
| 2027-01-01 | gemini-3.8-flash duplica precio: revisar modelo/routing y los costes orientativos de [skill-optimizer.md](skill-optimizer.md#costes-orientativos) |
