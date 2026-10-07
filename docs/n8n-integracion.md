# Integración de eventos con n8n

Esta guía describe el puente de eventos entre el Agent Runtime y sistemas externos, con n8n como primer consumidor y productor. Cubre el contrato de entrada (`POST /events/external`), el contrato de salida (webhooks firmados de `event_subscriptions`) y un workflow de ejemplo listo para importar.

n8n integra y orquesta; nunca contiene la inteligencia central (LLD v0.1, sección 20). Las tareas de negocio (`TaskDefinition`) y sus disparadores viven en el runtime. n8n solo envía hechos externos al bus y reacciona a los eventos que el runtime le reenvía.

## Contenido

- [Resumen](#resumen)
- [Entrada: enviar eventos al runtime](#entrada-enviar-eventos-al-runtime)
- [Salida: recibir eventos del runtime](#salida-recibir-eventos-del-runtime)
- [Workflow de ejemplo](#workflow-de-ejemplo)
- [Red local: n8n y el runtime en Docker](#red-local-n8n-y-el-runtime-en-docker)
- [Seguridad](#seguridad)
- [Solución de problemas](#solución-de-problemas)

## Resumen

```
                 POST /events/external (Bearer)
  n8n ─────────────────────────────────────────────> EventBus ──> triggers EVENT ──> TaskRun
   ^                                                    │
   │      POST firmado (X-Pxos-Event-Signature)         │ cola {QUEUE_NAME}-events
   └──────────── WebhookDeliveryWorker <── {QUEUE_NAME}-webhooks <── WebhookDispatcher
```

| Dirección | Mecanismo | Autenticación |
|---|---|---|
| n8n → runtime | `POST /events/external` | Token estático `EXTERNAL_EVENTS_TOKEN` en `Authorization: Bearer` |
| runtime → n8n | Webhook de una fila de `event_subscriptions` | Firma HMAC-SHA256 con el secreto de la suscripción |

## Entrada: enviar eventos al runtime

### Configura el runtime

1. Genera un token y defínelo en el entorno del proceso con rol `api` (o `all`):

   ```sh
   EXTERNAL_EVENTS_TOKEN=$(openssl rand -hex 32)
   ```

   Sin token, la ruta responde `503 external_events_not_configured`. El token necesita al menos 16 caracteres.

1. Opcional: cambia los prefijos de tipo permitidos con `EXTERNAL_EVENT_TYPE_PREFIXES` (lista separada por comas; por defecto `ext.`). El runtime rechaza al arrancar cualquier prefijo que cubra sus propios eventos (`task.`, `agent.`, `evaluation.`).

### Contrato de la petición

```
POST /events/external
Authorization: Bearer <EXTERNAL_EVENTS_TOKEN>
Content-Type: application/json
x-tenant-id: publiexpe            (opcional; por defecto DEFAULT_TENANT_ID)
```

El cuerpo es un sobre parcial. La validación es estricta: una clave desconocida devuelve `400`.

| Campo | Obligatorio | Regla |
|---|---|---|
| `type` | Sí | Empieza por un prefijo permitido (`ext.` por defecto) y sigue el formato del bus: minúsculas, puntos y guiones bajos, sin dígitos. Ejemplo: `ext.lead.created`. Máximo 120 caracteres. |
| `data` | Sí | Objeto JSON de 64 KB como máximo (serializado). |
| `producer` | No | `n8n` (por defecto) o `twenty`. Decide `producer` (`n8n` o `twenty-app`) y `source` (`n8n` o `twenty`) del evento. |
| `occurred_at` | No | ISO 8601 con zona. Por defecto, el momento de la recepción. |
| `correlation_id` | No | Hasta 200 caracteres. Por ejemplo, el id de la ejecución de n8n. Por defecto, `ext-<uuid>`. |
| `idempotency_key` | No | Hasta 200 caracteres. El runtime la guarda como `ext:{producer}:{clave}`. |

El runtime completa el sobre (`id`, `schemaVersion` = `{type}.v1`, `tenantId`) y fuerza `data.chainDepth = 0`, aunque el cuerpo traiga otro valor. Después lo publica por el `EventBus` normal: se guarda en `events`, se encola, el re-publicador lo recupera si Redis falla y los triggers `EVENT` lo evalúan como a cualquier evento interno.

### Respuestas

| Código | Significado |
|---|---|
| `202` | Evento creado. Cuerpo: `{ "event": <sobre>, "created": true, "dispatched": true }`. |
| `200` | Ya existía un evento con la misma `idempotency_key`: devuelve ese evento con `"created": false`. |
| `400` | Cuerpo inválido (`validation_error`) o `x-tenant-id` inválido. |
| `401` | Falta el token o no coincide. Incluye `WWW-Authenticate: Bearer`. El cuerpo ni siquiera se analiza. |
| `413` | Cuerpo de más de 96 KB. |
| `503` | `EXTERNAL_EVENTS_TOKEN` sin configurar, o el proceso no tiene event bus. |

### Ejemplo con curl

```sh
curl -sS -X POST http://127.0.0.1:4020/events/external \
  -H "Authorization: Bearer $EXTERNAL_EVENTS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'x-tenant-id: publiexpe' \
  -d '{
    "type": "ext.lead.created",
    "data": { "channel": "web", "email": "contacto@expositor.example", "fair": "Fitur 2027" },
    "correlation_id": "n8n-exec-1234",
    "idempotency_key": "form-submission-98765"
  }'
```

Respuesta (`202`):

```json
{
  "event": {
    "id": "7c1d0a9e-2b4f-4c3a-9e1d-6f5a8b2c3d4e",
    "type": "ext.lead.created",
    "schemaVersion": "ext.lead.created.v1",
    "tenantId": "publiexpe",
    "occurredAt": "2026-10-07T11:02:13.408Z",
    "producer": "n8n",
    "correlationId": "n8n-exec-1234",
    "idempotencyKey": "ext:n8n:form-submission-98765",
    "data": { "channel": "web", "email": "contacto@expositor.example", "fair": "Fitur 2027", "chainDepth": 0 }
  },
  "created": true,
  "dispatched": true
}
```

### Disparar una tarea con un evento externo

Una tarea con schedule `EVENT` reacciona al evento externo igual que a uno interno:

```json
{ "type": "EVENT", "event_type": "ext.lead.created", "filter": { "channel": "web" } }
```

El run recibe el sobre completo en `input.event`. Su profundidad de cadena es 1.

> **Importante:** `data` es contenido **no confiable**. El runtime lo guarda y los filtros lo comparan como datos; nunca lo interpreta como instrucciones. Un agente que lea `input.event.data` debe tratarlo igual que el contenido web: datos, nunca órdenes.

## Salida: recibir eventos del runtime

### Crea una suscripción

```sh
curl -sS -X POST http://127.0.0.1:4020/event-subscriptions \
  -H 'Content-Type: application/json' \
  -H 'x-tenant-id: publiexpe' \
  -d '{
    "name": "n8n runs fallidos",
    "target_url": "http://host.docker.internal:5678/webhook/pxos-eventos",
    "event_types": ["task.completed", "task.failed"]
  }'
```

| Campo | Regla |
|---|---|
| `name` | Único por tenant (`409` si se repite). |
| `target_url` | `http` o `https`, sin credenciales, máximo 2048 caracteres. Pasa la [guarda SSRF](#seguridad). |
| `event_types` | De 1 a 50 patrones: tipo exacto (`task.completed`) o prefijo (`task.*`). |
| `secret` | Opcional, de 16 a 512 caracteres. Si lo omites, el runtime genera uno de 64 caracteres hexadecimales. |
| `enabled` | Opcional, `true` por defecto. |

La respuesta (`201`) incluye `secret` **solo** cuando lo generó el runtime. Guárdalo: ninguna otra respuesta lo vuelve a mostrar (solo `secret_hint`, los 4 últimos caracteres).

Operaciones disponibles:

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/event-subscriptions` | Crea una suscripción. |
| `GET` | `/event-subscriptions?enabled=true` | Lista las del tenant. |
| `GET` | `/event-subscriptions/:id` | Lee una, con el estado de entrega. |
| `PATCH` | `/event-subscriptions/:id` | Cambia `name`, `target_url`, `event_types`, `secret`, `enabled` o rota el secreto con `"rotate_secret": true` (devuelve el nuevo una vez). |

No hay `DELETE`. Para apagar una suscripción, envía `PATCH` con `{"enabled": false}`.

### Entrega

Por cada evento del bus cuyo tipo case con una suscripción activa del mismo tenant, el runtime hace:

```
POST <target_url>
Content-Type: application/json
User-Agent: pxos-agent-runtime/0.1 (+event-subscriptions)
X-Pxos-Event-Timestamp: 1791367220512
X-Pxos-Event-Signature: c5cb586504b55a63a6ad92399ed611e4fd7d7dfa863189b6237a9ddcc5397032
X-Pxos-Event-Id: 0b9f3c52-6d1e-4a7b-9c2d-5e8f1a3b7c90
X-Pxos-Event-Type: task.completed
X-Pxos-Subscription-Id: <id de la suscripción>
X-Pxos-Delivery-Attempt: 1

<sobre event.envelope.v1 completo, JSON.stringify sin espacios>
```

- Cualquier `2xx` cuenta como entregado.
- Reintentos: 3 intentos en total con backoff exponencial (`WEBHOOK_DELIVERY_BACKOFF_MS`, por defecto 5 s y 10 s). Se reintentan errores de red, timeouts (`WEBHOOK_DELIVERY_TIMEOUT_MS`, 10 s), `5xx`, `408` y `429`. Cualquier otro código (`4xx`, y `3xx`, porque las redirecciones no se siguen) falla a la primera.
- La suscripción guarda `last_delivery_at` (última entrega correcta), `last_error` y `last_error_at` (último intento fallido, con su número de intento) y `consecutive_failures` (entregas abandonadas desde el último éxito).
- La entrega es *al menos una vez*: el mismo evento puede llegar dos veces. Deduplica con `X-Pxos-Event-Id`.

### Verifica la firma

La firma usa el mismo esquema que los webhooks de Twenty:

```
X-Pxos-Event-Signature = hex( HMAC-SHA256( secret, "<X-Pxos-Event-Timestamp>:<cuerpo>" ) )
```

`X-Pxos-Event-Timestamp` está en milisegundos desde epoch. Rechaza las peticiones con un timestamp a más de 5 minutos del reloj local y compara la firma en tiempo constante.

Ejemplo verificable. Con el secreto `ejemplo-secreto-0123456789abcdef`, el timestamp `1791367220512` y este cuerpo:

```json
{"id":"0b9f3c52-6d1e-4a7b-9c2d-5e8f1a3b7c90","type":"task.completed","schemaVersion":"task.completed.v1","tenantId":"publiexpe","occurredAt":"2026-10-07T08:00:20.512Z","producer":"agent-runtime","correlationId":"5d2f9c1e-3b6a-4e8f-a1c7-2f9e0b4d6a33","idempotencyKey":"evt:task.completed:5d2f9c1e-3b6a-4e8f-a1c7-2f9e0b4d6a33","data":{"taskRunId":"5d2f9c1e-3b6a-4e8f-a1c7-2f9e0b4d6a33","taskDefinitionId":"a41c7e20-9d3b-4f61-8e2a-7c5b0d9f1e44","executionId":"e3a1b2c4-5d6e-4f70-8a9b-0c1d2e3f4a5b","status":"COMPLETED","attempts":1,"finishedAt":"2026-10-07T08:00:20.497Z","chainDepth":0,"costEur":0.0431,"latencyMs":18234,"outcome":"FAILED"}}
```

la firma es `c5cb586504b55a63a6ad92399ed611e4fd7d7dfa863189b6237a9ddcc5397032`. Compruébalo en una shell (guarda el cuerpo en `body.json` sin salto de línea final):

```sh
printf '%s:%s' 1791367220512 "$(cat body.json)" \
  | openssl dgst -sha256 -hmac 'ejemplo-secreto-0123456789abcdef'
```

En Node.js:

```js
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', secret).update(`${timestamp}:${rawBody}`).digest('hex');
const valid = expected.length === signature.length
  && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()));
```

## Workflow de ejemplo

El fichero [`integrations/n8n/ejemplo-eventos.json`](../integrations/n8n/ejemplo-eventos.json) es un workflow listo para importar:

1. **Webhook PXOS** recibe `POST /webhook/pxos-eventos` y responde desde un nodo posterior.
1. **Verificar firma** (Code) recalcula el HMAC con el secreto de la suscripción y comprueba el timestamp.
1. **¿Firma válida?** responde `401` si la firma no cuadra (el runtime lo registra en `last_error` y no reintenta) o `200` si cuadra.
1. **¿task.completed con FAILED?** deja pasar solo `type = task.completed` con `data.outcome = FAILED` (el Prospector cerró el run, pero sin resultado útil).
1. **Notificación (placeholder)** compone el mensaje. Sustitúyelo por tu canal (email, Slack, Telegram…).

Para usarlo:

1. En n8n, abre **Workflows > Import from File** y elige `ejemplo-eventos.json`.
1. Abre el nodo **Verificar firma** y sustituye `REEMPLAZA_POR_EL_SECRETO_DE_LA_SUSCRIPCION` por el secreto de tu suscripción.
1. Permite el módulo `crypto` en los nodos Code: define `NODE_FUNCTION_ALLOW_BUILTIN=crypto` en el entorno de n8n y reinícialo.
1. Activa el workflow. La URL de producción es `http://<host-de-n8n>:5678/webhook/pxos-eventos`.
1. Crea la suscripción en el runtime con esa URL y `event_types: ["task.completed"]`.

> **Nota:** el nodo Code reconstruye el cuerpo con `JSON.stringify($json.body)`. Funciona porque el runtime envía `JSON.stringify(sobre)` sin espacios y la ida y vuelta por `JSON.parse` conserva el orden de las claves. Si pones un proxy que reformatee el JSON, activa **Raw Body** en el webhook y firma sobre el binario recibido.

Para el sentido contrario (n8n → runtime), añade un nodo **HTTP Request** con método `POST`, URL `http://<host-del-runtime>:4020/events/external`, cabecera `Authorization: Bearer <token>` (mejor como credencial *Header Auth*) y el cuerpo JSON del [contrato de entrada](#contrato-de-la-petición).

## Red local: n8n y el runtime en Docker

La guarda SSRF rechaza por defecto las IP privadas y de loopback, y `localhost` o `host.docker.internal` lo son. Para apuntar a un n8n local, nómbralo en `EXTERNAL_WEBHOOK_ALLOW_PRIVATE` (lista separada por comas de `host` o `host:puerto`; coincidencia exacta, sin subdominios; con puerto, solo ese puerto):

| Dónde corre el runtime | `target_url` de la suscripción | `EXTERNAL_WEBHOOK_ALLOW_PRIVATE` |
|---|---|---|
| Contenedor `pxos-runtime` (n8n en el host, puerto 5678) | `http://host.docker.internal:5678/webhook/pxos-eventos` | `host.docker.internal:5678` |
| Host (`pnpm dev`) | `http://localhost:5678/webhook/pxos-eventos` | `localhost:5678` |
| Misma red Docker que un contenedor `n8n` | `http://n8n:5678/webhook/pxos-eventos` | `n8n:5678` |

Define la variable en el proceso con rol `api` (valida la URL al crear o cambiar la suscripción) y en el de rol `scheduler` (entrega). En `all` es el mismo proceso. El contenedor `pxos-runtime` necesita `extra_hosts: host.docker.internal:host-gateway` (ya está en `docker-compose.runtime.yml`).

En sentido contrario, n8n llega al runtime en `http://localhost:4020` si corre en el host, o en `http://host.docker.internal:4020` si corre en Docker (el runtime publica `127.0.0.1:4020`; en Linux, n8n necesita `extra_hosts: host.docker.internal:host-gateway`).

> **Precaución:** no uses `EXTERNAL_WEBHOOK_ALLOW_PRIVATE` en producción salvo para destinos internos concretos. Cada entrada abre ese host a peticiones firmadas del runtime.

## Seguridad

- **Token de entrada.** Comparación en tiempo constante. La comprobación ocurre antes de analizar el cuerpo. Rota el token cambiando `EXTERNAL_EVENTS_TOKEN` y reiniciando el proceso `api`.
- **Espacio de nombres.** Los tipos externos no pueden usar `task.`, `agent.` ni `evaluation.`; las claves de idempotencia externas llevan el prefijo `ext:{producer}:`, así que un emisor externo no puede suplantar ni bloquear eventos del runtime (`evt:task.completed:{runId}`).
- **Contenido no confiable.** `data` se guarda tal cual, se limita a 64 KB y nunca se interpreta como instrucciones.
- **Guarda SSRF.** `target_url` solo admite `http`/`https` y todas las IP a las que resuelve el host deben ser públicas (mismas reglas que `fetch_url`: loopback, privadas, link-local con la metadata de la nube, CGNAT, IPv6 únicas locales e IPv4 embebidas en IPv6 se rechazan). La comprobación se repite antes de cada entrega y la conexión TCP se fija a la IP comprobada, así que un *DNS rebinding* no alcanza una IP privada. Las redirecciones no se siguen.
- **Secretos.** El secreto de cada suscripción se guarda en claro en `event_subscriptions.secret` porque el runtime firma con él. La API nunca lo devuelve salvo al generarlo o rotarlo.
- **Bucles a través de n8n.** Los eventos externos entran con `chainDepth = 0`, así que la guardia anti-bucle del runtime no ve una cadena que pase por n8n (`task.completed` → n8n → `ext.*` → tarea → `task.completed` → …). No construyas workflows que reinyecten, como evento externo, un evento que dispare la misma tarea que lo originó. Si lo necesitas, filtra en n8n por `X-Pxos-Event-Type` y `data.taskDefinitionId`.
- **Gestión de suscripciones.** `/event-subscriptions` no tiene autenticación propia, como el resto de la API de administración: el runtime escucha en `127.0.0.1`. No lo expongas fuera del host.

## Solución de problemas

| Síntoma | Causa probable |
|---|---|
| `503 external_events_not_configured` | Falta `EXTERNAL_EVENTS_TOKEN` en el proceso `api`. |
| `400` con `type must start with one of: ext.` | El tipo no lleva el prefijo permitido, o contiene dígitos o mayúsculas (`ext.n8n.x` no es válido; usa `ext.lead.created`). |
| `400 invalid_target_url` al crear la suscripción | Destino privado o loopback sin entrada en `EXTERNAL_WEBHOOK_ALLOW_PRIVATE`. El mensaje indica la entrada que falta. |
| `last_error` con `target refused` | El host resolvió a una IP privada en el momento de la entrega. Revisa la allowlist del proceso `scheduler`. |
| `last_error` con `HTTP 401` | La firma no cuadra en n8n: secreto distinto, `crypto` no permitido o un proxy que reformatea el cuerpo. |
| `last_error` con `HTTP 404` | El workflow no está activo o la ruta del webhook no coincide (`/webhook/` en producción, `/webhook-test/` en pruebas). |
| `last_error` con `network error: ECONNREFUSED` | n8n no escucha en esa dirección desde el runtime (revisa la tabla de red). |
