# Plan de warm-up del canal de email

Este documento describe cómo calentar (*warm-up*) los buzones de envío en frío de PubliEXPE durante las primeras cuatro semanas, qué vigilar cada semana y cuándo endurecer la política DMARC. Está pensado para el operador del sistema y para el equipo comercial que envía los correos.

El warm-up es manual: IONOS no incluye ninguna herramienta que lo haga por ti. El sistema no envía ningún correo por su cuenta: los envíos los haces tú, desde el webmail o con un clic desde Twenty (consulta [Los envíos desde Twenty cuentan](#los-envíos-desde-twenty-cuentan)).

## Contenido

1. [Estado del canal](#estado-del-canal)
1. [Reglas de oro](#reglas-de-oro)
1. [Calendario de 4 semanas](#calendario-de-4-semanas)
1. [Cómo hacer el warm-up](#cómo-hacer-el-warm-up)
1. [Qué vigilar](#qué-vigilar)
1. [Alta en Microsoft SNDS](#alta-en-microsoft-snds)
1. [Hito del 2026-11-03: pasar DMARC a quarantine](#hito-del-2026-11-03-pasar-dmarc-a-quarantine)
1. [Gestión de bajas y lista de supresión](#gestión-de-bajas-y-lista-de-supresión)
1. [Checklist diaria de 5 minutos](#checklist-diaria-de-5-minutos)
1. [Checklist semanal](#checklist-semanal)
1. [Después del warm-up](#después-del-warm-up)
1. [Referencias](#referencias)

## Estado del canal

Todo lo siguiente está configurado y verificado desde el 2026-10-06. Las decisiones de diseño están en la [sección 10 del LLD v0.1](LLD-0.1-publiexpe-commercial-os.md#10-email-canal-de-envío-e-inbound-c3).

| Elemento | Valor |
|---|---|
| Dominio de envío en frío | `publiexpe.info` (aparte del principal `publiexpe.com`, para proteger su reputación) |
| Proveedor | IONOS |
| Buzones de envío (basic) | `jesus.abril@publiexpe.info` y `j.abril@publiexpe.info` |
| Redirecciones | `dmarc@publiexpe.info` y `baja@publiexpe.info` hacia `jesus.abril@publiexpe.info` |
| SPF | Configurado con el asistente de IONOS |
| DKIM | Activado a nivel de dominio; firma todos los buzones |
| DMARC | `p=none` con `rua=mailto:dmarc@publiexpe.info` |
| Web | Mínima, publicada en `https://publiexpe.info`, con aviso legal y privacidad |
| Google Postmaster Tools | Alta del dominio verificada |
| Autenticación | SPF, DKIM y DMARC comprobados con `PASS` contra Gmail |
| Inicio del warm-up | 2026-10-06 |
| Envío desde Twenty | Operativo desde 2026-10-07 con el SMTP de `jesus.abril@publiexpe.info` ([guía](twenty-envio-email.md)) |

### Límites de envío de IONOS

| Antigüedad del buzón | Límite |
|---|---|
| Primeros 7 días | 50 correos por hora |
| Más de 30 días | 500 por hora |

> **Importante:** los volúmenes de este plan están muy por debajo de esos límites. Aun así, no los superes nunca: un buzón bloqueado por exceso de envíos retrasa todo el calendario. Los correos enviados desde Twenty salen por el mismo SMTP de IONOS y cuentan para estos límites.

## Reglas de oro

1. **Nunca hagas prospección en frío desde `@publiexpe.com`.** La reputación del dominio principal sostiene el correo corporativo; si se daña, afecta a toda la empresa. El frío sale siempre desde `@publiexpe.info`.
1. **Identifícate en cada correo de prospección:** nombre real, cargo, empresa y datos de contacto en la firma.
1. **Incluye siempre la línea de baja** con la dirección `baja@publiexpe.info`. Nunca la quites ni la reformules para que pase desapercibida.
1. **Procesa toda baja de inmediato** y apúntala en la lista de supresión (consulta [Gestión de bajas](#gestión-de-bajas-y-lista-de-supresión)). No vuelvas a escribir a esa persona ni a esa dirección.
1. **No superes los límites de IONOS** ni el ritmo del calendario. Si dudas, envía menos.
1. **No uses el píxel de apertura** ni enlaces acortados en correos en frío. La métrica útil es la respuesta, no la apertura.
1. **Pausa el envío si ves una señal de problema** (consulta [Señales de problema](#señales-de-problema)) y avisa al operador antes de reanudar.

## Calendario de 4 semanas

Las semanas empiezan en martes porque el warm-up arrancó el 2026-10-06. Los volúmenes son por día laborable. Descansa fines de semana: un patrón de envío humano y regular ayuda a la reputación.

### Semanas 1 y 2: pocos correos, todos con respuesta

Escribe solo a contactos que van a contestar: compañeros, familiares, clientes de confianza y cuentas propias en Gmail y Outlook. Total entre los dos buzones.

| Semana | Fechas | Volumen diario (total, ambos buzones) | Reparto |
|---|---|---|---|
| 1 | 2026-10-06 a 2026-10-12 | 10 el primer y segundo día; después, subida gradual hasta 20 | Mitad en cada buzón |
| 2 | 2026-10-13 a 2026-10-19 | 15 a 20 | Mitad en cada buzón |

### Semanas 3 y 4: subida gradual

Sube el volumen poco a poco y mantén la proporción de respuestas. Las cifras son por buzón.

| Semana | Fechas | Volumen diario por buzón | Total aproximado |
|---|---|---|---|
| 3 | 2026-10-20 a 2026-10-26 | Empieza en 15 el martes y sube 3 a 5 correos por día hasta llegar a 25-30 | 30 a 60 |
| 4 | 2026-10-27 a 2026-11-02 | 30 a 40 | 60 a 80 |

> **Nota:** no subas más de un 30 % de un día para otro. Si un día hay señales de problema, no avances: repite el volumen del día anterior o baja.

### Hito

El **2026-11-03** (martes) se revisan los informes DMARC y, si están limpios, se endurece la política. Consulta [Hito del 2026-11-03](#hito-del-2026-11-03-pasar-dmarc-a-quarantine).

## Cómo hacer el warm-up

### Reparte entre los dos buzones

1. Alterna los buzones: la mitad de los correos del día sale de `jesus.abril@publiexpe.info` y la otra mitad de `j.abril@publiexpe.info`.
1. Cada buzón tiene que enviar a destinatarios distintos. Evita que los dos escriban a la misma persona el mismo día.

### Varía horas y destinatarios

1. Reparte los envíos a lo largo del día, en horario laboral (por ejemplo, entre las 09:00 y las 18:00). No envíes todo de golpe.
1. Cambia la hora cada día. Un patrón idéntico (siempre a las 10:00 en punto) parece automatizado.
1. Escribe a destinatarios de proveedores distintos: Gmail, Outlook, dominios corporativos y, si puedes, otros proveedores.
1. Escribe correos distintos entre sí, con asuntos y textos diferentes. No copies y pegues el mismo mensaje.

### Los envíos desde Twenty cuentan

Los correos que envías con **Enviar borrador de email** en Twenty salen por el mismo buzón y el mismo servidor SMTP de IONOS que los del webmail. Para IONOS y para los proveedores de destino no hay diferencia, así que **cuentan en el calendario** igual que los demás.

1. Suma los envíos desde Twenty y desde el webmail para comprobar el volumen del día frente a la tabla de la semana. En Twenty, filtra **Hypotheses** por **Email status** = `Sent` y por fecha de actualización.
1. Consulta el bloque **Email** del dashboard local del runtime (`http://127.0.0.1:4020/dashboard`) para ver la actividad de envío junto al resto de métricas.
1. Cada clic envía un solo correo, de uno en uno. No lo uses para recuperar volumen de golpe.
1. Twenty envía desde tu buzón conectado, `jesus.abril@publiexpe.info`. Para repartir el volumen entre los dos buzones, sigue enviando desde el webmail con `j.abril@publiexpe.info`.
1. Si conectaste solo SMTP (lo recomendado), el correo enviado desde Twenty **no aparece en *Enviados*** del webmail de IONOS. Cuéntalo igualmente.

Los pasos para enviar están en la [guía del equipo comercial](guia-comercial.md#enviar-desde-twenty-con-un-clic) y los detalles técnicos en [Enviar los borradores desde Twenty](twenty-envio-email.md).

### Busca respuestas

Las respuestas son la señal más fuerte de reputación positiva. Para conseguirlas:

1. Pide por adelantado a los contactos cercanos que contesten a tus correos, aunque sea con una línea.
1. Escribe mensajes que invitan a responder: una pregunta sencilla, una petición de opinión, una confirmación.
1. Responde tú a las respuestas. Mantener la conversación en hilo refuerza la señal.
1. Pide que saquen el correo de la carpeta de spam y lo marquen como "No es spam" si ocurre.

> **Nota:** durante las semanas 1 y 2 no hagas prospección real. Reserva los contactos desconocidos para después del warm-up.

## Qué vigilar

### Informes DMARC en `dmarc@`

DMARC envía informes agregados diarios al buzón `dmarc@publiexpe.info`, que redirige a `jesus.abril@publiexpe.info`. Llegan de grandes proveedores (por ejemplo, Google) como un adjunto comprimido (`.zip` o `.gz`) con un archivo XML. Cada informe resume los correos que esos proveedores han recibido en nombre de `publiexpe.info`. No contienen el texto de los correos.

Cómo leerlos por encima:

1. Descomprime el adjunto y abre el XML con un editor de texto.
1. Busca cada bloque `<record>`. Contiene la IP de origen (`source_ip`), el número de mensajes (`count`) y el resultado de la evaluación (`policy_evaluated`).
1. Comprueba que `dkim` y `spf` dentro de `policy_evaluated` valen `pass` en tus envíos legítimos.
1. Reconoce tus IP: las de IONOS. Una IP desconocida que envía como `publiexpe.info` es un problema (suplantación o un servicio mal configurado).

Qué es un fallo de alineamiento (*alignment fail*):

- DMARC no solo exige que SPF o DKIM den `pass`. Exige que el dominio que se autentica **coincida** con el dominio del remitente visible (`From`). Esa coincidencia es el alineamiento.
- Un fallo de alineamiento significa que SPF o DKIM pueden dar `pass` por sí mismos, pero con un dominio distinto al del `From`. Para DMARC, eso cuenta como fallo.
- Con `p=none` un fallo no tiene consecuencias. Con `p=quarantine` esos correos irían a spam. Por eso se revisan antes de endurecer.

Qué considerar limpio: todos tus envíos aparecen con `dkim` o `spf` en `pass` y alineados, y no hay IP desconocidas con volumen relevante.

### Google Postmaster Tools

1. Abre [Google Postmaster Tools](https://postmaster.google.com) y selecciona `publiexpe.info`.
1. Mira la **Reputación del dominio**. El objetivo es `Alta` o `Media`. `Baja` o `Mala` exige parar y analizar.
1. Mira la **Tasa de spam** y los **Errores de entrega**. Deben ser cero o muy bajos.

> **Nota:** Postmaster Tools no muestra datos hasta que el dominio alcanza un volumen mínimo diario hacia Gmail. Durante las primeras semanas es normal que aparezca vacío. El LLD v0.1 también menciona Microsoft SNDS como fuente de monitorización, pero con IONOS compartido no puedes usarlo: consulta [Alta en Microsoft SNDS](#alta-en-microsoft-snds) para ver qué haces en su lugar.

### Señales de problema

Para y avisa al operador si ocurre cualquiera de estas situaciones:

| Señal | Qué indica | Qué haces |
|---|---|---|
| Rebotes (*bounces*) con código 5xx | Dirección inexistente o bloqueo. | Elimina la dirección de tus listas. Si hay varios, pausa y revisa. |
| Un correo de prueba a tu Gmail u Outlook cae en spam | El filtro ya penaliza el dominio. | Pausa los envíos 24 horas y repite la prueba. Revisa SPF, DKIM y DMARC. |
| Mensaje de bloqueo de IONOS o del proveedor del destinatario | Superación de límites o listado en una blacklist. | Pausa, anota el mensaje exacto y avisa al operador. |
| Reputación en Postmaster `Baja` o `Mala` | Muchas quejas o rechazos. | Pausa y vuelve al volumen de la semana 1. |
| IP desconocida en un informe DMARC | Suplantación o servicio mal configurado. | Avisa al operador antes de endurecer DMARC. |
| Nadie responde en varios días | Los correos pueden no llegar a la bandeja. | Haz una prueba de colocación (consulta la [checklist semanal](#checklist-semanal)). |

### Prueba de colocación

1. Envía un correo desde cada buzón a una cuenta de Gmail y a una de Outlook que controles.
1. Comprueba si llega a la bandeja principal o a spam.
1. En Gmail, abre el menú del mensaje y elige **Mostrar original**. Verifica que SPF, DKIM (`d=publiexpe.info`) y DMARC muestran `PASS`.

## Alta en Microsoft SNDS

Microsoft ofrece [Smart Network Data Services (SNDS)](https://sendersupport.olc.protection.outlook.com/snds/) para ver la reputación de tus IP de envío en Outlook.com y Hotmail. El LLD v0.1 lo propone como fuente de monitorización. Esta sección explica cómo se da de alta y, sobre todo, qué puedes hacer de verdad con IONOS correo compartido.

### Qué es SNDS y por qué no encaja con IONOS compartido

SNDS funciona **por IP, no por dominio**. Para ver los datos de una IP tienes que demostrar que eres responsable de ella:

1. Entras en SNDS con una cuenta Microsoft.
1. Solicitas acceso a una IP o a un rango de IP.
1. Microsoft envía un correo de autorización a contactos vinculados al registro de esa IP (los datos de propiedad del rango, no los del dominio de tu correo).
1. Aprobada la solicitud, el acceso caduca a los 10 meses y hay que volver a confirmarlo.

Con IONOS correo compartido, tus correos salen por servidores de IONOS (por ejemplo, `mout.kundenserver.de`) cuyas IP son de IONOS y las usan muchos clientes a la vez ([IP de los servidores de correo de IONOS](https://www.ionos.com/help/email/postmaster/ip-addresses-of-the-11-ionos-mail-servers/)). Tú no controlas esas IP ni su registro, así que **no puedes completar el paso 3**: el correo de autorización iría a contactos de IONOS, no a ti.

> **Importante:** no hemos encontrado ninguna página oficial de Microsoft que diga de forma expresa "SNDS no admite IP compartidas". La página de SNDS solo describe la autorización por IP. Las fuentes de terceros sobre deliverability coinciden en que, sin control de la IP, no hay acceso ([Suped](https://www.suped.com/knowledge/email-deliverability/tools/how-to-get-microsoft-snds-access-when-using-an-email-service-provider), [Trulyinbox](https://www.trulyinbox.com/blog/microsoft-snds/)). Trátalo como "no disponible para nosotros" y no inviertas más tiempo.

Esto tiene dos consecuencias:

- **No hay datos de reputación de IP** en SNDS para tus envíos. Los datos de las IP de IONOS, si alguien los ve, son de IONOS.
- **No hay feedback de quejas.** El programa de quejas de Microsoft (JMRP) forma parte de SNDS y también se vincula a IP. No recibirás aviso cuando un usuario de Outlook marque tu correo como spam.

SNDS tampoco ofrece datos por dominio. Por eso, aunque IONOS te diera acceso, no sustituiría a Google Postmaster Tools. No hemos encontrado una herramienta de Microsoft equivalente a Postmaster Tools que muestre la reputación de un dominio propio.

### Cuándo sí aplicaría SNDS

Solo si en el futuro envías desde IP que controlas: una IP dedicada contratada a IONOS u otro proveedor que te delegue la IP, o un servicio de envío con IP dedicada que te dé acceso. En ese caso:

1. Abre [SNDS](https://sendersupport.olc.protection.outlook.com/snds/) e inicia sesión con una cuenta Microsoft.
1. Solicita acceso a tu IP o rango.
1. Confirma la autorización en el correo que Microsoft envía a los contactos del registro de la IP.
1. Anota en el calendario la reconfirmación a los 10 meses.

Hasta entonces, no te des de alta: no vas a conseguir datos.

### Qué haces en su lugar

Sin SNDS, vigilas Outlook de forma manual con estas cuatro acciones. Son más pobres que SNDS: dan señales, no métricas.

#### 1. Prueba de colocación casera con cuentas propias de Outlook

1. Crea o reutiliza al menos dos cuentas que controles: una de Outlook.com o Hotmail y, si puedes, otra de Microsoft 365 empresarial.
1. Cada semana (consulta la [checklist semanal](#checklist-semanal)), envía un correo desde cada buzón de `publiexpe.info` a esas cuentas. Usa asuntos y textos distintos, como en el warm-up.
1. Comprueba si el correo llega a **Recibidos**, a **Otros** o a **Correo no deseado**. Anótalo en una tabla simple con fecha, buzón de origen, cuenta de destino y carpeta.
1. Si cae en correo no deseado, márcalo como **No es correo no deseado**, responde al mensaje y añade el remitente a contactos seguros. Esa interacción ayuda a la reputación.
1. Si cae en correo no deseado dos pruebas seguidas, aplica la fila correspondiente de [Señales de problema](#señales-de-problema).

> **Nota:** esta prueba no sustituye a un servicio de *seed testing* profesional. Con dos o tres cuentas es solo un termómetro: un resultado aislado no es concluyente.

#### 2. Lee las cabeceras del correo recibido en Outlook

1. En la cuenta de Outlook de prueba, abre el mensaje y elige **Ver origen del mensaje** (o equivalente).
1. Busca `Authentication-Results` y comprueba que `spf`, `dkim` y `dmarc` valen `pass`.
1. Busca las cabeceras `X-Forefront-Antispam-Report` y `X-Microsoft-Antispam`. Contienen, entre otros, `SCL` (probabilidad de spam), `BCL` (reputación del remitente masivo), `SFV` (resultado del filtro) y `CAT` (categoría). Un `SFV:SPM` o un `SCL` alto indica que Microsoft considera el correo spam.

> **Nota:** estas cabeceras son una ayuda de diagnóstico y su significado exacto lo define Microsoft. Úsalas para comparar un día con otro, no para fijar umbrales.

#### 3. Sigue rebotes y bloqueos a mano

1. Revisa a diario los avisos de rechazo (*bounce*) que llegan a los buzones de envío. Fíjate en los que vienen de `*.protection.outlook.com`.
1. Anota el código completo (por ejemplo, `550 5.7.1`) y el texto exacto del mensaje.
1. Un rechazo con código `5.7.1` y mención a "block list" indica que Microsoft bloquea la **IP de IONOS**, no tu dominio. Pausa el envío a destinos de Microsoft (Outlook, Hotmail, Live y Microsoft 365).
1. Abre un ticket con el soporte de IONOS con el texto del rechazo. La IP es suya y solo ellos pueden gestionarla.
1. Puedes presentar además una solicitud de mitigación en el [portal de soporte para remitentes de Outlook.com](https://olcsupport.office.com/), indicando tu dominio y la IP que aparece en el rechazo. Puede que Microsoft responda que no gestiona esa IP o que no está bloqueada.

> **Nota:** hay casos documentados de IP de IONOS en listas de bloqueo de Microsoft ([BornCity](https://borncity.com/blog/2024/01/04/e-mails-von-ionos-und-strato-abgelehnt-deren-ip-adressen-sind-auf-black-lists-gelandet/)) y de bloqueos que persisten semanas aunque Microsoft confirme el desbloqueo. Es un riesgo propio de la infraestructura compartida: no depende de tu comportamiento.

#### 4. Usa las señales indirectas

Sin feedback de quejas, estas señales sustituyen al informe de spam de Microsoft:

- **Respuestas.** Una proporción de respuestas sostenida desde destinatarios de Outlook indica que llegas a la bandeja.
- **Silencio selectivo.** Si recibes respuestas de Gmail y de dominios corporativos, pero ninguna de Outlook, sospecha de la colocación en Microsoft y repite la prueba.
- **Informes DMARC.** Revisa en los informes diarios las filas de los receptores de Microsoft, si llegan, y comprueba que `spf` y `dkim` siguen en `pass`.

### Requisitos de Microsoft que sí te afectan

Desde el 2025-05-05, Outlook.com exige SPF, DKIM y DMARC (al menos `p=none`) a los dominios que envían más de 5.000 correos al día; los incumplidores van a correo no deseado ([documentación de remitentes de Outlook](https://sendersupport.olc.protection.outlook.com/)). Tus volúmenes están muy por debajo de ese umbral y tu autenticación ya cumple, así que no es un riesgo hoy. Sí ilustra la dirección de Microsoft: revisa estos requisitos si algún día el volumen se acerca a esa cifra.

## Hito del 2026-11-03: pasar DMARC a quarantine

El 2026-11-03, tras cuatro semanas de warm-up, decide si endureces la política DMARC de `p=none` a `p=quarantine`.

### Condiciones previas

Cambia la política solo si se cumplen **todas**:

- Has revisado los informes DMARC de las cuatro semanas y no hay fallos de alineamiento en tus envíos legítimos.
- No aparecen IP desconocidas con volumen relevante.
- Las pruebas de colocación llegan a la bandeja principal de Gmail y Outlook.
- No hay señales de problema abiertas.

Si falla alguna, mantén `p=none`, corrige la causa y repite la revisión una semana después.

### Pasos en IONOS

1. Inicia sesión en tu cuenta de IONOS y abre la gestión de dominios.
1. Selecciona `publiexpe.info` y abre la configuración de **DNS**.
1. Localiza el registro **TXT** con el nombre `_dmarc`. Su valor actual es:

   ```
   v=DMARC1; p=none; rua=mailto:dmarc@publiexpe.info
   ```

1. Edita ese registro (no crees uno nuevo: un dominio solo puede tener un registro DMARC). Cambia el valor por:

   ```
   v=DMARC1; p=quarantine; rua=mailto:dmarc@publiexpe.info
   ```

1. Guarda el cambio. La propagación puede tardar desde unos minutos hasta unas horas.
1. Comprueba el registro con una consulta DNS, por ejemplo:

   ```bash
   nslookup -type=TXT _dmarc.publiexpe.info
   ```

1. Envía una prueba a tu Gmail, abre **Mostrar original** y comprueba que DMARC sigue en `PASS`.

> **Nota:** si prefieres un endurecimiento más prudente, añade `pct=25` (`v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@publiexpe.info`) durante una semana. Solo se aplica la cuarentena al 25 % de los correos que fallan. Después, quita `pct` para aplicarla al 100 %.

> **Precaución:** anota el valor anterior del registro antes de cambiarlo. Si tras el cambio los correos legítimos llegan a spam, restaura `p=none` y avisa al operador.

> **Nota:** `p=reject` queda fuera de este plan. Considéralo solo cuando `p=quarantine` lleve varias semanas estable.

## Gestión de bajas y lista de supresión

Una persona se da de baja escribiendo a `baja@publiexpe.info` o respondiendo a un correo con una petición de baja. Ambas llegan a `jesus.abril@publiexpe.info`.

1. Lee la petición el mismo día laborable en que llega.
1. Añade la dirección (y, si procede, su dominio) a la **lista de supresión** siguiendo el procedimiento de más abajo.
1. Responde con una confirmación breve si lo ves oportuno. No insistas ni intentes retener.
1. Avisa al resto del equipo comercial de que no debe volver a escribir a esa persona.

### Dónde vive la lista

La lista de supresión vive en Twenty, en una **nota** (*Note*) titulada exactamente `Lista de supresión — NO contactar`. Para encontrarla, busca "supresión" en Twenty. Hay una sola nota: no crees copias.

Cada baja es una línea con este formato:

```
email — fecha — motivo
```

Por ejemplo:

```
compras@empresa-uno.example — 2026-10-14 — respuesta al primer correo: "no nos interesa, no escribáis más"
info@empresa-dos.example — 2026-10-15 — correo a baja@publiexpe.info
```

Usa la fecha en formato `AAAA-MM-DD` y un motivo breve (por ejemplo, la vía por la que llegó la baja).

### Cómo añadir una baja

1. Abre la nota `Lista de supresión — NO contactar`.
1. Añade una línea nueva **al final** con el formato `email — fecha — motivo`. Si la persona pide la baja de toda su empresa, añade también una línea con el dominio precedido de arroba (por ejemplo, `@empresa-uno.example`).
1. Guarda la nota.
1. Hazlo **el mismo día** en que llega la petición, sea una respuesta a un correo o un mensaje a `baja@publiexpe.info`.

> **Precaución:** no borres ni edites líneas existentes de la nota, ni siquiera si la persona vuelve a escribir más tarde. Una baja no se revierte desde esta lista. Si alguien pide que le vuelvas a escribir, consúltalo antes con el operador.

### Cómo comprobar la lista antes de enviar

1. Abre la nota `Lista de supresión — NO contactar`.
1. Busca en ella la dirección del destinatario (con `Ctrl+F`) y también su dominio.
1. Si aparece, **no envíes el correo** y no vuelvas a contactar con esa persona nunca.
1. Si no aparece, continúa con el envío.

Haz esta comprobación **antes de enviar cualquier correo en frío**, sin excepciones. Si envías desde Twenty, el sistema además la comprueba y devuelve el borrador a `Draft` si la dirección está en la lista; no te saltes tu comprobación por eso.

> **Importante:** escribir a alguien que se ha dado de baja incumple la normativa (LSSI y RGPD) y daña la reputación del dominio.

Desde la tanda 6, el sistema revisa el buzón cada 2 horas y añade a la nota las bajas que detecta, sin intervención humana (primera pieza del Inbound Manager, [sección 10.2 del LLD v0.1](LLD-0.1-publiexpe-commercial-os.md#102-inbound-y-conversaciones)); desde la tanda 12 además clasifica el resto de respuestas ([triaje del inbound](inbound-triaje.md)). Solo lee el correo: no responde ni mueve mensajes. Si una baja no está en la nota, añádela tú el mismo día. La nota de Twenty es la única fuente de verdad.

## Checklist diaria de 5 minutos

Hazla al empezar el día y antes de cerrar.

1. Revisa la bandeja de `jesus.abril@publiexpe.info` y `j.abril@publiexpe.info`: respuestas, rebotes y avisos del proveedor.
1. Procesa las bajas recibidas en `baja@` y en las respuestas: añade cada una a la nota `Lista de supresión — NO contactar` de Twenty.
1. Comprueba el volumen de ayer frente al calendario de la semana: no superes el rango. Suma los envíos desde Twenty y desde el webmail (bloque **Email** del dashboard local).
1. Reparte los envíos de hoy entre los dos buzones y varía horas y destinatarios.
1. Responde a las conversaciones abiertas. Una respuesta tuya a una respuesta ajena refuerza la reputación.
1. Si recibes un correo de bloqueo o un rebote con código 5xx, pausa y anótalo.

## Checklist semanal

Hazla el último día laborable de cada semana de warm-up (2026-10-12, 2026-10-19, 2026-10-26 y 2026-11-02).

1. Abre los informes DMARC recibidos en `dmarc@` durante la semana y comprueba que no hay fallos de alineamiento ni IP desconocidas.
1. Abre Google Postmaster Tools y anota la reputación del dominio y la tasa de spam.
1. Haz una prueba de colocación desde cada buzón a Gmail y Outlook propios. Anota si llega a bandeja o a spam.
1. Cuenta rebotes y respuestas de la semana. Anota la proporción de respuestas.
1. Revisa que la nota `Lista de supresión — NO contactar` recoge todas las bajas de la semana.
1. Haz la comprobación de Outlook de la sección [Alta en Microsoft SNDS](#alta-en-microsoft-snds) (prueba de colocación y cabeceras).
1. Decide el volumen de la semana siguiente: sube, mantén o baja según las señales.
1. El 2026-11-02, prepara la decisión del [hito del 2026-11-03](#hito-del-2026-11-03-pasar-dmarc-a-quarantine).

## Después del warm-up

Terminadas las cuatro semanas, empieza la prospección real de forma gradual. No pases de golpe del volumen de warm-up al máximo de IONOS. El volumen previsto en el MVP-0 es de unos 10 a 20 correos aprobados al día ([LLD v0.1, sección 10.1](LLD-0.1-publiexpe-commercial-os.md#101-canal-de-envío-outbound)).

Para cada hipótesis validada, el sistema prepara un borrador de email que tú revisas y envías, con un clic desde Twenty o a mano. Consulta [Borradores de email](guia-comercial.md#borradores-de-email) en la guía del equipo comercial.

## Referencias

- [LLD v0.1, sección 10: canal de email](LLD-0.1-publiexpe-commercial-os.md#10-email-canal-de-envío-e-inbound-c3)
- [Guía del equipo comercial](guia-comercial.md)
- [Enviar los borradores desde Twenty](twenty-envio-email.md)
- [Runbook de operación local](runbook-local.md)
- [Límites de envío de IONOS](https://www.ionos.com/help/email/general-topics/what-are-the-mass-mailing-limits/)
