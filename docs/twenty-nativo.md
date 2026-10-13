# Twenty nativo: qué vive en cada pestaña y por qué

Hasta la tanda 18, casi todo lo que el sistema dejaba en Twenty vivía en los objetos propios de la App (Signals, Research, Hypotheses, Agent runs) o en notas sueltas. Las pestañas nativas de Twenty (Personas, Oportunidades, Tareas) estaban vacías, aunque el ContactFinder ya encontraba nombres y cargos, y las alertas que piden una acción se perdían entre las notas. La tanda 19 corrige eso: **cada cosa vive donde Twenty ya sabe tratarla**.

Este documento es el mapa: qué aparece en cada pestaña, quién lo escribe, cuándo y por qué. Lo que ve y hace el comercial está en la [guía del equipo comercial](guia-comercial.md); la operación (sincronizar las vistas) está en el [runbook](runbook-local.md#sincronizar-las-vistas-de-fábrica).

> **Nota:** este documento describe la especificación de la tanda 19. Los nombres exactos de endpoints, campos y vistas son los del código y del [README del runtime](../runtime/agent-runtime/README.md) y de la [App](../apps/twenty-app/README.md); si alguno difiere, manda el README. Los puntos marcados `[POR VERIFICAR]` dependen de la implementación final.

## Contenido

1. [El principio](#el-principio)
1. [Empresas](#empresas)
1. [Personas](#personas)
1. [Oportunidades](#oportunidades)
1. [Tareas](#tareas)
1. [Notas](#notas)
1. [Tableros: las vistas de fábrica](#tableros-las-vistas-de-fábrica)
1. [Evento del sistema, qué aparece en Twenty](#evento-del-sistema-qué-aparece-en-twenty)
1. [Límites conocidos](#límites-conocidos)
1. [Qué se descartó y por qué](#qué-se-descartó-y-por-qué)
1. [Documentos relacionados](#documentos-relacionados)

## El principio

**Twenty es el system of record** ([principio P1 del LLD](LLD-0.1-publiexpe-commercial-os.md)): lo que es una empresa, una persona, un trato abierto o algo que alguien tiene que hacer se guarda en los objetos nativos de Twenty, con sus vistas, sus tableros kanban, su historial de correos y sus permisos. Reinventarlo en objetos propios sería mantener una copia peor.

**Lo custom queda para lo que Twenty no tiene:**

| Objeto de la App | Por qué es propio |
|---|---|
| **Signals** | Un hecho que justifica un contacto (una feria) con su ciclo de cualificación. Twenty no tiene el concepto. |
| **Research** | Hechos observados con su fuente, de apoyo a una decisión. Es información, no una acción. |
| **Hypotheses** | La capa de inteligencia: qué vender, a quién y por qué ahora, con su feedback humano. No es un trato todavía. |
| **Agent runs** | El registro de lo que hizo el sistema y cuánto costó. Solo lectura. |
| Ciclo de skills, datasets, experimentos | Viven en el Agent OS, fuera de Twenty ([P6](LLD-0.1-publiexpe-commercial-os.md)). |

Y esta es la regla de reparto, de una frase:

| Si es... | Vive en... |
|---|---|
| Una cuenta | **Empresas** |
| Una persona con nombre y cargo | **Personas** |
| Un trato con tracción real | **Oportunidades** |
| Algo que te toca hacer, con fecha | **Tareas** |
| Un registro que se conserva y se consulta (la lista de supresión, el contexto) | **Notas** |
| Una idea del sistema pendiente de tu decisión | **Hypotheses** (y Signals) |

## Empresas

Sin cambios. El Prospector localiza o crea la empresa antes de registrar su señal y su hipótesis; el ContactFinder y el triaje la usan como ancla. Desde su ficha ves todo lo demás relacionado: señales, hipótesis, personas, oportunidades, tareas y notas.

## Personas

**Qué entra.** El ContactFinder ([contactos.md](contactos.md#la-person-nativa)) hace *upsert* de una **Person** cuando la web de la empresa publica una persona con **nombre** (y, normalmente, cargo):

| Campo | Valor |
|---|---|
| Nombre | El que publica la web |
| Email | El de la persona, publicado en el dominio de la empresa |
| Cargo (`jobTitle`) | El que asocia la web a esa persona |
| Empresa | Enlazada a la empresa de la hipótesis |

Reglas:

- **Dedupe por email.** Si ya existe una Person con esa dirección (porque la creaste tú o la creó una pasada anterior), se reutiliza; no se duplica.
- **Los buzones genéricos y de función no crean Person.** `info@`, `comercial@`, `ventas@`, `contacto@`... pertenecen a un departamento, no a una persona. Siguen yendo a **Email to** y al Research, como hasta ahora.
- El Research «Contacto — empresa» **referencia el `personId`**, de modo que desde el Research llegas a la ficha de la persona.

**Para qué sirve (el beneficio clave).** Twenty asocia los correos por dirección: si la persona está en Personas, los correos intercambiados con esa dirección cuelgan de su ficha como timeline de conversación. Es el historial que antes hacía falta reconstruir a mano.

> **Importante:** el timeline solo se llena si el buzón conectado a Twenty **sincroniza mensajes**, no solo envía. Hasta la tanda 18 el buzón de `jesus.abril@publiexpe.info` estaba conectado para enviar ([twenty-envio-email.md](twenty-envio-email.md)). `[POR VERIFICAR]` que la sincronización de mensajes está activa; si no lo está, Personas existe igualmente pero la ficha no mostrará correos hasta activarla.

**Quién más escribe.** El [triaje del inbound](inbound-triaje.md#clases-y-acciones) crea la Person del remitente cuando contesta un interesado y la deja como punto de contacto de la oportunidad.

## Oportunidades

**Qué es una Oportunidad aquí.** Un trato con **tracción real**: alguien ha contestado con interés o tú has decidido trabajarlo. No es una hipótesis con otro nombre.

### Por qué NO se vuelcan las hipótesis

Una hipótesis es una predicción del sistema; la mayoría no pasa de `Proposed` y muchas se rechazan. Si cada hipótesis fuese una Oportunidad:

- El kanban se llenaría de decenas de tarjetas en la primera columna que nadie ha pedido, y el pipeline dejaría de ser una vista fiable del negocio real.
- Las cifras de pipeline (importe, número de tratos) mezclarían estimaciones del modelo con tratos reales.
- Habría dos fuentes de verdad para el mismo estado: el de la hipótesis y el de la oportunidad.

Por eso **la hipótesis sigue siendo la capa de inteligencia** (con su feedback y su ciclo de mejora) y **la Oportunidad se crea solo por promoción**.

### Las dos vías de promoción

| Vía | Cuándo | Qué crea |
|---|---|---|
| **Automática: respuesta `INTERESADO`** | El [triaje del inbound](inbound-triaje.md#clases-y-acciones) clasifica una respuesta como interesada | La Oportunidad de la empresa, con la **Person del remitente** como punto de contacto, y una **Task 📬 «Responder a…»** con fecha |
| **Manual** | Tú decides que una hipótesis merece pipeline sin esperar respuesta | `POST /opportunities/promote` con `{hypothesis_id}`. Queda en el `audit_log` |

Reglas comunes:

- **Idempotente por empresa con oportunidad abierta.** Si la empresa ya tiene una Oportunidad abierta, no se crea otra: se reutiliza (en el caso automático, la Task de responder sí se crea).
- **Evento `opportunity.created`** en el bus, para suscribirse desde n8n ([integración](n8n-integracion.md#salida-recibir-eventos-del-runtime)).
- **El sistema no mueve etapas.** Crea la oportunidad y nada más; el avance por el pipeline es tuyo.
- **La hipótesis no cambia de estado sola.** Un `INTERESADO` no la pasa a `Validated`.

El funnel de venta vive en el **kanban nativo de Oportunidades**, con las etapas estándar de Twenty. `[POR VERIFICAR]` etapa inicial de la oportunidad creada y cómo se enlaza con la hipótesis de origen.

## Tareas

**Tu bandeja de trabajo.** Las alertas que exigen una acción dejan de ser notas: pasan a ser **Tasks** con fecha, que ves en un kanban (*To do*, *In progress*, *Done*) y marcas como hechas. Una nota se queda en la ficha; una tarea se te pone delante y se cierra.

| Task | Qué la genera | Fecha | Qué haces |
|---|---|---|---|
| **📬 Responder a…** | Respuesta `INTERESADO` (y `PREGUNTA`, `[POR VERIFICAR]`) del triaje | `[POR VERIFICAR]` | Responder desde tu correo |
| **⚠️ Revalidación fallida** | Una revalidación `REFUTED` de una skill activa o en canario ([detalle](skill-optimizer.md#revalidación-de-un-pass_form)) | +1 día | Revisar los casos y decidir: rollback, `force` o esperar |
| **Propuesta de promoción** | Una optimización termina en `GATE_PASS` ([detalle](skill-optimizer.md#revisar-una-propuesta-de-promoción-en-twenty)) | +3 días | Revisar la propuesta y decidir si se activa |
| **⏳ Fuera de ventana / sin fecha** | Calificas una señal cuya feria queda fuera de la [ventana de lead time](prospeccion-por-senales.md#ventana-de-lead-time) o no tiene fecha | `[POR VERIFICAR]` | Nada urgente; descartar la señal si no la quieres pendiente |
| **⚠️ Catálogo no disponible** | El catálogo no responde ([detalle](catalog-service.md)) | `[POR VERIFICAR]`; **máximo una al día** | Avisar al operador si persiste |

Principios:

- **Una tarea por causa, no por intento.** La de catálogo se limita a una al día aunque el catálogo falle en varias ejecuciones.
- **Las tareas son tuyas.** Cerrarlas es tu gesto; el sistema no las cierra ni las borra.
- **Se enlazan a su origen** (la empresa, la señal, la skill) para que abras la ficha desde la tarea. `[POR VERIFICAR]` a qué objeto se enlaza cada una.

## Notas

Una nota es un registro que se conserva y se consulta, no un aviso con fecha. Lo que **sigue** siendo nota:

| Nota | Por qué sigue siéndolo |
|---|---|
| **`Lista de supresión — NO contactar`** | Es un libro **append-only** con valor de auditoría: solo se añaden líneas, nunca se editan ni se borran. Una Task, que se cierra, no sirve para eso ([bajas](email-warmup.md#gestión-de-bajas-y-lista-de-supresión)) |
| **📬 Respuesta recibida** | Contexto informativo: el extracto saneado del mensaje y su clasificación. La acción pendiente es la Task |
| **⚠️ Rebote** | Aviso informativo de dirección inexistente. No está entre las alertas que pasan a Task `[POR VERIFICAR]` |
| **Research** | Los hechos observados y los contactos con su fuente viven en **Research**, no en notas |

Lo que **deja** de ser nota: las cuatro alertas de la tabla de [Tareas](#tareas) (revalidación fallida, propuesta de promoción, fuera de ventana o sin fecha, catálogo no disponible).

**La nota-borrador de la empresa** («Borrador email — …») se retira si el workflow de envío no la usa: lo que envía Twenty son los campos **Email to**, **Email subject** y **Email body** de la hipótesis, y la nota era una copia de referencia. La retirada se confirma contra el workflow antes de aplicarla (`[POR VERIFICAR]`, lo comprueba el agente de la rama).

> **Nota:** «retirar» significa dejar de crear notas nuevas. Las notas existentes no se borran.

## Tableros: las vistas de fábrica

La App declara cuatro vistas que cubren el trabajo diario. Existen tras [sincronizar la App](runbook-local.md#sincronizar-las-vistas-de-fábrica):

| Vista | Objeto | Formato | Para qué |
|---|---|---|---|
| **Señales · Cola** | Signals | Kanban por estado (`New`, `Reviewing`, `Qualified`, `Discarded`, `Expired`) | Tu cola de decisión sobre las ferias |
| **Hipótesis · Por estado** | Hypotheses | Kanban por estado (`Proposed`, `Validated`, `Rejected`, `Expired`) | La revisión diaria de hipótesis |
| **Oportunidades · Pipeline** | Opportunities | Kanban por etapa | El funnel de venta |
| **Tareas · Bandeja** | Tasks | Kanban por estado | Todo lo que te toca hacer |

> **Nota:** la vista **By status** de Hypotheses ya existía; **Hipótesis · Por estado** la reemplaza o convive con ella (`[POR VERIFICAR]` en la App). La página nativa de métricas (*Agent OS*) no cambia, salvo que ahora muestra los **envíos del día** (antes mostraba 0 por un error de sincronización: ver el [runbook](runbook-local.md#problemas-frecuentes)).

## Evento del sistema, qué aparece en Twenty

| Evento del sistema | Qué aparece en Twenty | Dónde |
|---|---|---|
| El scout descubre una feria (lunes 07:30) | Una **señal** `New` con fecha y fuente | Señales · Cola |
| Calificas una feria dentro de ventana | Empresas (alta o reutilizadas), una señal por expositor y una **hipótesis** `Proposed` por cada uno; un resumen de ejecución | Signals, Hypotheses, Agent runs |
| Calificas una feria fuera de ventana, o sin fecha | Una **Task ⏳** con fecha; la señal sigue `Qualified` | Tareas · Bandeja |
| La fecha de una feria pasa | La señal pasa a `Expired`; las hipótesis `Proposed` de ferias a menos de 45 días pasan a `Expired` | Signals, Hypotheses |
| Validas una hipótesis | Búsqueda de contacto: **Person** (si la web publica una persona con nombre), **Email to** (si estaba vacío), Research «Contacto — empresa» o «Sin contacto público», y borrador en los campos de la hipótesis | Personas, Hypotheses, Research |
| Pulsas *Enviar borrador de email* | **Email status** pasa a `Sent`; el correo cuelga de la ficha de la Person si el buzón sincroniza | Hypotheses, Personas |
| Un cliente responde `INTERESADO` | **Person** del remitente, **Oportunidad** de la empresa (con la Person de contacto) y **Task 📬 «Responder a…»**; nota 📬 con el extracto | Personas, Oportunidades · Pipeline, Tareas · Bandeja, Notas |
| Un cliente responde con una `PREGUNTA` | Nota 📬 y **Task 📬 «Responder a…»** `[POR VERIFICAR]`, sin oportunidad | Notas, Tareas · Bandeja |
| Un cliente pide la baja o responde `NO_INTERESADO` | Una línea nueva en la nota `Lista de supresión — NO contactar` | Notas |
| Rebote duro | Nota ⚠️ con la dirección que no existe | Notas |
| Decides promocionar una hipótesis (`POST /opportunities/promote`) | **Oportunidad** (idempotente por empresa abierta) y evento `opportunity.created`; queda en el `audit_log` | Oportunidades · Pipeline |
| Una revalidación da `REFUTED` | **Task ⚠️ Revalidación fallida**, +1 día | Tareas · Bandeja |
| Una optimización llega a `GATE_PASS` | **Task «Propuesta de promoción»**, +3 días | Tareas · Bandeja |
| El catálogo no está disponible | **Task ⚠️** (máximo una al día) y evento `catalog.unavailable` | Tareas · Bandeja |
| Cada ejecución de una tarea del Agent OS | Un resumen con resultado y coste | Agent runs |
| Cada día, sincronización de métricas | El registro diario, con los **envíos del día**, que alimenta la página de métricas | Página de métricas |

## Límites conocidos

- **Person, Opportunity y Task son objetos estándar de Twenty y no llevan `tenantId`.** A diferencia de los objetos de la App, no se pueden filtrar por tenant ([tanda 16](incidentes/2026-10-12-catchup-tenants-test.md)). El aislamiento es por convención: **solo el tenant `publiexpe` escribe en ellos**. Mientras haya un único tenant productivo no es un problema; antes de tener un segundo hay que resolverlo.
- **El sistema nunca borra.** Ni personas ni oportunidades ni tareas. Una oportunidad creada por error se cierra (etapa final), no se elimina.
- **El rol de la API key del runtime** («Agent runtime», sin tools) debe permitir lectura y escritura sobre Person, Opportunity y Task. `[POR VERIFICAR]` tras sincronizar la App ([runbook](runbook-local.md#rol-de-la-api-key-de-twenty)).
- **Las vistas dependen del sync de la App**, que lo ejecuta una persona con una API key de rol Admin temporal. Sin él, las vistas de fábrica no existen y la información sigue llegando igual.

## Qué se descartó y por qué

- **Controlar las tareas de los agentes desde Twenty** (lanzar, pausar o editar tasks del Agent OS desde la interfaz de Twenty). Descartado por ahora por decisión del usuario: el plano de control del Agent OS sigue en su API y en el runbook. Queda en los [futuribles del roadmap](ROADMAP.md#ruta-propuesta-tandas-siguientes).
- **Volcar todas las hipótesis como Oportunidades**: ver [arriba](#por-qué-no-se-vuelcan-las-hipótesis).
- **Sustituir Signals, Research o Hypotheses por objetos nativos**: Twenty no tiene un equivalente y el feedback humano y el ciclo de mejora dependen de ellos.

## Documentos relacionados

- [Guía del equipo comercial](guia-comercial.md): tu rutina con Tareas, Personas y Oportunidades.
- [Búsqueda de contactos](contactos.md#la-person-nativa): cómo se crea la Person.
- [Triaje del inbound](inbound-triaje.md): Person, Oportunidad y Task ante una respuesta.
- [Runbook de operación local](runbook-local.md#sincronizar-las-vistas-de-fábrica): sincronizar las vistas.
- [Estudio del dashboard en Twenty](estudio-dashboard-twenty.md): la página de métricas.
- [Roadmap](ROADMAP.md): lugar de la tanda 19 en el plan.
