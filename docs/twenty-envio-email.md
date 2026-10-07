# Enviar los borradores desde Twenty

Esta guía explica cómo pasar del flujo actual («el sistema deja el borrador en una nota y tú lo copias a tu correo») a **revisar y enviar el borrador dentro de Twenty**, con tu buzón `jesus.abril@publiexpe.info` conectado a Twenty.

La regla no cambia: **el sistema nunca envía**. Envías tú, con un gesto explícito sobre cada hipótesis, desde tu propio buzón. El Agent Runtime solo escribe el texto del borrador.

| Campo | Valor |
|---|---|
| Estado | Preparado. **Pendiente de que conectes el buzón** y de activar el flujo. |
| Versión de Twenty | `v2.45.6` (verificado en la instancia local y en el código del contenedor `pxos-twenty`) |
| Rama | `feat/twenty-email-account` |
| Quién hace cada paso | Marcado en cada paso: **tú** (comercial/propietario del buzón) o **técnico** (PM u operador) |

## Contenido

1. [Cómo funciona](#cómo-funciona)
1. [Qué permite Twenty 2.45](#qué-permite-twenty-245)
1. [Antes de conectar: privacidad y seguridad](#antes-de-conectar-privacidad-y-seguridad)
1. [Paso 1. Restringir la API key del runtime](#paso-1-restringir-la-api-key-del-runtime)
1. [Paso 2. Conectar tu buzón](#paso-2-conectar-tu-buzón)
1. [Paso 3. Activar el flujo de un clic](#paso-3-activar-el-flujo-de-un-clic)
1. [Uso diario](#uso-diario)
1. [Warm-up y límites de IONOS](#warm-up-y-límites-de-ionos)
1. [Límites conocidos](#límites-conocidos)
1. [Desactivar o volver atrás](#desactivar-o-volver-atrás)
1. [Anexo: evidencia técnica](#anexo-evidencia-técnica)

## Cómo funciona

```
 validas la hipótesis
        │
        ▼
 EmailDrafter (runtime) ── escribe ──► nota «Borrador email — …»        (como hoy)
                        └─ escribe ──► campos de la hipótesis:
                                        Email to · Email subject · Email body
                                        Email status = Draft
        │
        ▼
 TÚ: lees y editas los campos en la hipótesis, compruebas la lista de supresión
     y pones Email status = Reviewed
        │
        ▼
 TÚ: pulsas «Enviar borrador de email» en la hipótesis
        │
        ▼
 Workflow manual de Twenty «Commercial OS · Enviar borrador de email»
   1. relee la hipótesis en la base de datos
   2. sigue solo si Email status = Reviewed, Status = Validated y Para/Asunto/Cuerpo no están vacíos
   3. pone Email status = Sending
   4. envía por SMTP desde el buzón conectado de quien pulsó
   5. pone Email status = Sent
```

Por qué este diseño:

- **Lo envía una persona.** El workflow solo arranca a mano, sobre una hipótesis concreta, y envía desde el buzón de **quien lo pulsa**. No hay disparadores automáticos ni envíos en lote.
- **Revisar es un gesto explícito.** Sin `Email status = Reviewed`, el workflow se detiene sin enviar nada. El paso a *Reviewed* equivale a «lo he leído y es correcto».
- **No envía dos veces.** El workflow relee la hipótesis (no se fía de la copia que tiene tu navegador) y pone *Sending* antes de enviar: un segundo clic se detiene en el filtro.
- **El runtime sigue sin poder enviar.** Solo rellena cuatro campos. Su política de tools no tiene ninguna tool de correo, y el [paso 1](#paso-1-restringir-la-api-key-del-runtime) le quita también el acceso a las tools de correo de Twenty.

> **Nota:** mientras no conectes el buzón, todo sigue como hoy. La nota «Borrador email — …» se crea siempre, y es el borrador de referencia si el envío desde Twenty no está disponible.

## Qué permite Twenty 2.45

Resumen de lo verificado en la instancia (`http://localhost:3020`, `v2.45.6`). El detalle y las rutas de código están en el [anexo](#anexo-evidencia-técnica).

| Pregunta | Respuesta en esta instancia |
|---|---|
| ¿Qué cuentas se pueden conectar? | **Solo IMAP/SMTP/CalDAV genérico.** Google y Microsoft existen en el código, pero están desactivados porque no hay credenciales OAuth configuradas (`isGoogleMessagingEnabled: false`, `isMicrosoftMessagingEnabled: false`, `isImapSmtpCaldavEnabled: true`). Para IONOS es lo que necesitas. |
| ¿Qué pide el formulario IMAP/SMTP? | Nombre (se usa como nombre visible del remitente), dirección de correo y, por protocolo, servidor, puerto, usuario, contraseña y seguridad (`None`, `STARTTLS` o `SSL/TLS`). Puedes configurar **cualquier combinación**: solo SMTP es válido. Valores por defecto del formulario: IMAP 993 SSL/TLS, SMTP 587 STARTTLS. |
| ¿Prueba la conexión al guardar? | Sí. IMAP inicia sesión y lista carpetas; SMTP hace `verify` (no envía ningún correo). |
| ¿Se puede enviar solo con SMTP? | Sí. Twenty contempla expresamente cuentas «solo SMTP» para enviar. Sin IMAP no se crea canal de mensajes: **no se sincroniza nada** del buzón. |
| Visibilidad de la sincronización | **Metadatos** (fecha y participantes), **Asunto y metadatos**, o **Todo** (asunto, cuerpo y adjuntos). Valor por defecto: **Metadatos**. Se aplica a **los demás usuarios** del workspace; tú siempre ves tus correos completos. |
| Otras opciones de sincronización | Creación automática de contactos (*Enviado y recibido*, *Enviado*, *Ninguno*), importar *Todo* o *Algunas carpetas*, excluir correos de grupos y no profesionales, lista de bloqueo. La sincronización no arranca hasta que pulsas **Finalizar la configuración**. |
| ¿Hay acción *Send Email* en workflows? | Sí, `SEND_EMAIL` (y `DRAFT_EMAIL`, que necesita IMAP). Requiere una cuenta conectada **capaz de enviar** (con SMTP). El remitente puede ser una cuenta o un miembro del workspace (Twenty usa su primera cuenta capaz de enviar). |
| ¿Hay *Compose email* en la app? | Sí, en el menú de comandos (Cmd/Ctrl+K), para quien tenga el permiso *Send Email*. No admite precargar el borrador, por eso el flujo usa un workflow. |

Opciones evaluadas para el «un clic»:

| Opción | Resultado |
|---|---|
| (a) Workflow manual sobre la hipótesis con *Send Email* | **Elegida.** Funciona con solo SMTP, la persona edita en la propia hipótesis y pulsa una acción. Verificado contra los esquemas y utilidades de 2.45.6. |
| (b) Borrador nativo (*Draft Email* en la carpeta Borradores del buzón) | Descartada como principal: exige IMAP y sincronizar el buzón con el CRM, y el runtime tendría que usar las tools de correo de Twenty (la misma puerta que `send_email`). |
| (c) Enlace `mailto:` | No necesaria: (a) es viable. La nota sigue sirviendo de alternativa manual. |

## Antes de conectar: privacidad y seguridad

Lee esta sección **antes** de introducir la contraseña.

### Recomendación: conecta solo SMTP

Configura **solo SMTP** y deja IMAP y CalDAV en blanco.

| | Solo SMTP (recomendado) | IMAP + SMTP |
|---|---|---|
| ¿Se copia el buzón en el CRM? | No. No se crea canal de mensajes ni se importa nada. | Sí: los correos de las carpetas que elijas se guardan **completos** en la base de datos de Twenty. La visibilidad solo controla qué ven los demás usuarios. |
| ¿Aparece el correo enviado en *Enviados* de IONOS? | **No.** Twenty solo copia el enviado a *Enviados* cuando hay IMAP. | Sí. |
| ¿Aparece en la ficha de la empresa en Twenty? | No. Queda el estado *Sent* en la hipótesis y el registro de la ejecución del workflow (destinatario, asunto e inicio del cuerpo). | Sí, en el timeline. |
| Respuestas del cliente | Las lees en tu correo, como hoy. | Se importan a Twenty (con datos personales de terceros). |

Empieza con solo SMTP. Si más adelante quieres el histórico en Twenty, añade IMAP con esta configuración, **antes** de pulsar *Finalizar la configuración*:

| Opción | Valor recomendado | Motivo |
|---|---|---|
| Visibilidad | **Metadatos** | Los demás usuarios ven solo fecha y participantes. |
| Creación automática de contactos | **Ninguno** | Evita crear personas (y, por el workflow de ejemplo activo *Create company when adding a new person*, empresas) a partir de cada correo. |
| Importar | **Algunas carpetas**: solo *Enviados* (o *Enviados* y *Bandeja de entrada* si quieres las respuestas) | Lo mínimo para el histórico comercial. Twenty excluye siempre *Papelera* y *Spam*. |
| Excluir correos de grupos | Activado | |
| Excluir correos no profesionales | Activado | |

> **Precaución:** con IMAP, el contenido completo se guarda en la base de datos de Twenty aunque la visibilidad sea *Metadatos*. Informa de este tratamiento en tu registro de actividades si lo activas.

### Seguridad de la conexión

- Twenty guarda la contraseña **cifrada** con la `ENCRYPTION_KEY` del servidor. Nadie del proyecto la copia a ningún fichero: la escribes tú en el formulario.
- Twenty 2.45 conecta a IMAP y SMTP **sin verificar el certificado TLS** del servidor (`rejectUnauthorized: false` en su código). La conexión va cifrada, pero no autenticada. Usa la conexión desde una red de confianza.
- Usa `SSL/TLS` en el puerto 465. Con `STARTTLS` en el 587, Twenty no obliga a cifrar si el servidor no lo ofrece.

## Paso 1. Restringir la API key del runtime

**Quién:** técnico. **Cuándo:** antes de conectar el buzón (y después de crear el workflow en el [paso 3.2](#32-crear-el-workflow-en-borrador)).

**Por qué es obligatorio.** La API key `agent-runtime` tiene hoy el rol **Admin** (`canAccessAllTools: true`). En Twenty 2.45, el endpoint MCP (`/mcp`) acepta API keys y ofrece a ese rol las tools `send_email` y `draft_email`. Sin un buzón conectado no pueden enviar nada; **en cuanto conectes uno, cualquiera con esa API key podría enviar desde él** (Twenty elige la primera cuenta del workspace cuando la llamada no viene de un usuario). Restringir el rol devuelve la garantía «el sistema no puede enviar» también en Twenty.

1. En Twenty, abre **Settings → Roles** y crea un rol `Agent runtime`.
1. Permisos sobre objetos: lectura y escritura de todos los objetos (el runtime crea empresas, señales, hipótesis, notas y resúmenes). Sin borrado definitivo.
1. Permisos de tools: **desactiva el acceso a todas las tools** y no concedas *Send Email*, *Workflows* ni *HTTP Request*.
1. Ajustes: concede solo *API keys & webhooks* si vas a volver a ejecutar `pnpm register:webhook`; si no, ninguno.
1. Abre **Settings → APIs & Webhooks**, entra en la API key `agent-runtime` y asígnale el rol `Agent runtime`.
1. Comprueba que el runtime ya no ve las tools de correo. Este comando solo lee el catálogo; no envía nada:

   ```bash
   curl -s http://localhost:3020/mcp \
     -H "Authorization: Bearer $TWENTY_API_KEY" \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_tool_catalog","arguments":{"categories":["ACTION"]}}}' \
     | grep -c send_email
   ```

   El resultado esperado es `0`.

1. Comprueba con una ejecución manual del EmailDrafter (o con la siguiente ejecución programada) que el runtime sigue escribiendo en Twenty. Si falla por permisos, amplía los permisos **de objetos** del rol, nunca los de tools.

> **Nota:** la sincronización de la Twenty App (`scripts/sync-twenty-app.ps1`) y `pnpm twenty:send-workflow` usan una API key con permisos de administración. Ejecútalos antes de restringir la key, o con una API key temporal de rol Admin que revoques después.

## Paso 2. Conectar tu buzón

**Quién:** tú. Nadie más introduce la contraseña.

1. Abre `http://localhost:3020` e inicia sesión con tu usuario (el que va a enviar).
1. Ve a **Settings → Cuentas** (*Accounts*) y pulsa **Agregar cuenta**.
1. Elige **IMAP/SMTP/CalDAV**. Se abre el formulario **Nueva Cuenta**.
1. Rellena la parte común:

   | Campo | Valor |
   |---|---|
   | Nombre | `Jesús Abril` (es el nombre que verá el destinatario en «De») |
   | Dirección de correo electrónico | `jesus.abril@publiexpe.info` |

1. **Configuración IMAP:** déjala en blanco (recomendado; consulta [Antes de conectar](#antes-de-conectar-privacidad-y-seguridad)). Si decides sincronizar:

   | Campo | Valor |
   |---|---|
   | Servidor IMAP | `imap.ionos.es` |
   | Nombre de usuario IMAP | `jesus.abril@publiexpe.info` |
   | Contraseña IMAP | La del buzón (la escribes tú) |
   | Puerto IMAP | `993` |
   | Seguridad de la conexión IMAP | `SSL/TLS` |

1. **Configuración SMTP:**

   | Campo | Valor |
   |---|---|
   | Servidor SMTP | `smtp.ionos.es` |
   | Nombre de usuario SMTP | `jesus.abril@publiexpe.info` |
   | Contraseña SMTP | La del buzón (la escribes tú) |
   | Puerto SMTP | `465` (el formulario propone `587`: cámbialo) |
   | Seguridad de la conexión SMTP | `SSL/TLS` |

   Si el 465 no conecta (algunas redes lo bloquean), usa `587` con `STARTTLS`. Si `smtp.ionos.es` falla, prueba `smtp.ionos.com`: IONOS publica ambos nombres según el país del contrato.

1. **Configuración CalDAV:** en blanco.
1. Guarda. Twenty prueba la conexión (SMTP: verificación sin envío). Si falla, revisa usuario, contraseña, puerto y seguridad.
1. Si configuraste IMAP, Twenty te lleva a **1. Correo Electrónico**: aplica la [configuración recomendada](#recomendación-conecta-solo-smtp) **antes** de pulsar **Finalizar la configuración**. La sincronización empieza al pulsarlo.
1. Comprueba en **Settings → Cuentas** que la cuenta aparece. Con solo SMTP no verás estado de sincronización: es normal.

> **Importante:** el segundo buzón (`j.abril@publiexpe.info`) puede conectarse igual, pero Twenty envía desde la **primera** cuenta capaz de enviar de cada usuario (por fecha de alta). Si conectas dos en el mismo usuario, el workflow saldrá siempre de la primera. Para repartir el warm-up entre buzones, sigue enviando desde el webmail con el otro.

## Paso 3. Activar el flujo de un clic

**Quién:** técnico (3.1 a 3.3) y tú (3.4 y 3.5).

### 3.1. Sincronizar la Twenty App

La rama añade a **Hypotheses** cuatro campos: *Email to*, *Email subject*, *Email body* y *Email status* (`Draft`, `Reviewed`, `Sending`, `Sent`). Sincroniza la App como siempre (en Windows, `.\scripts\sync-twenty-app.ps1`; consulta el [README de la App](../apps/twenty-app/README.md)). Son campos nuevos: no hay cambios destructivos.

### 3.2. Crear el workflow en borrador

Desde `runtime/agent-runtime`, con `TWENTY_API_KEY` y `TWENTY_BASE_URL` en el entorno o en `.env`:

```bash
pnpm twenty:send-workflow           # simulación: comprueba los campos y muestra la definición; no escribe nada
pnpm twenty:send-workflow --apply   # crea el workflow en BORRADOR (nunca lo activa) y lo valida
```

- Si faltan los campos del paso 3.1, `--apply` se detiene con `blocked`.
- Si el workflow ya existe, no lo toca (`exists`): edítalo en la UI.
- El script no tiene ninguna opción para activar el workflow.

Alternativa sin script: crea el workflow a mano en **Workflows** con la misma definición (consulta `src/integrations/twenty/send-draft-workflow.ts`: disparador manual sobre *Hypothesis*, *Search records* por id, *Filter*, *Update record*, *Send Email*, *Update record*).

### 3.3. Activar la escritura del borrador en los campos

La EmailDrafter escribe en los campos solo si su versión tiene `send_from_twenty.enabled = true` (hoy `false`). Cambia el valor en `desiredEmailDrafterVersion()` de `src/seed/email-drafter-seed.ts` y ejecuta `pnpm seed`: se crea una versión nueva del agente. No hace falta ninguna variable de entorno nueva ni tocar `deployments/`.

Si activas la marca sin el paso 3.1, el runtime no falla: crea la nota como siempre y anota en la ejecución que no pudo guardar los campos.

### 3.4. Revisar y activar el workflow

1. En Twenty, abre **Workflows → Commercial OS · Enviar borrador de email**.
1. Revisa los pasos. En **Enviar email**, el remitente es `{{trigger.metadata.workspaceMemberId}}`: el miembro que pulsa. No lo cambies salvo que quieras fijar una cuenta concreta.
1. Pulsa **Activate**. Esta decisión es tuya: el sistema no activa el workflow.

### 3.5. Primera prueba controlada

1. Elige una hipótesis validada con borrador en los campos (*Email status* = *Draft*).
1. En *Email to* pon **una dirección tuya** (Gmail u Outlook de las pruebas de warm-up), no la del cliente.
1. Pon *Email status* = *Reviewed* y pulsa **Enviar borrador de email**.
1. Comprueba: llega el correo con nombre `Jesús Abril`, los saltos de línea y la línea de baja; las cabeceras dan `SPF`, `DKIM` y `DMARC` `pass`; *Email status* pasa a *Sent*.
1. Vuelve a pulsar **Enviar borrador de email**: la ejecución debe detenerse en el filtro sin enviar.
1. Devuelve *Email to* a la dirección del cliente y *Email status* a *Draft* para trabajarla de verdad.

## Uso diario

Cuando el flujo esté activo, en cada hipótesis validada:

1. Abre la hipótesis y lee *Email subject* y *Email body*. Edita lo que haga falta **en la hipótesis** (no en la nota).
1. No quites la línea de baja ni la firma.
1. Comprueba *Email to*. Si está vacío, escribe la dirección (de rol si no hay decisor).
1. Comprueba que ni la dirección ni el dominio están en la nota `Lista de supresión — NO contactar`. **El workflow no lo comprueba.**
1. Comprueba que no superas el ritmo del día del [plan de warm-up](email-warmup.md).
1. Cambia *Email status* a **Reviewed**.
1. Abre el menú de comandos de la hipótesis (Cmd/Ctrl+K o el botón de acciones) y pulsa **Enviar borrador de email**. Twenty lo lanza sin otra confirmación: tu confirmación es el *Reviewed*.
1. Comprueba que *Email status* pasa a **Sent** (recarga la ficha si no cambia).

Si se queda en **Sending**, el envío falló o está en curso: abre la ejecución en **Workflows → Runs**. **No vuelvas a pulsar.** Si el paso *Enviar email* falló, corrige la causa y vuelve a poner *Reviewed* para reintentar. Si el paso se completó, el correo salió: pon *Sent* a mano.

## Warm-up y límites de IONOS

Los correos que envías desde Twenty **salen por el mismo buzón y el mismo servidor SMTP de IONOS** que los del webmail. Para IONOS y para los proveedores de destino no hay diferencia.

- **Cuentan para los límites de IONOS** (50 por hora los primeros 7 días; 500 por hora con más de 30 días) y para el volumen diario del [calendario de warm-up](email-warmup.md#calendario-de-4-semanas). Suma los envíos desde Twenty y desde el webmail.
- El workflow envía **de uno en uno** y no admite selección múltiple, a propósito. No lo uses para envíos masivos.
- Cuenta tus envíos del día: en **Hypotheses**, filtra por *Email status* = *Sent* y por fecha de actualización, o revisa **Workflows → Runs**.
- Con solo SMTP, el enviado **no** se guarda en *Enviados* de IONOS. Si necesitas esa copia, añade IMAP con la [configuración recomendada](#recomendación-conecta-solo-smtp).
- El resto de reglas del warm-up no cambian: identificación, línea de baja, nada de píxeles ni acortadores, pausa ante señales de problema.

## Límites conocidos

| Límite | Consecuencia | Mitigación |
|---|---|---|
| El workflow no consulta la lista de supresión. | Puede enviar a una baja si no la compruebas. | Paso obligatorio del [uso diario](#uso-diario). La lista sigue siendo manual hasta el Inbound Manager. |
| Cuerpo como texto preformateado (`<pre>` con `white-space: pre-wrap`). | Gmail, Apple Mail y Outlook web lo muestran bien. Outlook de escritorio puede no ajustar líneas largas. | Prueba de colocación con tu cuenta de Outlook en la [primera prueba](#35-primera-prueba-controlada). La parte de texto plano del mensaje conserva los saltos de línea. |
| Remitente = primera cuenta capaz de enviar del usuario. | Con dos buzones en el mismo usuario, siempre sale del primero. | Un buzón por usuario en Twenty. |
| Sin copia en *Enviados* con solo SMTP. | No ves el correo en el webmail. | Ejecución del workflow y estado *Sent*; o IMAP con *Algunas carpetas*. |
| Si regeneras el borrador, la EmailDrafter no sobrescribe los campos. | Escribe solo si *Email status* está vacío; un *Draft* puede tener tus ediciones. | Para regenerar, vacía *Email status* y vuelve a lanzar la EmailDrafter (`POST /tasks/:id/run` con `{ "hypothesis_id": … }`). |

## Desactivar o volver atrás

- **Parar los envíos desde Twenty:** **Workflows → el workflow → Deactivate**.
- **Dejar de rellenar los campos:** `send_from_twenty.enabled = false` y `pnpm seed` (nueva versión del agente).
- **Desconectar el buzón:** **Settings → Cuentas → ⋯ → Desconectar cuenta**. Se borran las credenciales y se para la sincronización; los datos ya sincronizados se conservan.

> **Precaución:** no uses **Eliminar cuenta y datos sincronizados**: borra de forma permanente la cuenta y todo lo importado.

## Anexo: evidencia técnica

Verificado el 2026-10-07 contra `twentycrm/twenty:v2.45.6` (`pxos-twenty`), sin conectar ninguna cuenta y sin enviar ningún correo.

| Hecho | Evidencia |
|---|---|
| Solo IMAP/SMTP/CalDAV disponible | `GET /client-config`: `isImapSmtpCaldavEnabled: true`, `isGoogleMessagingEnabled: false`, `isMicrosoftMessagingEnabled: false`. Variable `IS_IMAP_SMTP_CALDAV_ENABLED`, por defecto `true` (`twenty-config/config-variables.js`). |
| Campos y valores por defecto del formulario | `front/assets/SettingsAccountsConnectionForm-*.js` (IMAP 993 `SSL_TLS`, SMTP 587 `STARTTLS`, CalDAV 443) y catálogo `es-ES`. Esquema de servidor: `imap-smtp-caldav-connection/schemas/connection-parameters.schema.js` (seguridad por defecto `SSL_TLS`). |
| Prueba al guardar | `ImapSmtpCaldavService.testImapConnection` / `testSmtpConnection` (`transport.verify()`), gobernado por `IS_IMAP_SMTP_CALDAV_CONNECTION_TEST_ENABLED` (por defecto `true`). |
| Sin IMAP no hay sincronización | `ImapSmtpCalDavApiService.upsertConnectedAccount`: el canal de mensajes se crea solo si hay parámetros IMAP. `EmailComposerService.composeEmail`: `isSmtpOnlyAccount`. |
| Copia en *Enviados* solo con IMAP | `ImapSmtpMessageOutboundService.sendMessage`: `imapClient.append` solo si `connectionParameters.IMAP`. |
| Visibilidad por defecto *Metadatos* y sincronización tras configurar | `CreateMessageChannelService`: `visibility: METADATA`, `syncStage: PENDING_CONFIGURATION`. Valores: `METADATA`, `SUBJECT`, `SHARE_EVERYTHING`. |
| La visibilidad solo afecta a otros | `ApplyMessagesVisibilityRestrictionsService`: el propietario de la cuenta ve todo; a los demás se les ocultan asunto o cuerpo. |
| *Send* exige SMTP; *Draft* exige IMAP | `canConnectedAccountPerformEmailOperation` (`twenty-shared/utils`). |
| Remitente por miembro del workspace | `EmailWorkflowActionBase.resolveSenderConnectedAccountId`. |
| Contexto del disparador manual | `buildWorkflowRunTriggerContext`: el registro va en `trigger.payload` y quien pulsa en `trigger.metadata.workspaceMemberId`. El front envía el registro de su caché (`CommandMenuItemRenderer-*.js`). |
| Cuerpo y saltos de línea | Un cuerpo de texto plano se interpreta como HTML y pierde los saltos (`compileOutboundEmailContent`). El documento con nodo `html` y `<pre>` los conserva y escapa el valor (`resolveEmailBody`). Probado con las utilidades del propio contenedor. |
| Definición del workflow válida | `workflowTriggerSchema`, `workflowActionSchema` y `validateWorkflowStructure` (`twenty-shared/workflow`) sobre la salida de `buildSendDraftWorkflow`: válida, sin errores ni avisos. Filtro, resolución de variables y filtro por id comprobados con `evaluateStepFilters`, `resolveInput` y `computeRecordGqlOperationFilter`. |
| La API key del runtime puede ver `send_email` | `getRoles`: la key `agent-runtime` tiene el rol Admin (`canAccessAllTools: true`). `POST /mcp` `get_tool_catalog` con esa key lista `send_email`, `draft_email` y `find_connected_accounts`. `SendEmailTool` sin usuario elige la primera cuenta del workspace (`getDefaultConnectedAccountIdOrThrow`). |
| TLS sin verificación de certificado | `tls: { rejectUnauthorized: false }` en `testImapConnection`, `testSmtpConnection` y los proveedores de cliente. |
| Servidores de IONOS | [IONOS: datos de servidor IMAP, POP3 y SMTP](https://www.ionos.com/help/email/general-topics/ionos-mail-server-details-for-imap-pop3-and-smtp/) (IMAP 993 SSL/TLS, SMTP 465 SSL/TLS, alternativa 587 STARTTLS, usuario = dirección completa). Los nombres `imap.ionos.es` y `smtp.ionos.es` son los de los contratos de IONOS España. |
