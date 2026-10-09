# Registro de cambios

Cambios notables de PubliEXPE Commercial OS, agrupados por tanda de trabajo. Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Las fechas usan el formato `AAAA-MM-DD`.

## 2026-10-07 — Tanda 6 (PR #6)

- Catálogo completo: paginación hasta el final (parada temprana), presupuesto por TIEMPO (20 min, cortes limpios sin perder evaluaciones pagadas), captura de la API JSON de las SPAs de catálogo (filtrada y untrusted) y fichas en paralelo. Run real: 91/91 expositores, 29 empresas con dominio (23 nuevas), 0,195 €. `max_profile_lookups` por defecto: 100 (gobernado por tiempo).
- Borradores: la primera mención de PubliEXPE lleva siempre descriptor ("expertos en merchandising para empresas"), por prompt y garantizado por código (`company_descriptor` configurable). Feedback directo del usuario.
- Inbound de bajas: BajasAgent determinista (sin LLM) lee el buzón por IMAP en SOLO LECTURA (cliente sin métodos de escritura, verificado), clasifica bajas con señales estrictas y las añade (append-only, dedupe) a la nota de supresión de Twenty. Task `process-unsubscribes` cada 2 h. Migración 0004.
- Flaky de events: diagnóstico (ventana intencionada del patrón outbox; el código es correcto), test robustecido + test determinista del orden.
- LLD v0.3 (`docs/LLD-0.3-estado-real.md`): 22 ADRs, mapa de los 34 puntos del v0.2 (2 iguales, 21 distintos, 11 pendientes), métricas base y pendientes honestos. 9 contradicciones de documentación reconciliadas.

## 2026-10-07 — Tanda 7 (PR #7)

- Envío HITL desde Twenty (preparado): campos de borrador en la hipótesis (`emailTo/Subject/Body/Status`), workflow manual de envío creado en borrador (filtra READY+VALIDATED, 0 reintentos, un clic humano por envío) y guía `docs/twenty-envio-email.md`. 2.45 self-hosted solo admite cuentas IMAP/SMTP genéricas — perfecto para IONOS. Hallazgo de seguridad corregido: la API key del runtime tenía rol Admin y habría podido enviar vía MCP con un buzón conectado → rol restringido "Agent runtime" (objetos sí, tools no) creado y asignado; verificado `send_email` fuera del catálogo.
- Puente n8n: `POST /events/external` (Bearer, tipos `ext.*`, no puede suplantar eventos internos) y suscripciones salientes firmadas HMAC con reintentos; ejemplo importable en `integrations/n8n/ejemplo-eventos.json`. Migración 0006.
- Skills versionadas (primer paso MVP-1): tablas `skills`/`skill_versions` inmutables por trigger SQL, 4 skills migradas byte a byte como v1 ACTIVE, resolución desde BD con fallback a código, API de versiones con activación/rollback, y el trace registra la versión exacta usada. Migración 0005.
- PM: journal de migraciones 0005/0006 refechado (el orden por fecha contradecía el de índice: drizzle habría saltado la 0006 en silencio).

## 2026-10-07 — Tanda 8 (PR #8)

- Email-ops en el flujo: al marcar READY, el runtime comprueba la lista de supresión (y destinatario vacío/ inválido) y devuelve a DRAFT con nota ⛔; doble chequeo en SENT para la ventana de carrera; tabla `email_sends` (migración 0007) y eventos `email.*`; bloque Email en métricas/dashboard con las fases del calendario de warm-up y el límite horario de IONOS.
- Ciclo de mejora de skills (primera vuelta real, LLD §6.4 en manual): análisis de trazas con patrones citables (cantidades de plantilla, confianza inflada sin datos, suposiciones como hechos), v2 del Prospector como DRAFT con 5 operaciones acotadas, tooling `pnpm skill:candidate` (límites de edición 35%/50%) y `pnpm skill:compare`, holdout sin contaminar (P5) y EXP-001 documentado. Veredicto del gate: ITERAR (regresión de semántica de confianza detectada) — la v2 no se activa. Playbook en docs/ciclo-mejora-skills.md.
- Docs: ADRs 23-31 en el LLD v0.3; guía del comercial y warm-up en presente (envío con un clic operativo desde 2026-10-07); roadmap LLD 0.1 vs construido (docs/ROADMAP.md).
- Fixes PM: título de la nota de supresión reparado (mojibake de encoding), compose con EXTERNAL_EVENTS_TOKEN, tests alineados con send_from_twenty activo.

## 2026-10-07 — Tanda 9 (PR #9)

- MVP-1 cerrado: skill v3 del Prospector ACTIVADA tras el EXP-002 (todos los criterios pre-declarados cumplidos; la regresión de la v2 ausente; rollback a un comando); harness versionado v1 (políticas consolidadas e inmutables, semántica de techo sobre límites por agente, 7 fallbacks, comportamiento idéntico verificado; migración 0008); memoria semántica KnowledgeEntry (ACTIVE solo con evidencia, 3 entradas reales sembradas del EXP-001 y del feedback del usuario, paso MEMORY_READ en el trace; migración 0009); y el Prospector escribe Research (solo hechos observados y fuentes del SourceLedger).
- Dashboard en Twenty (nativo): estudio con evidencia (Front Components con Origin null e iframe descartados), objeto agentOsDailyMetric sincronizado cada 15 min por el runtime + página "Agent OS · Métricas" con KPIs, 4 gráficos de 14 días y tabla de últimos runs. Sin CORS ni superficies nuevas.
- E2E en producción: run con harness default-commercial@1, skill v3 (hash del EXP-002), MEMORY_READ con 2 entradas y research creado.
- Pendiente del operador: sync de la App (rol Admin temporal en la key, revertir y verificar send_email=0) y backfill de métricas (--days=30).

## 2026-10-07 — Tanda 10 (PR #10)

- MVP-2 cerrado: datasets de evaluación versionados cosechados de datos reales (prospeccion-v1: 94 casos; P5 operativo con markUsed y registro de exclusiones; hallazgo honesto: 0 etiquetados limpios en VAL/TEST hasta que haya más veredictos humanos frescos — migración 0010); 11 evaluadores (RULE deterministas destilados de EXP-001/002, LLM_JUDGE ciego a versiones con gemini-pro, COMPOSITE §11.3 con restricciones duras) que reproducen el veredicto del EXP-002 automáticamente; y motor de Experiments + Release Gate (§11.5-11.6 con seesaw, PASS/PASS_FORM/FAIL/INCONCLUSIVE, migración 0011) con candado en la activación de skills y harness (409 release_gate_blocked; override humano con force+reason auditado).
- EXP-003, el primer experimento 100% automático, rechazó la v4 (Δ composite 0,007 < 0,02; el juez detectó además que v4 inventaba "notoriedad contrastada"). 0,14 €.
- Incidente PM sin impacto (documentado): una verificación contra el contenedor sin redesplegar activó brevemente la v2; restaurada la v3 en ~3 min; 0 trazas afectadas; el VALIDATION de prospeccion-v1 queda gastado por EXP-003 (siguiente experimento: dataset v2 o etiquetas nuevas).
- Decisión de coordinación: evaluaciones automáticas al tenant `experiments` (métricas humanas limpias por diseño); el filtro kind='HUMAN' en queries.ts queda documentado para la sesión externa que posee ese archivo.

## Sin publicar

### Documentación y herramientas

- Se completa el [runbook de operación local](runbook-local.md) con el comando de migraciones de Drizzle, las variables del runtime, el arranque del stack completo (incluido `pxos-runtime` en el `4020`), los logs por contenedor, el flujo de prueba end-to-end, las credenciales de desarrollo y la rotación de la API key de Twenty.
- Se añade `scripts/sync-twenty-app.ps1`, que sincroniza la Twenty App desde Windows. Ejecuta `yarn twenty apply` en un contenedor efímero `node:24` conectado a `pxos-net`, con `socat` reenviando `127.0.0.1:3020` a `pxos-twenty:3000`. Evita el error `Resource path must not contain backslashes` y el fallo de subida de archivos por `SERVER_URL`.
- Se documenta el workaround de Windows en el runbook y en el README de la Twenty App.
- Se añade la [guía del equipo comercial](guia-comercial.md) y la sección "Operación diaria" del runbook, y se cierra el hueco del seed con `pnpm seed`.
- Se añade el [plan de warm-up del canal de email](email-warmup.md) (calendario de cuatro semanas desde el 2026-10-06, vigilancia DMARC y Postmaster, hito DMARC `p=quarantine` del 2026-11-03, bajas y checklists), la sección "Borradores de email" de la guía comercial y su enlace desde el runbook y el README.
- Se amplía el [plan de warm-up](email-warmup.md) con la sección "Alta en Microsoft SNDS" (SNDS no es accesible con IONOS correo compartido; se documenta la alternativa manual: prueba de colocación con cuentas Outlook propias, cabeceras, rebotes y señales indirectas) y con el procedimiento de la lista de supresión: nota de Twenty "Lista de supresión — NO contactar", una línea `email — fecha — motivo` por baja y comprobación obligatoria antes de cada envío en frío.
- La [guía del equipo comercial](guia-comercial.md) resume el procedimiento de la lista de supresión en la sección de borradores y documenta que una hipótesis editada y validada también genera borrador, con los datos corregidos.
- Se añade el [LLD v0.3 — estado real del sistema](LLD-0.3-estado-real.md): resumen de lo que corre hoy, registro de 22 decisiones (ADR) de las tandas 1 a 5, tabla «LLD 0.2 → realidad» sobre los 34 puntos del v0.2, métricas de línea base a 2026-10-07 y mapa honesto de pendientes hacia MVP-1 y MVP-2. Marca como `[TANDA 6, EN CURSO]` el descriptor de PubliEXPE en los borradores.
- Se amplía el [LLD v0.3](LLD-0.3-estado-real.md) con las ADR 23 a 31 de las tandas 6 y 7 (descriptor de PubliEXPE por código, BajasAgent de solo lectura, captura de la API JSON del renderer, presupuesto por tiempo del scout, envío HITL con workflow manual de Twenty, rol restringido «Agent runtime» de la API key, skills versionadas, puente de eventos `ext.*` con firma HMAC y regla de refechado del journal de migraciones). Total: 31 ADR. Las skills y n8n dejan de figurar como pendientes en el mapa de los 34 puntos (2 iguales, 23 distintos, 9 pendientes), se cierra la marca `[TANDA 6, EN CURSO]` y se añaden contradicciones de documentación nuevas.
- La [guía del equipo comercial](guia-comercial.md) pasa el envío desde Twenty de condicional a activo (operativo desde el 2026-10-07): flujo con `Email to`, `Email status` (`Draft`, `Reviewed`, `Sending`, `Sent`) y el botón **Enviar borrador de email**, la comprobación de la lista de supresión antes de poner `Reviewed`, la alternativa de enviar a mano y la nota de que el sistema añade las bajas a la lista cada 2 horas.
- El [plan de warm-up](email-warmup.md) indica que los envíos desde Twenty cuentan en el calendario y en los límites de IONOS, remite al bloque **Email** del dashboard local y actualiza la gestión de bajas (altas automáticas del BajasAgent).
- El [runbook](runbook-local.md) añade el mapa de `pxos-renderer`, las variables `IONOS_IMAP_*` y `RENDERER_URL`, las migraciones `0004` a `0006` y la comprobación del journal, la comprobación de skills con `GET /skills`, la sección «Rol de la API key de Twenty» (al rotar la key hay que reasignar el rol restringido) y problemas frecuentes nuevos.
- El README raíz corrige la tabla de componentes (el Catalog Service y el Inbound Manager no existen como servicios), añade el puerto `4030` y enlaza las guías de envío desde Twenty y de integración con n8n.

## 2026-10-06 — Tanda 2 (PR #2)

- Scheduler (CRON/INTERVAL/ONCE, timezone Europe/Madrid) sobre BullMQ, con deduplicación por slot, `max_concurrency` por tarea, locks por entidad (`entity_locks`) y recuperación de runs huérfanos.
- Capa de tools contra Twenty: 7 tools (find/get/upsert company, create signal/research/hypothesis/run summary), registry con clases de riesgo, allowlist por agente y executor con límites.
- GeminiProvider (REST v1beta, salida JSON estructurada, tabla de precios por modelo real servido) y factory multi-proveedor stub | gemini | anthropic. Decisión: Gemini como proveedor de trabajo.
- Prospector v1: clasifica expositores de un evento y escribe en Twenty empresa + señal (NEW) + hipótesis (PROPOSED) + resumen de ejecución, con coste real por paso (~0,005 €/run). Seed de agente y tarea `daily-event-prospecting` (CRON 08:00).
- Runbook completo, `scripts/sync-twenty-app.ps1` (workaround Windows del CLI de Twenty) y fixes de `deployments/`.

## 2026-10-07 — Tanda 3 (PR #3)

- Fix de arranque: el worker espera a que Twenty esté sano antes de ejecutar runs con sus tools (sin gastar reintentos, tope configurable).
- Modo scout del Prospector: grounding de Google Search vía Gemini + tool `fetch_url` con guardias SSRF; contenido web tratado como no confiable (LLD §76) y URLs validadas contra fuentes reales. Tarea `weekly-event-scouting` (lunes 07:30). Limitaciones conocidas: Gemini 3.8 no devuelve metadatos de fuentes del grounding (fallback por descarga) y los catálogos JS/PDF no se leen (señal a nivel de feria).
- Event bus: tabla `events` append-only, publicación de `task.*` y `agent.execution.*`, trigger `EVENT` del scheduler con guardia anti-bucle y `GET /events`.
- Evaluador HUMAN: webhook de Twenty firmado (HMAC) → tabla `evaluations` (ACCEPTED 1.0 / EDITED 0.5 con diff / DISCARDED 0.0), vinculado a la ejecución de origen; `pnpm register:webhook` y `POST/GET /evaluations`.
- Guía del equipo comercial (`docs/guia-comercial.md`) y runbook actualizado.
- Infra: allowlist de webhooks internos de Twenty (`OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS`), `TWENTY_WEBHOOK_SECRET`, `TWENTY_WAIT_MAX_MS` y claves de Gemini en el compose.

## 2026-10-07 — Tanda 4 (PR #4)

- Lector de catálogos: PDF en `fetch_url` (unpdf, +2,5 MB) y servicio `pxos-renderer` (Playwright/Chromium, red interna, doble barrera anti-SSRF: interceptación + proxy muerto) con tool `render_url` y espera de hidratación. E2E real: 20 expositores del catálogo JS de Gastrónoma donde antes salían 0.
- Borradores de email HITL: `evaluation.recorded` → trigger EVENT → EmailDrafter → nota "Borrador email — ..." en Twenty (empresa + hipótesis). Línea de baja y firma garantizadas por código. Sin ningún código de envío. ~0,002 €/borrador.
- Métricas: `GET /metrics/summary|agents|evaluations|runs` + dashboard local en `/dashboard` (tasa de aceptación humana por versión de agente, coste, embudo, AC-15/16/17).
- Plan operativo del warm-up (`docs/email-warmup.md`) con calendario hasta el hito DMARC del 2026-11-03, y sección de borradores en la guía del comercial.
- Infra: servicio pxos-renderer en el compose (sin puerto público; 127.0.0.1:4030 solo desarrollo), `RENDERER_URL` al runtime. Prospector v4 (render_url) y agente EmailDrafter sembrados.

## 2026-10-07 — Tanda 5 (PR #5)

- Dominios de expositores: paginación de catálogos (también la de solo-cliente, pulsando el paginador dentro del renderer) + apertura de fichas de los relevantes para extraer y validar su web. Run real: 60 expositores evaluados, 6 empresas reales creadas en Twenty con señal e hipótesis (0,14 €). `max_profile_lookups` por defecto: 20.
- Triggers EVENT con operador `{in: [...]}` y guarda `toStatus`: una hipótesis editada y validada también genera borrador, con los datos corregidos.
- Limpieza: script `pnpm cleanup:archive-test-agents`; 30+ agentes/tareas de test archivados (nunca borrados); métricas y dashboard ocultan archivados (`include_archived=true` para verlos).
- Sandbox de Chromium activo en pxos-renderer (perfil seccomp de Playwright + `cap_add SYS_CHROOT`).
- Email: documentado que SNDS no aplica con IP compartida de IONOS (alternativa manual para Outlook) y procedimiento de la lista de supresión (nota en Twenty, ya creada).


## 2026-10-06 — Tanda 1: bootstrap del MVP-0 (PR #1)

Integración de `feat/mvp0-bootstrap` en `main` (PR #1).

### Añadido

- **Infraestructura local** (`deployments/`): stack Docker Compose con Twenty CRM `v2.45.6` (servidor y worker), Postgres 16 y Redis 7.4 de Twenty, PostgreSQL con pgvector del Agent OS (`127.0.0.1:5440`) y Redis del Agent OS con AOF para BullMQ (`127.0.0.1:6391`). Red `pxos-net` y volúmenes con prefijo `pxos`.
- **Servicio `pxos-runtime`** integrado en el compose: build desde `runtime/agent-runtime`, puerto `127.0.0.1:4020`, healthcheck sobre `/health`, migraciones al arrancar con `RUN_MIGRATIONS=true` y variables `TWENTY_BASE_URL` y `TWENTY_API_KEY`.
- **Agent Runtime** (`runtime/agent-runtime/`): esqueleto ejecutable en Node.js 22 y TypeScript con API Fastify, worker BullMQ y persistencia con Drizzle ORM sobre PostgreSQL.
  - Endpoints para agentes, tareas, task runs y ejecuciones, con ciclo de vida de estados y trace con pasos.
  - Lanzamiento idempotente de `TaskRun` con la clave `taskrun:{task_id}:{scheduled_at}` e índice único `(tenant_id, idempotency_key)`.
  - `tenant_id` en todas las tablas (C6).
  - Agentes con `StubAgent` (sin LLM) y `AnthropicProvider` como esqueleto.
  - Tests unitarios y de integración con Vitest.
- **Twenty App** (`apps/twenty-app/`): App `publiexpe-commercial-os` con los objetos `commercialSignal`, `research`, `commercialHypothesis` y `agentRunSummary`, sus relaciones con `Company` y `Person`, la carpeta de navegación **Commercial OS** y las vistas kanban de hipótesis por estado y señales recientes.
- **Especificación**: LLD v0.2 del MVP-0 (`docs/LLD-0.2-especificacion.md`) junto al LLD v0.1.
- **Documentación**: guía de contribución (`docs/CONTRIBUTING.md`), runbook local (`docs/runbook-local.md`, esqueleto), puertos reservados (`docs/PORTS.md`) y README de despliegue.

### Conocido y pendiente

- El runtime todavía no tiene scheduler: las runs se lanzan a mano con `POST /tasks/:id/run`.
- `/health` del runtime solo comprueba PostgreSQL; el contrato del LLD v0.2 prevé también Redis y Twenty.
- El runtime recibe `TWENTY_API_KEY` pero aún no escribe en Twenty.
- No hay autenticación por token en la API del runtime.
- Promote, rollback y evaluate de agentes devuelven `501` (previstos para MVP-2).

## 2026-10-07 — Tanda 11 (PR #11)

- MVP-3: Skill Optimizer automático (LLD §18) sobre el Release Gate: cosecha de fallos reales (veredictos humanos negativos + hard-fails de las reglas, sin LLM y solo de trazas reales), clustering con el ejecutor, candidata por edit-ops acotadas (topes 35%/50%, reintento conservador), dataset nuevo con las entidades de los fallos quemadas como design (P5), experimento con el runner existente y veredicto del gate. Nunca activa: con PASS deja una nota "Propuesta de promoción" en Twenty y el cierre (PROMOTED/DISCARDED) es humano. `pnpm optimize:run` + API `/optimizer/*`; solo manual (sin tarea programada); un run abierto por skill; BLOCKED_NO_DATA sin gastar si no hay etiquetas frescas. Tabla `optimization_runs` (migración 0013).
- Experimentos de harness: la tabla experiments ya era genérica; el runner compara harness ACTIVA vs DRAFT con la skill activa fija, y activar una harness exige gate PASS/PASS_FORM o force con motivo (409 release_gate_blocked). `pnpm experiment:run --subject harness:<nombre>`.
- Canario post-gate (solo skills): `POST /skills/:name/versions/:v/canary {percent}` tras un PASS/PASS_FORM (sin force), reparto determinista por hash del task run, un canario ACTIVE por skill (índice único + triggers de inmutabilidad, migración 0012), comparativa en `GET /skills/:name/canary` y promote (re-verifica el gate) / rollback (siempre) humanos.
- Trabajo huérfano de las 2 sesiones externas canceladas, recuperado: métricas comerciales solo con evaluaciones kind='HUMAN' (las automáticas de experimentos no contaminan), desglose por versión de skill en `/metrics/agents` (+tabla en el dashboard), y fix del reconciliador: la causa real era que nada refrescaba `updated_at` en intentos largos → latido cada 30 s (RUN_HEARTBEAT_MS) + UPDATE guardado por attempts/staleBefore; 3 scouts reales habían sido sentenciados FAILED con traza SUCCESS.
- Docs: `docs/skill-optimizer.md` (ciclo MVP-3, revisión de propuestas, canario, costes), modo automático en el ciclo de mejora, ROADMAP al día (MVP-1/2 ✅, MVP-3 🔄→✅ al fusionar), y LLD v0.3/README reconciliados (supresión automática de la tanda 8, plataforma 9-11, runner de harness).
- PM: migraciones intercambiadas a 0012 skill_canaries / 0013 optimization_runs — la 0012 original del optimizer tenía un `when` anterior al de la canaries ya aplicada a la BD compartida y el migrador la habría saltado en silencio (mismo patrón que la tanda 7); snapshots re-encadenados y `db:generate` limpio. Suite completa: 729 tests.

## 2026-10-08 — Tanda 12 (PR #12)

- Triaje general del buzón (Inbound Manager §10.2): InboxAgent sustituye al lector de solo-bajas (process-inbox cada 2 h, un único cursor; process-unsubscribes desactivada). Determinista sin LLM para rebotes (duro/blando por DSN), auto-replies y bajas; LLM con contenido envuelto como no confiable para INTERESADO/PREGUNTA/NO_INTERESADO/OTRO (duda → OTRO; NO_INTERESADO exige confianza ≥0,85). Acciones: notas 📬 en empresa+hipótesis con extracto saneado y cruce con email_sends, NO_INTERESADO explícito → alta en supresión, rebote duro → nota ⚠️ sin supresión, evento email.reply_received (solo dominios). IMAP sigue estructuralmente de solo lectura; el sistema nunca responde. Migración 0014. Bug corregido de paso: mailparser agrupa las cabeceras List-* y el clasificador de bajas no las veía.
- Revalidación de PASS_FORM: accuracy medida sobre los outputs por caso que el experimento guardó (coste 0, sin re-ejecutar LLMs), registro append-only experiment_revalidations (CONFIRMED/REFUTED/INSUFFICIENT, P5: los casos de diseño nunca revalidan), `pnpm experiment:revalidate` + `POST /experiments/:id/revalidate` + pending-revalidation; si REFUTED con la versión activa o en canario → nota ⚠️ en Twenty y evento; nada se desactiva solo. Hallazgo: los outputs por caso solo vivían en informe.json → ahora van en el experimento (case_outputs); los antiguos se revalidan desde el informe. Migración 0016. Deuda anotada: el gate aún no considera un REFUTED.
- audit_log append-only (migración 0015): hook onSend sobre un catálogo explícito de rutas mutantes (un test obliga a clasificar toda ruta nueva — ya cazó /experiments/:id/revalidate en la integración); el force queda siempre auditado con su motivo; GET /audit con filtros; suppression.add auditado desde el InboxAgent (las altas no pasan por la API).
- Retención de trazas sin pérdida (LLD §22): `pnpm traces:archive` exporta payloads pesados a JSONL.gz (creación exclusiva), verifica recuento+sha256+valores y solo entonces aligera campo a campo con triggers que solo permiten la transición exacta payload→puntero (sha256 calculado por la BD); GET /traces/:id nuevo con rehidratación bajo demanda; volumen persistente pxos_trace_archive en el compose. Solo manual.
- Stall-guard (deuda tanda 11): una re-entrega de BullMQ tras stall con latido fresco ya no mata el intento (job aplazado sin consumir intento); el test antiguo describía el comportamiento incorrecto y se adaptó con justificación.
- Docs: inbound-triaje.md, revalidación en skill-optimizer.md y ciclo, runbook (archivado, audit, migraciones 0000-0016), guía comercial ("Respuestas de los clientes"), ROADMAP (MVP-3 ✅, tanda 12); reconciliados Research (se escribe desde la tanda 9) y email-warmup.
- Integración PM: journal 0014→0015→0016 limpio a la primera (when preasignados por el PM — lección de la tanda 11 convertida en procedimiento); suite 835 tests; e2e real del inbox: SUCCESS, 5 mensajes, 1 INTERESADO real (gmail, sin match → sin nota por diseño), 2 llamadas LLM, 0,0014 €.

## 2026-10-08 — Tanda 13 (PR #13)

- El Release Gate escucha las revalidaciones: una REFUTED (la más reciente del experimento) bloquea activar skill/harness, arrancar canario y promote con 409 `revalidation_refuted` (opciones en la respuesta; en canario sin force); CONFIRMED marca `revalidated: true`; INSUFFICIENT no cambia nada; hasta un PASS estricto con REFUTED se bloquea (la comprobación no se fía del veredicto original). El force humano sigue y se audita. Archivado de trazas programado: job interno diario con anti-solapamiento, apagado por defecto (`TRACE_ARCHIVE_ENABLED=false`), auditado como `traces.archive` solo cuando aligera.
- Model routing por rol (§18): `executor_cheap`/`executor_reasoner`/`judge`/`triage`/`optimizer` en lugar de modelos en el código; precedencia `MODEL_ROUTE_<ROL>` > modelo fijado por la versión del agente > `JUDGE_MODEL`/`GEMINI_MODEL` (fallback con aviso si discrepan) > tabla; sin tocar env, todo queda como antes. Juez≠ejecutor se corta antes de crear o gastar nada (alias resueltos). La traza registra la ruta (P4). `pnpm models:costs` + `GET /metrics/model-costs`: proyección de la subida del 2027-01-01 con el volumen real del último mes. Precio de gemini-3.6-flash en 2027 corregido contra la fuente (1,50, no 0,75).
- Environments sintéticos (MVP-4, §13): generador determinista por plantillas con semilla (sin LLM), 12 plantillas con ground truth por construcción sobre F1-F4 + «notoriedad contrastada» + inyección; dominios siempre `.invalid` (el cliente de Twenty además rechaza escrituras con ellos), sin red (fetch/render rechazados en casos sintéticos). Migración 0017: `origin` HARVESTED/SYNTHETIC/MIXED, split `SYNTH`, `curriculum_level` 1-3 (campo propio — `difficulty` conserva su semántica). Triple candado para que una etiqueta sintética jamás cuente como humana: la accuracy del gate sigue siendo solo real; lo sintético alimenta reglas/seesaw/forma (4 evaluadores `synth.*`), y obedecer una inyección suspende POLICY_COMPLIANCE → FAIL. `pnpm synth:build` + `--synth-sample` en `experiment:run`; los casos sintéticos no se queman (P5 no aplica: regenerables).
- Docs: environments-sinteticos.md, model-routing.md, runbook (archivado programado, variables nuevas), gate-REFUTED en skill-optimizer.md y ciclo, ROADMAP (tanda 12 ✅, 13 🔄) — reconciliados por el PM con la implementación real. **Borrador del contrato del Catalog Service (§9) en `docs/catalog-connector-contrato.md`**: REST `/catalog/v1` + MCP equivalente, Bearer solo-lectura, 4 operaciones mínimas, preguntas abiertas agrupadas — PROPUESTA pendiente de revisión con el usuario.
- Integración PM: 905 tests; coordinación en vivo entre agentes (la colisión del campo difficulty y el precio anómalo de 3.6-flash se detectaron en docs y se corrigieron en las ramas antes de fusionar); flaky previo de harness.test arreglado de paso.

## 2026-10-09 — Tanda 14 (PR #14)

- Contrato del Catalog Service v1.1 CERRADO (acordado 2026-10-09): los 18 cambios de la respuesta del backend + decisiones de su tabla de pendientes + 3 correcciones de Commercial OS (aviso por nota ⚠️ y evento catalog.unavailable — nunca email; exención del guard anti-SSRF solo para el origen exacto de la VPN; textos del catálogo como contenido no confiable hacia el LLM). Seis operaciones REST↔MCP; backend ~16 días; docs/catalog-connector-contrato.md y la respuesta del backend como anexo.
- Lado runtime del catálogo, entero contra stub y apagado por defecto (CATALOG_ENABLED=false): cliente REST v1.1 (Bearer pxcat_, reintentos, cursor, rechazo de MAJOR desconocido), stub de 14 fixtures ficticios + lápida DISCONTINUED, caché TTL en memoria; gate de salud con modo degradado (nota única diaria + evento; el run sigue sin catálogo); 5 tools READ (search/get/estimate/families/describe) con salida no confiable; hipótesis con productos reales (campo recommendedProducts existente de Twenty: «Nombre · ref. SKU · id»; con stub, prefijo [STUB]); skill DRAFT del Prospector con la marca [[capacidad:catalogo]] creada por seed — SIN activar: exige experimento con reglas de evaluación de catálogo (productos inventados, priceHint como precio cierto, caso degradado) que quedan para cuando el backend entregue. Checklist de conmutación stub→http en docs/catalog-service.md. El doble filtrado por productId+sku y la confirmación con ficha garantizan que el LLM no puede inventar productos.
- Optimización programada: job cron (0 9 * * 3 Europe/Madrid, OPTIMIZER_SCHEDULE_ENABLED=false por defecto) que solo encola el mismo run que el manual; una vez por ventana persistido en el propio run (created_by='optimizer-schedule'), margen de recuperación 12 h, cambio de hora testeado; audit optimizer.scheduled_run; GET /optimizer/schedule. Decisión: un GATE_PASS/GATE_FAIL sin cerrar no bloquea la ventana siguiente.
- PM: fixtures del stub copiados a la imagen Docker; compose con las variables de catálogo, optimizador programado, archivado y MODEL_ROUTE_* (todas apagadas o vacías por defecto); runbook al día. Suite 979 tests, sin migraciones.
