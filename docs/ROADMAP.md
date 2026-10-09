# Roadmap — LLD 0.1 frente a lo construido

Actualizado: 2026-10-09 (tanda 14). Contrasta la visión completa del [LLD v0.1](LLD-0.1-publiexpe-commercial-os.md) con el estado real. El detalle fino por decisión está en el [LLD v0.3 (estado real)](LLD-0.3-estado-real.md) y la bitácora por tandas en [ESTADO.md](ESTADO.md).

**Leyenda:** ✅ hecho · 🟡 parcial · 🔄 en curso (tanda 14) · ⬜ pendiente · ⛔ bloqueado por decisión externa

## Respuesta corta: ¿estamos llegando?

- **La capa de valor comercial (MVP-0 del LLD §26) está al 100% y en producción local**: prospección autónoma de ferias reales, hipótesis en el CRM, feedback humano capturado, borradores y envío HITL con un clic. Coste total de LLM del proyecto: < 1 €.
- **La plataforma evolutiva — lo que convierte esto en "no un CRM con ChatGPT pegado" — ya funciona de punta a punta salvo el último tramo**: MVP-1 ✅ (skills y harness versionados, memoria semántica, Research; tanda 9) y MVP-2 ✅ (datasets sin contaminación, evaluadores, Experiments y Release Gate con candado en la activación; tanda 10, con EXP-003 como primer experimento automático). MVP-3 ✅ (tanda 11): Skill Optimizer automático sobre el gate, gate también para harness y canario post-gate. La **tanda 12** ✅ no abrió un MVP nuevo: cerró deudas de operación (revalidación de `PASS_FORM`, triaje general del inbound, audit log con retención de trazas, y stall-guard). La **tanda 13** ✅ las endurece (el gate bloquea una revalidación `REFUTED`; archivado programado de trazas), prepara el cambio de precio del 2027-01-01 con model routing por roles y abre MVP-4 🔄 con [environments sintéticos](environments-sinteticos.md) (que alimentan reglas, seesaw y forma, no la accuracy del gate). La **tanda 14** 🔄 construye el lado runtime del [Catalog Service](catalog-service.md) contra un stub y añade la [optimización programada](skill-optimizer.md#programado) (apagada por defecto).
- **Un solo bloqueo externo, ya desbloqueado en lo que depende de nosotros**: el Catalog Service esperaba cerrar el contrato del conector con el backend de publiexpe. **El [contrato v1.1 está cerrado](catalog-connector-contrato.md) (2026-10-09)**; el backend lo implementa (estimación: ~16 días) y Commercial OS construye su lado contra un stub fiel. La **conmutación stub → http** se hará cuando el backend entregue el conector. Es la pieza que hará que las hipótesis recomienden productos reales.
- **Un límite honesto de los datos**: el optimizador necesita veredictos humanos frescos para validar. El `VALIDATION` de `prospeccion-v1` se quemó en EXP-003, así que hasta que el equipo comercial genere etiquetas nuevas una optimización puede terminar en `BLOCKED_NO_DATA` (consulta [Skill Optimizer](skill-optimizer.md)). Esas mismas etiquetas permiten, desde la tanda 12 ✅, [revalidar un `PASS_FORM`](skill-optimizer.md#revalidación-de-un-pass_form) a coste cero, y desde la tanda 13 ✅ un `REFUTED` [bloquea el gate](skill-optimizer.md#qué-hace-el-gate-con-una-revalidación). Los [environments sintéticos](environments-sinteticos.md) no sustituyen esas etiquetas: la accuracy del gate se mide solo con veredictos humanos.

## Mapa por áreas del LLD 0.1

### Fundamentos (P1-P6) — ✅

| Principio | Estado | Dónde |
|---|---|---|
| P1 Twenty system of record | ✅ | [apps/twenty-app](../apps/twenty-app/README.md) |
| P2 Agent OS separado | ✅ | [runtime/agent-runtime](../runtime/agent-runtime/README.md) |
| P3 Todo lo evolutivo con versión | 🟡 agentes/tasks/skills/harness ✅; router ⬜; evaluator ✅; environment 🔄 (sintéticos, tanda 13) | [Skills](../runtime/agent-runtime/README.md#skills), [Harness](../runtime/agent-runtime/README.md#harness) |
| P4 Ejecución inmutable | ✅ (config del run + skill_version y harness exactas en el trace) | traces/trace_steps |
| P5 Nunca evaluar sobre lo que generó el cambio | ✅ operativo: `markUsed` y casos quemados en los datasets, reserva previa en `experiment:run` (tanda 10); el optimizador lo hereda ✅ (tanda 11) y la revalidación de `PASS_FORM` lo respeta ✅ | [Datasets](../runtime/agent-runtime/README.md#datasets-de-evaluación) |
| P6 Plataforma fuera de Twenty | ✅ | ADR-01 del [LLD v0.3](LLD-0.3-estado-real.md) |

### Sistema comercial (§5, §10, §15, §23) — ✅ el motor funciona

| Pieza | Estado | Dónde |
|---|---|---|
| CommercialSignal / CommercialHypothesis | ✅ | [App](../apps/twenty-app/README.md) |
| Research | ✅ el Prospector escribe Research con hechos observados y fuentes (tanda 9) | README runtime, sección Research |
| Canal de email (dominio, DNS, warm-up) | ✅ (warm-up en curso, iniciado el 2026-10-06) | [email-warmup.md](email-warmup.md) |
| Borradores HITL + envío con un clic desde Twenty | ✅ (estrenado 2026-10-07) | [twenty-envio-email.md](twenty-envio-email.md) |
| Inbound: bajas automáticas | ✅ · triaje general de respuestas ✅ tanda 12 (clasifica todo el buzón; nunca responde; evento `email.reply_received`) | [inbound-triaje.md](inbound-triaje.md) |
| Supresión automática en el flujo de envío | ✅ (tanda 8: chequeo al marcar READY y en SENT) | README runtime |
| Tools con riesgo/allowlist/human gates | ✅ · faltan `create_activity`; las del catálogo (`catalog_*`, READ) 🔄 tanda 14 contra stub | README runtime, sección Tools |
| UI comercial en Twenty + guía | ✅ | [guia-comercial.md](guia-comercial.md) |
| Catalog Service (§9) | 🔄 **Contrato v1.1 cerrado 2026-10-09**; backend ~16 días; lado runtime contra stub en la tanda 14 (`CATALOG_ENABLED=false`); **conmutación stub → http al entregar** (antes ⛔) | [catalog-service.md](catalog-service.md), [catalog-connector-contrato.md](catalog-connector-contrato.md), LLD 0.1 §9 |

### Runtime y robustez (§8, §12, §21, §22) — ✅ sólido

| Pieza | Estado | Dónde |
|---|---|---|
| Runtime (API, colas, worker, recovery, gate de salud) | ✅ (reconciliador de huérfanos corregido en la tanda 11 ✅; stall-guard de BullMQ en la tanda 12 ✅) | README runtime |
| Scheduler CRON/INTERVAL/ONCE/EVENT | ✅ · DEPENDENCY/CONDITION ⬜ | README runtime |
| Idempotencia, locks, concurrencia | ✅ | — |
| Event bus + eventos externos (n8n) | ✅ | [n8n-integracion.md](n8n-integracion.md) |
| Seguridad: untrusted web, SSRF, sandbox Chromium, rol restringido de la API key | ✅ | ADRs del LLD v0.3 |
| Retención de trazas (§22) y `audit_log` | ✅ tanda 12: `audit_log` append-only consultable en `GET /audit`; archivado manual sin pérdida (`pnpm traces:archive`) · archivado programado ✅ tanda 13 (apagado por defecto, `TRACE_ARCHIVE_ENABLED`) | [runbook-local.md](runbook-local.md#archivado-de-trazas) |
| Export de contratos a JSON Schema versionado (§21) | ⬜ | — |
| Multi-tenant | 🟡 columna `tenant_id` en todo (lo previsto para v0.x) | — |

### Observabilidad y evaluación (§11, §17) — ✅

| Pieza | Estado | Dónde |
|---|---|---|
| Traces estructurados + cost tracking | ✅ | README runtime |
| Dashboard y métricas (aceptación por versión de agente) | ✅ local y dentro de Twenty (tanda 9) · desglose por versión de skill y filtro `kind='HUMAN'` ✅ tanda 11 | `GET /dashboard`, `GET /metrics/agents` |
| Evaluador HUMAN | ✅ | README runtime, sección Evaluador |
| Evaluadores EXACT/RULE/LLM_JUDGE/COMPOSITE | ✅ tanda 10 (11 evaluadores; juez con modelo distinto al ejecutor) | LLD 0.1 §11 |
| Datasets train/validation/test desde trazas | ✅ tanda 10 (`prospeccion-v1`, 94 casos; 0 etiquetados limpios en VAL/TEST) | [Datasets](../runtime/agent-runtime/README.md#datasets-de-evaluación) |
| Experiments formales + Release Gate | ✅ tanda 10 (EXP-003 automático; candado en la activación) · revalidación de `PASS_FORM` con etiquetas posteriores, sin re-ejecutar LLMs ✅ tanda 12 · el gate bloquea activar/canarizar/promover si la última revalidación es `REFUTED` ✅ tanda 13 | [Experiments y Release Gate](../runtime/agent-runtime/README.md#experiments-y-release-gate), [skill-optimizer.md](skill-optimizer.md#revalidación-de-un-pass_form) |
| Canary y rollback (§11.7) | ✅ tanda 11: canario post-gate con reparto determinista, una por skill, promote/rollback humano | [skill-optimizer.md](skill-optimizer.md#canario-despliegue-gradual-tras-el-gate) |
| Failure clustering (§17.4) | ✅ tanda 11: agrupación de fallos con LLM en el optimizador (antes, manual en EXP-001) | [skill-optimizer.md](skill-optimizer.md) |

### Plataforma evolutiva (§6.3-6.4, §7, §13, §14, §16, §18) — MVP-3 cerrado, MVP-4 en curso

| Pieza | Estado | Plan |
|---|---|---|
| Skills/SkillVersions versionadas e inmutables | ✅ tanda 7 | — |
| Ciclo de mejora de skills (manual, humano como gate) | ✅ tanda 8-10 (EXP-001, EXP-002 y EXP-003) | [ciclo-mejora-skills.md](ciclo-mejora-skills.md): sigue siendo el fallback |
| Harness versionado (§7) | ✅ v1 tanda 9 · con Release Gate para activarlo ✅ tanda 11 (exige gate `PASS`/`PASS_FORM` o `force` con motivo) | [Harness](../runtime/agent-runtime/README.md#harness) |
| Memoria semántica / KnowledgeEntry (§6.4, §16) | ✅ tanda 9 (3 entradas ACTIVE con evidencia) | [Knowledge](../runtime/agent-runtime/README.md#knowledge-memoria-semántica) |
| Router/orquestación multi-agente (§14) | ⬜ decisión registrada: hoy un solo Prospector (+EmailDrafter); el grafo Researcher/Scorer se descartó de facto — revalidar si hace falta al crecer | ADR del LLD v0.3 |
| Environments sintéticos + curriculum (§13) | 🔄 MVP-4 (primera entrega en la tanda 13 ✅): generador determinista por plantillas, ground truth por construcción, `pnpm synth:build`. La accuracy del gate sigue midiéndose solo con etiquetas humanas | [environments-sinteticos.md](environments-sinteticos.md) |
| Optimizadores automáticos (§18) | ✅ Skill Optimizer en la tanda 11 (el humano promueve) · optimización programada 🔄 tanda 14 (`OPTIMIZER_SCHEDULE_ENABLED=false` por defecto, cron `0 9 * * 3` Europe/Madrid, solo encola) · Harness Optimizer y Router Optimizer ⬜ | [skill-optimizer.md](skill-optimizer.md) |
| Model routing por tarea (§18, barato/razonador/evaluador independiente) | ✅ tanda 13: roles (`executor_cheap`, `executor_reasoner`, `judge`, `triage`), overrides `MODEL_ROUTE_<ROL>` y `pnpm models:costs`; multi-proveedor ✅ y juez distinto del ejecutor ✅ | [model-routing.md](model-routing.md); decidir antes del 2027-01-01 (sube el precio de 3.8-flash) |

## Ruta propuesta (tandas siguientes)

1. **Tanda 9 — cerrar MVP-1** ✅: harness v1, KnowledgeEntry y Research escrito por el Prospector, y dashboard dentro de Twenty.
2. **Tanda 10 — MVP-2, evaluación formal** ✅: datasets desde trazas anotadas, evaluadores RULE/LLM_JUDGE/COMPOSITE, Experiments y Release Gate con candado en la activación; EXP-003 fue el primer experimento automático.
3. **Tanda 11 — MVP-3** ✅: [Skill Optimizer](skill-optimizer.md) automático sobre el gate (cosecha de fallos → clusters → candidata → experimento → propuesta de promoción en Twenty), Release Gate también para versiones de harness, canario post-gate, métricas por versión de skill (solo evaluaciones `HUMAN`) y reconciliador de huérfanos corregido. El humano sigue aprobando toda promoción.
4. **Tanda 12 — operación y cierre de deudas tras el MVP-3** ✅:
   - **Revalidación de `PASS_FORM`**: mide la accuracy de un experimento que no tenía etiquetas cuando el comercial ya las ha dado, sobre los outputs guardados y sin re-ejecutar LLMs. Veredicto `CONFIRMED`/`REFUTED`/`INSUFFICIENT` en un registro append-only; si es `REFUTED` avisa en Twenty y decide una persona ([detalle](skill-optimizer.md#revalidación-de-un-pass_form)).
   - **Triaje general del inbound**: el buzón deja de ser solo-bajas. Reglas deterministas para automáticos y rebotes, LLM para interesado/pregunta/no interesado/otro, notas 📬 en Twenty y evento `email.reply_received`. El sistema nunca responde ([detalle](inbound-triaje.md)).
   - **`audit_log` y retención de trazas** (§22): registro append-only de las acciones mutantes de la API (`GET /audit`) y archivado manual sin pérdida de los payloads pesados ([runbook](runbook-local.md#archivado-de-trazas)).
   - **Stall-guard de BullMQ**: una re-entrega con latido fresco ya no mata un intento sano (deuda de la tanda 11).
5. **Tanda 13 — gate más estricto, model routing y primeros environments sintéticos** ✅:
   - **Gate y revalidaciones**: una revalidación `REFUTED` (la más reciente del experimento) bloquea activar, canarizar o promover con `409 release_gate_blocked` y `reason: revalidation_refuted`; `CONFIRMED` marca `revalidated: true`; `INSUFFICIENT` no cambia nada; el `force` humano sigue y queda auditado ([detalle](skill-optimizer.md#qué-hace-el-gate-con-una-revalidación)). Además, **archivado programado de trazas**: job interno apagado por defecto (`TRACE_ARCHIVE_ENABLED`), cada 24 h, auditado como `traces.archive` ([runbook](runbook-local.md#archivado-programado)).
   - **Model routing (§18)**: roles en lugar de modelos en el código, overrides `MODEL_ROUTE_<ROL>=proveedor:modelo`, juez siempre distinto del ejecutor y `pnpm models:costs` para decidir antes de la subida del 2027-01-01 ([detalle](model-routing.md)).
   - **MVP-4 — environments sintéticos** ✅ (primera entrega): generador determinista por plantillas, ground truth por construcción, dominios `*.invalid`, dificultad 1-3 y `pnpm synth:build`. Alimentan reglas, seesaw y forma; **no** la accuracy del gate, que sigue pidiendo etiquetas humanas, así que no resuelven por sí solos el `BLOCKED_NO_DATA` ([detalle](environments-sinteticos.md)).
6. **Tanda 14 — catálogo lado runtime y optimización programada** 🔄:
   - **Catalog Service, lado Commercial OS** 🔄: cliente REST y **stub fiel al contrato v1.1** detrás de `CATALOG_ENABLED=false` y `CATALOG_PROVIDER=stub|http`, gate de salud con modo degradado (si `/health` falla, prospección sin catálogo y nota ⚠️ en Twenty más evento `catalog.unavailable`, nunca correo), tools `catalog_*` de lectura, hipótesis con `recommended_products` (`productId`, `sku`, `name`, `priceHint`) y una skill DRAFT del Prospector que recomienda de 1 a 3 productos reales; sin activar, el gate manda ([detalle](catalog-service.md)).
   - **Contrato del conector v1.1 cerrado** (2026-10-09), acordado con el backend de publiexpe: seis operaciones, REST y MCP, VPN, lápidas para descatalogados, 90 días de transición entre versiones. El backend lo implementa en unos 16 días. La **conmutación stub → http** se hace al entregar ([lista de comprobación](catalog-service.md#el-día-de-la-conmutación-stub-a-http)).
   - **Optimización programada** 🔄: job con `OPTIMIZER_SCHEDULE_ENABLED=false` por defecto, cron `0 9 * * 3` (miércoles 09:00, `Europe/Madrid`), solo encola; nada se promueve solo; auditado como `optimizer.scheduled_run`; `GET /optimizer/schedule` ([detalle](skill-optimizer.md#programado)).
7. **Tanda 15 y siguientes** (por orden de prioridad aproximado):
   - **Conmutación del catálogo a `http`** cuando el backend entregue el conector, y activación de la skill con catálogo por el Release Gate.
   - **Conector de presupuestos** (posterior al de catálogo, con token propio de escritura) y despublicar en los importadores del backend (tarea interna suya).
   - Harness Optimizer y Router Optimizer, cuando haya datos y confianza en el gate.
   - Export JSON Schema (§21) y triggers DEPENDENCY/CONDITION.
   - Búsqueda semántica y emparejamiento (`match_products`, `build_bundle`) sobre el catálogo conectado.

## Hitos de calendario (no perder)

| Fecha | Hito |
|---|---|
| Cada lunes 07:30 | Scout semanal de ferias (próximo: 2026-10-12, el primero automático). Sus hipótesis, una vez revisadas, son los veredictos frescos que desbloquean al optimizador |
| Diario 08:00 | Prospección + rutina de 10 min del comercial ([guía](guia-comercial.md)) |
| ~2026-10-29 (**estimación**) | Entrega del conector del catálogo por el backend de publiexpe (~16 días de trabajo de un desarrollador; la fecha supone que empiezan ya, tras el cierre del contrato el 2026-10-09). Después, conmutación stub → http con la [lista de comprobación](catalog-service.md#el-día-de-la-conmutación-stub-a-http) |
| 2026-11-03 | DMARC `p=none` → `p=quarantine` si los informes van limpios ([plan](email-warmup.md)) |
| 2027-01-01 | gemini-3.8-flash duplica precio: ejecutar [`pnpm models:costs`](model-routing.md#costes-pnpm-modelscosts) antes de esa fecha, decidir si se aplica algún override del [model routing](model-routing.md) (tanda 13) y revisar los costes orientativos de [skill-optimizer.md](skill-optimizer.md#costes-orientativos) |
