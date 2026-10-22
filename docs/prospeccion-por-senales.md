# Prospección guiada por señales: el ciclo completo

Hasta la tanda 14, la tarea diaria de las 08:00 evaluaba siempre la misma lista de expositores incrustada en el seed (una feria de ejemplo con dominios `.example`) y nunca buscaba nada nuevo. Las ferias reales se prospectaban a mano. Desde la tanda 15, **la prospección la guían las señales de feria** y el comercial es quien cualifica: la máquina descubre, tú decides qué merece trabajo, y la máquina trabaja solo lo que has calificado.

Este documento es técnico-operativo: describe el ciclo, cómo decide cada pieza y cómo se configura. Lo que ve y hace el comercial está en la [guía del equipo comercial](guia-comercial.md#señales-de-feria-tu-cola-de-decisión).

> **Nota:** este documento describe la especificación de las tandas 15 (el ciclo), 18 (la [ventana de lead time](#ventana-de-lead-time)), 20 (el [Resolver de Dominios](resolver-dominios.md)) y 21 (los [caladeros](#caladeros-el-scout-cubre-varios-sectores) y las [señales de empresa](#señales-de-empresa-más-allá-de-las-ferias)). Los nombres exactos de tareas, eventos y variables son los del código y del [README del runtime](../runtime/agent-runtime/README.md); si alguno difiere, manda el README. Lo que depende de la implementación de la tanda 21 va marcado `[POR CONFIRMAR]`.

## Contenido

1. [El ciclo en una imagen](#el-ciclo-en-una-imagen)
1. [Estados de la señal y quién los cambia](#estados-de-la-señal-y-quién-los-cambia)
1. [Descubrir: el scout semanal](#descubrir-el-scout-semanal)
1. [Caladeros: el scout cubre varios sectores](#caladeros-el-scout-cubre-varios-sectores)
1. [Señales de empresa: más allá de las ferias](#señales-de-empresa-más-allá-de-las-ferias)
1. [Prospección directa de una empresa](#prospección-directa-de-una-empresa)
1. [Prospectar a diario, en modo señales](#prospectar-a-diario-en-modo-señales)
1. [Prospectar al calificar: el trigger inmediato](#prospectar-al-calificar-el-trigger-inmediato)
1. [Envejecimiento: señales que pasan a `EXPIRED`](#envejecimiento-señales-que-pasan-a-expired)
1. [Ventana de lead time](#ventana-de-lead-time)
1. [Configurar el webhook de `commercialSignal` en Twenty](#configurar-el-webhook-de-commercialsignal-en-twenty)
1. [Comprobar que funciona](#comprobar-que-funciona)
1. [Limitaciones](#limitaciones)
1. [Qué no hace](#qué-no-hace)
1. [Documentos relacionados](#documentos-relacionados)

## El ciclo en una imagen

```mermaid
flowchart TD
    scout["Scout semanal<br/>lunes 07:30"] -->|"una señal por feria dentro<br/>de ventana (o sin fecha)"| new["Señal NEW"]
    new -->|"el comercial la revisa"| rev["REVIEWING<br/>(opcional)"]
    new --> dec{"Decisión del comercial"}
    rev --> dec
    dec -->|"descartar"| disc["DISCARDED<br/>nadie la toca"]
    dec -->|"calificar"| qual["QUALIFIED"]
    qual -->|"webhook de Twenty<br/>(inmediato)"| win1{"Lead time<br/>45-210 días"}
    qual -->|"cada día 08:00<br/>round-robin"| win2{"Lead time<br/>45-210 días"}
    win1 -->|"en ventana"| trig["Trigger: prospect-on-qualified<br/>evento signal.qualified"]
    win1 -->|"fuera de ventana"| note["Nota ⏳ en Twenty<br/>la señal sigue QUALIFIED"]
    win2 -->|"en ventana"| daily["Tarea diaria<br/>daily-event-prospecting v2"]
    win2 -->|"too_close / too_far"| wait["No se reparte hoy<br/>(entra sola al cumplir ventana)"]
    trig --> out["Empresas, señales de expositor<br/>e hipótesis PROPOSED en Twenty"]
    daily --> out
    out --> hum["El comercial valida o rechaza<br/>las hipótesis"]
    qual -->|"fecha de la feria pasada<br/>(único cambio de estado de<br/>señal que hace la máquina)"| exp["EXPIRED"]
    new -->|"fecha pasada"| exp
    rev -->|"fecha pasada"| exp
```

Tres ideas sostienen el diseño:

- **El humano cualifica.** La máquina nunca decide que una feria merece trabajo. Calificar una señal es el único gesto que activa la prospección de esa feria.
- **Dos caminos hacia el mismo trabajo.** Al calificar, el trigger prospecta esa feria *al momento*. Además, la tarea diaria de las 08:00 reparte su presupuesto entre todas las señales `QUALIFIED` vigentes, así que una feria calificada sigue recibiendo trabajo los días siguientes.
- **Solo se trabaja lo que da tiempo a vender.** Una feria calificada solo recibe trabajo si su fecha cae dentro de la [ventana de lead time](#ventana-de-lead-time).
- **Sin señales calificadas en ventana no se gasta nada.** El run diario termina `SKIPPED` a coste 0.

## Estados de la señal y quién los cambia

| Estado | Significado | Quién lo pone |
|---|---|---|
| `NEW` | Feria descubierta, sin decidir. | El scout, al crearla |
| `REVIEWING` | El comercial la está mirando. Opcional. No dispara nada. | El comercial |
| `QUALIFIED` | Trabájala: se prospecta ya y entra en el reparto diario. | El comercial |
| `DISCARDED` | Ya no. No se prospecta ni se vuelve a mirar. | El comercial |
| `EXPIRED` | La fecha de la feria ya pasó. | **La máquina** (envejecimiento) |

`EXPIRED` es la **única escritura de estado de una señal que hace la máquina**. Nunca califica ni descarta.

**Señal de feria frente a señal de expositor.** El ciclo trabaja con señales a **nivel de evento**: una feria o un congreso, **sin empresa asociada**. Las señales por expositor (las que lleva una empresa y se titulan «feria — empresa», como las que el scout creó hasta la tanda 14) no disparan nada, ni al cambiar de estado ni en el reparto diario, y el comercial no tiene que gestionarlas.

> **Nota (tanda 21):** las [señales de empresa](#señales-de-empresa-más-allá-de-las-ferias) (apertura, ronda de financiación y aniversario) son una excepción a esa regla: llevan una empresa asociada **y sí** disparan la prospección al calificarlas. El sistema las distingue por el sufijo de tipo del nombre (y el evento `signal.qualified` lleva `signal_kind`); las señales por expositor y las de feria con `companyId` siguen sin disparar nada jamás.

## Descubrir: el scout semanal

La tarea `weekly-event-scouting` (lunes 07:30, `Europe/Madrid`) sigue buscando ferias reales del sector con grounding de Google Search. Lo que cambia en la tanda 15 es el resultado de lo que encuentra: **una señal de feria en estado `NEW` por cada feria descubierta**, con su fecha y su fuente, a la espera de que el comercial decida. Detalles del scout en [ADR-10](LLD-0.3-estado-real.md#adr-10) y [ADR-26](LLD-0.3-estado-real.md#adr-26).

Desde la tanda 18, el scout **no crea señales de ferias fuera de la [ventana de lead time](#ventana-de-lead-time)**: cuenta las que descarta en el output del run. Una feria sin fecha se crea igual.

Cada lunes, por tanto, el scout deja de ser el único camino de material nuevo: alimenta la cola de decisión, y el trabajo sobre cada feria lo desencadena la calificación, no el calendario.

## Caladeros: el scout cubre varios sectores

Hasta la tanda 20, el scout semanal buscaba ferias de un solo sector: «alimentación y bebidas». Desde la tanda 21 **recorre una lista de sectores («caladeros»)**, configurable en el input de la task del seed (`weekly-event-scouting`).

### Los sectores

| Sector | Qué busca |
|---|---|
| Alimentación y bebidas | Ferias de producto alimentario y de bebidas (el caladero de siempre) |
| Horeca y food service | Hostelería, restauración y servicios de alimentación |
| Farmacia y salud | Ferias de farmacia, parafarmacia y salud |
| Cosmética y belleza | Ferias de perfumería, cosmética y belleza |
| Franquicias y retail | Ferias de franquicias, comercio y retail |
| Industria y packaging | Ferias de industria, envase y embalaje |

### Qué se mantiene igual en todos

- **Solo España**, como hasta ahora.
- **Modo `discover_only`**: el scout busca con grounding de Google Search y verifica una página de cada feria, pero no peina expositores. El gasto grande llega tras la calificación humana.
- **La misma [ventana de lead time](#ventana-de-lead-time)** (45 a 210 días): no se crean señales de ferias fuera de ella, y el output las cuenta.
- **El humano califica.** Cada feria nueva entra como señal `NEW` y espera tu decisión.

### Qué cambia

- **Deduplicación entre sectores.** Una misma feria puede aparecer en dos caladeros (una feria de alimentación y retail, por ejemplo): se crea **una sola señal**. El criterio de duplicado es la URL de la feria o el par nombre y fecha; las noticias de empresa deduplican por la URL exacta del artículo.
- **Contadores por sector.** El output del run informa, por cada sector, de las ferias encontradas, las creadas, las descartadas por ventana y las duplicadas. Los campos van en `output.sectors[]`: ferias propuestas/verificadas/creadas/existentes/fuera de ventana/duplicadas en otro sector, señales de empresa propuestas/creadas/existentes/descartadas y `cost_eur`.
- **Coste.** Aproximadamente **0,07 € por sector y semana**: con los seis sectores, unos 0,42 € a la semana. El coste de cada run aparece en el campo **Cost** del *Agent run*.
- **Tiempo.** El scout mantiene su límite de 20 minutos por ejecución. Si un sector no cabe, el run sale `Partial` y lo ya hecho se guarda. Los sectores corren en serie; los que no caben salen como `skipped_time_budget` y el orden de inicio rota cada lunes, así ninguno se muere siempre al final.

### Cómo cambiar la lista

La lista vive en la task del seed, no en una variable de entorno. Para añadir o quitar un sector:

1. Edita la lista de sectores en el input de `weekly-event-scouting` del seed (`runtime/agent-runtime/src/seed/prospector-seed.ts`). El campo es `sectors` (lista); `sector` sigue valiendo como alternativa si falta.
1. Ejecuta `pnpm seed` desde `runtime/agent-runtime/`. El seed añade una **versión nueva** de la task; la anterior no se borra.
1. Comprueba en el siguiente run del lunes que el output trae el contador del sector nuevo.

> **Nota:** quitar un sector del seed no borra las señales que ya creó. Descártalas tú si no las quieres.

## Señales de empresa: más allá de las ferias

Una feria no es la única razón para escribir a una empresa. Desde la tanda 21, el scout también descubre **señales de empresa**: noticias que dicen que una empresa concreta está en un momento en que el merchandising encaja.

| Tipo | Qué es | Por qué importa |
|---|---|---|
| **Apertura** | Una empresa abre un local, una fábrica o una sede, o lo va a hacer | Una apertura necesita regalo de inauguración, uniformes y material de marca |
| **Ronda de financiación** | Una empresa anuncia que ha cerrado una ronda | Con caja nueva y un equipo que crece hay presupuesto de marca |
| **Aniversario** | Una empresa cumple un aniversario redondo | Los aniversarios piden regalo corporativo y piezas conmemorativas |

### Reglas de frescura y de verificación

- **Solo noticias recientes.** La noticia debe ser de los **últimos 60 días**. La excepción es la **apertura futura**: una apertura anunciada para una fecha por venir también vale.
- **Fuente verificada.** La señal solo se crea si el scout ha descargado (`fetch_url`) la URL de la noticia y ha comprobado que dice lo que se afirma. Sin fuente verificada, no hay señal.
- **Caducidad a los 120 días.** Una señal de empresa pasa sola a `EXPIRED` cuando han pasado **120 días desde la fecha de la noticia**, igual que una feria cuando pasa su fecha. Es el mismo envejecimiento diario ([más abajo](#envejecimiento-señales-que-pasan-a-expired)). Los 120 días cuentan desde la fecha de la noticia, también en una apertura futura.
- **La ventana de lead time no se aplica.** La ventana de 45 a 210 días mide la distancia a una feria; una empresa no tiene fecha de feria. Lo que acota la vida de la señal de empresa es su frescura y su caducidad.
- **El humano califica.** Como con las ferias, el sistema descubre y tú decides. Nada se prospecta hasta que calificas la señal.

### Cómo las reconoces

El nombre de cada señal de empresa lleva un **sufijo de tipo**: por ejemplo, «Conservas del Norte — apertura», «Conservas del Norte — financiación» o «Conservas del Norte — aniversario». El mecanismo de tipado es el sufijo del nombre (acepta variantes de guion y «financiacion» sin tilde); el campo `signalType` existente lleva además un valor orientativo para la persona (EXPANSION, OTHER, ANNIVERSARY) y el evento `signal.qualified` viaja con `signal_kind`. No hay cambios de esquema en la Twenty App.

> **Nota:** a diferencia de una señal de feria, que no tiene empresa asociada, la señal de empresa **sí la tiene**: es la empresa a la que luego se prospecta.

## Prospección directa de una empresa

Calificar una señal de empresa no peina ningún catálogo de expositores: **se prospecta directamente a esa empresa**.

```mermaid
flowchart TD
    q["El comercial califica una<br/>señal de empresa"] -->|"webhook de Twenty"| ev["Evento signal.qualified"]
    ev --> t["Task prospect-on-qualified<br/>modo empresa"]
    t --> dom{"¿La noticia trae la web<br/>de la empresa?"}
    dom -->|"sí"| ev2["Evaluar la empresa<br/>con el motivo de la señal"]
    dom -->|"no"| res["Resolver de Dominios<br/>(búsqueda + verificación de portada)"]
    res -->|"domain_resolved"| ev2
    res -->|"domain_ambiguous o<br/>domain_not_found"| stop["Sin hipótesis: no se adivina"]
    ev2 --> out["Empresa y hipótesis PROPOSED<br/>en Twenty"]
    out --> hum["El comercial valida o rechaza"]
```

Qué hace el trigger, en orden:

1. **Recoge la señal calificada**: la empresa, el tipo de señal y la URL de la noticia.
1. **Obtiene el dominio de la empresa.** Si la noticia trae su web, la usa. Si no, **recurre al [Resolver de Dominios](resolver-dominios.md)**, con las mismas garantías de siempre: verifica la portada y, en caso de duda o empate, no resuelve.
1. **Evalúa la empresa con el motivo de la señal** (la apertura, la ronda o el aniversario) en lugar de un expositor de feria.
1. **Escribe en Twenty** la empresa (localizada o creada, con su web verificada) y una hipótesis `PROPOSED` enlazada a la señal. Deja el resumen de la ejecución (*Agent run*).
1. **Deja la auditoría** del disparo. Reutiliza `prospect.on_qualified`.

Lo que **no** cambia:

- **El humano valida.** La hipótesis nace `PROPOSED`; sin tu validación no hay contacto ni borrador.
- **Una vez por señal** en la ventana de 24 h, como con las ferias ([idempotencia](#idempotencia-y-ventana-de-recalificación-de-24-h)).
- **Nada se envía solo.**

Las señales de empresa `QUALIFIED` entran también en el reparto diario, pero si ya tienen hipótesis `PROPOSED` o `VALIDATED` salen como `skipped_existing` a coste 0 (no gastan el turno de una feria). Sus hipótesis `PROPOSED` caducan cuando caduca la señal (120 días), nunca por la ventana de lead time.

## Prospectar a diario, en modo señales

La tarea `daily-event-prospecting` pasa a su **versión 2**. La versión anterior (con la feria de ejemplo del seed como entrada) no se borra: queda como versión histórica de la tarea, y la v2 ya no la lleva.

### Qué hace el run de las 08:00

1. **Lee las señales de feria** de Twenty (herramienta `list_event_signals`, solo señales sin empresa) y se queda con las `QUALIFIED` vigentes (fecha de la feria no pasada) **y dentro de la [ventana de lead time](#ventana-de-lead-time)**. Las `QUALIFIED` fuera de ventana se listan en el output como `too_close` o `too_far`, con sus días, y no entran en el reparto.
1. **Aplica el envejecimiento** (herramienta `expire_signal`; ver [más abajo](#envejecimiento-señales-que-pasan-a-expired)) y la [auto-expiración de hipótesis](#auto-expiración-de-hipótesis-proposed).
1. **Si no hay ninguna señal calificada vigente y en ventana, termina con `outcome` `SKIPPED`** y coste 0: no llama a ningún modelo.
1. **Reparte el presupuesto entre las señales**, por turnos (*round-robin*), empezando por **la señal menos trabajada**: la que lleva más tiempo sin recibir una pasada de prospección, o ninguna. Cada turno prospecta una feria; el reparto sigue hasta agotar el presupuesto del run.
1. **Escribe en Twenty** lo de siempre (empresa, señal de expositor, hipótesis `PROPOSED`) y deja el resumen de la ejecución (*Agent run*).

El presupuesto del run es el que ya limitaba la prospección (tiempo y número de expositores por ejecución): lo que cambia es que ahora se reparte entre varias ferias en lugar de gastarse sobre una sola.

### Por qué round-robin por la menos trabajada

Con una sola feria calificada, el comportamiento es el de siempre sobre esa feria. Con varias, evita que la primera de la lista consuma todo el presupuesto: cada día avanza la que va más atrasada, y ninguna se queda sin atender mientras haya otra que sí lo recibe.

### Expositores sin web: ya no se descartan a la primera

Los catálogos de las ferias suelen listar a los expositores por nombre, sin enlace a su web. Hasta la tanda 19, un expositor sin dominio acababa como `skipped_no_domain` en el primer pase (el caso del 2026-10-16: unos 110 bloqueados entre Anuga, Madrid Fusión y BWW). Desde la tanda 20, el Prospector **intenta resolver su web oficial antes de descartarlo**: busca el nombre, comprueba que la portada candidata corrobora la marca y descarta redes sociales, marketplaces y directorios. Si hay duda o empate, no resuelve (`domain_ambiguous`); si no hay web real, `domain_not_found`.

Un dominio resuelto devuelve al expositor a la evaluación normal: solo si resulta relevante se crea la empresa en Twenty, y siempre como hipótesis `PROPOSED` para que la valides tú. La resolución tiene un tope de búsquedas por run (`DOMAIN_RESOLVER_MAX_PER_RUN`, 25 por defecto): lo que no cabe queda `skipped_no_domain` y entra en el siguiente turno del reparto. Detalle, reglas y límites en [Resolver de Dominios](resolver-dominios.md).

## Prospectar al calificar: el trigger inmediato

Esperar a las 08:00 del día siguiente no tiene sentido cuando el comercial acaba de decidir que una feria merece trabajo. Por eso calificar dispara la prospección de esa feria al momento.

```mermaid
sequenceDiagram
    participant C as Comercial
    participant T as Twenty
    participant R as Runtime (/webhooks/twenty)
    participant E as Event bus
    participant K as Task prospect-on-qualified
    C->>T: Status de la señal = Qualified
    T->>R: POST commercialSignal.updated (firmado)
    R->>R: Comprueba firma, estado destino,<br/>ventana de 24 h y ventana de lead time
    R->>E: Publica signal.qualified
    E->>K: Dispara la task EVENT
    K->>T: Empresas, señales de expositor e hipótesis PROPOSED
    K->>R: Auditoría prospect.on_qualified
```

Piezas:

| Pieza | Qué es |
|---|---|
| Webhook de Twenty | Un `POST` por cada cambio o alta de una señal (`commercialSignal.updated` y `commercialSignal.created`), firmado con `TWENTY_WEBHOOK_SECRET`. Lo recibe el mismo endpoint `POST /webhooks/twenty` del feedback de hipótesis; el runtime enruta por el nombre del objeto. |
| Evento `signal.qualified` | Lo publica el runtime en el [event bus](n8n-integracion.md) cuando una señal de feria pasa a `QUALIFIED` y la ventana lo permite. Sus datos son `signal_id`, `name`, `event_url`, `event_date` y `signal_type`. También lo recibe n8n si hay suscripciones. |
| Task `prospect-on-qualified` | Task de tipo `EVENT` que escucha `signal.qualified` y lanza un scout dirigido a esa feria (modo `event_url`, con la URL de la señal). |
| Auditoría | Cada disparo queda en el `audit_log` como `prospect.on_qualified` (`GET /audit`). |

### Qué dispara y qué no

| Cambio en Twenty | ¿Dispara? |
|---|---|
| Señal de feria (sin empresa) pasa a `QUALIFIED`, con la feria dentro de la ventana de lead time | Sí |
| Señal de feria pasa a `QUALIFIED` con la feria fuera de ventana | No: deja una [nota ⏳](#qué-pasa-al-calificar-fuera-de-ventana) y conserva el `QUALIFIED` |
| Pasa a `REVIEWING` o `DISCARDED` | No |
| Se edita otro campo estando ya en `QUALIFIED` | No: solo cuenta la transición de estado |
| Señal por expositor (con empresa) pasa a `QUALIFIED` | No |
| La máquina la pasa a `EXPIRED` | No |

### Idempotencia y ventana de recalificación de 24 h

- **Como máximo una vez por señal cada 24 h.** El disparo se deduplica por la señal: si Twenty reenvía el mismo webhook, o el comercial cambia el estado y vuelve a `QUALIFIED` dentro de la ventana, la feria no se prospecta dos veces.
- **Ventana de recalificación de 24 h.** Pasada la ventana, una recalificación deliberada sí puede volver a disparar.
- **No hay reintentos de Twenty.** Si el webhook se pierde, no hay disparo inmediato. No se pierde el trabajo: la señal sigue `QUALIFIED` y el run de las 08:00 la recoge en el reparto.

## Envejecimiento: señales que pasan a `EXPIRED`

Cada run diario, antes de repartir (herramienta `expire_signal`), revisa las señales de feria no cerradas (`NEW`, `REVIEWING` y `QUALIFIED`) y pasa a **`EXPIRED`** las que tienen la fecha de la feria **anterior a hoy**. Es la única escritura de estado que hace la máquina.

- **Solo señales de feria con fecha.** Una señal sin fecha no caduca sola.
- **Solo hacia `EXPIRED`.** Vuelve a leer el registro justo antes de escribir, no toca `DISCARDED` y nunca califica, descarta ni reabre nada.
- **No borra nada.** La señal queda en Twenty con su historial. Una señal `EXPIRED` sale del reparto diario y deja de aparecer en la cola de decisión.
- **Señales de empresa (tanda 21).** El mismo envejecimiento pasa a `EXPIRED` las [señales de empresa](#señales-de-empresa-más-allá-de-las-ferias) cuando han pasado **120 días desde la fecha de la noticia**. Sigue siendo la única escritura de estado de señal que hace la máquina. Lo hace la misma herramienta `expire_signal`, con una edad mínima de 120 días.

## Ventana de lead time

**Regla:** solo se trabaja una feria cuya fecha queda a entre 45 y 210 días de hoy, porque el merchandising necesita plazo para muestras, pruebas de marcaje y producción.

El 2026-10-12 el equipo comercial rechazó los seis primeros borradores listos para enviar, todos de expositores de una feria que se celebraba dos semanas después: con tan poco margen es imposible vender y producir un pedido, y las ferias que interesan son las del próximo trimestre. Esa decisión humana es la que codifica esta sección ([cómo se convirtió en regla](ciclo-mejora-skills.md#caso-canónico-el-rechazo-de-los-6-borradores-del-2026-10-12)).

### Las dos variables

| Variable | Defecto | Significado |
|---|---|---|
| `LEADTIME_MIN_DAYS` | `45` | Mínimo de días entre hoy y la feria. Con menos, la feria está demasiado cerca (`too_close`). |
| `LEADTIME_MAX_DAYS` | `210` | Máximo de días. Con más, la feria está demasiado lejos (`too_far`) y todavía no toca. |

Los días se cuentan en la zona horaria `Europe/Madrid`. Ambas variables se configuran como el resto del runtime ([lista](runbook-local.md#variables-del-runtime)).

### Qué pasa con una señal según los días

| Días hasta la feria | Etiqueta | Reparto diario (08:00) | Al calificar (trigger) | Scout de descubrimiento |
|---|---|---|---|---|
| De 45 a 210 | en ventana | Entra en el round-robin | Prospecta al momento | Crea la señal `NEW` |
| Menos de 45 | `too_close` | No entra; se lista con sus días | No prospecta: deja la [nota ⏳](#qué-pasa-al-calificar-fuera-de-ventana) | No crea la señal; suma al contador del output |
| Más de 210 | `too_far` | No entra; se lista con sus días | No prospecta: deja la nota ⏳ | No crea la señal; suma al contador del output |
| Sin fecha | — | Sin días que medir (ver nota) | Sin días que medir (ver nota) | Crea la señal igual |
| Fecha pasada | — | No entra; pasa a `EXPIRED` | No dispara | No crea la señal |

Una señal `QUALIFIED` fuera de ventana **conserva su estado**: no pasa a `EXPIRED` ni a `DISCARDED`. `EXPIRED` sigue reservado a las ferias cuya fecha ya pasó.

> **Nota:** una señal sin fecha no se puede medir contra la ventana. Si no quieres que una feria sin fecha consuma presupuesto, descártala o complétale la fecha.

### Qué pasa al calificar fuera de ventana

Cuando el comercial califica una señal de feria cuya fecha queda fuera de ventana, el trigger **no prospecta**. Deja en Twenty una **nota ⏳** con los días que faltan, la ventana vigente y qué ocurre a continuación. El estado `QUALIFIED` se conserva, así que:

- **Demasiado lejos (`too_far`):** la feria entra sola en el reparto diario el día en que su fecha entra en ventana (cuando quedan 210 días). No hay que volver a calificarla.
- **Demasiado cerca (`too_close`):** no se trabajará. La señal pasa a `EXPIRED` cuando la fecha pase, como cualquier otra.

La nota ⏳ es solo informativa: no es un fallo ni una orden pendiente.

### Auto-expiración de hipótesis (`PROPOSED`)

Las hipótesis `PROPOSED` de ferias que han quedado a menos de 45 días, o ya pasadas, no tienen sentido comercial. El run diario las pasa a **`EXPIRED`** antes de repartir.

- **Solo `PROPOSED`.** Una hipótesis `VALIDATED` no se auto-expira jamás: la aprobó una persona y solo otra persona la cambia.
- **Por vía de sistema, sin evaluación.** El cambio no crea ninguna evaluación `HUMAN`, y el webhook de Twenty deja de tratar `EXPIRED` como veredicto. Estas expiraciones no entran en la aceptación por versión, en los datasets ni en el Skill Optimizer: las métricas solo reflejan juicios del comercial.
- **No borra nada.** La hipótesis queda en Twenty con su historial.
- **Una feria lejana no expira nada.** Solo expiran las hipótesis por cercanía o por fecha pasada.

> **Importante:** para dar feedback que el sistema aprenda, usa `Validated` o `Rejected`. Un `EXPIRED` puesto a mano se guarda, pero ya no cuenta como veredicto.

## Configurar el webhook de `commercialSignal` en Twenty

El trigger necesita que Twenty avise al runtime cuando cambia una señal. Twenty no lo hace por defecto: hay que dar de alta el webhook **una vez**, a mano. Es una acción de configuración del operador (no la hace el runtime).

> **Importante:** es el **mismo webhook** del feedback de hipótesis (marca `pxos-runtime:human-feedback`): `pnpm register:webhook` lo actualiza en el sitio y suscribe por defecto `commercialHypothesis.updated`, `commercialSignal.updated` y `commercialSignal.created`. Prueba antes con `--dry-run`. El feedback de las hipótesis sigue funcionando por el mismo canal.

Requisitos previos, que ya cumple el entorno si el webhook de feedback funciona:

- `TWENTY_WEBHOOK_SECRET` (16 caracteres o más) definido en el runtime. Usa **el mismo valor** como secreto de este webhook.
- `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS=pxos-runtime,host.docker.internal` en el servidor y el worker de Twenty. Sin ella, Twenty descarta el envío sin registrar ningún error ([detalle](../runtime/agent-runtime/README.md#webhook-de-twenty)).

Pasos:

1. Abre Twenty y ve a **Settings → APIs & Webhooks → Webhooks → Create webhook** (en algunas versiones, el botón es **+ Create webhook**).
1. En **URL**, escribe `http://pxos-runtime:4020/webhooks/twenty`. Si el runtime corre en tu máquina con `pnpm dev`, usa `http://host.docker.internal:<puerto>/webhooks/twenty`.
1. En **Operations**, añade dos eventos al webhook del runtime: objeto **Signal** (`commercialSignal`) con **Updated** y con **Created** (una señal creada ya calificada también dispara; la ventana de 24 h evita duplicados). No suscribas más objetos.
1. En **Secret**, pega el valor de `TWENTY_WEBHOOK_SECRET`. No lo pongas en la URL (`?secret=`): Twenty escribe la URL completa en sus logs.
1. En **Description**, escribe `pxos-runtime:signal-qualified`, para reconocerlo luego.
1. Guarda.

> **Nota:** Twenty no tiene un estado "inactivo" para los webhooks. Para pausar el trigger inmediato sin borrarlo, vacía su lista de **Operations**; las señales calificadas siguen recibiendo trabajo en el run de las 08:00. No borres el webhook.

## Comprobar que funciona

1. Cambia a `QUALIFIED` una señal de feria de prueba con fecha futura.
1. En unos segundos, mira el `audit_log`: debe aparecer `prospect.on_qualified` con el identificador de la señal.

   ```bash
   curl -s "http://127.0.0.1:4020/audit?limit=20" -H 'x-tenant-id: publiexpe' | jq '.items[] | select(.action=="prospect.on_qualified")'
   ```

1. En Twenty, comprueba que hay un *Agent run* nuevo y, si la feria tenía expositores con encaje, hipótesis `Proposed`.
1. Si no aparece nada, revisa el destino del webhook en **Settings → APIs & Webhooks**, los [logs](runbook-local.md#dónde-mirar-los-logs) del runtime (`401` firma o secreto, `503` sin `TWENTY_WEBHOOK_SECRET`) y la variable `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS` de Twenty.
1. Sin señales calificadas, el run de las 08:00 de un día cualquiera debe terminar `SKIPPED`: es lo esperado, no un fallo.

### Comprobar el scout multi-caladero y las señales de empresa

1. Tras un lunes, abre **Commercial OS → Agent runs** y localiza el run de `weekly-event-scouting` de las 07:30. Su **Result** debe traer los contadores de cada sector de la lista. El formato: un bloque `sectors[]` con los contadores por sector.
1. En **Commercial OS → Signals**, la columna `New` debe incluir ferias de varios sectores, sin la misma feria dos veces.
1. Para una señal de empresa, comprueba que su nombre lleva el sufijo de tipo, que su fecha de noticia es de los últimos 60 días (o una apertura futura) y que la URL de la fuente abre la noticia.
1. Califica una señal de empresa de prueba y busca el disparo en el `audit_log` (`GET /audit`, igual que arriba). Debe aparecer una empresa nueva o reutilizada y una hipótesis `Proposed` enlazada a la señal.

## Limitaciones

- **Repetir una feria ya peinada solo recoge expositores nuevos.** El sistema deduplica por empresa y feria: una segunda pasada sobre la misma feria (el trigger y luego el reparto diario, o una recalificación) no repite lo ya escrito. Si el catálogo no ha cambiado, la pasada cuesta modelo y no aporta nada.
- **No hay tracking de "feria agotada".** El sistema no sabe que ha terminado con una feria. Una señal `QUALIFIED` sigue entrando en el reparto diario hasta que su fecha pasa (`EXPIRED`) o tú la descartas. Si ya has sacado de ella lo que querías, **descártala** para dejar de gastar presupuesto en ella.
- **La ventana de 24 h protege contra repeticiones accidentales, no contra el coste de recalificar a propósito.** Una recalificación fuera de ventana vuelve a lanzar la pasada completa.
- **El webhook no reintenta.** Un fallo de entrega pierde el disparo inmediato (el reparto de las 08:00 lo cubre al día siguiente).
- **Los umbrales del lead time son una regla comercial, no una medida.** Los 45 y 210 días recogen el criterio del equipo (muestras, pruebas de marcaje y producción); si cambia, se ajustan por variable de entorno ([las dos variables](#las-dos-variables)).
- **El envejecimiento y la ventana dependen de la fecha.** Una señal sin fecha, o con una fecha errónea, no caduca cuando debería.
- **Los expositores sin web se resuelven con un tope por run.** Un catálogo con muchos expositores sin dominio se desbloquea en varios runs, no en uno ([detalle](resolver-dominios.md#qué-pasa-al-agotar-el-presupuesto)).
- **El presupuesto diario es finito.** Con muchas ferias calificadas a la vez, cada una avanza más despacio: es el efecto del round-robin.
- **Más sectores, más señales `NEW`.** Con seis caladeros, la cola de decisión crece. Una feria que no te interesa se descarta, y un sector que no aporta se quita de la lista del seed ([cómo](#cómo-cambiar-la-lista)).
- **Las señales de empresa dependen de que la noticia sea verificable.** Una noticia que el scout no consigue descargar no genera señal, aunque sea cierta. Y una empresa sin web resoluble no genera hipótesis ([Resolver de Dominios](resolver-dominios.md#límites)).
- **La señal de empresa no sabe si ya escribiste a esa empresa por otra vía.** Una empresa que ya tiene hipótesis por una feria puede recibir otra por una apertura. Es normal: hay una hipótesis por empresa y motivo.

## Qué no hace

- **No califica ni descarta señales por su cuenta.** Solo pasa a `EXPIRED` las vencidas. Una señal calificada fuera de ventana no se descarta: espera.
- **No contacta con nadie.** Prospectar una feria deja empresas, señales de expositor e hipótesis `Proposed`; los correos siguen siendo cosa tuya ([borradores](guia-comercial.md#borradores-de-email)).
- **No borra nada.** Ni señales, ni la feria de ejemplo del seed (que simplemente deja de formar parte de la tarea, en una versión nueva).
- **No toca el canal de email** ni el [plan de warm-up](email-warmup.md).
- **No califica las señales de empresa por su cuenta.** Descubre y verifica la noticia; calificar es tuyo.
- **No inventa noticias.** Una señal de empresa sin URL fuente verificada por descarga no se crea.

## Documentos relacionados

- [Guía del equipo comercial](guia-comercial.md#señales-de-feria-tu-cola-de-decisión): qué ves y qué haces.
- [Runbook de operación local](runbook-local.md#webhook-de-commercialsignal-en-twenty): el paso de configuración del webhook y la operación diaria.
- [README del runtime: webhook de Twenty](../runtime/agent-runtime/README.md#webhook-de-twenty): firma, cabeceras y `register:webhook`.
- [Integración de eventos con n8n](n8n-integracion.md): el evento `signal.qualified` también puede consumirse desde n8n.
- [Ciclo de mejora de skills](ciclo-mejora-skills.md#caso-canónico-el-rechazo-de-los-6-borradores-del-2026-10-12): cómo el rechazo de los primeros borradores se convirtió en la regla de lead time.
- [Resolver de Dominios](resolver-dominios.md): cómo se resuelve la web de los expositores que el catálogo lista sin ella.
- [Seguimiento de leads enviados](seguimiento-leads.md): qué pasa con un lead después del clic (tanda 21).
- [Roadmap](ROADMAP.md): lugar de las tandas 15 y 18 en el plan.
