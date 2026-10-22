# Guía del equipo comercial

Esta guía explica cómo trabajar cada día con PubliEXPE Commercial OS desde Twenty, sin necesidad de conocimientos técnicos. En unos 10 minutos al día revisas las hipótesis que el sistema ha preparado para ti, decides cuáles merecen tu tiempo y despachas tu bandeja de **Tareas**.

El sistema propone; tú decides. El sistema nunca contacta con nadie por su cuenta: todo envío lo lanzas tú.

Desde la tanda 19, el trabajo se reparte entre las pestañas nativas de Twenty en lugar de acumularse en notas: lo que te toca hacer está en **Tareas**, las personas de contacto en **Personas** (con su historial de correos) y los tratos con interés real en **Oportunidades**. El mapa completo está en [Twenty nativo](twenty-nativo.md).

## Contenido

1. [Qué hace el sistema por ti](#qué-hace-el-sistema-por-ti)
1. [Señales de feria: tu cola de decisión](#señales-de-feria-tu-cola-de-decisión)
1. [Dónde mirar en Twenty](#dónde-mirar-en-twenty)
1. [Tu bandeja: las Tareas](#tu-bandeja-las-tareas)
1. [Cómo leer una hipótesis](#cómo-leer-una-hipótesis)
1. [Tu rutina diaria de 10 minutos](#tu-rutina-diaria-de-10-minutos)
1. [Cuando validas, el sistema busca el contacto](#cuando-validas-el-sistema-busca-el-contacto)
1. [Personas y oportunidades](#personas-y-oportunidades)
1. [Borradores de email](#borradores-de-email)
1. [Respuestas de los clientes](#respuestas-de-los-clientes)
1. [Seguimiento de lo que has enviado](#seguimiento-de-lo-que-has-enviado)
1. [Estados: cuándo usar cada uno](#estados-cuándo-usar-cada-uno)
1. [Por qué tu feedback importa](#por-qué-tu-feedback-importa)
1. [Preguntas frecuentes](#preguntas-frecuentes)

## Qué hace el sistema por ti

El sistema es un equipo de agentes automáticos que prepara el trabajo de prospección y deja el resultado en Twenty. Tú no ejecutas nada: abres Twenty y el trabajo ya está hecho.

### Los lunes a las 07:30: busca ferias nuevas

> **Activo desde el 2026-10-07.** La primera ejecución automática es el lunes siguiente a las 07:30.

Cada lunes, el sistema busca ferias y eventos reales relevantes para PubliEXPE y deja en **Commercial OS → Signals** una **señal por cada feria descubierta**, en estado `NEW`, con su fecha y su fuente. No crea señales de ferias demasiado próximas ni demasiado lejanas ([por qué](#qué-ferias-calificar-las-del-próximo-trimestre)). Es tu cola de decisión: consulta [qué hacer con ella](#señales-de-feria-tu-cola-de-decisión). El lunes ya no es la única vía por la que llega material nuevo: lo que desencadena el trabajo sobre una feria es que tú la califiques, no el calendario.

La ejecución tiene un límite de 20 minutos: si algo es muy grande, el resumen de la ejecución (*Agent run*) sale como `Partial` e indica en qué fase se cortó. Lo ya hecho se guarda igualmente.

> **Novedad (tanda 21):** el lunes el sistema ya no mira solo alimentación y bebidas. Recorre **seis sectores** (alimentación y bebidas, horeca y food service, farmacia y salud, cosmética y belleza, franquicias y retail, industria y packaging) y, además de ferias, deja **señales de empresa** de tipo apertura, ronda de financiación y aniversario. Tu cola de `New` tendrá más variedad; el gesto para decidir es el mismo. Consulta [señales de empresa](#señales-de-empresa-apertura-financiación-y-aniversario). `[POR CONFIRMAR]` fecha de activación en producción.

### Cuando calificas una feria: al momento

Cuando pones una señal en `QUALIFIED` y la feria queda dentro del [plazo que necesita el merchandising](#qué-ferias-calificar-las-del-próximo-trimestre) (de 2 a 6 meses vista), el agente **Prospector** investiga esa feria de inmediato: analiza sus expositores y, para cada uno, decide si PubliEXPE puede venderle merchandising con motivo de ese evento. Para cada expositor con encaje:

- Localiza o crea la **empresa** en Twenty.
- Registra una **señal** (*Signal*) del expositor: el hecho que justifica el contacto, por ejemplo "expone en Expo Alimentaria el 24 de noviembre". Nace en estado `NEW`.
- Redacta una **hipótesis** (*Hypothesis*): qué podría necesitar la empresa, por qué ahora, cuántas unidades, qué presupuesto y qué productos encajan. Nace en estado `PROPOSED`, a la espera de tu revisión.

Al terminar, deja un **resumen de la ejecución** (*Agent run*) con lo que ha hecho y lo que ha costado.

El sistema solo registra hipótesis con una confianza igual o superior a 0,50. Los expositores dudosos o sin encaje no llegan a Twenty.

### Cada mañana a las 08:00: sigue con tus ferias calificadas

La tarea diaria reparte su presupuesto entre **todas las ferias que tienes en `QUALIFIED`, siguen vigentes y quedan dentro del plazo de trabajo** (de 2 a 6 meses vista), empezando cada día por la que menos se ha trabajado. Así, una feria calificada sigue dando hipótesis nuevas los días siguientes sin que tengas que hacer nada más.

- **Si no tienes ninguna feria calificada en plazo, no hace nada**: el resumen de la ejecución sale como `Skipped`, a coste 0. No es un fallo.
- **Las hipótesis `Proposed` de ferias que ya quedan a menos de 45 días las pasa a `Expired`.** No cuentan como feedback tuyo. Las `Validated` no se tocan nunca.
- Cuando la fecha de una feria pasa, su señal cambia sola a `EXPIRED` y sale del reparto. Es lo único que el sistema cambia por su cuenta en una señal.

> **Nota:** la tarea diaria ya no trabaja con una lista fija de expositores de demostración. Si todavía ves registros cuyo dominio termina en `.example`, son de demostración de cuando existía esa lista: ignóralos o recházalos.

### Más hipótesis nuevas cuando se desbloquean expositores sin web

Muchas ferias publican a sus expositores solo por nombre, sin web, y hasta ahora el sistema los descartaba porque sin web no podía evaluarlos. Ahora intenta **encontrar la web oficial de cada uno** antes de descartarlo, y la comprueba contra la propia portada de la empresa; si no está seguro, la deja sin resolver en lugar de adivinar.

Qué notarás: en **Commercial OS → Hypotheses** aparecerán más hipótesis `Proposed` de las ferias que ya tenías calificadas, sobre todo las de catálogos grandes (Anuga, Madrid Fusión, BWW), repartidas en varios días porque el sistema resuelve un número limitado de webs por ejecución. **Tu trabajo no cambia**: validas, editas o rechazas como siempre. Las empresas nacen con su web ya verificada y con la fuente de la comprobación registrada, y el sistema sigue sin enviar nada por su cuenta.

> **Nota:** si una empresa que esperabas no aparece, puede ser que su web no se haya podido confirmar (nombre muy genérico, varias empresas con el mismo nombre o sin web propia). Es intencionado: el sistema prefiere no proponerla a proponerte una empresa equivocada. Más detalle en [Resolver de Dominios](resolver-dominios.md).

### Lo que el sistema no hace

- **No envía emails ni mensajes por su cuenta.** Un correo solo sale cuando tú revisas el borrador y pulsas el envío. Tampoco envía un segundo correo de recordatorio a quien no contesta: te avisa con una [tarea de seguimiento](#seguimiento-de-lo-que-has-enviado) y decides tú.
- **No contacta con decisores.** Busca una dirección de contacto publicada por la empresa, la deja en **Email to** y, si la web publica una persona con nombre y cargo, la crea en **Personas**; pero elegir a quién escribir y cuándo es cosa tuya.
- **No mueve las oportunidades por el pipeline ni crea presupuestos.** Solo crea la oportunidad cuando [alguien responde con interés](#personas-y-oportunidades) o cuando tú lo pides; el avance de etapas es tuyo.
- **No califica ni descarta ferias por ti.** Solo las pasa a `EXPIRED` cuando su fecha ya ha pasado.
- **No borra nada.**

Cuando validas una hipótesis, el sistema [busca el contacto](#cuando-validas-el-sistema-busca-el-contacto) de la empresa y prepara un **borrador de email**, pero nunca lo envía: los revisas y los envías tú, con un clic desde Twenty o a mano desde tu correo. Consulta [Borradores de email](#borradores-de-email). También clasifica las respuestas que llegan al buzón y te deja una **tarea** con las que piden tu atención, sin responder nunca por ti. Consulta [Respuestas de los clientes](#respuestas-de-los-clientes).

## Señales de feria: tu cola de decisión

Una **señal** es un hecho que justifica un contacto. Las que más te importan son las **señales de feria**: cada lunes el sistema busca ferias y eventos del sector y deja una por feria en **Commercial OS → Signals**, en estado `NEW`. Con ellas decides **en qué ferias quieres que el sistema trabaje**: el sistema propone las ferias y tú eliges.

### Estados de una señal

| Estado | Qué significa | Quién lo pone |
|---|---|---|
| `NEW` | Feria descubierta, todavía sin decidir. | El sistema |
| `REVIEWING` | La estás mirando. Es opcional y no hace que ocurra nada. | Tú |
| `QUALIFIED` | **Trabájala.** Es una feria que merece la pena. | Tú |
| `DISCARDED` | **Ya no.** No te interesa. | Tú |
| `EXPIRED` | La fecha de la feria ya pasó. | Solo el sistema |

### El gesto clave

- **Calificar** (`QUALIFIED`): si la feria es del próximo trimestre, el agente la investiga **al momento** y, además, la mantiene en el reparto de cada mañana mientras siga vigente. Las hipótesis llegan a **Hypotheses** como siempre, en `Proposed`. Si la feria queda fuera de plazo, [verás una tarea ⏳](#qué-ferias-calificar-las-del-próximo-trimestre) y no se trabajará todavía.
- **Descartar** (`DISCARDED`): el sistema no vuelve a tocar esa feria.
- **Dejar en `NEW`**: no pasa nada. Una feria sin decidir no consume presupuesto.

Para calificar, abre la señal en **Commercial OS → Signals** y cambia el campo **Status** a `Qualified`. No hay ningún botón adicional.

> **Importante:** calificar tiene coste: el agente usa un modelo de pago por uso sobre los expositores de esa feria. Califica las ferias que de verdad te interesen. Si ya has sacado de una feria lo que querías, **descártala** para que deje de recibir presupuesto cada día.

### Qué ferias calificar: las del próximo trimestre

**Califica ferias que se celebren dentro de 2 a 6 meses** (en concreto, entre 45 y 210 días desde hoy). El motivo es comercial: el merchandising necesita plazo. Entre las muestras, las pruebas de marcaje y la producción, un pedido no se puede servir para una feria que está a las puertas. Una feria de la semana que viene no es una oportunidad: es una puerta cerrada, aunque el expositor encaje de maravilla.

Qué verás si calificas fuera de ese plazo:

| La feria queda... | Qué pasa | Qué haces |
|---|---|---|
| **Demasiado cerca** (menos de 45 días) | Verás una **tarea ⏳** en tu bandeja que explica los días que faltan. La señal sigue en `Qualified`, pero no se trabajará. Cuando pase la fecha, cambia sola a `Expired`. | Nada. Puedes descartar la señal si no quieres tenerla pendiente y cerrar la tarea. |
| **Demasiado lejana** (más de 210 días) | Verás la misma tarea ⏳. La señal sigue en `Qualified` y **se queda esperando su momento**: el día en que la feria entre en plazo, entra sola en el reparto de la mañana. | Nada. No hace falta volver a calificarla. |
| **Sin fecha** | También recibes la tarea ⏳: el sistema no puede saber si está en plazo. | Pon la fecha en la señal o descártala. |

La tarea ⏳ no es un fallo: es el sistema diciéndote «te he hecho caso, pero ahora no toca». Si no quieres que una feria lejana te quede pendiente, descártala.

El lunes, el sistema ya no te deja en la cola ferias demasiado próximas ni demasiado lejanas: la cola de `New` son, en su mayoría, ferias del próximo trimestre.

### Señales de empresa: apertura, financiación y aniversario

Además de ferias, desde la tanda 21 el sistema deja en tu cola **señales de empresa**: noticias que dicen que una empresa concreta está en un buen momento para el merchandising.

| Tipo | Cómo lo reconoces | Qué significa |
|---|---|---|
| **Apertura** | El nombre acaba en «— apertura» | La empresa abre (o va a abrir) un local, una fábrica o una sede |
| **Financiación** | El nombre acaba en «— financiación» | La empresa ha cerrado una ronda de financiación |
| **Aniversario** | El nombre acaba en «— aniversario» | La empresa cumple un aniversario redondo |

`[POR CONFIRMAR]` el texto exacto de los sufijos de tipo.

**Las calificas igual que una feria.** Abre la señal en **Commercial OS → Signals**, comprueba la noticia con su enlace y cambia **Status** a `Qualified` o `Discarded`. Lo que cambia es lo que ocurre después:

- **No investiga una feria, sino a esa empresa.** El agente prospecta directamente a la empresa de la señal y te deja una hipótesis en `Proposed`, con el motivo de la noticia como razón del momento (**Why now**) `[POR CONFIRMAR]`. Si la noticia no trae la web de la empresa, el sistema intenta [encontrarla y verificarla](resolver-dominios.md); si no está seguro, no propone nada en lugar de adivinar.
- **No hay «plazo de 2 a 6 meses».** Esa regla es de ferias. En una señal de empresa manda la frescura: solo se crean con noticias de los últimos 60 días (o una apertura futura) y con la fuente comprobada por el sistema.
- **Caducan solas a los 120 días.** Si no la has calificado, la señal pasa sola a `Expired` cuando han pasado 120 días desde la noticia: una noticia vieja ya no es un buen motivo para escribir.
- **Sigue siendo tu decisión.** El sistema no califica por ti y no envía nada. Validar una hipótesis de empresa, buscar el contacto y revisar el borrador funciona como en cualquier otra.

> **Importante:** calificar una señal de empresa tiene coste, aunque menor que el de una feria con catálogo: el agente usa un modelo de pago por uso para evaluar a esa empresa. Califica las noticias que de verdad te cuadren. `[POR CONFIRMAR]` el coste medido por señal de empresa.

### Dónde las ves

En **Commercial OS → Signals**, con la vista **Señales · Cola**: un tablero con una columna por estado. La columna `New` es tu cola de decisión y `Qualified`, las ferias que el sistema está trabajando; arrastra la tarjeta de una columna a otra para calificar o descartar. Cada señal lleva la fecha de la feria y el enlace a su fuente, para que decidas con datos.

### Lo que no cambia

Las **hipótesis** siguen llegando como siempre: en **Commercial OS → Hypotheses**, estado `Proposed`, y las validas, editas o rechazas con tu rutina diaria. Validar una hipótesis sigue sin enviar nada. Tampoco cambian los borradores ni el envío de email.

> **Nota:** las señales antiguas por expositor (una por empresa, de antes de este ciclo) siguen ahí, pero cambiarles el estado no pone nada en marcha: lo que dispara el trabajo es calificar la **señal de la feria**.

El detalle técnico del ciclo está en [Prospección guiada por señales](prospeccion-por-senales.md).

## Dónde mirar en Twenty

Abre Twenty (`http://localhost:3020` en el entorno local). Tu trabajo está repartido entre dos zonas de la barra lateral: la carpeta **Commercial OS**, con lo que propone el sistema, y las pestañas nativas de Twenty, con lo que es tuyo.

### Carpeta Commercial OS: lo que propone el sistema

| Entrada | Qué es | Quién la escribe | Qué haces tú |
|---|---|---|---|
| **Commercial OS → Signals** | Hechos que justifican un contacto. Las ferias que se descubren cada lunes son tu cola de decisión. | El sistema las crea; tú las calificas | **Calificar o descartar las ferias nuevas.** Consulta [Señales de feria](#señales-de-feria-tu-cola-de-decisión). |
| **Commercial OS → Research** | Investigación de apoyo sobre una empresa o señal, incluidos los contactos encontrados con su fuente. | El sistema | Consultarla al preparar un contacto: el Prospector la rellena con hechos observados y sus fuentes. |
| **Commercial OS → Hypotheses** | Las propuestas comerciales: qué vender, a quién y por qué ahora. | El sistema | **Validarlas, editarlas o rechazarlas.** |
| **Commercial OS → Agent runs** | Un resumen por cada ejecución del sistema: qué hizo, si fue bien y cuánto costó. | El sistema | Solo lectura. Sirve para saber si hoy se ha ejecutado todo. |

### Pestañas nativas de Twenty: lo que es tuyo

| Pestaña | Qué hay | Qué haces tú |
|---|---|---|
| **Tareas** | Todo lo que te toca hacer, con fecha: responder a un interesado, revisar una alerta. Ver [Tu bandeja](#tu-bandeja-las-tareas). | **Despacharlas. Es tu tarea diaria.** |
| **Personas** | Las personas de contacto que el sistema encuentra en las webs de las empresas y los remitentes que te responden, con su cargo y el historial de correos. | Consultarlas antes de escribir; crear o corregir las que conozcas. |
| **Oportunidades** | Los tratos con interés real, en un tablero por etapa. Ver [Personas y oportunidades](#personas-y-oportunidades). | Mover cada una por el pipeline según avance. |
| **Empresas** | La ficha de cada cuenta, con todo lo relacionado. | Consultarla para tener el contexto en un solo sitio. |

### Vistas de fábrica

La App trae cinco vistas pensadas para el trabajo diario. Las cuatro primeras existen cuando se ha [sincronizado la App](runbook-local.md#sincronizar-las-vistas-de-fábrica) tras la tanda 19, y la quinta, tras la tanda 21 ([qué añade](runbook-local.md#qué-añade-la-sincronización-de-la-tanda-21)); si todavía no las ves, usa las listas normales de cada pestaña.

| Vista | Qué muestra |
|---|---|
| **Señales · Cola** | Tablero de señales por estado. Tu cola de decisión está en `New`. |
| **Hipótesis · Por estado** | Tablero de hipótesis con una columna por estado (`Proposed`, `Validated`, `Rejected`, `Expired`). Tu trabajo está en `Proposed`. Sustituye a la vista **By status**. |
| **Hipótesis · Envíos** | Tablero de hipótesis con una columna por **Email status** (`Draft`, `Reviewed`, `Sending`, `Sent`). Es tu tablero de envíos: qué está por revisar, qué se está enviando y qué ya salió. Ver [Seguimiento](#seguimiento-de-lo-que-has-enviado). |
| **Oportunidades · Pipeline** | Tablero de oportunidades por etapa. |
| **Tareas · Bandeja** | Tablero de tareas por estado (*To do*, *In progress*, *Done*). |

Cambia de vista desde el selector de la parte superior de la lista. En **Signals** sigue disponible la vista **Recent signals** para ver primero las detectadas más recientemente.

### Cómo se relacionan

Cada **hipótesis** está enlazada a una **empresa** y a la **señal** que la originó. Desde la ficha de una empresa de Twenty ves también sus personas, oportunidades, tareas, señales, hipótesis y ejecuciones. Úsala para tener todo el contexto de una cuenta en un solo sitio.

> **Nota:** en **Agent runs** no puedes crear ni editar registros. Es intencionado: son el registro de lo que hizo el sistema.

## Tu bandeja: las Tareas

Las alertas que piden una acción ya no se quedan enterradas en notas: el sistema las convierte en **tareas con fecha** en la pestaña **Tareas** de Twenty. Abre la vista **Tareas · Bandeja**, trabaja primero las que vencen antes y márcalas como hechas (*Done*) al terminar.

| Tarea | Cuándo aparece | Fecha | Qué haces |
|---|---|---|---|
| **📬 Responder a…** | Alguien ha contestado a tu correo con interés (o con una pregunta) | La que fija el sistema al crearla | Responde desde tu correo y márcala como hecha. Es la más importante |
| **⚠️ Revalidación fallida** | Una versión de skill en uso ha dado peor resultado al medirla con tus veredictos | +1 día | Avisa al equipo técnico: decide si se revierte. Tú no tienes que hacer nada más |
| **Propuesta de promoción** | El optimizador propone una skill mejor y ha pasado el Release Gate | +3 días | Avisa al equipo técnico para que la revise. Si no se hace nada, no pasa nada |
| **🔔 Seguimiento — {empresa}** | Has enviado un correo a esa empresa hace 5 días laborables o más y no ha respondido (ni está en la lista de supresión) | El mismo día en que se crea | Lee el cuerpo (fecha y asunto del envío, destinatario, ángulo y guion sugerido), decide si escribes de nuevo, llamas o lo dejas, y márcala como hecha. **El sistema no envía nada**. Ver [Seguimiento](#seguimiento-de-lo-que-has-enviado) |
| **⏳ Fuera de ventana / sin fecha** | Has calificado una feria demasiado cercana, demasiado lejana o sin fecha | La que fija el sistema | Nada urgente: [qué ferias calificar](#qué-ferias-calificar-las-del-próximo-trimestre) |
| **⚠️ Catálogo no disponible** | El catálogo de productos no respondió | Como máximo una al día | Nada: las hipótesis de ese día llevan familias genéricas. Avisa al equipo técnico si se repite varios días |

> **Importante:** el sistema **nunca cierra ni borra tus tareas**. Una tarea sin cerrar es una tarea pendiente: lo que ves en la columna *To do* es lo que te queda por hacer.

Qué **no** son tareas:

- La **lista de supresión** sigue siendo una nota: es un libro donde solo se añaden líneas ([cómo se usa](#lista-de-supresión-qué-haces-antes-de-enviar)).
- Las notas **📬 Respuesta recibida** (con el extracto del mensaje) y **⚠️ Rebote** siguen siendo notas informativas en la empresa.
- La investigación de apoyo vive en **Research**.

## Cómo leer una hipótesis

Abre una hipótesis desde **Commercial OS → Hypotheses** para ver todos sus campos. Esto es lo que significa cada uno.

| Campo en Twenty | Qué significa para ti |
|---|---|
| **Hypothesis** | El titular: `{empresa} — {evento}`. Por ejemplo, "Conservas Marineras del Cantábrico — Expo Alimentaria Ibérica 2026". |
| **Company** | La empresa a la que se refiere. |
| **Signal** | La señal que originó la hipótesis. Ábrela para ver el evento y su fuente. |
| **Need** | La necesidad concreta de merchandising: qué necesita y para qué. Es la idea central de la hipótesis. |
| **Why now** | Por qué es buen momento: cita el evento, su fecha y el diferencial de PubliEXPE que más ayuda (por ejemplo, el taller propio si el plazo es corto). |
| **Quantity min** / **Quantity max** | Horquilla de unidades totales estimadas. Es una estimación del sistema, no un pedido. |
| **Budget min** / **Budget max** | Horquilla de presupuesto en euros, **sin IVA**. Es una estimación para orientarte, no un presupuesto. |
| **Recommended products** | Familias de producto que encajan (bolsas, bolígrafos, botellas, lanyards, textil...). Son genéricas: todavía no hay catálogo conectado, así que no verás referencias ni SKU. |
| **Timing** | Cuándo conviene actuar. Ver tabla siguiente. |
| **Confidence** | Cuánto se fía el sistema de la hipótesis, de 0 a 1. Ver [más abajo](#cómo-interpretar-la-confianza). |
| **Evidence** | Los datos en que se apoya la hipótesis: afirmaciones y, cuando existe, el enlace a la fuente. Compruébalas si vas a actuar. |
| **Decision maker** | La persona de contacto recomendada. El sistema **no la rellena**: la eliges tú. Si la web de la empresa publica personas, las encontrarás ya creadas en **Personas**. |
| **Status** | En qué punto del proceso está. Ver [Estados](#estados-cuándo-usar-cada-uno). |

> **Nota:** cuando el catálogo de PubliEXPE esté conectado ([Catalog Service](catalog-service.md)), las hipótesis nuevas llevarán en **Recommended products** productos reales con su **referencia (SKU)** y un **rango de precio orientativo** por unidad, sin IVA y sin personalización. Ese rango es solo un punto de partida: **el presupuesto se hace donde siempre**, en el CMS de PubliEXPE. Si un día el catálogo no está disponible, verás una tarea ⚠️ en tu bandeja y las hipótesis de ese día volverán a llevar familias genéricas; no tienes que hacer nada.

### Valores de Timing

| Valor | Significa |
|---|---|
| `IMMEDIATE` | El evento es dentro de menos de 30 días. Actúa primero aquí. |
| `THIS_QUARTER` | El evento cae en este trimestre natural. |
| `NEXT_QUARTER` | El evento cae el trimestre siguiente. |
| `LATER` | El evento es más lejano. |
| `UNKNOWN` | No hay fecha clara. |

### Cómo interpretar la confianza

La confianza mide cuánto encaja la empresa con PubliEXPE y cuántos datos concretos respaldan la hipótesis. No mide la probabilidad de cerrar una venta.

| Confianza | Lectura |
|---|---|
| **0,80 a 1** | Encaje claro y datos concretos: empresa grande, lanzamiento, presencia destacada en el evento. Revísala la primera. |
| **0,50 a 0,79** | Encaje razonable, pero falta algún dato. Lee `Need` y `Evidence` antes de decidir. |
| **Menos de 0,50** | Dudosa. El sistema normalmente no la registra. Si ves una, trátala con cautela. |

Dos ejemplos:

- **0,88:** una fabricante con stand propio, un lanzamiento reciente y varios comerciales en la feria. El sistema ve necesidad clara de regalo para visitantes y material de equipo. Merece una llamada.
- **0,45:** un distribuidor de envases que también imprime bolsas promocionales. Puede ser un cliente potencial, pero también un competidor parcial. Por esa duda, el sistema no la registra por defecto.

> **Importante:** una confianza alta no sustituye a tu criterio. Si conoces la cuenta y la hipótesis no te cuadra, recházala. Esa decisión es valiosa para el sistema.

## Tu rutina diaria de 10 minutos

1. Abre Twenty y ve a **Tareas → Tareas · Bandeja**. Despacha primero las **📬 Responder a…** (alguien ha contestado con interés: responde hoy desde tu correo y márcala como hecha) y después el resto, empezando por las que vencen antes ([qué es cada una](#tu-bandeja-las-tareas)). Si hay una tarea 🔔 de seguimiento, decide si vuelves a escribir o llamas ([cómo](#seguimiento-de-lo-que-has-enviado)). Si hay una tarea ⚠️ de skill o de catálogo, no tienes que resolverla tú: avisa al equipo técnico.
1. Ve a **Commercial OS → Agent runs** y comprueba que hay una ejecución de hoy. Si el resultado (*Outcome*) es `Failed` o `Partial`, avisa al equipo técnico (consulta [Preguntas frecuentes](#preguntas-frecuentes)). Un `Skipped` es normal si no tienes ninguna feria calificada.
1. Ve a **Commercial OS → Signals** con la vista **Señales · Cola**. Si el lunes llegaron ferias nuevas (columna `New`), califica las que merecen trabajo y descarta el resto ([cómo](#señales-de-feria-tu-cola-de-decisión)).
1. Ve a **Commercial OS → Hypotheses** con la vista **Hipótesis · Por estado**.
1. En la columna `Proposed`, empieza por las hipótesis con **Timing** `IMMEDIATE` y **Confidence** más alta.
1. Abre cada hipótesis y lee `Need`, `Why now`, `Evidence` y los importes. Decide una de estas tres acciones.

   | Acción | Cuándo | Cómo |
   |---|---|---|
   | **Validar** | La hipótesis es buena tal como está y vas a trabajarla. | Cambia **Status** a `Validated`. |
   | **Editar y validar** | Es buena, pero hay que corregir algo: cantidades, presupuesto, productos, el enfoque. | Corrige los campos y después cambia **Status** a `Validated`. |
   | **Rechazar** | No encaja: empresa equivocada, ya es cliente de otro comercial, no es el momento, es un competidor. | Cambia **Status** a `Rejected`. |

   Puedes cambiar el estado abriendo la hipótesis y editando el campo **Status**, o arrastrando la tarjeta a otra columna del tablero **Hipótesis · Por estado**.

1. Para cada hipótesis validada, espera a que el sistema deje el contacto y el borrador, y **revisa el destinatario y su fuente antes del clic**: abre **Email to**, el Research «Contacto — empresa» y, si hay, la persona en **Personas** ([cómo](#cuando-validas-el-sistema-busca-el-contacto)). Después decide tú el siguiente paso: por qué canal y con qué mensaje. Si quieres a una persona concreta, selecciónala en **Decision maker**.
1. Echa un vistazo a **Oportunidades → Oportunidades · Pipeline**: mueve de etapa las que hayan avanzado ([cómo](#personas-y-oportunidades)).
1. Si una feria calificada ya no te da más (has sacado de ella lo que querías), descártala para que el sistema deje de dedicarle presupuesto (consulta [Estados de señal](#señales)).

> **Importante:** validar una hipótesis **no envía ningún email** ni avisa a nadie. Solo significa "esta hipótesis es buena y la voy a trabajar yo". El contacto con el cliente lo decides y lo ejecutas tú. Esto es así por diseño: en el sistema, toda acción con efecto hacia fuera (enviar un email, contactar con un decisor) exige una persona.

### Qué pasa con cada acción

| Acción | Qué ocurre en Twenty | Qué ocurre además |
|---|---|---|
| **Validar** | La hipótesis pasa a `Validated`. | Cuenta como una hipótesis **aceptada** para el sistema (consulta [Por qué tu feedback importa](#por-qué-tu-feedback-importa)). El sistema [busca el contacto](#cuando-validas-el-sistema-busca-el-contacto) y prepara un [borrador de email](#borradores-de-email). No se envía nada. |
| **Editar y validar** | Se guardan tus cambios y la hipótesis pasa a `Validated`. | Cuenta como **editada**: el sistema aprende de lo que corriges. El sistema busca el contacto y prepara un [borrador de email](#borradores-de-email) con tus datos corregidos. No se envía nada. |
| **Rechazar** | La hipótesis pasa a `Rejected` y sale de tu cola. | Cuenta como **descartada**. No se borra ni se avisa a nadie. |
| **No hacer nada** | La hipótesis sigue en `Proposed`. | El sistema no aprende nada de ella. |

> **Precaución:** no borres registros de hipótesis, señales ni empresas, ni siquiera los que te parezcan erróneos. Rechaza la hipótesis o descarta la señal. Borrar un registro elimina la información que el sistema necesita para mejorar.

## Cuando validas, el sistema busca el contacto

Un borrador sin destinatario no se puede enviar. Por eso, al validar una hipótesis, el sistema busca primero **a quién escribir** y después redacta el borrador.

Qué hace, en este orden:

1. **Mira la web de la propia empresa** (portada, contacto, aviso legal, equipo) y recoge los emails que la empresa publica, solo del dominio de la empresa. Prefiere una persona con cargo relevante; si no hay, un buzón de función (`comercial@`, `ventas@`, `marketing@`, `export@`); y si tampoco, uno genérico (`info@`, `contacto@`). Nunca propone `noreply`, protección de datos, bajas ni nada de la lista de supresión.
1. **Escribe el mejor candidato en Email to**, pero **solo si estaba vacío**. Si ya habías puesto una dirección tú, no la toca.
1. **Crea la persona en Personas**, si la web publica una persona con nombre y cargo: queda enlazada a la empresa, con su cargo y su email. Los buzones como `info@` o `comercial@` **no** crean persona.
1. **Deja un Research «Contacto — empresa»** en **Commercial OS → Research** con todos los candidatos y la **URL exacta** de la página donde aparece cada uno (y el enlace a la persona, si se creó).
1. **Si la web no publica ningún email**, deja un Research **«Sin contacto público»**. Si el enriquecimiento externo está activado, lo intentará después; si no, queda para ti.

> **Nota:** el sistema nunca inventa una dirección (no adivina `nombre.apellido@`). Todo lo que ves en **Email to** viene de una página pública o, si está activado, de un proveedor externo, y consta con su fuente.

### Tu paso nuevo: revisar destinatario y fuente antes del clic

Antes de poner `Reviewed` en un borrador:

1. Abre la hipótesis y mira **Email to**.
1. Abre el Research **«Contacto — empresa»** de esa empresa y haz clic en la **URL de origen**: comprueba que la dirección está ahí y que tiene sentido para esta oferta. Si se creó una persona, ábrela desde el Research: verás su cargo y, si ya habéis intercambiado correos, el historial.
1. Si hay varios candidatos y prefieres otro (por ejemplo, la persona de marketing en lugar de `info@`), sustituye **Email to** por ese. Tu valor manda: el sistema no lo vuelve a cambiar.
1. Sigue con la revisión del borrador y la [lista de supresión](#lista-de-supresión-qué-haces-antes-de-enviar) como siempre.

### Si pone «Sin contacto público»

La empresa no publica un email en su web. Tienes dos opciones:

| Opción | Cuándo |
|---|---|
| **Buscar a mano** | La cuenta te importa o tienes otra vía (una llamada, LinkedIn, un contacto conocido). Escribe la dirección en **Email to**. |
| **Esperar al enriquecimiento** | Si el enriquecimiento externo está activado, el sistema consulta un proveedor para esas hipótesis (con un tope diario). Solo rellena **Email to** si la confianza es alta; si no, deja el candidato en el Research para que decidas tú. |

> **Importante:** que el sistema encuentre un contacto no significa que el correo salga. El envío sigue siendo tuyo: `Reviewed` y el botón. Los criterios legales y qué hace cada fase están en [Búsqueda de contactos](contactos.md).

## Personas y oportunidades

Estas dos pestañas nativas de Twenty se llenan solas, pero con criterio: **no todo lo que el sistema propone es un trato**.

### Personas

Cada persona que el sistema encuentra publicada en la web de una empresa (con nombre y cargo), o que te responde a un correo, aparece en **Personas**, enlazada a su empresa. Para ti tiene dos ventajas:

- **Sabes a quién escribes**: nombre, cargo y empresa, en lugar de una dirección suelta.
- **Ves el historial de correos**: Twenty asocia los correos por dirección, así que en la ficha de la persona se acumula la conversación (lo que enviaste y lo que respondió). Esto depende de que el buzón conectado a Twenty sincronice mensajes; si no ves correos en una ficha donde sí ha habido intercambio, avisa al equipo técnico.

No se crea persona para direcciones de departamento (`info@`, `comercial@`, `ventas@`): esas siguen yendo a **Email to**. Si conoces a la persona real de una empresa, créala tú en **Personas** con su email y el sistema la reutilizará (no duplica por email).

### Oportunidades: solo cuando hay tracción

Las hipótesis **no** se vuelcan a **Oportunidades**: la mayoría no pasa de propuesta y llenarías el pipeline de ruido. Una oportunidad aparece solo en dos casos:

| Caso | Qué ocurre |
|---|---|
| **Alguien responde con interés** (`Interesado`) | El sistema crea la **oportunidad** de la empresa, con la persona que te escribió como punto de contacto, y una tarea **📬 Responder a…** con fecha en tu bandeja. |
| **Tú decides promocionar una hipótesis** | Pídelo al equipo técnico (es una operación auditada). Crea la oportunidad sin esperar respuesta, para hipótesis que ya sabes que son buenas. |

Qué debes saber:

- **Una sola oportunidad abierta por empresa.** Si la empresa ya tiene una abierta, no se crea otra.
- **El sistema no la mueve de etapa.** El pipeline es tuyo: arrastra la tarjeta en **Oportunidades · Pipeline** según avance el trato (reunión, propuesta, cliente...).
- **La hipótesis no cambia sola.** Un interesado no pasa la hipótesis a `Validated`; si procede, valídala tú.
- **El funnel de venta vive aquí**, no en la hipótesis. La hipótesis es la idea del sistema; la oportunidad es el trato real.

## Borradores de email

Cuando validas una hipótesis, el sistema prepara un borrador del primer email para esa empresa. Esto ocurre tanto si la validas tal cual como si la editas antes de validarla: en ese segundo caso, el borrador usa los datos que has corregido (cantidades, presupuesto, productos o enfoque).

**El ángulo del borrador.** Como solo se trabajan ferias del próximo trimestre, el correo habla de **tiempo para hacerlo bien**: a unas semanas de la feria es el momento ideal para resolver el merchandising con calma, con muestras, pruebas de marcaje y producción sin prisas. El borrador no debe presumir de plazos cortos ni de «adaptarse a las prisas»: si ves ese discurso, corrígelo o recházalo. El tono y el formato no cambian. (Esta redacción nueva depende de que se active la versión correspondiente de la skill del EmailDrafter; mientras tanto, revisa el ángulo tú.)

El borrador es solo una propuesta de texto: **el sistema no envía nada por su cuenta, nunca**. El correo sale cuando tú lo revisas y lo lanzas, y puedes hacerlo de dos formas:

| Forma | Cuándo la usas |
|---|---|
| [Enviar desde Twenty con un clic](#enviar-desde-twenty-con-un-clic) | Es la forma habitual. El correo sale desde tu buzón `jesus.abril@publiexpe.info`, conectado a Twenty. |
| [Enviar a mano desde tu correo](#alternativa-enviar-a-mano-desde-tu-correo) | Si el envío desde Twenty no está disponible, o si prefieres escribir desde el webmail (por ejemplo, para usar el otro buzón). |

En las dos formas se aplican las mismas reglas: [lista de supresión](#lista-de-supresión-qué-haces-antes-de-enviar) y [Qué no haces](#qué-no-haces).

### Dónde aparece el borrador

El borrador está **en la hipótesis**, en los campos **Email to** (destinatario), **Email subject** (asunto) y **Email body** (cuerpo), con **Email status** = `Draft`. Es donde lo revisas y lo envías.

> **Nota:** antes de la tanda 19 el sistema dejaba además una copia como nota en la empresa («Borrador email — ...»). Esa nota deja de crearse si el envío desde Twenty no la necesita (el equipo técnico lo confirma; las notas antiguas se conservan). Edita siempre el borrador **en la hipótesis**: lo que envía Twenty son sus campos.

### Enviar desde Twenty con un clic

> **Activo desde el 2026-10-07.** Tu buzón está conectado a Twenty y el flujo de envío está activado. Los detalles técnicos están en [Enviar los borradores desde Twenty](twenty-envio-email.md).

En cada hipótesis validada:

1. Abre la hipótesis y lee **Email subject** y **Email body**. Corrige lo que haga falta **en la hipótesis**, no en la nota. No quites la línea de baja ni la firma.
1. Comprueba **Email to** y su fuente: el sistema lo rellena al validar y deja el Research «Contacto — empresa» con la URL de origen ([cómo](#tu-paso-nuevo-revisar-destinatario-y-fuente-antes-del-clic)). Si está vacío ("Sin contacto público"), escribe tú la dirección del destinatario (una dirección de rol, como `compras@`, si no hay un decisor identificado).
1. Comprueba que ni la dirección ni el dominio del destinatario están en la nota `Lista de supresión — NO contactar` (consulta [Lista de supresión](#lista-de-supresión-qué-haces-antes-de-enviar)). El sistema además lo comprueba y devuelve el borrador a `Draft` si la dirección está en la lista.
1. Comprueba que no superas el ritmo del día del [plan de warm-up](email-warmup.md). Los envíos desde Twenty cuentan igual que los del webmail.
1. Cambia **Email status** a `Reviewed`. Significa «lo he leído y se puede enviar».
1. Abre el menú de acciones de la hipótesis (Cmd/Ctrl+K o el botón de acciones) y pulsa **Enviar borrador de email**. Twenty lo lanza sin otra confirmación: tu confirmación es el `Reviewed`. El correo sale desde **tu** buzón conectado, con tu nombre como remitente.
1. Comprueba que **Email status** pasa a `Sent` (recarga la ficha si no cambia).

Cómo cambia **Email status**:

| Estado | Significa | Quién lo cambia |
|---|---|---|
| `Draft` | Borrador escrito por el sistema, sin revisar. | El sistema |
| `Reviewed` | Lo has leído y se puede enviar. | Tú |
| `Sending` | El envío está en curso. | Twenty, al pulsar el botón |
| `Sent` | El correo ha salido. | Twenty, al terminar el envío |

Qué debes saber:

- **Un clic envía un solo correo.** El botón no admite selección múltiple, a propósito: no sirve para envíos masivos.
- **Sin `Reviewed`, no sale nada.** Si pulsas el botón con otro estado, Twenty se detiene sin enviar. Tampoco envía si la hipótesis no está en `Validated` o si faltan destinatario, asunto o cuerpo.
- **No vuelvas a pulsar si se queda en `Sending`.** El envío ha fallado o sigue en curso. Avisa al equipo técnico, que lo revisa en **Workflows → Runs**. Pulsar otra vez podría duplicar el correo.
- **El correo enviado no aparece en la carpeta *Enviados* de IONOS**, porque Twenty solo se conecta a tu buzón para enviar. Las respuestas de los clientes llegan a tu correo como siempre.
- **El historial de correos cuelga de la persona, no de la empresa.** Si el destinatario es una persona de **Personas**, Twenty asocia los correos por su dirección y los ves en su ficha. Si escribes a un buzón genérico (`info@`), no hay persona y no hay historial; queda `Sent` en la hipótesis y el registro del envío en **Workflows → Runs**.
- **Cuenta tus envíos del día.** En **Hypotheses**, filtra por **Email status** = `Sent` y por fecha de actualización.

### Alternativa: enviar a mano desde tu correo

Usa esta forma si el envío desde Twenty no está disponible. El borrador es el mismo, el de los campos de la hipótesis.

1. Abre la hipótesis que acabas de validar y copia **Email subject** y **Email body**.
1. **Lee el borrador completo.** Revísalo siempre, aunque la hipótesis te parezca buena.
1. Personaliza lo que haga falta: saludo, nombre de la persona, referencia al evento, cantidades o tono. Comprueba que los datos son correctos.
1. Antes de enviar, comprueba que el destinatario no está en la lista de supresión (consulta el apartado siguiente).
1. Copia el texto a un correo nuevo. Envíalo desde `jesus.abril@publiexpe.info` o `j.abril@publiexpe.info`.
1. Comprueba que el correo lleva tu identificación y la línea de baja con `baja@publiexpe.info`.

### Lista de supresión: qué haces antes de enviar

1. **Antes de enviar cualquier correo en frío**, abre en Twenty la nota `Lista de supresión — NO contactar` (búscala por "supresión") y comprueba que ni la dirección ni el dominio del destinatario aparecen. Si aparecen, no envíes ni vuelvas a contactar nunca.
1. **Toda petición de baja** (una respuesta a tu correo o un mensaje a `baja@publiexpe.info`) acaba como una línea nueva al final de la nota, con el formato `email — fecha — motivo`. El sistema revisa el buzón cada 2 horas y añade las bajas que detecta, y también las respuestas que dicen claramente "no nos interesa" (motivo `no interesado (respuesta)`). Si recibes una petición de baja y todavía no está en la nota, añádela tú **el mismo día**.
1. **No borres ni edites** las líneas existentes de la nota.

Para el detalle del procedimiento, consulta [Gestión de bajas y lista de supresión](email-warmup.md#gestión-de-bajas-y-lista-de-supresión).

> **Importante:** la comprobación antes de enviar sigue siendo tuya. El sistema la repite como red de seguridad, pero no la sustituye.

### Qué no haces

- **No quites la línea de baja.** Es obligatoria en cada correo de prospección.
- **No envíes sin leer.** El borrador lo ha escrito un modelo de IA y puede contener errores o cifras que no encajan.
- **No envíes prospección en frío desde una dirección `@publiexpe.com`.** El frío sale solo desde `@publiexpe.info`, para proteger la reputación del dominio principal.
- **No superes el ritmo de envío del [plan de warm-up](email-warmup.md)** mientras los buzones se están calentando.
- **No pongas `Reviewed` sin haber comprobado la lista de supresión.**

> **Importante:** el borrador no es un correo enviado. Si no pones `Reviewed` y pulsas tú el envío (o lo envías a mano), el correo no sale.

### Respuestas de los clientes

Cada 2 horas el sistema lee el buzón (sin marcar ni mover nada) y clasifica cada correo nuevo una sola vez. **Nunca responde ni envía nada**: te prepara la información y la respuesta es tuya.

| Lo que llega | Lo que hace el sistema | Lo que haces tú |
|---|---|---|
| **Interesado** (pide precios, catálogo, una llamada...) | Crea la **persona** que te escribe en **Personas**, la **oportunidad** de la empresa en el pipeline (con esa persona como contacto) y una **tarea 📬 «Responder a…»** con fecha en tu bandeja. Deja además en la empresa una nota `📬 Respuesta recibida — Interesado (fecha hora)` con un extracto del texto. | Abre la tarea, lee el correo en tu bandeja y respóndelo hoy. Márcala como hecha. |
| **Pregunta** concreta | Tarea **📬 «Responder a…»** y nota `📬 Respuesta recibida — Pregunta (...)`. No crea oportunidad. | Contesta la pregunta desde tu correo. |
| **No interesado** explícito | Nota `📬 Respuesta recibida — No interesado (...)` y alta en la lista de supresión. | No vuelvas a escribirle. Si la clasificación es un error, avisa al operador. |
| **Baja** | Alta en la lista de supresión (como hasta ahora). | Nada. |
| **Rebote**: la dirección no existe | Nota `⚠️ Rebote: el email no existe (...)` en la empresa. No la añade a la supresión. | Busca otro contacto y corrige **Email to** antes de volver a enviar. |
| Respuesta automática, fuera de la oficina, boletines u otros | Solo lo registra. | Nada: lo verás en tu bandeja como siempre. |

Qué debes saber:

- **La clasificación es una ayuda, no un filtro.** Sigue leyendo tu bandeja: todo el correo sigue ahí.
- **En caso de duda, el sistema no decide.** Una respuesta ambigua ("ahora no", "escribidme en enero", "habla con mi compañera") queda como *Otro* y no crea nota ni da de baja a nadie.
- **Tu punto de entrada es la tarea**, no la nota. La nota 📬 queda en la empresa como contexto (el extracto del mensaje); la acción pendiente está en **Tareas**.
- Si el remitente no corresponde a ningún envío ni a ninguna empresa de Twenty (por ejemplo, una dirección de Gmail), no hay nota, ni tarea, ni oportunidad: el correo queda en tu bandeja.
- **Un interesado no cambia sola la hipótesis.** Si procede, valídala tú.

Cómo funciona por dentro, las garantías y el evento para n8n están en [Triaje del inbound](inbound-triaje.md).

### Seguimiento de lo que has enviado

Hasta ahora, un correo sin respuesta se perdía en silencio. Desde la tanda 21, **el sistema te avisa cuando un envío lleva 5 días laborables sin respuesta**: te deja una tarea en tu bandeja y tú decides qué hacer. `[POR CONFIRMAR]` fecha de activación en producción.

**Cuándo aparece la tarea.** Cada día a las 08:30 el sistema revisa las hipótesis con **Email status** = `Sent` y crea la tarea **🔔 Seguimiento — {empresa}** si se cumplen las tres condiciones:

1. Han pasado **5 días laborables** (de lunes a viernes) desde el primer envío.
1. **No hay ninguna respuesta registrada** de esa empresa.
1. El destinatario **no está en la lista de supresión**.

**Qué lleva la tarea.** Vence el mismo día en que aparece y su cuerpo incluye:

- La **fecha y el asunto** del primer correo que enviaste.
- El **destinatario**.
- El **ángulo de la hipótesis**: qué le propusiste y por qué.
- Un **guion sugerido**, sin urgencia. Es una idea de texto, no un correo enviado. Por ejemplo, en la línea de «retomo mi mensaje de hace unos días por si se te pasó; si el momento no es bueno, dímelo y no te molesto más».

**Qué haces tú.**

1. Abre **Tareas → Tareas · Bandeja** y localiza las que empiezan por 🔔.
1. Lee el cuerpo y decide: escribir de nuevo con el guion (adáptalo), llamar, o dejarlo correr.
1. Si vas a escribir, hazlo **a mano desde tu correo** o con un clic desde Twenty, **tras comprobar la [lista de supresión](#lista-de-supresión-qué-haces-antes-de-enviar)** como siempre.
1. Marca la tarea como hecha (*Done*).

**Qué debes saber.**

- **El sistema no envía nada.** Ni un segundo correo automático ni un recordatorio. La tarea es solo un aviso para ti.
- **Una sola tarea por hipótesis, para siempre.** Si la cierras o la borras, no vuelve a aparecer. Si quieres insistir otra vez, lo decides tú.
- **Si el cliente responde, el aviso se corta.** Si llega una respuesta (interesado, pregunta, no interesado o baja), no hay seguimiento y sigues el camino habitual de [respuestas de los clientes](#respuestas-de-los-clientes).
- **Si la tarea es un falso aviso**, por ejemplo porque contestó otra persona desde otra dirección y el sistema no lo asoció, ciérrala sin más: no pasa nada.
- **Las hipótesis enviadas antes de la tanda 21 pueden generar tareas de golpe** la primera vez que se activa el seguimiento. `[POR CONFIRMAR]` si el sistema limita la antigüedad. Si te llega una avalancha, avisa al equipo técnico.

**Tu tablero de envíos.** La vista **Hipótesis · Envíos** (en **Commercial OS → Hypotheses**) muestra tus hipótesis en columnas por **Email status**: `Draft` (por revisar), `Reviewed` (listas para enviar), `Sending` (en curso) y `Sent` (ya enviadas). Úsala para ver de un vistazo qué te queda por revisar y qué has enviado ya; las enviadas con tarea 🔔 son las que no han contestado.

> **Nota:** la tarea de seguimiento cuenta como cualquier otra de tu bandeja: aparece en la vista **Tareas · Bandeja**, y el sistema nunca la cierra ni la borra.

El detalle técnico está en [Seguimiento de leads enviados](seguimiento-leads.md).


## Estados: cuándo usar cada uno

### Hipótesis

| Estado | Significa | Cuándo lo usas |
|---|---|---|
| `PROPOSED` | Propuesta por el sistema, pendiente de tu revisión. | Lo pone el sistema. No lo pongas tú. |
| `VALIDATED` | La has revisado y la vas a trabajar. | Cuando la hipótesis es buena, tal cual o tras editarla. |
| `REJECTED` | La has revisado y no la vas a trabajar. | Cuando no encaja o no es el momento. |
| `EXPIRED` | Ya no es vigente. | Normalmente lo pone el sistema (ver la nota). A mano, solo si la oportunidad se ha enfriado. |

> **Nota:** desde la tanda 18, el sistema pasa solo a `Expired` las hipótesis `Proposed` cuya feria ha pasado o queda a menos de 45 días. Esa expiración no cuenta como feedback tuyo ni entra en las métricas. Las hipótesis `Validated` nunca se auto-expiran. Si quieres que tu decisión enseñe algo al sistema, usa `Validated` o `Rejected`: un `Expired` puesto a mano no cuenta como veredicto.

### Señales

Las señales de feria nacen en `NEW` y las gestionas tú: el estado que les pones decide si el sistema trabaja esa feria. Consulta [Señales de feria: tu cola de decisión](#señales-de-feria-tu-cola-de-decisión).

| Estado | Significa | Quién lo pone |
|---|---|---|
| `NEW` | Feria descubierta, sin decidir. | El sistema |
| `REVIEWING` | La estás mirando. Opcional: no dispara nada. | Tú |
| `QUALIFIED` | Trabájala: si es del próximo trimestre (de 2 a 6 meses vista), el agente la investiga al momento y la mantiene en el reparto diario. Fuera de plazo se queda esperando, con una tarea ⏳. | Tú |
| `DISCARDED` | Ya no: el sistema no la toca. | Tú |
| `EXPIRED` | La fecha de la feria ya pasó. | Solo el sistema |

> **Nota:** cambiar el estado de una hipótesis no cambia el de su señal.

## Por qué tu feedback importa

> **Activo desde el 2026-10-07.** Tu feedback se captura automáticamente al cambiar el estado de una hipótesis.

El sistema no sabe de verdad si una hipótesis es buena: lo sabes tú. Cada decisión que tomas es una lección para él:

- Cuando **validas** una hipótesis sin tocarla, el sistema entiende que acertó.
- Cuando **editas** campos antes de validar, entiende que acertó en parte y aprende qué corregiste.
- Cuando **rechazas**, entiende que se equivocó.

Con esas decisiones, el equipo técnico ajusta qué expositores prioriza el Prospector, cómo calcula las cantidades y los presupuestos y qué productos recomienda. Cuantas más hipótesis revises, más rápido mejora y menos ruido ves.

Para que el feedback sea útil:

- **Decide siempre**, aunque sea rechazar. Una hipótesis olvidada en `Proposed` no enseña nada.
- **Edita en lugar de rechazar** cuando la idea es buena pero los números no. Así el sistema aprende la corrección exacta.
- **Cambia el estado desde Twenty**, no por otros canales. Es lo que el sistema lee.
- Si quieres dejar el motivo para tus compañeros, añade una nota en la ficha de la hipótesis.

## Preguntas frecuentes

### ¿Validar una hipótesis envía un email al cliente?

No. Validar solo cambia el estado de la hipótesis. El sistema no envía emails por su cuenta: un correo solo sale cuando tú pones `Reviewed` en **Email status** y pulsas **Enviar borrador de email**, o cuando lo envías a mano desde tu correo. Tú decides si contactas, a quién y cómo.

### El sistema se equivocó de contacto

El sistema elige la **dirección de email** (**Email to**) a partir de lo que la empresa publica y crea en **Personas** a quien la web publica con nombre y cargo, pero no decide quién es el decisor: el campo **Decision maker** viene vacío. Si **Email to** no es la dirección adecuada, cámbiala (el sistema no la volverá a tocar) y, si quieres, busca a la persona en **Personas** (o créala) y selecciónala en **Decision maker**. Si el campo ya tiene a alguien que no es, sustitúyelo. Ese cambio cuenta como una edición.

### ¿Por qué mis hipótesis no aparecen en Oportunidades?

Porque una hipótesis es una propuesta del sistema, no un trato. A **Oportunidades** solo llegan los tratos con tracción: cuando [alguien responde con interés](#personas-y-oportunidades) o cuando decides promocionar una hipótesis concreta. Así el pipeline refleja negocio real.

### La empresa ya es cliente

En esta versión, el sistema no comprueba si una empresa ya es cliente de PubliEXPE. Decide según el caso:

- **Es una cuenta tuya y el evento es una buena ocasión de venderle más:** valida la hipótesis y trabájala.
- **Es una cuenta de otro comercial:** avísale y, si la lleva él, rechaza la hipótesis.
- **El cliente no necesita nada:** rechaza.

En cualquier caso, tu decisión enseña al sistema qué empresas no debe proponer.

### Veo duplicados

Distingue dos casos:

- **La misma empresa con varias hipótesis de eventos distintos.** Es normal: hay una hipótesis por empresa y evento.
- **La misma empresa y el mismo evento dos veces.** No debería ocurrir: el sistema evita repetirlos. Si lo ves, no borres nada. Anota el nombre de la hipótesis y avisa al equipo técnico.

### Hoy no hay hipótesis nuevas

Abre **Commercial OS → Agent runs** y mira la ejecución de hoy:

- **Skipped:** no tienes ninguna feria en `QUALIFIED` vigente y dentro de plazo (de 2 a 6 meses vista), así que no había nada que trabajar. Es lo esperado hasta que califiques alguna. Si calificaste una y no pasó nada, mira si tienes la [tarea ⏳](#qué-ferias-calificar-las-del-próximo-trimestre) en tu bandeja: está fuera de plazo.
- **Success** y 0 hipótesis nuevas: las ferias calificadas no tenían expositores nuevos con encaje, o ya estaban registrados. El campo **Result** detalla cuántos se descartaron y por qué.
- **Partial** o **Failed**: algo falló. Avisa al equipo técnico e indica la fecha.
- **No hay ejecución de hoy:** avisa al equipo técnico.

### ¿Son fiables las cantidades y los presupuestos?

Son estimaciones del sistema basadas en el tamaño de la empresa y del evento. Úsalos como punto de partida y corrígelos con lo que sepas. El presupuesto no incluye IVA y no es un presupuesto formal.

### ¿Cuánto cuesta esto?

El sistema usa un modelo de inteligencia artificial de pago por uso. Una ejecución del Prospector cuesta unos **0,006 €** por cada tres expositores analizados (cifra medida con un evento de ejemplo). El coste crece con el número de expositores y de ferias calificadas; si no hay ninguna, la tarea diaria no gasta nada. El descubrimiento semanal de ferias cuesta unos **0,07 € por sector y semana**: con los seis sectores, unos 0,42 € a la semana. Puedes ver el coste real de cada ejecución en el campo **Cost** de **Commercial OS → Agent runs**.

### ¿Qué es la "traza" (*Trace*) de una ejecución?

Es el registro detallado de cada paso que dio el sistema. Es una herramienta para el equipo técnico: no la necesitas en tu rutina.

## Siguientes pasos

- Si eres del equipo técnico, consulta el [runbook de operación local](runbook-local.md).
- Para entender el diseño completo del sistema, consulta el [LLD v0.1](LLD-0.1-publiexpe-commercial-os.md) y la [especificación del MVP-0](LLD-0.2-especificacion.md).
