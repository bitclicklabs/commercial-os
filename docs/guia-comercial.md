# Guía del equipo comercial

Esta guía explica cómo trabajar cada día con PubliEXPE Commercial OS desde Twenty, sin necesidad de conocimientos técnicos. En unos 10 minutos al día revisas las oportunidades que el sistema ha preparado para ti, y decides cuáles merecen tu tiempo.

El sistema propone; tú decides. El sistema nunca contacta con nadie por su cuenta: todo envío lo lanzas tú.

## Contenido

1. [Qué hace el sistema por ti](#qué-hace-el-sistema-por-ti)
1. [Dónde mirar en Twenty](#dónde-mirar-en-twenty)
1. [Cómo leer una hipótesis](#cómo-leer-una-hipótesis)
1. [Tu rutina diaria de 10 minutos](#tu-rutina-diaria-de-10-minutos)
1. [Borradores de email](#borradores-de-email)
1. [Estados: cuándo usar cada uno](#estados-cuándo-usar-cada-uno)
1. [Por qué tu feedback importa](#por-qué-tu-feedback-importa)
1. [Preguntas frecuentes](#preguntas-frecuentes)

## Qué hace el sistema por ti

El sistema es un equipo de agentes automáticos que prepara el trabajo de prospección y deja el resultado en Twenty. Tú no ejecutas nada: abres Twenty y el trabajo ya está hecho.

### Cada mañana a las 08:00

El agente **Prospector** analiza los expositores de un evento (feria, congreso o evento sectorial) y, para cada uno, decide si PubliEXPE puede venderle merchandising con motivo de ese evento. Para cada expositor con encaje:

- Localiza o crea la **empresa** en Twenty.
- Registra una **señal** (*Signal*): el hecho que justifica el contacto, por ejemplo "expone en Expo Alimentaria el 24 de noviembre". Nace en estado `NEW`.
- Redacta una **hipótesis** (*Hypothesis*): qué podría necesitar la empresa, por qué ahora, cuántas unidades, qué presupuesto y qué productos encajan. Nace en estado `PROPOSED`, a la espera de tu revisión.

Al terminar, deja un **resumen de la ejecución** (*Agent run*) con lo que ha hecho y lo que ha costado.

El sistema solo registra hipótesis con una confianza igual o superior a 0,50. Los expositores dudosos o sin encaje no llegan a Twenty.

> **Nota:** la tarea diaria trabaja con la lista de expositores configurada (hoy incluye datos de demostración, reconocibles por dominios `.example`). El scouting de los lunes sí busca por su cuenta: localiza ferias reales del sector, lee sus catálogos de expositores y crea empresas reales con su señal e hipótesis. Los registros de demostración se reconocen porque el dominio de la empresa termina en `.example`. Ignóralos o recházalos.

### Los lunes a las 07:30

> **Activo desde el 2026-10-07.** La primera ejecución automática es el lunes siguiente a las 07:30.

Cada lunes, el sistema busca ferias y eventos reales relevantes para PubliEXPE, lee el catálogo de expositores completo y deja en Twenty las empresas con encaje, con su señal y su hipótesis en `Proposed`. Lo verás reflejado en **Commercial OS → Signals**, en **Commercial OS → Hypotheses** y en **Commercial OS → Agent runs**. La ejecución tiene un límite de 20 minutos: si un catálogo es muy grande, el resumen de la ejecución (*Agent run*) sale como `Partial` e indica en qué fase se cortó. Lo ya evaluado se guarda igualmente.

### Lo que el sistema no hace

- **No envía emails ni mensajes por su cuenta.** Un correo solo sale cuando tú revisas el borrador y pulsas el envío.
- **No contacta con decisores.** Elegir a quién escribir y cuándo es cosa tuya.
- **No cambia etapas de oportunidad ni crea presupuestos.**
- **No borra nada.**

El sistema sí prepara **borradores de email** cuando validas una hipótesis, pero nunca los envía: los revisas y los envías tú, con un clic desde Twenty o a mano desde tu correo. Consulta [Borradores de email](#borradores-de-email).

## Dónde mirar en Twenty

Abre Twenty (`http://localhost:3020` en el entorno local) y localiza en la barra lateral izquierda la carpeta **Commercial OS**. Contiene cuatro entradas, en este orden.

| Entrada | Qué es | Quién la escribe | Qué haces tú |
|---|---|---|---|
| **Commercial OS → Signals** | Hechos que justifican un contacto: una feria, un lanzamiento, una contratación. | El sistema | Revisarlas y clasificarlas (opcional pero recomendable). |
| **Commercial OS → Research** | Investigación de apoyo sobre una empresa o señal. | El sistema | Consultarla cuando exista. El Prospector actual no la rellena, así que hoy suele estar vacía. |
| **Commercial OS → Hypotheses** | Las propuestas comerciales: qué vender, a quién y por qué ahora. | El sistema | **Validarlas, editarlas o rechazarlas. Es tu tarea diaria.** |
| **Commercial OS → Agent runs** | Un resumen por cada ejecución del sistema: qué hizo, si fue bien y cuánto costó. | El sistema | Solo lectura. Sirve para saber si hoy se ha ejecutado todo. |

### Vistas útiles

- En **Hypotheses**, abre la vista **By status**. Muestra un tablero con una columna por estado (`Proposed`, `Validated`, `Rejected`, `Expired`). Tu trabajo diario está en la columna `Proposed`.
- En **Signals**, abre la vista **Recent signals**. Muestra primero las señales detectadas más recientemente.
- Cambia de vista desde el selector de vistas de la parte superior de la lista.

### Cómo se relacionan

Cada **hipótesis** está enlazada a una **empresa** y a la **señal** que la originó. Desde la ficha de una empresa de Twenty también ves sus señales, hipótesis y ejecuciones. Úsalo para tener todo el contexto de una cuenta en un solo sitio.

> **Nota:** en **Agent runs** no puedes crear ni editar registros. Es intencionado: son el registro de lo que hizo el sistema.

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
| **Decision maker** | La persona de contacto recomendada. En esta versión el sistema **no la rellena**: la eliges tú. |
| **Status** | En qué punto del proceso está. Ver [Estados](#estados-cuándo-usar-cada-uno). |

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

1. Abre Twenty y ve a **Commercial OS → Agent runs**. Comprueba que hay una ejecución de hoy. Si el resultado (*Outcome*) es `Failed` o `Partial`, avisa al equipo técnico (consulta [Preguntas frecuentes](#preguntas-frecuentes)).
1. Ve a **Commercial OS → Hypotheses** y abre la vista **By status**.
1. En la columna `Proposed`, empieza por las hipótesis con **Timing** `IMMEDIATE` y **Confidence** más alta.
1. Abre cada hipótesis y lee `Need`, `Why now`, `Evidence` y los importes. Decide una de estas tres acciones.

   | Acción | Cuándo | Cómo |
   |---|---|---|
   | **Validar** | La hipótesis es buena tal como está y vas a trabajarla. | Cambia **Status** a `Validated`. |
   | **Editar y validar** | Es buena, pero hay que corregir algo: cantidades, presupuesto, productos, el enfoque. | Corrige los campos y después cambia **Status** a `Validated`. |
   | **Rechazar** | No encaja: empresa equivocada, ya es cliente de otro comercial, no es el momento, es un competidor. | Cambia **Status** a `Rejected`. |

   Puedes cambiar el estado abriendo la hipótesis y editando el campo **Status**, o arrastrando la tarjeta a otra columna del tablero **By status**.

1. Para cada hipótesis validada, decide tú el siguiente paso: a quién escribir, por qué canal y con qué mensaje. Busca o crea el contacto en Twenty y enlázalo en **Decision maker**.
1. Opcional: en **Commercial OS → Signals**, marca las señales que has revisado (consulta [Estados de señal](#señales)).

> **Importante:** validar una hipótesis **no envía ningún email** ni avisa a nadie. Solo significa "esta hipótesis es buena y la voy a trabajar yo". El contacto con el cliente lo decides y lo ejecutas tú. Esto es así por diseño: en el sistema, toda acción con efecto hacia fuera (enviar un email, contactar con un decisor) exige una persona.

### Qué pasa con cada acción

| Acción | Qué ocurre en Twenty | Qué ocurre además |
|---|---|---|
| **Validar** | La hipótesis pasa a `Validated`. | Cuenta como una hipótesis **aceptada** para el sistema (consulta [Por qué tu feedback importa](#por-qué-tu-feedback-importa)). El sistema prepara un [borrador de email](#borradores-de-email). No se envía nada. |
| **Editar y validar** | Se guardan tus cambios y la hipótesis pasa a `Validated`. | Cuenta como **editada**: el sistema aprende de lo que corriges. El sistema prepara un [borrador de email](#borradores-de-email) con tus datos corregidos. No se envía nada. |
| **Rechazar** | La hipótesis pasa a `Rejected` y sale de tu cola. | Cuenta como **descartada**. No se borra ni se avisa a nadie. |
| **No hacer nada** | La hipótesis sigue en `Proposed`. | El sistema no aprende nada de ella. |

> **Precaución:** no borres registros de hipótesis, señales ni empresas, ni siquiera los que te parezcan erróneos. Rechaza la hipótesis o descarta la señal. Borrar un registro elimina la información que el sistema necesita para mejorar.

## Borradores de email

Cuando validas una hipótesis, el sistema prepara un borrador del primer email para esa empresa. Esto ocurre tanto si la validas tal cual como si la editas antes de validarla: en ese segundo caso, el borrador usa los datos que has corregido (cantidades, presupuesto, productos o enfoque).

El borrador es solo una propuesta de texto: **el sistema no envía nada por su cuenta, nunca**. El correo sale cuando tú lo revisas y lo lanzas, y puedes hacerlo de dos formas:

| Forma | Cuándo la usas |
|---|---|
| [Enviar desde Twenty con un clic](#enviar-desde-twenty-con-un-clic) | Es la forma habitual. El correo sale desde tu buzón `jesus.abril@publiexpe.info`, conectado a Twenty. |
| [Enviar a mano desde tu correo](#alternativa-enviar-a-mano-desde-tu-correo) | Si el envío desde Twenty no está disponible, o si prefieres escribir desde el webmail (por ejemplo, para usar el otro buzón). |

En las dos formas se aplican las mismas reglas: [lista de supresión](#lista-de-supresión-qué-haces-antes-de-enviar) y [Qué no haces](#qué-no-haces).

### Dónde aparece el borrador

El borrador aparece en dos sitios:

- **En la hipótesis**, en los campos **Email to** (destinatario), **Email subject** (asunto) y **Email body** (cuerpo), con **Email status** = `Draft`. Es donde lo revisas y lo envías.
- **Como una nota en la empresa**, con el título "Borrador email — ...". Es una copia de referencia: se crea siempre, aunque no uses el envío desde Twenty.

> **Nota:** edita el borrador **en la hipótesis**, no en la nota. Lo que envía Twenty son los campos de la hipótesis.

### Enviar desde Twenty con un clic

> **Activo desde el 2026-10-07.** Tu buzón está conectado a Twenty y el flujo de envío está activado. Los detalles técnicos están en [Enviar los borradores desde Twenty](twenty-envio-email.md).

En cada hipótesis validada:

1. Abre la hipótesis y lee **Email subject** y **Email body**. Corrige lo que haga falta **en la hipótesis**, no en la nota. No quites la línea de baja ni la firma.
1. Comprueba **Email to**. Si está vacío, escribe la dirección del destinatario (una dirección de rol, como `compras@`, si no hay un decisor identificado).
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
- **No tienes histórico del correo en la ficha de la empresa.** Queda `Sent` en la hipótesis y el registro del envío en **Workflows → Runs**.
- **Cuenta tus envíos del día.** En **Hypotheses**, filtra por **Email status** = `Sent` y por fecha de actualización.

### Alternativa: enviar a mano desde tu correo

Usa esta forma si el envío desde Twenty no está disponible. El sistema deja el mismo borrador en la nota de la empresa.

1. Abre la nota "Borrador email — ..." de la empresa de la hipótesis que acabas de validar.
1. **Lee el borrador completo.** Revísalo siempre, aunque la hipótesis te parezca buena.
1. Personaliza lo que haga falta: saludo, nombre de la persona, referencia al evento, cantidades o tono. Comprueba que los datos son correctos.
1. Antes de enviar, comprueba que el destinatario no está en la lista de supresión (consulta el apartado siguiente).
1. Copia el texto a un correo nuevo. Envíalo desde `jesus.abril@publiexpe.info` o `j.abril@publiexpe.info`.
1. Comprueba que el correo lleva tu identificación y la línea de baja con `baja@publiexpe.info`.

### Lista de supresión: qué haces antes de enviar

1. **Antes de enviar cualquier correo en frío**, abre en Twenty la nota `Lista de supresión — NO contactar` (búscala por "supresión") y comprueba que ni la dirección ni el dominio del destinatario aparecen. Si aparecen, no envíes ni vuelvas a contactar nunca.
1. **Toda petición de baja** (una respuesta a tu correo o un mensaje a `baja@publiexpe.info`) acaba como una línea nueva al final de la nota, con el formato `email — fecha — motivo`. El sistema revisa el buzón cada 2 horas y añade las bajas que detecta. Si recibes una petición de baja y todavía no está en la nota, añádela tú **el mismo día**.
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

## Estados: cuándo usar cada uno

### Hipótesis

| Estado | Significa | Cuándo lo usas |
|---|---|---|
| `PROPOSED` | Propuesta por el sistema, pendiente de tu revisión. | Lo pone el sistema. No lo pongas tú. |
| `VALIDATED` | La has revisado y la vas a trabajar. | Cuando la hipótesis es buena, tal cual o tras editarla. |
| `REJECTED` | La has revisado y no la vas a trabajar. | Cuando no encaja o no es el momento. |
| `EXPIRED` | Ya no es vigente. | Cuando el evento ya pasó y nadie actuó, o la oportunidad se ha enfriado. |

> **Nota:** hoy ningún proceso automático caduca las hipótesis. Marca `Expired` manualmente las que sigan en `Proposed` cuando el evento haya pasado.

### Señales

El sistema crea todas las señales en `NEW`. A partir de ahí, las clasificas tú. Es opcional, pero mantiene la lista ordenada.

| Estado | Significa | Cuándo lo usas |
|---|---|---|
| `NEW` | Detectada, sin revisar. | Lo pone el sistema. |
| `REVIEWING` | La estás mirando. | Cuando empiezas a trabajar la señal y no has decidido todavía. |
| `QUALIFIED` | Señal real e interesante: merece seguimiento. | Cuando confirmas que el hecho es cierto y es relevante. |
| `DISCARDED` | No sirve. | Cuando el dato es erróneo o irrelevante para PubliEXPE. |
| `EXPIRED` | Ha perdido vigencia. | Cuando el evento ya se celebró o el momento pasó. |

> **Nota:** cambiar el estado de una hipótesis no cambia el de su señal. Actualiza la señal tú si quieres que la lista refleje tu decisión.

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

En esta versión, el sistema no elige contacto: el campo **Decision maker** viene vacío. Busca a la persona adecuada en **People** (o créala), y selecciónala en **Decision maker**. Si el campo ya tiene a alguien que no es, sustitúyelo. Cuando la captura de feedback esté activa, ese cambio contará como una edición.

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

- **Success** y 0 hipótesis nuevas: el evento no tenía expositores con encaje, o ya estaban registrados. El campo **Result** detalla cuántos se descartaron y por qué.
- **Partial** o **Failed**: algo falló. Avisa al equipo técnico e indica la fecha.
- **No hay ejecución de hoy:** avisa al equipo técnico.

### ¿Son fiables las cantidades y los presupuestos?

Son estimaciones del sistema basadas en el tamaño de la empresa y del evento. Úsalos como punto de partida y corrígelos con lo que sepas. El presupuesto no incluye IVA y no es un presupuesto formal.

### ¿Cuánto cuesta esto?

El sistema usa un modelo de inteligencia artificial de pago por uso. Cada ejecución del Prospector cuesta aproximadamente **0,006 €** con un evento de ejemplo de tres expositores. El coste crece con el número de expositores analizados. Puedes ver el coste real de cada ejecución en el campo **Cost** de **Commercial OS → Agent runs**.

### ¿Qué es la "traza" (*Trace*) de una ejecución?

Es el registro detallado de cada paso que dio el sistema. Es una herramienta para el equipo técnico: no la necesitas en tu rutina.

## Siguientes pasos

- Si eres del equipo técnico, consulta el [runbook de operación local](runbook-local.md).
- Para entender el diseño completo del sistema, consulta el [LLD v0.1](LLD-0.1-publiexpe-commercial-os.md) y la [especificación del MVP-0](LLD-0.2-especificacion.md).
