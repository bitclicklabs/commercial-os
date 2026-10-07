# Roadmap — LLD 0.1 frente a lo construido

Actualizado: 2026-10-07 (durante la tanda 8). Contrasta la visión completa del [LLD v0.1](LLD-0.1-publiexpe-commercial-os.md) con el estado real. El detalle fino por decisión está en el [LLD v0.3 (estado real)](LLD-0.3-estado-real.md) y la bitácora por tandas en [ESTADO.md](ESTADO.md).

**Leyenda:** ✅ hecho · 🟡 parcial · 🔄 en curso (tanda 8) · ⬜ pendiente · ⛔ bloqueado por decisión externa

## Respuesta corta: ¿estamos llegando?

- **La capa de valor comercial (MVP-0 del LLD §26) está al 100% y en producción local**: prospección autónoma de ferias reales, hipótesis en el CRM, feedback humano capturado, borradores y envío HITL con un clic. Coste total de LLM del proyecto: < 1 €.
- **La plataforma evolutiva — lo que convierte esto en "no un CRM con ChatGPT pegado" — está empezada, no terminada**: skills versionadas ✅ (tanda 7) y la primera vuelta manual del ciclo de mejora 🔄 (tanda 8), pero faltan harness versionado, memoria semántica, evaluación formal con datasets/gates y los optimizadores (MVP-1 ≈ 40%, MVP-2/3/4 ≈ 0%).
- **Un solo bloqueo externo**: el Catalog Service espera el contrato del conector con el backend de publiexpe. Es la pieza que hará que las hipótesis recomienden productos reales.

## Mapa por áreas del LLD 0.1

### Fundamentos (P1-P6) — ✅ con una pata coja

| Principio | Estado | Dónde |
|---|---|---|
| P1 Twenty system of record | ✅ | [apps/twenty-app](../apps/twenty-app/README.md) |
| P2 Agent OS separado | ✅ | [runtime/agent-runtime](../runtime/agent-runtime/README.md) |
| P3 Todo lo evolutivo con versión | 🟡 agentes/tasks/skills ✅; harness/router/evaluator/environment ⬜ | [Skills](../runtime/agent-runtime/README.md) |
| P4 Ejecución inmutable | ✅ (config del run + skill_version exacta en el trace) | traces/trace_steps |
| P5 Nunca evaluar sobre lo que generó el cambio | 🔄 aplicado a mano en EXP-001 | `docs/experimentos/` (tanda 8) |
| P6 Plataforma fuera de Twenty | ✅ | ADR-01 del [LLD v0.3](LLD-0.3-estado-real.md) |

### Sistema comercial (§5, §10, §15, §23) — ✅ el motor funciona

| Pieza | Estado | Dónde |
|---|---|---|
| CommercialSignal / CommercialHypothesis | ✅ | [App](../apps/twenty-app/README.md) |
| Research | 🟡 objeto existe; ningún agente lo escribe aún | — |
| Canal de email (dominio, DNS, warm-up) | ✅ (warm-up día 2 de 28) | [email-warmup.md](email-warmup.md) |
| Borradores HITL + envío con un clic desde Twenty | ✅ (estrenado 2026-10-07) | [twenty-envio-email.md](twenty-envio-email.md) |
| Inbound: bajas automáticas | ✅ · triaje general de respuestas ⬜ | README runtime, sección Inbound |
| Supresión automática en el flujo de envío | 🔄 tanda 8 | rama `feat/email-ops-flujo` |
| Tools con riesgo/allowlist/human gates | ✅ · faltan `create_activity` y las del catálogo | README runtime, sección Tools |
| UI comercial en Twenty + guía | ✅ | [guia-comercial.md](guia-comercial.md) |
| Catalog Service (§9) | ⛔ a la espera del contrato del conector (acción: usuario/equipo backend publiexpe) | LLD 0.1 §9 |

### Runtime y robustez (§8, §12, §21, §22) — ✅ sólido

| Pieza | Estado | Dónde |
|---|---|---|
| Runtime (API, colas, worker, recovery, gate de salud) | ✅ | README runtime |
| Scheduler CRON/INTERVAL/ONCE/EVENT | ✅ · DEPENDENCY/CONDITION ⬜ | README runtime |
| Idempotencia, locks, concurrencia | ✅ | — |
| Event bus + eventos externos (n8n) | ✅ | [n8n-integracion.md](n8n-integracion.md) |
| Seguridad: untrusted web, SSRF, sandbox Chromium, rol restringido de la API key | ✅ | ADRs del LLD v0.3 |
| Retención de trazas (purga §22) y `audit_log` como objeto | ⬜ | LLD 0.1 §22 |
| Export de contratos a JSON Schema versionado (§21) | ⬜ | — |
| Multi-tenant | 🟡 columna `tenant_id` en todo (lo previsto para v0.x) | — |

### Observabilidad y evaluación (§11, §17) — la mitad medidora ✅, la mitad formal ⬜

| Pieza | Estado | Dónde |
|---|---|---|
| Traces estructurados + cost tracking | ✅ | README runtime |
| Dashboard y métricas (aceptación por versión de agente) | ✅ (+ bloque de warm-up 🔄 tanda 8) | `GET /dashboard` |
| Evaluador HUMAN | ✅ | README runtime, sección Evaluador |
| Evaluadores EXACT/RULE/LLM_JUDGE/COMPOSITE | ⬜ MVP-2 | LLD 0.1 §11 |
| Datasets train/validation/test desde trazas | ⬜ MVP-2 | LLD 0.1 §11.4 |
| Experiments formales + Release Gate + canary | ⬜ MVP-2 (EXP-001 manual 🔄 como ensayo) | LLD 0.1 §11.5-11.7 |
| Failure clustering (§17.4) | 🟡 manual en EXP-001 | — |

### Plataforma evolutiva (§6.3-6.4, §7, §13, §14, §16, §18) — el tramo que falta

| Pieza | Estado | Plan |
|---|---|---|
| Skills/SkillVersions versionadas e inmutables | ✅ tanda 7 | — |
| Ciclo de mejora de skills (manual, humano como gate) | 🔄 tanda 8 (EXP-001) | [ciclo-mejora-skills.md] al cerrar la tanda |
| Harness versionado (§7) | ⬜ | Tanda 9 propuesta: consolidar las políticas existentes (tool/retry/timeout/espera) en `harness_versions` v1 |
| Memoria semántica / KnowledgeEntry (§6.4, §16) | ⬜ | Tanda 9 propuesta |
| Router/orquestación multi-agente (§14) | ⬜ decisión registrada: hoy un solo Prospector (+EmailDrafter); el grafo Researcher/Scorer se descartó de facto — revalidar si hace falta al crecer | ADR del LLD v0.3 |
| Environments sintéticos + curriculum (§13) | ⬜ MVP-4 | — |
| Optimizadores automáticos (§18) | ⬜ MVP-3 (requiere el gate del MVP-2) | — |
| Model routing por tarea (§18, barato/razonador/evaluador independiente) | 🟡 multi-proveedor ✅; routing ⬜ (todo gemini-flash) | Revisar antes del 2027-01-01 (sube el precio de 3.8-flash) |

## Ruta propuesta (tandas siguientes)

1. **Tanda 9 — cerrar MVP-1**: Harness v1 (objeto versionado con las políticas actuales), KnowledgeEntry básica (memoria semántica alimentada por el ciclo de mejora), y que el Prospector escriba `Research`. 
2. **Tanda 10 — MVP-2, evaluación formal**: datasets desde trazas anotadas (ya hay evaluaciones humanas acumulándose), objeto Experiment, Release Gate automático con los umbrales del LLD §11.6 y rollback conjunto. El EXP-001 de la tanda 8 es la plantilla.
3. **Tanda 11 — MVP-3**: Skill Optimizer automático sobre el gate (estilo SkillOpt), con el humano aún aprobando promociones.
4. **En paralelo, cuando toque**: Catalog Service (al llegar el contrato ⛔), triaje general de inbound, retención/audit_log, export JSON Schema, triggers DEPENDENCY/CONDITION, UI de plataforma más allá del dashboard.

## Hitos de calendario (no perder)

| Fecha | Hito |
|---|---|
| Cada lunes 07:30 | Scout semanal de ferias (próximo: 2026-10-12, el primero automático) |
| Diario 08:00 | Prospección + rutina de 10 min del comercial ([guía](guia-comercial.md)) |
| 2026-11-03 | DMARC `p=none` → `p=quarantine` si los informes van limpios ([plan](email-warmup.md)) |
| 2027-01-01 | gemini-3.8-flash duplica precio: revisar modelo/routing |
