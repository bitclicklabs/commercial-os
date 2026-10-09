# Catalog Service: el catálogo de publiexpe en Commercial OS

El Catalog Service da a los agentes acceso de **solo lectura** al catálogo de PubliEXPE para que las hipótesis recomienden productos reales, con referencia, y no familias genéricas ([LLD v0.1, sección 9](LLD-0.1-publiexpe-commercial-os.md#9-catalog-service-c2)). Este documento es el lado de Commercial OS, para quien opera el runtime y para el equipo comercial. El contrato con el backend de publiexpe (formas JSON, límites, autenticación) está en [catalog-connector-contrato.md](catalog-connector-contrato.md).

> **Importante:** el catálogo está **apagado por defecto** (`CATALOG_ENABLED=false`). Hasta que el backend de publiexpe entregue el conector (estimado hacia el 2026-10-29) y se haga la [conmutación](#el-día-de-la-conmutación-stub-a-http), el runtime trabaja contra un **stub** con la misma forma que el contrato real. Nada de lo que verás con el stub son productos reales.

> **Nota:** si algún detalle (nombre de una tool o de una variable) difiere del [README del runtime](../runtime/agent-runtime/README.md), manda el README.

## Contenido

1. [Qué es y qué no es](#qué-es-y-qué-no-es)
1. [Variables](#variables)
1. [El stub](#el-stub)
1. [El día de la conmutación stub a http](#el-día-de-la-conmutación-stub-a-http)
1. [Qué pasa si el catálogo no está disponible](#qué-pasa-si-el-catálogo-no-está-disponible)
1. [Las tools](#las-tools)
1. [Qué gana la hipótesis](#qué-gana-la-hipótesis)
1. [La skill del Prospector con catálogo](#la-skill-del-prospector-con-catálogo)
1. [Seguridad](#seguridad)
1. [Qué no hace (todavía)](#qué-no-hace-todavía)
1. [Documentos relacionados](#documentos-relacionados)

## Qué es y qué no es

| Es | No es |
|---|---|
| Una ventana de **lectura** sobre el catálogo: buscar, ver la ficha, estimar un marcaje | Un sistema que escriba, reserve stock o genere presupuestos |
| Una fuente de productos reales (`productId`, `sku`, `name`) para las hipótesis | Una fuente de precios vinculantes: todo importe es **orientativo** y sin IVA |
| Una pieza opcional: si no está, el sistema trabaja como antes | Una dependencia dura de la prospección diaria |

El presupuesto sigue saliendo del CMS de publiexpe, por la vía de siempre. Twenty guarda solo la referencia y el estado.

## Variables

Se configuran en el bloque `environment` de `pxos-runtime` (desde `deployments/.env`). La tabla completa del runtime está en el [runbook](runbook-local.md#variables-del-runtime).

| Variable | Valor por defecto | Uso |
|---|---|---|
| `CATALOG_ENABLED` | `false` | Interruptor general. Con `false`, las tools `catalog_*` no se exponen a los agentes y no se comprueba la salud. Solo `true` lo enciende |
| `CATALOG_PROVIDER` | `stub` | `stub` (datos de muestra fieles al contrato, sin red) o `http` (el conector real de publiexpe). Solo tiene efecto con `CATALOG_ENABLED=true` |
| `CATALOG_BASE_URL` | vacía | Dirección del conector por la VPN. Con `CATALOG_PROVIDER=http` es obligatoria. Es el **único host** que queda exento del guard anti-SSRF ([Seguridad](#seguridad)) |
| `CATALOG_API_TOKEN` | vacía | Token Bearer de solo lectura del catálogo (`pxcat_…`). Solo en `deployments/.env`; nunca en el repositorio ni en el chat |

> **Precaución:** `CATALOG_API_TOKEN` es un secreto. El backend de publiexpe lo da de alta, lo rota y lo revoca; Commercial OS solo lo custodia. Si sospechas que se ha filtrado, pide su revocación al backend y sustitúyelo en `deployments/.env`.

> **Nota:** una variable que no llega al contenedor no tiene ningún efecto. Si tu `docker-compose.yml` todavía no pasa estas cuatro, añádelas con la forma `${NOMBRE:-}` y recrea el servicio (`docker compose up -d pxos-runtime`).

## El stub

Mientras no exista el conector real, `CATALOG_PROVIDER=stub` sirve un catálogo de muestra con **la misma forma que el contrato v1.1**: las mismas seis operaciones, las mismas fichas con variantes, `priceHint` completo, lápidas incluidas, los mismos errores y la misma paginación por cursor. Sirve para dos cosas:

- Que el resto del sistema (tools, skill, hipótesis) se construya y se pruebe sin esperar al backend.
- Ejecutar los **tests de contrato**, que son los mismos contra el stub y contra el conector real.

El stub **no son productos reales**. Sus `productId` y `sku` son ficticios; si una hipótesis generada con el stub llega a Twenty, descártala. Por eso el stub solo se usa con `CATALOG_ENABLED=true` en entornos de prueba, nunca en la ejecución de las 08:00 de producción mientras los comerciales trabajan con hipótesis reales.

## El día de la conmutación (stub a http)

Cuando el backend entregue el conector en preproducción y pasen los tests de contrato:

- [ ] El backend ha dado de alta un token `pxcat_…` para Commercial OS (primero el de **preproducción**) y ha limitado su IP al rango de la VPN.
- [ ] La VPN está arriba desde la máquina donde corre `pxos-runtime`. Compruébalo con una petición directa al `/health` del conector:

  ```sh
  curl -s "<CATALOG_BASE_URL>/api/catalog/v1/health" -H "Authorization: Bearer $CATALOG_API_TOKEN"
  ```

  Esperas `"status": "ok"` y `"contractVersion": "1.1.0"` (o un `1.x` posterior; un `MAJOR` distinto lo rechaza el runtime).
- [ ] `CATALOG_API_TOKEN` está en `deployments/.env` y `CATALOG_BASE_URL` apunta al host de la VPN. Revisa que **es el host exacto** que usarás: la exención del guard SSRF es solo para ese host.
- [ ] Pasa `CATALOG_PROVIDER=http`, mantén `CATALOG_ENABLED=true` y recrea `pxos-runtime`.
- [ ] El runtime arranca sin errores y el gate de salud lee `/health` (consulta los logs: `docker compose logs --tail 100 pxos-runtime`).
- [ ] Haz una búsqueda de prueba con una tool `catalog_*` y comprueba que devuelve productos reales con `sku`, y que `priceHint.basis` es `INDICATIVE`.
- [ ] Revisa el `audit_log` del runtime y, con el backend, el registro de consultas de su lado.
- [ ] Repite con el token de **producción** cuando lo den de alta.
- [ ] Si algo falla, vuelve a `CATALOG_PROVIDER=stub` o a `CATALOG_ENABLED=false` y recrea el servicio. La vuelta atrás es inmediata y no pierde datos.

La conmutación **no activa la skill nueva del Prospector** ([abajo](#la-skill-del-prospector-con-catálogo)): las hipótesis seguirán saliendo con familias hasta que esa skill pase el Release Gate y una persona la active.

## Qué pasa si el catálogo no está disponible

Antes de cada tarea que usa el catálogo (hoy, la prospección diaria de las 08:00), el runtime comprueba la salud del conector (`/health`). Es el **gate de salud**.

| Situación | Qué hace el runtime |
|---|---|
| `/health` responde `ok` con una versión de contrato conocida | Ejecuta la tarea con catálogo |
| `/health` falla: no responde, `503`, error de red, token rechazado, o un `MAJOR` de contrato desconocido | **Modo degradado**: ejecuta la tarea **sin catálogo**. Las hipótesis salen con familias genéricas, como antes |
| `CATALOG_ENABLED=false` | No hay gate: el catálogo no existe para los agentes |

En modo degradado:

- **La prospección no se cae ni se retrasa.** El comercial recibe sus hipótesis del día como siempre.
- El runtime deja **una nota ⚠️ en Twenty** y emite el evento **`catalog.unavailable`** (que n8n puede reenviar a donde prefiera el equipo, véase [n8n-integracion.md](n8n-integracion.md)).
- **Nunca se avisa por correo.** El runtime no envía correo por principio; su único correo es el borrador HITL que revisa y envía una persona.

### Qué ve el comercial

Una única nota **⚠️** al día en Twenty que dice que el catálogo no estuvo disponible y que las hipótesis de hoy llevan familias genéricas en lugar de productos con referencia. Es un aviso, no una acción pendiente: no tienes que hacer nada, y las hipótesis siguen siendo válidas para revisar. Si el catálogo vuelve, la ejecución del día siguiente lo usa de nuevo sola.

Para quien opera:

1. Comprueba que la VPN está arriba y que el host de `CATALOG_BASE_URL` responde.
1. Consulta el `/health` del conector (comando de la [conmutación](#el-día-de-la-conmutación-stub-a-http)). Un `401` o `403` apunta a un token caducado o a una IP fuera del rango permitido.
1. Si el conector está caído, es del equipo del backend de publiexpe. En v1 no hay guardia humana ni SLA formal; los mantenimientos del conector quedan fuera de 07:00-10:00.
1. Si hace falta, apaga el catálogo con `CATALOG_ENABLED=false` mientras tanto.

## Las tools

Las tools del catálogo son de **solo lectura** (riesgo `READ`) y llevan el prefijo `catalog_`. Envuelven las operaciones del contrato; el LLD las llama `search_products`, `get_product`, etc.

| Tool | Operación del contrato | Qué hace |
|---|---|---|
| `catalog_search_products` | Buscar productos | Búsqueda por texto, SKU, familia y atributos, con cantidad |
| `catalog_get_product` | Ficha de producto | Ficha completa: variantes, personalización, `priceHint`, plazo y estado |
| `catalog_estimate_customization` | Estimar el marcaje | Precio orientativo del marcaje (técnica, zona, colores, cantidad) |
| `catalog_list_families` | Familias | Familias disponibles para filtrar |
| `catalog_describe` | Describir el vocabulario | Valores válidos de filtros y límites |

Reglas que cumplen todas:

- **No escriben nada.** Ninguna tool del catálogo reserva, crea o modifica.
- **Todo importe es orientativo.** Las tools devuelven `basis: "INDICATIVE"` tal cual y los agentes no lo presentan como precio cierto.
- Con `CATALOG_ENABLED=false` **no se exponen**: el agente no las ve, no puede llamarlas y no hay tráfico hacia el conector.
- Siguen el modelo de seguridad de siempre: allowlist por agente y techo de riesgo ([README del runtime, sección Tools](../runtime/agent-runtime/README.md)).

Quedan fuera por ahora `match_products`, `build_bundle` y `get_active_offers` del LLD. El emparejamiento semántico llega después, sobre un índice propio; las ofertas activas se reflejan en `priceHint.onOffer`.

## Qué gana la hipótesis

La hipótesis guarda en `recommended_products` una lista de productos reales en lugar de familias:

```json
"recommended_products": [
  {
    "productId": "10482",
    "sku": "12/BT-ALG-140",
    "name": "Bolsa tote de algodón 140 g",
    "priceHint": {
      "fromEur": 1.2,
      "toEur": 1.35,
      "basis": "INDICATIVE",
      "forQuantity": null,
      "perUnit": true,
      "includesCustomization": false,
      "onOffer": false
    }
  }
]
```

Lo que cambia para quien lee la hipótesis en Twenty (**Recommended products**):

- Verás el **nombre y la referencia** de cada producto (de 1 a 3), no solo una familia como «bolsas».
- Verás un **rango orientativo** por unidad, **sin IVA** y sin personalización. Es un punto de partida para la conversación, no un precio.
- Las hipótesis antiguas no cambian: siguen con sus familias.

Lo que no cambia:

- **El presupuesto sigue siendo del CMS de publiexpe.** El `priceHint` nunca es un precio cierto, y ningún agente lo cifra como tal en un borrador.
- El `productId` y el `sku` identifican el producto en el catálogo. Si un producto se retira, su ficha sale como `DISCONTINUED` y la hipótesis conserva la referencia.
- La decisión de qué proponer al cliente es tuya: el sistema recomienda, el comercial valida o descarta como hasta ahora.

## La skill del Prospector con catálogo

Existe una versión **DRAFT** de la skill del Prospector que, además de la necesidad, recomienda de **1 a 3 productos reales** del catálogo con su `priceHint` como dato orientativo. Está **sin activar**:

- Mientras sea `DRAFT`, no se usa en ninguna ejecución. La skill activa sigue produciendo familias genéricas.
- Para activarla debe pasar el [Release Gate](../runtime/agent-runtime/README.md#experiments-y-release-gate) como cualquier cambio de skill, con un experimento contra la versión activa. **El gate manda**: que el catálogo esté conectado no la activa.
- La activación es siempre una decisión humana ([regla de oro, LLD §19](LLD-0.1-publiexpe-commercial-os.md#19-regla-de-oro-del-sistema-evolutivo)). El procedimiento es el de [skill-optimizer.md](skill-optimizer.md#activar).
- Mide la aceptación por versión como en el [ciclo de mejora](ciclo-mejora-skills.md#7-mide-la-aceptación-por-versión).

> **Nota:** el experimento tiene que cubrir lo nuevo: que la skill no invente productos que la tool no devolvió, que no presente el `priceHint` como cierto y que respete el caso sin catálogo (modo degradado). Las reglas de evaluación correspondientes forman parte de la candidata, no de este documento.

## Seguridad

| Aspecto | Cómo se garantiza |
|---|---|
| **Red** | El conector no tiene endpoint público: se llega por **VPN** (montada en casa y en local de momento). El backend acepta solo el rango de IP de la VPN para este token |
| **Guard anti-SSRF** | El guard del runtime rechaza IP privadas por diseño. El cliente del catálogo queda exento **únicamente para el host exacto de `CATALOG_BASE_URL`** (host y puerto, sin subdominios). Nunca es una exención general: `fetch_url`, `render_url` y los webhooks de n8n conservan su guard intacto. Cambiar `CATALOG_BASE_URL` cambia el único host exento |
| **Texto no confiable** | Las descripciones y los textos libres del catálogo vienen de proveedores y pueden contener instrucciones dirigidas a un agente. Cuando viajan a un LLM van envueltos como **contenido no confiable** (`<<<DATOS_NO_CONFIABLES …>>>`, solo en mensajes de usuario), igual que el contenido web. Los ids, los importes y los vocabularios controlados no necesitan envoltorio |
| **Solo lectura** | Las tools son `READ`; el token es de solo lectura del catálogo; el servidor del backend se conecta con un rol de BD de solo lectura |
| **Sin datos sensibles** | El conector nunca expone coste, márgenes, tarifas crudas, datos de proveedor, clientes ni pedidos ([lista](catalog-connector-contrato.md#lo-que-el-conector-no-expone-nunca)). Lo que sale hacia el LLM (descripciones, atributos, imágenes) está permitido: publiexpe tiene licencia de los proveedores |
| **Precios** | Siempre orientativos y sin IVA. Ningún texto de borrador cifra un precio como cierto |
| **Token** | Solo en `deployments/.env`. Alta, rotación y revocación las hace el backend; la rotación admite dos tokens a la vez |
| **Auditoría** | Cada consulta queda en el registro del backend (token, operación, parámetros, resultado y tiempo) y en el `audit_log` del runtime |

## Qué no hace (todavía)

- No genera presupuestos ni los envía: el conector de presupuestos se diseñará después, con token propio de escritura ([Pendiente en el contrato](catalog-connector-contrato.md#pendiente)).
- No hace búsqueda semántica ni emparejamiento automático (`match_products`, `build_bundle`): llegan después.
- No sincroniza el catálogo de forma incremental: el contrato no promete `updatedSince` en v1.
- No avisa por correo de que el catálogo está caído (por principio).
- No activa solo la skill con catálogo.

## Documentos relacionados

- [Contrato del conector (v1.1, cerrado)](catalog-connector-contrato.md): formas JSON, límites, autenticación y red.
- [Respuesta del backend de publiexpe](catalog-connector-respuesta-backend.md): anexo del contrato.
- [Runbook de operación local](runbook-local.md#variables-del-runtime): tabla de variables.
- [Guía del equipo comercial](guia-comercial.md#cómo-leer-una-hipótesis): cómo leer una hipótesis.
- [Skill Optimizer](skill-optimizer.md): cómo se activa una versión de skill.
- [Integración con n8n](n8n-integracion.md): eventos del runtime.
- [Roadmap](ROADMAP.md): estado del Catalog Service.
