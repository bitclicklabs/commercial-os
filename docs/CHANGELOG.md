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
