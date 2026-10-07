# LLD v0.1 — PubliEXPE Commercial OS

| Campo | Valor |
|---|---|
| Estado | Draft técnico v0.1 |
| Fecha | 2026-10-06 |
| Objetivo | Sistema comercial multiagente, evaluable, observable y evolutivo sobre Twenty |
| CRM | Twenty self-hosted (system of record) |
| Orquestación | n8n + runtime propio (Agent OS) |
| IA | Proveedores intercambiables |
| Extensibilidad | Twenty Apps + servicios externos |

**Principio rector:** el CRM es el *system of record*; el Agent OS es el *system of intelligence*.

---

## Cambios respecto al borrador original

Este documento parte del borrador de ChatGPT con estos cambios. Cada uno está marcado en su sección con `[C-n]`:

- **C1 — Twenty guarda solo los objetos comerciales.** El borrador metía ~25 objetos custom en Twenty, incluidos los de infraestructura (Skill, Harness, Experiment, Trace...). Eso satura el workspace, acopla la plataforma a los upgrades de Twenty y no aporta nada al comercial. Los metadatos de plataforma viven en el PostgreSQL del Agent OS; Twenty guarda referencias y resúmenes.
- **C2 — Catalog Service.** La visión exige acceso de lectura al catálogo (+15.000 productos), emparejamiento y combinaciones de productos, pero el borrador no tenía ningún componente de catálogo. Se añade como servicio y como tools.
- **C3 — Gestión de inbound.** La visión incluye gestionar las respuestas del cliente y la relación comercial con HITL, pero el borrador solo cubría outbound. Se añade el componente de conversaciones.
- **C4 — Referencias verificadas.** Los cuatro papers citados existen; se corrigen los enlaces (consulta *Referencias*).
- **C5 — MVP-0 orientado a valor comercial.** Faltan ventas: el MVP-0 debe producir leads cualificados en semanas, con evaluación humana como primer evaluador. La maquinaria de evaluación formal y evolución pasa a MVP-1/MVP-2.
- **C6 — Multi-tenancy mínima.** Solo la columna `tenant_id` en los esquemas. Nada de infraestructura multi-tenant en v0.x.

Las decisiones que requieren tu input están en *Decisiones pendientes*.

---

## 1. Visión

El sistema responde continuamente a cinco preguntas:

| Pregunta | Respuesta PubliEXPE |
|---|---|
| ¿A quién vender? | Empresas B2B y multinacionales. |
| ¿Por qué ahora? | Faltan ventas: el sistema debe generar pipeline nuevo de forma continua. |
| ¿Qué ofrecer? | Más de 15.000 productos, pero el diferencial es: ofertas de producto, trato humano y cercano, taller propio y precios infalibles. El sistema hace fondo en estos diferenciales, no en el volumen de catálogo. |
| ¿Qué hace el comercial? | Multiplicar las ventas. El agente le quita la prospección, la investigación y el primer borrador; el comercial decide y cierra. |
| ¿Cómo sabemos que el agente mejora? | Mejora medible en prospección: mejores emails, lenguaje más natural, datos de empresa correctos, emparejamiento producto-necesidad, combinaciones de producto, gestión del inbound y de la relación comercial con HITL. Todo con métricas, no con impresiones. |

La última pregunta es la que diferencia este sistema de "un CRM con ChatGPT pegado encima". Cada agente es: versionable, ejecutable, programable, evaluable, observable, modificable, pausable, desactivable, eliminable, reproducible y auditable.

**Importante:** Ninguna evolución automática puede saltarse el sistema de evaluación. La promoción a producción pasa siempre por un Release Gate.

## 2. Principios arquitectónicos

### P1 — Twenty como system of record

Empresas, contactos, leads, oportunidades, actividades y pipeline viven en Twenty. Twenty genera API REST/GraphQL a partir del esquema del workspace y permite extender el CRM mediante [Apps](https://github.com/twentyhq/twenty/blob/main/packages/twenty-docs/developers/extend/api.mdx).

### P2 — El Agent OS no sustituye a Twenty

```
                 ┌─────────────────────────┐
                 │         TWENTY          │
                 │     SYSTEM OF RECORD    │
                 └────────────┬────────────┘
                              │
                      API / Webhooks
                              │
                              ▼
                 ┌─────────────────────────┐
                 │      AGENT PLATFORM     │
                 │  Skills · Harness       │
                 │  Memory · Evaluations   │
                 │  Tasks · Environments   │
                 │  Orchestration          │
                 └────────────┬────────────┘
                              │
                              ▼
                         ┌────────┐
                         │  n8n   │
                         └────────┘
```

### P3 — Todo lo evolutivo tiene versión

Nunca `skill = "texto actual"`. Siempre:

```
Skill
 ├── v1
 ├── v2
 ├── v3
 └── v4  ACTIVE
```

Aplica a: Agent, Skill, Harness, Workflow, Evaluator, Environment, Router, Prompt, Toolset y TaskDefinition.

### P4 — Ejecución inmutable

Una ejecución sabe exactamente con qué configuración ocurrió:

```
Execution
 ├── agent_version
 ├── skill_versions[]
 ├── harness_version
 ├── model + model_parameters
 ├── toolset_version
 ├── memory_snapshot
 ├── environment_version
 ├── router_version
 └── evaluator_version
```

Esto permite reproducir exactamente la ejecución del martes a las 08:00.

### P5 — Nunca evolucionar sobre el mismo dataset

Cada optimización usa splits `TRAIN / VALIDATION / TEST`. El test jamás se usa para optimizar:

```
EXPERIENCE → TRAIN SPLIT → optimizer → candidate
                                           │
                                      VALIDATION
                                       /      \
                                    FAIL      PASS
                                     │          │
                                  reject      ship → TEST
```

Disciplina tomada de [SkillOpt](https://microsoft.github.io/SkillOpt/): rollout → reflexión → edición acotada → evaluación → gate sobre datos no usados para generar la modificación.

### P6 — Twenty no aloja la plataforma `[C1]`

En Twenty vive lo que el comercial ve y toca. En el Agent OS vive todo lo demás. Consulta *Reparto de responsabilidades*.

## 3. Arquitectura

```
                         ┌──────────────────────┐
                         │        TWENTY        │
                         │ CRM · Custom Objects │
                         │ Activities·Pipelines │
                         │ Agent UI             │
                         └──────────┬───────────┘
                                    │ API / Webhooks
                                    ▼
┌──────────────────────────────────────────────────────────────┐
│                     PUBLIEXPE AGENT OS                       │
│                                                              │
│  ┌────────────┐     ┌──────────────┐     ┌───────────────┐  │
│  │ Task       │────▶│ Agent        │────▶│ Orchestrator  │  │
│  │ Scheduler  │     │ Runtime      │     │ / Router      │  │
│  └────────────┘     └──────┬───────┘     └───────────────┘  │
│                            │                                 │
│            ┌───────────────┼────────────────┐                │
│            ▼               ▼                ▼                │
│         Skills          Harness           Memory             │
│            └───────────────┼────────────────┘                │
│                            ▼                                 │
│                        Tools Layer                           │
│          ┌─────────┬───────┼────────┬───────────┐            │
│          ▼         ▼       ▼        ▼           ▼            │
│         Web     Twenty  Catalog  Inbound       n8n           │
│                         Service  /Email                      │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │               OBSERVABILITY / TRACES                   │  │
│  └──────────────────────┬─────────────────────────────────┘  │
│                         ▼                                    │
│                  Evaluation Engine                           │
│             ┌───────────┴────────────┐                       │
│             ▼                        ▼                       │
│       Skill Optimizer          Harness Optimizer             │
│             └───────────┬────────────┘                       │
│                         ▼                                    │
│                   Candidate Store                            │
│                         ▼                                    │
│                     Release Gate                             │
└──────────────────────────────────────────────────────────────┘
```

## 4. Reparto de responsabilidades `[C1]`

### Vive en Twenty

Objetos que el equipo comercial ve y usa:

```
Company, Person, Opportunity, Task, Note, Activity   (estándar)
CommercialSignal                                      (custom)
Research                                              (custom)
CommercialHypothesis                                  (custom)
AgentRunSummary                                       (custom, solo lectura)
```

`AgentRunSummary` es la vista comercial de una ejecución: qué hizo el agente, sobre qué empresa, con qué resultado y un enlace al trace completo en el Agent OS.

### Vive en el Agent OS (PostgreSQL propio)

Objetos de infraestructura, invisibles para el comercial:

```
Agent, AgentVersion
Skill, SkillVersion
Harness, HarnessVersion
Router, RouterVersion
TaskDefinition, TaskDefinitionVersion, TaskRun
Evaluator, EvaluationDataset, EvaluationCase, EvaluationRun
Experiment, Candidate, Release
Environment, EnvironmentVersion
AgentExecution, Trace, TraceStep
KnowledgeEntry
Tool, Mutation, AuditLog
```

### No vive en ninguna base relacional

```
raw traces completos          → object storage
documentos web descargados    → object storage
datasets de evaluación        → object storage (versionados)
embeddings                    → pgvector
```

Razón del reparto: un crash de Twenty no pierde ejecuciones, y un upgrade de Twenty no obliga a reescribir el Agent OS.

## 5. Modelo de datos comercial

### 5.1 CommercialSignal

```
id, tenant_id
company_id
type            FAIR | CONGRESS | EVENT | NEW_PRODUCT | HIRING | EXPANSION |
                REBRANDING | SPONSORSHIP | CAMPAIGN | ANNIVERSARY | OTHER
title, description
source_url, source_domain
detected_at, event_date
confidence
status
created_by
```

### 5.2 Research

Una investigación no se sobrescribe. Nueva investigación = nuevo registro.

```
id, tenant_id
company_id, signal_id
agent_execution_id
research_type
query
summary
structured_result
sources[]
confidence
created_at
```

### 5.3 CommercialHypothesis

```
id, tenant_id
company_id, signal_id
need, why_now
quantity_min, quantity_max
budget_min, budget_max
recommended_products[]      ← refs al Catalog Service [C2]
decision_maker_id
timing
confidence
evidence[]
status                      PROPOSED | VALIDATED | REJECTED | EXPIRED
```

## 6. Modelo de datos de plataforma

### 6.1 Agent

Entidad lógica, no una ejecución.

```
id, name, description, role
status              DRAFT | ACTIVE | PAUSED | DEPRECATED | ARCHIVED
active_version_id
default_schedule_id
risk_level
owner
created_at, updated_at
```

### 6.2 AgentVersion

```
id, agent_id
version
status              DRAFT | CANDIDATE | EVALUATING | APPROVED |
                    ACTIVE | REJECTED | DEPRECATED
model, model_provider
system_prompt, configuration
skill_refs[]
harness_version_id
router_version_id
tool_policy_id
memory_policy_id
evaluation_policy_id
created_at, created_by
```

### 6.3 Skill y SkillVersion

Una skill no es un prompt. Es un objeto versionado con estructura:

```
Skill:         id, name, description, domain, status, active_version_id
SkillVersion:  id, skill_id, version
               instructions, constraints, workflow, examples, anti_patterns
               optimization_budget
               created_at
```

Ciclo de evolución:

```
CURRENT SKILL → ROLL OUT → COLLECT TRACES → SELECT FAILURES
             → OPTIMIZER → CANDIDATE → VALIDATION → PROMOTE | REJECT
```

El optimizador solo ejecuta operaciones acotadas: `ADD`, `REMOVE`, `REPLACE`, `MOVE`, `REORDER`. Nunca reescribe la skill entera salvo política explícita. Este es el "learning rate textual" de [SkillOpt](https://arxiv.org/abs/2605.23904).

### 6.4 Knowledge layer (wiki persistente)

Separación estricta, tomada de [WikiSkill](https://arxiv.org/abs/2608.27454):

```
RAW EXPERIENCE  →  KNOWLEDGE  →  SKILL
```

Nunca `trace → directamente prompt`.

```
KnowledgeEntry
  id, domain, topic
  statement
  evidence[], confidence
  source_executions[]
  valid_from, valid_until
  status    PROPOSED | VALIDATED | ACTIVE | SUPERSEDED | REJECTED
```

Ejemplo de conocimiento que el sistema puede acumular: "Para empresas industriales de 50-200 empleados que participan en ferias sectoriales, el contacto funciona mejor con marketing que con compras". Solo se activa con evidencia suficiente.

## 7. Harness

La ecuación del sistema:

```
Agent = Model + Harness + Skills + Memory + Tools
```

No `Agent = Prompt + Model`.

### 7.1 HarnessVersion

```
Harness:        id, name, description, active_version_id
HarnessVersion: id, harness_id, version
                context_policy, memory_policy, tool_policy,
                planning_policy, execution_policy, retry_policy,
                reflection_policy, verification_policy,
                compression_policy, safety_policy
                processor_graph
                created_at
```

Inspirado en [HarnessX](https://arxiv.org/abs/2606.14249): el harness es un objeto compuesto y versionado cuyos componentes se intercambian sin tocar el modelo.

### 7.2 Dimensiones

```
D1 MODEL        D4 TOOLS        D7 SAFETY
D2 CONTEXT      D5 EXECUTION    D8 OBSERVABILITY
D3 MEMORY       D6 EVALUATION   D9 TRAINING
```

Ejemplo de configuración:

```yaml
harness:
  context:
    max_tokens: 24000
    summarization: hierarchical
  memory:
    short_term: true
    episodic: true
    semantic: true
  tools:
    parallel_calls: true
    max_concurrency: 4
  execution:
    max_turns: 12
    retry: exponential
    timeout_seconds: 180
  evaluation:
    verify_before_commit: true
  safety:
    destructive_tools_require_confirmation: true
```

### 7.3 Processor graph

En lugar de hardcodear `agent → LLM → tool`:

```
INPUT → CONTEXT → MEMORY → SKILL → PLANNER → MODEL
      → TOOL POLICY → EXECUTOR → VERIFIER → REFLECTOR → OUTPUT
```

Cada bloque tiene versión. Permite comparar `Harness A (planner_v1, verifier_v1)` contra `Harness B (planner_v2, verifier_v2)` sin tocar el agente.

### 7.4 Self-rewriting harness

El sistema puede proponer modificaciones al harness, pero nunca en caliente:

```
PROHIBIDO:  running agent → modify own harness → continue

PERMITIDO:  production harness → trace analysis → harness optimizer
            → candidate → sandbox → evaluation → gate → ACTIVE
```

Mutaciones permitidas: `ADD_PROCESSOR`, `REMOVE_PROCESSOR`, `REPLACE_PROCESSOR`, `CHANGE_PROMPT`, `CHANGE_TOOL_POLICY`, `CHANGE_RETRY_POLICY`, `CHANGE_MEMORY_POLICY`, `CHANGE_CONTEXT_POLICY`, `CHANGE_VERIFICATION_POLICY`, `CHANGE_ROUTING_POLICY`.

Cada mutación registra:

```
Mutation: id, target, before, after, reason, expected_effect, risk, experiment_id
```

## 8. Runtime

Servicio independiente (`agent-runtime/`), fuera de Twenty y fuera de n8n.

Responsabilidades: cargar agent version, harness, skills, memory y tools; ejecutar; trazar; recuperar; verificar; persistir.

```
Task → Runtime → Agent → Harness → Model → Tools → Environment → Verifier → Result
```

### API del runtime

```
POST /executions              GET  /executions/:id
POST /executions/:id/cancel   POST /executions/:id/pause
POST /executions/:id/resume

POST   /tasks        GET  /tasks         PATCH /tasks/:id
POST   /tasks/:id/run  POST /tasks/:id/pause  POST /tasks/:id/archive

POST /agents         PATCH /agents/:id
POST /agents/:id/evaluate   POST /agents/:id/pause
POST /agents/:id/promote    POST /agents/:id/rollback
```

## 9. Catalog Service `[C2]`

Componente nuevo. Da a los agentes acceso de **solo lectura** al catálogo de PubliEXPE (+15.000 productos) y soporta el emparejamiento producto-necesidad de las hipótesis comerciales.

**Decidido (2026-10-06):** la fuente es la base de datos de publiexpe, expuesta mediante un conector en su backend (API privada o servidor MCP). Este proyecto define el contrato (endpoints, campos, filtros); el equipo que lleva el backend de publiexpe lo implementa.

```
CatalogService
  ├── sync          ingesta periódica vía el conector del backend de publiexpe
  ├── search        búsqueda léxica (nombre, categoría, atributos)
  ├── semantic      búsqueda semántica (pgvector sobre descripciones)
  └── pricing       precios y ofertas vigentes (solo lectura)
```

Tools expuestas al runtime:

```
search_products        READ    búsqueda por texto/categoría/atributos
get_product            READ    ficha completa + precio vigente
match_products         READ    productos candidatos para una necesidad
build_bundle           READ    combinaciones de productos coherentes
get_active_offers      READ    ofertas activas (diferencial de PubliEXPE)
```

### Presupuestos

**Decidido (2026-10-06):** los presupuestos se crean en el CMS de publiexpe a través del mismo conector (API/MCP). La tool `create_quote_request` dispara la creación en el CMS y guarda en Twenty la referencia y el estado sobre la `Opportunity`. Twenty nunca es la fuente de verdad del presupuesto; solo del pipeline.

## 10. Email: canal de envío e inbound `[C3]`

### 10.1 Canal de envío (outbound)

Proveedor: IONOS. Sus límites de envío por buzón ([50-500 correos/hora según antigüedad](https://www.ionos.com/help/email/general-topics/what-are-the-mass-mailing-limits/)) cubren de sobra el volumen previsto (~10-20 emails aprobados/día en MVP-0).

**Decidido (2026-10-06):** dominio aparte para el frío: **`publiexpe.info`**.

- **Nunca prospección en frío desde `@publiexpe.com`.** La reputación del dominio principal sostiene el correo corporativo y transaccional; un bloqueo o listado en una blacklist afectaría a toda la empresa.
- **`publiexpe.info`** es el dominio de envío en frío. Gmail y Microsoft agregan reputación a nivel de dominio organizativo, así que un subdominio (`contacto.publiexpe.com`) aísla menos que un dominio aparte. `publiexpe.info` sirve una web mínima propia con aviso legal y privacidad, publicada el 2026-10-06, con enlaces a `publiexpe.com` (los filtros comprueban que el dominio remitente tiene web real).
- **Subdominio** (`mail.publiexpe.com`) reservado para contactos ya conocidos y seguimiento de clientes, donde el riesgo reputacional es bajo.
- **Buzones (decidido):** `jesus.abril@publiexpe.info` y `j.abril@publiexpe.info` (segunda identidad del mismo remitente real, para repartir el volumen de warm-up y envío). Remitente siempre una persona real; sin píxel de apertura en frío: penaliza entregabilidad y la métrica útil es la respuesta, no la apertura. Redirecciones gratuitas: `dmarc@` y `baja@` → `jesus.abril@`.
- **DKIM (decidido, 2026-10-06):** activado a nivel de dominio en IONOS, sin coste; firma todos los buzones, incluidos los basic. Los buzones de envío son basic (sin copago). Verificación obligatoria antes del warm-up: enviar un correo de prueba a una cuenta de Gmail y comprobar en "Mostrar original" que SPF, DKIM (`d=publiexpe.info`) y DMARC dan `PASS`.
- **Registros DNS** en `publiexpe.info`:

```
TXT  @        SPF creado con el asistente "IONOS SPF" del panel (mantiene el include al día)
TXT  _dmarc   v=DMARC1; p=none; rua=mailto:dmarc@publiexpe.info
DKIM           se activa desde el panel de IONOS (crea él los registros)
MX             los de IONOS (automáticos al activar el correo)
```

  DMARC pasa de `p=none` a `p=quarantine` tras 3-4 semanas sin fallos de alineamiento.
- **Warm-up manual** (IONOS no trae herramienta de warm-up): semanas 1-2, 10-20 correos/día a contactos que responden (internos, clientes cercanos); semanas 3-4, subir a 30-40/día por buzón. Monitorizar con Google Postmaster Tools y Microsoft SNDS.
- **Cumplimiento (España):** la LSSI (art. 21) exige consentimiento previo para comunicaciones comerciales electrónicas salvo relación contractual previa. Para prospección B2B en frío: dirigirse a direcciones corporativas de rol bajo interés legítimo (RGPD), identificación clara del remitente, enlace de baja en cada correo y lista de supresión global que el Inbound Manager alimenta automáticamente.

### 10.2 Inbound y conversaciones

Cubre "gestiona el inbound y la relación comercial con el cliente (HITL)".

```
InboundManager
  ├── ingest        correo entrante (IMAP, buzones IONOS) → Conversation ligada a Company/Person
  ├── classify      respuesta positiva | objeción | no interesado |
  │                 fuera de oficina | unsubscribe | otro
  ├── draft         borrador de respuesta (nunca envío autónomo)
  └── route         asigna al comercial con contexto completo
```

Reglas:

- `unsubscribe` se procesa de forma automática e inmediata (cumplimiento, no requiere aprobación).
- Todo envío de respuesta pasa por aprobación humana en v0.x.
- Cada conversación queda ligada en Twenty como `Activity` sobre la empresa/persona.

## 11. Evaluation Engine

No es un botón "Evaluar agente" que pregunta a otro LLM si la respuesta parece buena. Es un framework.

### 11.1 Evaluator

```
Evaluator: id, name, type, version, config
Tipos:     EXACT | RULE | LLM_JUDGE | REFERENCE | BUSINESS | HUMAN | COMPOSITE
```

**Importante:** En MVP-0 el evaluador principal es `HUMAN`: el feedback del comercial (aceptó/editó/descartó la propuesta del agente) es la primera señal de calidad y alimenta los datasets. `[C5]`

### 11.2 Dimensiones

```
TASK_SUCCESS          CRM_CORRECTNESS        COST
FACTUALITY            POLICY_COMPLIANCE      LATENCY
SOURCE_QUALITY        COMMERCIAL_RELEVANCE   TOKEN_EFFICIENCY
TOOL_CORRECTNESS      NEXT_ACTION_QUALITY
```

### 11.3 Score compuesto

Nunca un único score ciego:

```
commercial_score =
    0.30 * task_success
  + 0.20 * factuality
  + 0.15 * source_quality
  + 0.15 * crm_correctness
  + 0.10 * commercial_relevance
  + 0.10 * next_action_quality
```

Con restricciones duras:

```
if CRM_CORRECTNESS   < 0.95  → FAIL
if POLICY_COMPLIANCE < 1.00  → FAIL
if hallucinated_source       → FAIL
```

### 11.4 Datasets

```
EvaluationDataset: id, name, domain, version
                   train_cases[], validation_cases[], test_cases[]

EvaluationCase:    id, input, context, expected_behavior,
                   expected_output, verifier, difficulty, tags
```

Los primeros datasets se construyen desde trazas reales anotadas por el comercial, no se inventan. `[C5]`

### 11.5 Experiments

Cada cambio de skill, harness, agent, router, tool policy o model crea un `Experiment` que ejecuta baseline y candidate sobre el mismo conjunto:

```
Experiment: id, name, baseline_version, candidate_versions[],
            dataset_version, started_at, finished_at,
            metrics, decision
            status  DRAFT | RUNNING | COMPLETED | FAILED | CANCELLED
```

### 11.6 Release Gate

Un candidato pasa a producción solo si:

```
validation_score >= baseline + minimum_delta
AND critical_failures == 0
AND regression_count <= threshold
AND cost <= max_cost
AND latency <= max_latency
```

**Seesaw constraint:** si un candidato mejora tareas nuevas pero rompe tareas antiguas → `REJECT` o `CREATE_VARIANT`. Alineado con [HarnessX](https://darwin-agent.github.io/HarnessX/): no se aceptan regresiones sobre tareas ya resueltas; en caso de conflicto, se aíslan variantes.

### 11.7 Canary y rollback

Despliegue progresivo: `v2 = 10% → 50% → 100%` comparando en cada tramo. Rollback de un clic que restaura conjuntamente `AgentVersion + HarnessVersion + SkillVersions + RouterVersion`, no solo el prompt.

## 12. Tasks y scheduler

Las tareas no están hardcoded en n8n.

```
TaskDefinition
  id, name, description
  agent_id
  input_schema, output_schema
  schedule, timezone
  enabled, priority, max_concurrency
  retry_policy, timeout
  approval_policy
  environment_id, evaluation_policy
  created_by, updated_by
```

- **Versionado:** `TaskDefinition` + `TaskDefinitionVersion`. Modificar una tarea no destruye su historia; una ejecución antigua sigue siendo reproducible.
- **Borrado:** nunca `DELETE` físico por defecto; `ACTIVE → ARCHIVED`. Borrado físico solo para datos de prueba, datos personales sujetos a eliminación y cleanup administrativo.

### Scheduler

Soporta: `ONCE`, `CRON`, `INTERVAL`, `EVENT`, `MANUAL`, `DEPENDENCY`, `CONDITION`.

Ejemplos: cada día a las 08:00; cada lunes; cada 6 horas; cuando aparece una feria nueva; cuando un lead entra en `INTERESTED`; cuando una oportunidad lleva 5 días sin actividad.

### TaskRun

```
TaskRun: id, task_definition_id
         scheduled_at, started_at, finished_at
         agent_version, harness_version, skill_versions[], environment_version
         input, output, execution_id
         status, score, cost, tokens, latency
```

Permite responder: "enséñame qué hizo el agente el lunes a las 08:00".

## 13. Environments

El entorno no es un benchmark: es el contexto comercial donde opera el agente. Idea adaptada de [EnvHarness](https://github.com/google-research/envharness): modificar la capa de interacción manteniendo intactos los verificadores.

```
Environments: PUBLIEXPE_PROSPECTING | PUBLIEXPE_FOLLOWUP |
              PUBLIEXPE_RESEARCH | PUBLIEXPE_DISCOVERY

EnvironmentVersion: id, environment_id, version
                    tool_policy, data_policy, business_rules,
                    scenario_generator, verifier, created_at
```

Los entornos evolucionan en dificultad (empresas con información incompleta, duplicadas, contacto incorrecto, proveedor existente, señales contradictorias) y permiten hacer regression testing sintético antes de tocar producción.

### Dynamic curriculum

```
PRODUCTION FAILURES → DIAGNOSTIC → CURRICULUM → ENVIRONMENT
                   → EVALUATION → SKILL/HARNESS → PRODUCTION
```

Ejemplo: el failure cluster "empresas con proveedor existente" genera automáticamente el escenario `ExistingSupplierScenario` con variantes (proveedor desconocido, confirmado, descontento, con contrato cerrado).

## 14. Orquestación

No hay pipelines hardcoded (`Prospector → Researcher → Writer` para siempre). Hay un router versionado que decide el grafo:

```
Router: id, name, version
        routing_policy, available_agents[], constraints, fallback_policy
```

### Delegation graph (DAG)

```
                  PROSPECTOR
                      │
             ┌────────┴─────────┐
             ▼                  ▼
         RESEARCHER        SIGNAL ANALYST
             └────────┬─────────┘
                      ▼
                 QUALIFIER
                      │ confidence?
                /           \
              low           high
               ▼              ▼
           VERIFIER        SCORER
               └──────┬───────┘
                      ▼
             COMMERCIAL COPILOT
```

La topología evoluciona por la misma vía que todo lo demás: propuesta → evaluación → gate → producción. Sin self-modification en producción.

## 15. Tools

Los agentes no reciben "internet". Reciben herramientas explícitas de un registry:

```
Tool: id, name, description, version
      input_schema, output_schema
      risk_level, side_effects
      permissions, timeout, rate_limit, enabled
```

### Clases de riesgo

| Tool | Riesgo |
|---|---|
| `search_web`, `fetch_url`, `search_products`, `match_products` | `READ` |
| `create_lead`, `create_activity`, `update_lead` | `LOW_WRITE` |
| `update_opportunity`, `create_quote_request` | `HIGH_WRITE` |
| `send_email`, `send_whatsapp` | `EXTERNAL_SIDE_EFFECT` |
| `delete_company` | `DESTRUCTIVE` |

### Human gates

| Modo | Acciones |
|---|---|
| Automático | research, enrichment, deduplicación, scoring, hipótesis, notas internas, creación de tareas |
| Aprobación requerida | enviar email, enviar WhatsApp, contactar decision maker, cambiar etapa de oportunidad, crear quote request |
| Nunca autónomo | borrar datos del CRM, transacciones financieras, cambios en contratos de cliente |

Toda tool con `side_effect = true` tiene `approval_policy`. Ejemplo: `send_email` devuelve `{"status": "approval_required", "draft_id": "..."}`.

## 16. Memoria

```
WORKING      solo durante la ejecución
EPISODIC     qué ocurrió (traces)
SEMANTIC     qué hemos aprendido (knowledge layer)
PROCEDURAL   cómo hacer algo (skills)
```

## 17. Observabilidad

### 17.1 Trace

Cada ejecución genera un trace estructurado, nunca solo logs de texto:

```
Trace: execution_id, task, agent, agent_version, harness
       steps[], tool_calls[], messages[]
       memory_reads[], memory_writes[], delegations[]
       errors[], final_output, evaluation

TraceStep: sequence, timestamp
           type   THINK | MODEL | TOOL | DELEGATE | MEMORY_READ |
                  MEMORY_WRITE | VERIFY | REFLECT | FINAL
           input, output, model, tokens
           tool, tool_input, tool_output
           latency, error, reward
```

No se almacena razonamiento privado del modelo: eventos operacionales, entradas/salidas de tools, decisiones estructuradas y métricas.

### 17.2 Dashboard

```
AGENTS
  Success rate     87.2%      Avg cost      €0.043
  Task completion  91.4%      Avg latency   18.4s
  Hallucination     2.1%      CRM correct.  99.1%

Por agente:  Prospector · Researcher · Qualifier · Commercial Copilot
Por versión: v1.2 → 81% | v1.3 → 86% | v1.4 → 89%
```

### 17.3 Cost tracking

Cada ejecución registra `input_tokens, output_tokens, cached_tokens, tool_calls, tool_cost, model_cost, total_cost`. El objetivo de optimización es `calidad / €`, no solo calidad.

### 17.4 Failure clustering

Los errores se agrupan y alimentan a los optimizadores:

```
FAILURE CLUSTER FC-021
  Problem:      agents contact wrong role
  Occurrences:  34
  Agents:       Prospector v1.3, Commercial v1.1
  Likely cause: decision-maker heuristic
  Recommended:  skill update
```

Pipeline de reflexión (compresión antes de reflexionar, como el componente de digestión de HarnessX):

```
TRACE → NORMALIZE → CLASSIFY → CLUSTER → REFLECT → PROPOSE
```

## 18. Optimización automática

Tres optimizadores en v0.x; Environment Optimizer y Model Router Optimizer más adelante.

| Optimizador | Input | Output | Gate |
|---|---|---|---|
| Skill | current_skill, training_traces, validation_dataset | candidate_skill | `validation(candidate) > validation(current)` |
| Harness | current_harness, failure_clusters, trace summaries | candidate_harnesses[] | sandbox + evaluación |
| Router | task outcomes, delegation traces, agent capabilities | candidate graph | success ↑, cost ↓, latencia aceptable, sin regresiones críticas |

### Frontera harness/model en v0.1

Sí: `traces → harness/skill/routing optimization`.
No todavía: `traces → entrenamiento de pesos → reemplazo del modelo en producción`.

Se deja preparado el formato `RewardAnnotatedTrajectory`, exportable después a SFT/DPO/RL (el loop que plantea HarnessX).

### Model registry y routing

```
Model: provider, model_name, context_window, capabilities, pricing, availability

Routing: simple → modelo barato | research → modelo razonador |
         high-risk → mejor modelo | evaluator → modelo independiente
```

El evaluador no debe ser el mismo modelo que ejecuta.

## 19. Regla de oro del sistema evolutivo

Los agentes pueden proponer cambios, experimentar, evaluarse y crear candidatos. Pero **ningún agente puede promoverse a producción a sí mismo**. La promoción pasa por el Release Gate. Esto convierte el sistema en una plataforma controlable, no en un conjunto de agentes impredecibles.

## 20. n8n

n8n no contiene la inteligencia central; contiene integración y orquestación externa:

```
CRON → fetch event sources → normalize → send TaskRun
Twenty webhook → n8n → trigger agent task
Task scheduler → n8n execution → runtime
```

Las tareas de negocio (`TaskDefinition`) viven en el Agent OS; n8n solo las ejecuta. Así mañana puedes sustituir n8n por Temporal, BullMQ o Cloud Scheduler sin cambiar el modelo conceptual.

## 21. Robustez operacional

### Idempotencia

Obligatoria. Cada operación externa lleva `idempotency_key`:

```
publi:company:create:domain:acme.es
taskrun:{task_id}:{scheduled_at}
```

Un agente que reintenta no puede crear cinco empresas iguales.

### Concurrencia

Cada tarea tiene `max_concurrency` y locks por entidad (`Company ACME → locked_by execution_123`) para evitar que dos agentes actualicen el mismo lead a la vez.

### Event bus

```
company.created        task.scheduled         evaluation.completed
signal.detected        task.started           candidate.created
lead.created           task.completed         candidate.approved
opportunity.updated    task.failed            candidate.rejected
                       agent.execution.*      skill|harness|router.promoted
```

### Contratos de API

Todos los schemas en JSON Schema, versionados (`research.result.v1`, `commercial.hypothesis.v1`, `agent.task.input.v1`...). Nunca romper contratos silenciosamente.

## 22. Seguridad

Tres planos: `DATA SECURITY` (RBAC), `TOOL SECURITY` (allowlist), `AGENT SECURITY` (sandbox + límites).

### Permisos por agente

```
Prospector:
  READ:      companies, people, signals, opportunities
  WRITE:     signals, research, hypotheses
  FORBIDDEN: delete company, delete person, send email

Copilot:
  SEND_EMAIL: requires_approval = true
```

### Defensa contra prompt injection

El contenido web es untrusted input:

```
WEB CONTENT ≠ INSTRUCTIONS
```

El runtime marca `source_content = untrusted` y nunca lo incorpora como system instruction.

### Retención de datos

| Dato | Retención |
|---|---|
| Traces completos | 30-90 días (configurable) |
| Summaries | Indefinida |
| Knowledge | Hasta superseded |
| CRM | Política de negocio |

### Semántica de borrado

`Agent → ARCHIVE`, `Skill → DEPRECATE`, `Task → ARCHIVE`, `Experiment → IMMUTABLE`, `Execution → IMMUTABLE`, `Trace → retention policy`. Conserva la reproducibilidad.

### Audit log

Cada modificación, incluidas las automáticas:

```
who, what, before, after, why, experiment, approval, timestamp

Ejemplo:
  Skill v12 → v13
  Actor: SkillOptimizer · Experiment: EXP-0192
  Validation: +4.7% · Approved by: ReleaseGate
```

### Multi-tenancy `[C6]`

Columna `tenant_id` en todos los esquemas desde el principio. Sin infraestructura multi-tenant en v0.x.

## 23. UI en Twenty

No se construye un frontend propio. Twenty es la interfaz, mediante Apps (vistas, navegación, layouts y componentes).

```
Commercial OS (sidebar)
 ├── Dashboard
 ├── Signals
 ├── Research
 ├── Hypotheses
 ├── Agent runs        ← resúmenes; el detalle vive en el Agent OS [C1]
 └── Knowledge
```

La consola de plataforma (agentes, tasks, evaluaciones, experimentos, release gate) es una UI mínima servida por el Agent OS, no objetos de Twenty. `[C1]`

Ejemplos de las vistas de plataforma:

```
┌──────────────────────────────────────────┐
│ PROSPECTOR v1.8                          │
│ Status ACTIVE · Success 91.7%            │
│ Validation 89.4% · Production 87.2%      │
│ Cost/task €0.038 · Latency 12.4s         │
│ Skill v14 · Harness v7 · Router v3       │
│ [Pause] [Evaluate] [Rollback] [Edit]     │
└──────────────────────────────────────────┘

EXP-0192  Skill v13 vs v14
Dataset: Commercial Research Validation v4 (1.000 casos)
Result: +4.7% · Critical failures: 0 · Status: APPROVED
```

## 24. Flujo end-to-end de referencia

1. **08:00** — Se dispara la task `Daily Event Prospecting`.
2. El Prospector busca ferias y encuentra la Feria X con 120 expositores.
3. Deduplicación: 120 → 87.
4. El Researcher analiza: 87 → 52.
5. El Signal Classifier filtra: 52 → 31.
6. El Commercial Scorer puntúa: 31 → 14 hot leads.
7. Twenty recibe 14 companies, 14 signals, 14 hypotheses y 14 activities.
8. El Commercial Copilot propone: "contacta hoy a estas 8". El comercial decide.

### Feedback loop (30 días)

```
1.200 investigadas → 320 leads → 190 contactadas → 47 respuestas
→ 21 cualificadas → 12 propuestas → 4 ventas
```

El embudo alimenta el Evaluation Dataset y después los tres optimizadores.

## 25. Stack

| Capa | Tecnología |
|---|---|
| CRM | Twenty self-hosted |
| Extensión Twenty | TypeScript / twenty-sdk |
| Runtime | TypeScript / Node.js |
| Orquestación externa | n8n |
| Queue | Redis / BullMQ |
| Metadata | PostgreSQL |
| Artifacts | Object storage compatible S3 |
| Memoria semántica | PostgreSQL + pgvector (sin vector DB dedicada en MVP) |
| LLMs | Abstracción de proveedor |
| Observabilidad | OpenTelemetry |
| Evaluación | Motor propio |
| Despliegue | Docker Compose |

Twenty usa TypeScript/NestJS, PostgreSQL y Redis; mantener el Agent OS en TypeScript reduce fricción.

### Estructura de repositorio

```
publi-commercial-os/
├── apps/twenty-app/
├── runtime/{agent-runtime, harness, memory, tools, orchestration}/
├── services/{catalog, inbound}/          ← [C2][C3]
├── evaluation/{evaluators, datasets, benchmarks, gates}/
├── optimization/{skills, harness, router, environments}/
├── integrations/{twenty, n8n, web}/
├── schemas/
├── deployments/
└── docs/
```

## 26. Roadmap MVP `[C5]`

El criterio de MVP-0 es valor comercial medible, no completitud de plataforma.

### MVP-0 — Pipeline de prospección con HITL

Objetivo: leads cualificados en Twenty cada mañana, con feedback del comercial capturado.

Requisito previo: `publiexpe.info` contratado, DNS de envío configurado (SPF, DKIM, DMARC `p=none`) y warm-up en marcha. Arranca en paralelo al desarrollo: tarda 3-4 semanas.

```
Twenty + App (CommercialSignal, Research, CommercialHypothesis, AgentRunSummary)
Agent + AgentVersion (en Agent OS)
TaskDefinition + TaskRun + Trace
Catalog Service (search + match, solo lectura)
Evaluador HUMAN (aceptar / editar / descartar en Twenty)
1 agente compuesto: Prospector→Researcher→Scorer con grafo fijo
```

### MVP-1 — Estructura evolutiva

```
Skills + SkillVersion
Harness + HarnessVersion
Memory (episodic + semantic básica)
Inbound Manager (clasificación + borradores con aprobación)
```

### MVP-2 — Evaluación formal

```
Experiments, datasets validation/test (desde trazas anotadas)
Release gates, canary, rollback
```

### MVP-3 — Optimización automática

```
Skill Optimizer, Harness Optimizer, Router Optimizer
```

### MVP-4 — Entornos y entrenamiento

```
Dynamic environments, curriculum generation, model training bridge
```

### Fuera de alcance en v0.x

Fine-tuning automático, RL, vector DB dedicada, 20 agentes, multi-tenant completo, swarm autónomo, auto-deploy de código, agentes que escriben código de producción, auto-envío de emails, modificación autónoma de datos críticos. La arquitectura los permite; la primera versión no los necesita.

## 27. Decisiones

### Cerradas (2026-10-06)

1. **Fuente del catálogo** `[C2]`: base de datos de publiexpe, mediante conector en su backend (API privada o MCP). Este proyecto define el contrato; el equipo del backend lo implementa. Consulta *Catalog Service*.
2. **Presupuestos**: se crean en el CMS de publiexpe vía el conector (API/MCP). Twenty guarda referencia y estado en la `Opportunity`. Consulta *Presupuestos*.
3. **Twenty Apps — validado**: el framework de [Apps](https://docs.twenty.com/getting-started/core-concepts/apps) soporta oficialmente objetos y campos custom, logic functions server-side en TypeScript (triggers HTTP, cron y eventos de BD), componentes React sandboxed (Web Workers + Remote DOM, en side panel, widgets y command menu), skills y agentes, y vistas y navegación. Scaffold con `npx create-twenty-app`. Cubre todo lo que este LLD asume de Twenty. Queda validar en la instancia self-hosted concreta al desplegarla (paridad de versión).

4. **Dominio de outbound**: dominio aparte, **`publiexpe.info`**. El alta del dominio, el DNS (SPF/DKIM/DMARC) y el inicio del warm-up son requisito previo del MVP-0: el warm-up tarda 3-4 semanas y debe arrancar antes de que el primer agente esté listo. Consulta *Canal de envío*.

5. **Buzones y DKIM**: `jesus.abril@publiexpe.info` + `j.abril@publiexpe.info` (buzones basic de IONOS, sin copago). DKIM activado a nivel de dominio en IONOS, sin coste. SPF (asistente "IONOS SPF") y DMARC (`p=none`, `rua=dmarc@publiexpe.info`) configurados el 2026-10-06. Consulta *Canal de envío*.

### Pendientes

1. **Idioma de los agentes**: catálogo y clientes en español; ¿prospección también en otros idiomas/mercados?
2. **Datos registrales completos**: el aviso legal lleva "Tomo 1405, Libro 0" del Registro Mercantil de Granada; añadir folio y hoja (GR-xxxxx) cuando se localicen.

## Referencias

Verificadas el 2026-10-06:

- [SkillOpt: Agent skills as trainable parameters](https://microsoft.github.io/SkillOpt/) — Microsoft Research. [Paper](https://arxiv.org/abs/2605.23904) · [GitHub](https://github.com/microsoft/SkillOpt)
- [HarnessX: A Composable, Adaptive, and Evolvable Agent Harness Foundry](https://darwin-agent.github.io/HarnessX/) — Darwin Agent Team. [Paper](https://arxiv.org/abs/2606.14249)
- [EnvHarness: Awakening Static Worlds for Agent Learning](https://github.com/google-research/envharness) — Google Research. [Paper](https://arxiv.org/abs/2608.19880)
- [WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution](https://arxiv.org/abs/2608.27454)
- [Twenty — API y webhooks](https://github.com/twentyhq/twenty/blob/main/packages/twenty-docs/developers/extend/api.mdx)
- [Twenty — Apps: conceptos](https://docs.twenty.com/getting-started/core-concepts/apps) · [Quick start](https://github.com/twentyhq/twenty/blob/main/packages/twenty-docs/developers/extend/apps/getting-started/quick-start.mdx)
- [IONOS — límites de envío de correo](https://www.ionos.com/help/email/general-topics/what-are-the-mass-mailing-limits/) · [restricciones de envío masivo](https://www.ionos.com/help/email/general-topics/what-restrictions-apply-to-sending-bulk-emails/)

## Qué sigue — LLD v0.2

El LLD v0.2 es la especificación de implementación. Antes de redactarlo, lee las Agent Skills oficiales de Twenty para desarrollo de Apps (compatibles con Codex y otros harnesses). Contenido previsto:

```
01. Objetos Twenty exactos           18. Esquema de BD fuera de Twenty
02. Campos + tipos exactos           19. Workflows n8n
03. Relaciones exactas               20. Primeros 3 agentes
04. Enums exactos                    21. Primeras 10 skills
05. Interfaces TypeScript            22. Primer evaluation dataset
06. Contratos de API                 23. Primer benchmark comercial
07. Contratos de eventos             24. Modelo de seguridad
08. Interfaces del Agent Runtime     25. Arquitectura Docker
09. Tool interface                   26. CI/CD
10. Skill interface                  27. Estrategia de tests
11. Harness interface                28. Datos seed/demo
12. Memory interface                 29. Observabilidad
13. Evaluator interface              30. Rollback / disaster recovery
14. Task scheduler interface         31. Criterios de aceptación
15. Experiment interface             32. Estructura del repo
16. Algoritmo del Release Gate       33. Orden de implementación
17. Trace schema                     34. Master prompt para Codex
```
