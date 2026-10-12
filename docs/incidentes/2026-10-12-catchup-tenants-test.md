# Incidente 2026-10-12: catch-up del scheduler sobre tenants de test

Tras un fin de semana con la máquina apagada, el scheduler recuperó al arrancar los slots perdidos de **todos** los tenants de la base compartida, incluidos 1.418 tasks que las suites de integración de las tandas 10 a 15 habían dejado activas. El resultado fueron 485 ejecuciones de test con credenciales reales: 17,95 € de LLM y datos basura en el workspace de producción de Twenty. No se envió ningún correo (los agentes solo dejan borradores) y no se borró nada.

Este documento es un postmortem sin culpables: describe qué pasó, qué se hizo, por qué fue posible y qué cambia para que no se repita. El error de procedimiento de origen es del PM, que lanzó las suites contra la base compartida.

## Contenido

1. [Resumen](#resumen)
1. [Cronología](#cronología)
1. [Daño](#daño)
1. [Mitigación del mismo día](#mitigación-del-mismo-día)
1. [Causas raíz](#causas-raíz)
1. [Correcciones de raíz (tanda 16)](#correcciones-de-raíz-tanda-16)
1. [Qué habría hecho falta para que no pasara](#qué-habría-hecho-falta-para-que-no-pasara)
1. [Riesgos residuales y seguimiento](#riesgos-residuales-y-seguimiento)
1. [Apéndice: el webhook cacheado de Twenty](#apéndice-el-webhook-cacheado-de-twenty)
1. [Documentos relacionados](#documentos-relacionados)

## Resumen

| Aspecto | Valor |
|---|---|
| Fecha | Lunes 2026-10-12 |
| Duración de la ejecución no deseada | Unas 2 horas desde las 11:29 |
| Ejecuciones de test | 485 |
| Coste | 17,95 € de LLM (Gemini); el proyecto llevaba menos de 2 € acumulados |
| Datos afectados | 80 señales, 66 empresas y 104 hipótesis basura en Twenty |
| Datos que no se tocaron | 0 notas; la lista de supresión y el buzón quedaron intactos |
| Correos enviados | 0 |
| Estado actual | Contenido: 0 tasks de test activas. Correcciones de raíz en la tanda 16 |

## Cronología

Las horas de la mitigación son aproximadas (reconstruidas de la sesión del PM); las del daño salen de la base de datos.

| Cuándo | Qué ocurrió |
|---|---|
| Tandas 10 a 15 | El PM ejecuta las suites de integración contra la base compartida `agentos` (valor por defecto de `DATABASE_URL`). Cada suite crea tenants `it-*`, `e2e-*`, `ev-*` y `ar-*` con tasks activas y no las archiva. Se acumulan 1.418 `task_definitions` en estado `ACTIVE` |
| Viernes 2026-10-09 | Cierre de la tanda 15. Las tasks de test siguen activas en la base |
| Fin de semana (10 y 11 de octubre) | La máquina está apagada. El scheduler no dispara ningún slot |
| Lunes 2026-10-12, 11:29 | La máquina arranca y con ella el scheduler. Hace catch-up de los slots perdidos de todos los tenants, sin distinguir los de test de los de `publiexpe` |
| 11:29 a unas 13:30 | 485 ejecuciones de test con la clave real de Gemini y la API key del Twenty de producción. Escriben señales, empresas e hipótesis en el workspace único de Twenty |
| ~14:30 | El PM, al verificar el webhook de señales, detecta señales anómalas en Twenty y, al investigar, el gasto (de menos de 2 € acumulados a 17,95 €) |
| ~15:30 | El PM marca en Twenty, por API, 81 señales como `DISCARDED` y 106 hipótesis como `REJECTED`, con backoff por el rate-limit `429` |
| ~16:00 | El usuario archiva por SQL las 1.418 tasks de test (`enabled=false`, `status='ARCHIVED'`). Verificado después: 0 activas |
| Mismo día | Verificación: 0 tasks de test activas. Se diagnostica y repara además el webhook de señales ([apéndice](#apéndice-el-webhook-cacheado-de-twenty)) |

> **Nota:** la parada del scheduler no fue necesaria para contener el incidente: bastó con archivar las tasks. El scheduler descarta las inscripciones de tasks archivadas en su sincronización periódica.

## Daño

| Recurso | Cantidad | Estado actual |
|---|---|---|
| Coste de LLM (Gemini) | 17,95 € (unos 0,04 € por ejecución) | Gastado; no recuperable |
| Señales en Twenty | 80 | Marcadas `DISCARDED` (81 marcadas, [ver seguimiento](#riesgos-residuales-y-seguimiento)) |
| Hipótesis en Twenty | 104 | Marcadas `REJECTED` (106 marcadas, [ver seguimiento](#riesgos-residuales-y-seguimiento)) |
| Empresas en Twenty | 66 | Siguen en Twenty, identificables; decisión pendiente |
| Notas en Twenty | 0 | — |
| Lista de supresión | Sin cambios | — |
| Buzón (IONOS) | Sin cambios | — |
| Correos enviados | 0 | — |

Los registros basura se identifican por su campo `tenantId`: todo lo que no sea `publiexpe` es de test. Nada se ha borrado, por la regla de no borrado del proyecto.

El correo no estuvo en riesgo: el rol restringido de la API key de Twenty ([ADR-28](../LLD-0.3-estado-real.md#adr-28)) no tiene tools de envío, y los agentes solo dejan borradores que una persona envía.

## Mitigación del mismo día

1. **Contención.** Archivado por SQL de las 1.418 tasks de test. No se borró ninguna fila; solo se cambió `enabled=false` y `status='ARCHIVED'`. Se verificó que no quedaba ninguna activa.
1. **Datos en Twenty.** Las señales de test pasaron a `DISCARDED` y las hipótesis a `REJECTED` mediante la API de Twenty, que limita el ritmo con `429`: se aplicó backoff. Nada se borró.
1. **Comprobaciones.** Lista de supresión y buzón intactos; 0 notas creadas.

El resto del día se aprovechó para dejar operativos el webhook de señales y la cadena calificar → prospectar (verificada en vivo), y el scout del lunes en modo descubrimiento funcionó con una sola llamada al LLM: añadió Madrid Fusión 2027, HIP 2027, WOOE 2027, ENOMAQ 2027 y Gastronomic Forum BCN 2026.

## Causas raíz

Hicieron falta las tres a la vez. Quitar cualquiera habría evitado el incidente o reducido su alcance.

### 1. El scheduler ejecuta todos los tenants, sin allowlist

El scheduler registraba y recuperaba las tasks de cualquier tenant de la base. No había forma de decir «solo `publiexpe`». Una task de un tenant `it-*` era, para el scheduler, igual de legítima que `daily-event-prospecting`.

### 2. Las suites corrían contra la base compartida, sin guard

El valor por defecto de `DATABASE_URL` apunta a `agentos`, la misma base del scheduler en producción local. Nada impedía ejecutar `pnpm test:integration` contra ella. Además, `test/setup-env.ts` carga `runtime/agent-runtime/.env` y los tests de Twenty piden copiar allí la API key real, de modo que las suites y el runtime compartían credenciales reales.

El README del runtime decía que las suites «no borran datos» porque usan un tenant nuevo en cada ejecución. Era cierto, y por eso mismo cada ejecución dejaba tasks vivas que nadie archivaba.

### 3. Las lecturas de Twenty no filtraban por `tenantId`

Los objetos de Twenty llevan `tenantId`, pero las lecturas no lo usaban. Twenty es un workspace único: lo que escribía una ejecución de test lo veían como propio las ejecuciones reales. La basura entró así en los flujos reales en lugar de quedar aislada.

## Correcciones de raíz (tanda 16)

Dos ramas en paralelo, sin tocar el mismo código.

### `feat/scheduler-hardening`

| Variable o herramienta | Por defecto | Qué hace |
|---|---|---|
| `SCHEDULER_TENANTS` | `publiexpe` | Allowlist de tenants que el scheduler registra y recupera, separados por comas. `*` los admite todos y es solo para entornos de test |
| `CATCHUP_MAX_SLOTS` | `1` | Máximo de slots perdidos que se recuperan por task tras una parada |
| `CATCHUP_MAX_AGE_MS` | `172800000` (48 h) | Antigüedad máxima de un slot perdido para recuperarlo. Los más viejos se omiten |
| Cleanup por patrón de tenant | — | Archiva (nunca borra) las tasks de los tenants que casan con un patrón (`it-*`, `e2e-*`…). Admite `--dry-run`. Hermano de `pnpm cleanup:archive-test-agents` |
| Guard de BD en los tests | — | Los tests de integración se niegan a ejecutarse contra la base llamada `agentos`. `ALLOW_SHARED_TEST_DB=1` lo salta de forma explícita |

### `feat/twenty-tenant-filter`

- Toda lectura de un objeto con `tenantId` filtra por el tenant de la ejecución.
- Una actualización de un registro de otro tenant se rechaza.
- Los webhooks de Twenty descartan los records de otro tenant y responden `200` con `ignored`, sin reintentos.

Los detalles de uso están en el [runbook](../runbook-local.md#variables-del-runtime), y el comportamiento exacto en el [README del runtime](../../runtime/agent-runtime/README.md).

## Qué habría hecho falta para que no pasara

Cada candado, por sí solo, habría cortado la cadena en un punto distinto:

| Candado | Qué habría pasado con él | Efecto |
|---|---|---|
| Allowlist del scheduler (`SCHEDULER_TENANTS=publiexpe`) | Las 1.418 tasks seguirían en la base, pero el scheduler no las habría registrado ni recuperado | **Lo habría evitado.** 0 ejecuciones de test, 0 € |
| Guard de BD en las suites | Las suites habrían fallado contra `agentos`; las tasks de test habrían vivido en una base aparte que ningún scheduler lee | **Lo habría evitado.** Nunca habrían existido en la base del scheduler |
| Filtro de tenant en Twenty | Las ejecuciones de test habrían escrito igualmente, pero sus registros no se habrían leído en flujos reales y los updates cruzados habrían fallado | **Lo habría reducido.** Coste del LLM y registros basura igual; sin contaminación de los flujos de `publiexpe` |

Los topes de catch-up (`CATCHUP_MAX_SLOTS`, `CATCHUP_MAX_AGE_MS`) acotan el peor caso tras una parada larga, pero no habrían evitado este incidente por sí solos: ya se recuperaba un único slot por task, y casi todos los slots del domingo y del lunes estaban dentro de las 48 h.

Las correcciones son defensa en profundidad: el procedimiento correcto (base aislada para los tests) pasa a ser obligatorio por código y ya no depende de que alguien se acuerde.

## Riesgos residuales y seguimiento

- **Empresas de test en Twenty.** Las 66 siguen ahí. Decidir si se dejan identificadas por `tenantId` o se aplica una marca visible. No se borrarán.
- **Cifras que no cuadran.** Se marcaron 81 señales y 106 hipótesis, frente a las 80 y 104 contabilizadas en el recuento de daño. Conciliar el recuento contra el workspace.
- **Posible efecto en el feedback.** Marcar hipótesis como `REJECTED` por API puede haber disparado el webhook de feedback y haber registrado evaluaciones `HUMAN` de las hipótesis de test. Comprobar en la tabla `evaluations` que no hay filas de tenants de test que alimenten métricas o datasets, y filtrarlas con `tenantId`.
- **Tests de Twenty con credenciales reales.** `test/integration/twenty-tools.test.ts` sigue escribiendo registros `[TEST]` en el Twenty de producción cuando hay API key en el `.env`. Es intencionado y está acotado, pero conviene valorar una instancia de Twenty de pruebas.
- **Gasto.** Revisar el límite de gasto de la clave de Gemini para que un fallo así corte antes.

## Apéndice: el webhook cacheado de Twenty

Durante la recuperación se cambió por SQL el webhook de señales de Twenty y el cambio no tuvo efecto: el servidor de Twenty **cachea la lista de webhooks** y no la relee de la base de datos.

> **Importante:** si cambias un webhook directamente por SQL en la base de Twenty, reinicia `pxos-twenty` para que cargue la lista nueva. Los cambios hechos desde la interfaz o la API no lo necesitan.

```bash
cd deployments
docker compose restart pxos-twenty
```

Prefiere siempre la interfaz de Twenty o `pnpm register:webhook` (con `--dry-run` primero). Ver [Webhook de `commercialSignal` en Twenty](../runbook-local.md#webhook-de-commercialsignal-en-twenty).

## Documentos relacionados

- [Runbook de operación local](../runbook-local.md): variables del scheduler, [parada larga](../runbook-local.md#después-de-una-parada-larga) y [tests de integración](../runbook-local.md#tests-de-integración-base-aislada).
- [README del runtime](../../runtime/agent-runtime/README.md)
- [Roadmap](../ROADMAP.md), tanda 16.

## Efecto colateral de la propia mitigación (verificado)

Marcar las 106 hipótesis como `REJECTED` por API disparó el webhook de feedback de Twenty: se crearon **106 evaluaciones `HUMAN` bajo tenants de test**. Las métricas de `publiexpe` no se contaminaron (filtran por tenant), y las filas son append-only. El filtro de tenant en los webhooks de esta misma tanda descarta exactamente este caso (`200 ignored`), así que la mitigación de un incidente futuro ya no puede generar este ruido. Las cifras 81/106 frente a 80/104 del recuento inicial se deben a registros creados entre el recuento y el marcado.
