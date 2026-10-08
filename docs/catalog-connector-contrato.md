# Contrato del conector del catálogo de publiexpe (borrador v1)

> **PROPUESTA — pendiente de revisión con el equipo de publiexpe.** Este documento es un borrador redactado desde el lado de Commercial OS. Nada de lo que contiene está acordado ni implementado. Los campos y límites marcados con `[SUPUESTO]` los hemos supuesto sin haber visto el backend de publiexpe y hay que verificarlos en la reunión de revisión. Las [preguntas abiertas](#preguntas-abiertas-para-la-reunión-de-revisión) cierran el documento.

El Catalog Service del [LLD v0.1, sección 9](LLD-0.1-publiexpe-commercial-os.md#9-catalog-service-c2) da a los agentes acceso de **solo lectura** al catálogo de PubliEXPE (más de 15.000 productos) para que las hipótesis comerciales recomienden productos reales y no familias genéricas. Lleva bloqueado desde el inicio por una sola razón: falta el contrato del conector con el backend de publiexpe. Este documento propone ese contrato.

Para qué sirve cada lector:

- **Equipo de publiexpe:** qué tiene que exponer el conector, con qué forma y con qué límites, para estimar el trabajo y decir qué de esto no es posible.
- **Equipo de Commercial OS:** qué construir contra este contrato mientras tanto (un stub con la misma forma, tests de contrato) sin esperar a que el conector exista.

## Contenido

1. [Decisiones ya tomadas](#decisiones-ya-tomadas)
1. [Principios del contrato](#principios-del-contrato)
1. [Convenciones comunes](#convenciones-comunes)
1. [Operaciones mínimas](#operaciones-mínimas)
1. [Forma MCP equivalente](#forma-mcp-equivalente)
1. [Autenticación](#autenticación)
1. [Versionado del contrato](#versionado-del-contrato)
1. [Límites](#límites)
1. [Qué no hace el conector](#qué-no-hace-el-conector)
1. [Cómo lo usa Commercial OS](#cómo-lo-usa-commercial-os)
1. [Operaciones candidatas fuera del mínimo](#operaciones-candidatas-fuera-del-mínimo)
1. [Preguntas abiertas para la reunión de revisión](#preguntas-abiertas-para-la-reunión-de-revisión)
1. [Después de la revisión](#después-de-la-revisión)

## Decisiones ya tomadas

Estas decisiones están cerradas (LLD v0.1, sección 9, decididas el 2026-10-06) y este borrador no las discute:

- La fuente es la base de datos de publiexpe, expuesta por un **conector en el backend de publiexpe**: una API privada o un servidor MCP.
- **Este proyecto define el contrato** (operaciones, campos, filtros). El equipo del backend de publiexpe lo implementa.
- Los **presupuestos salen del CMS de publiexpe**, no de este sistema. Twenty guarda solo la referencia y el estado sobre la oportunidad. El presupuesto queda fuera de este contrato (consulta [Qué no hace el conector](#qué-no-hace-el-conector)).

## Principios del contrato

1. **Solo lectura.** El conector no tiene ninguna operación que escriba, reserve o genere nada.
1. **Nunca un precio comprometido.** Si el backend expone precios, el contrato los transporta como **orientativos** y así se etiquetan. El único precio que vincula a publiexpe es el del presupuesto del CMS.
1. **Una semántica, dos formas.** La API REST y el servidor MCP exponen las mismas operaciones con las mismas entradas y salidas. Basta con implementar una; la otra es una capa fina sobre la misma lógica.
1. **Identificadores estables.** `productId` no cambia nunca para un producto y no se reutiliza. Las hipótesis de Twenty guardan `productId` y `sku` (`recommendedProducts`), así que un id inestable rompe hipótesis ya escritas.
1. **Campos opcionales explícitos.** Un dato que el backend no tiene se devuelve como `null`, no se omite ni se inventa. El consumidor distingue "no existe" de "no lo sabemos".
1. **Tolerancia a campos nuevos.** El consumidor ignora los campos que no conoce. Añadir campos no rompe el contrato (consulta [Versionado](#versionado-del-contrato)).

## Convenciones comunes

| Aspecto | Contrato |
|---|---|
| Base de la API REST | `https://<host-del-conector>/catalog/v1` `[SUPUESTO]` |
| Formato | JSON UTF-8 (`Content-Type: application/json`), camelCase, como la API del runtime ([LLD v0.2, 6.1](LLD-0.2-especificacion.md)) |
| Identificadores | Cadenas opacas. `productId` y `familyId` son los ids internos del CMS; `sku` es la referencia comercial |
| Fechas | ISO 8601 UTC |
| Moneda | `EUR`. Los importes son números con punto decimal, sin símbolo, **sin IVA** `[SUPUESTO]` |
| Idioma | Español (`es`). Los textos vienen en el idioma del catálogo; no hay negociación de idioma en v1 `[SUPUESTO]` |
| Paginación | Por cursor (`cursor` y `limit`), nunca por desplazamiento: el catálogo tiene más de 15.000 productos y el orden debe ser estable aunque se actualice mientras se pagina |
| Cabecera de respuesta | `X-Catalog-Contract-Version: 1.0.0` en todas las respuestas |

**Formato de error** (el mismo del runtime, para que el cliente lo trate igual):

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "No existe el producto p-10482.",
    "details": { "productId": "p-10482" }
  }
}
```

| HTTP | `code` | Uso |
|---|---|---|
| 400 | `BAD_REQUEST` | Parámetro mal formado o fuera de rango |
| 401 | `UNAUTHENTICATED` | Falta el token o no es válido |
| 403 | `FORBIDDEN` | El token es válido pero no tiene permiso de lectura del catálogo |
| 404 | `NOT_FOUND` | El producto o la familia no existen |
| 429 | `RATE_LIMITED` | Se superó el límite; la respuesta trae `Retry-After` (segundos) |
| 503 | `UNAVAILABLE` | El conector o la base de datos del catálogo no están disponibles; reintentable |

## Operaciones mínimas

Cuatro operaciones bastan para que el runtime implemente `search_products` y `get_product` y para que la búsqueda semántica y el emparejamiento (`match_products`, `build_bundle`) se construyan en nuestro lado. Las rutas son de la forma REST; la [forma MCP](#forma-mcp-equivalente) es equivalente.

### 1. Buscar productos

`GET /catalog/v1/products`

Búsqueda por texto, familia y atributos, con paginación. Devuelve un **resumen** por producto; la ficha completa se pide con la operación 2.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `q` | texto (máx. 200 caracteres) | No | Búsqueda léxica sobre nombre, descripción corta, sku y atributos. Sin `q`, lista por familia o atributos |
| `familyId` | id | No | Restringe a una familia **y a sus descendientes** |
| `attr.<nombre>` | texto | No | Filtro por atributo, repetible: `attr.material=algodón&attr.color=azul`. Los nombres posibles los publica la ficha de producto y la operación de familias |
| `quantity` | entero ≥ 1 | No | Cantidad que se quiere pedir. Devuelve solo productos cuyo pedido mínimo es menor o igual `[SUPUESTO]` |
| `sort` | `relevance` \| `name` \| `updatedAt` | No | Por defecto `relevance` si hay `q`, `name` si no |
| `limit` | entero 1-100 | No | Por defecto 20 |
| `cursor` | texto opaco | No | El `nextCursor` de la página anterior |

Ejemplo de petición:

```sh
curl -s "https://<host-del-conector>/catalog/v1/products?q=bolsa%20tote&attr.material=algod%C3%B3n&quantity=300&limit=2" \
  -H "Authorization: Bearer $CATALOG_TOKEN"
```

Ejemplo de respuesta (datos ficticios):

```json
{
  "items": [
    {
      "productId": "p-10482",
      "sku": "BT-ALG-140",
      "name": "Bolsa tote de algodón 140 g",
      "familyId": "f-bolsas",
      "familyName": "Bolsas",
      "shortDescription": "Bolsa de algodón natural con asas largas, personalizable en serigrafía.",
      "minQuantity": 100,
      "priceHint": { "fromEur": 1.2, "toEur": 2.4, "basis": "INDICATIVE", "forQuantity": 300 },
      "imageUrl": "https://conector.publiexpe.example/img/p-10482.jpg",
      "productUrl": "https://catalogo.publiexpe.example/p/bt-alg-140",
      "updatedAt": "2026-09-30T08:12:44Z"
    },
    {
      "productId": "p-10517",
      "sku": "BT-ALG-220",
      "name": "Bolsa tote de algodón 220 g reforzada",
      "familyId": "f-bolsas",
      "familyName": "Bolsas",
      "shortDescription": "Algodón grueso con fondo reforzado.",
      "minQuantity": 50,
      "priceHint": null,
      "imageUrl": null,
      "productUrl": "https://catalogo.publiexpe.example/p/bt-alg-220",
      "updatedAt": "2026-08-14T11:03:02Z"
    }
  ],
  "page": { "limit": 2, "nextCursor": "eyJvIjoyfQ", "totalApprox": 37 }
}
```

`totalApprox` es opcional: si calcularlo es caro, puede ser `null`. El fin de la lista se detecta porque `nextCursor` es `null`.

### 2. Ficha de producto

`GET /catalog/v1/products/{productId}`

La ficha completa de un producto. Es lo que lee el agente antes de recomendarlo.

| Campo | Tipo | Descripción |
|---|---|---|
| `productId`, `sku`, `name` | texto | Identificación. `sku` puede ser `null` si el producto no tiene referencia |
| `family` | objeto | `{ familyId, name, path }`; `path` es la lista de nombres desde la raíz, por ejemplo `["Textil", "Bolsas"]` |
| `description` | texto (máx. 4.000 caracteres) | Descripción comercial. Texto plano, sin HTML `[SUPUESTO]` |
| `descriptionTruncated` | booleano | `true` si la descripción original era más larga y se ha recortado |
| `attributes` | lista | Atributos del producto: `{ name, label, values[] }`. `name` es la clave estable que se usa en `attr.<nombre>`; `label` es el texto legible |
| `customization` | objeto o `null` | Cómo se personaliza (consulta abajo) |
| `quantity` | objeto | `{ min, step, breaks }`: pedido mínimo, múltiplo de pedido y tramos de cantidad (`breaks`, lista de enteros, puede estar vacía) |
| `priceHint` | objeto o `null` | Rango **orientativo**. `null` si el backend no expone precios |
| `leadTimeDays` | objeto o `null` | `{ min, max }`: días de producción orientativos `[SUPUESTO]` |
| `images` | lista | `{ url, kind }` con `kind` en `MAIN` o `GALLERY`; puede estar vacía |
| `productUrl` | texto | Página pública del producto |
| `status` | `ACTIVE` \| `DISCONTINUED` | Un producto descatalogado se sigue devolviendo para que las hipótesis antiguas no apunten a un 404 |
| `updatedAt` | fecha | Última modificación |

`customization`:

| Campo | Tipo | Descripción |
|---|---|---|
| `techniques` | lista de texto | Técnicas disponibles: `serigrafía`, `bordado`, `grabado láser`... Vocabulario de publiexpe `[SUPUESTO]` |
| `areas` | lista de texto | Zonas personalizables, si el backend las modela |
| `maxColors` | entero o `null` | Colores máximos de la marca |
| `notes` | texto o `null` | Restricciones relevantes (por ejemplo, "no admite impresión en el asa") |

`priceHint`:

| Campo | Tipo | Descripción |
|---|---|---|
| `fromEur`, `toEur` | número | Extremos del rango, **sin IVA**. `fromEur ≤ toEur` |
| `basis` | `INDICATIVE` | Siempre este valor en v1. Un precio comprometido no existe en este contrato |
| `forQuantity` | entero o `null` | Cantidad para la que se calculó el rango. `null` si el rango no depende de la cantidad |
| `perUnit` | `true` | Precio por unidad. Se fija para evitar ambigüedad con el total del pedido `[SUPUESTO]` |

Ejemplo de respuesta (datos ficticios):

```json
{
  "productId": "p-10482",
  "sku": "BT-ALG-140",
  "name": "Bolsa tote de algodón 140 g",
  "family": { "familyId": "f-bolsas", "name": "Bolsas", "path": ["Textil", "Bolsas"] },
  "description": "Bolsa de algodón natural de 140 g con asas largas de 70 cm. Apta para serigrafía a una o dos tintas.",
  "descriptionTruncated": false,
  "attributes": [
    { "name": "material", "label": "Material", "values": ["algodón"] },
    { "name": "color", "label": "Color", "values": ["natural", "negro", "azul marino"] },
    { "name": "medida", "label": "Medida", "values": ["38 x 42 cm"] }
  ],
  "customization": {
    "techniques": ["serigrafía"],
    "areas": ["frontal", "trasera"],
    "maxColors": 2,
    "notes": null
  },
  "quantity": { "min": 100, "step": 50, "breaks": [100, 300, 500, 1000] },
  "priceHint": { "fromEur": 1.2, "toEur": 2.4, "basis": "INDICATIVE", "forQuantity": 300, "perUnit": true },
  "leadTimeDays": { "min": 7, "max": 12 },
  "images": [
    { "url": "https://conector.publiexpe.example/img/p-10482.jpg", "kind": "MAIN" }
  ],
  "productUrl": "https://catalogo.publiexpe.example/p/bt-alg-140",
  "status": "ACTIVE",
  "updatedAt": "2026-09-30T08:12:44Z"
}
```

### 3. Familias y categorías

`GET /catalog/v1/families`

Devuelve el árbol de familias como lista plana con `parentId`. Sirve para dos cosas: que el agente sepa qué familias existen antes de buscar y que `familyId` y `attr.<nombre>` tengan valores válidos.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `parentId` | id | No | Devuelve solo los hijos directos. Sin él, devuelve todo el árbol |
| `includeAttributes` | booleano | No | Si es `true`, cada familia lista los atributos filtrables (`name`, `label` y valores más frecuentes) |

```json
{
  "items": [
    { "familyId": "f-textil", "name": "Textil", "parentId": null, "productCount": 3120 },
    {
      "familyId": "f-bolsas",
      "name": "Bolsas",
      "parentId": "f-textil",
      "productCount": 412,
      "attributes": [
        { "name": "material", "label": "Material", "topValues": ["algodón", "yute", "poliéster"] }
      ]
    }
  ]
}
```

El árbol completo no se pagina: se espera que tenga unos cientos de nodos como mucho `[SUPUESTO]`. `productCount` cuenta los productos activos de la familia **y de sus descendientes**.

### 4. Salud y versión

`GET /catalog/v1/health`

Permite al runtime comprobar que el conector responde y con qué contrato habla, antes de depender de él.

```json
{
  "status": "ok",
  "contractVersion": "1.0.0",
  "connectorVersion": "0.3.2",
  "catalog": { "productCount": 15342, "lastUpdatedAt": "2026-10-08T06:00:11Z" }
}
```

| Campo | Descripción |
|---|---|
| `status` | `ok` o `degraded` (responde, pero con la base de datos lenta o con datos antiguos). Si no puede responder, la API devuelve `503` |
| `contractVersion` | La versión de este contrato que implementa el conector |
| `connectorVersion` | Versión interna del conector; informativa |
| `catalog.productCount` | Productos activos |
| `catalog.lastUpdatedAt` | Última modificación de cualquier producto; sirve para saber si la sincronización llega al día |

`/health` exige el mismo token. Si el equipo de publiexpe necesita un `/health` público para su monitorización, puede devolver solo `{ "status": "ok" }` sin autenticar.

## Forma MCP equivalente

Si el conector se implementa como servidor MCP, expone **cuatro herramientas** con la misma semántica. Los nombres llevan el prefijo `catalog_` para no chocar con las tools del runtime (`search_products`, `get_product`), que las envuelven.

| Herramienta MCP | Equivale a | Entrada | Salida |
|---|---|---|---|
| `catalog_search_products` | `GET /products` | `q`, `familyId`, `attributes` (objeto `{ nombre: valor }`), `quantity`, `sort`, `limit`, `cursor` | Igual que la respuesta REST: `items` y `page` |
| `catalog_get_product` | `GET /products/{productId}` | `productId` | La ficha completa |
| `catalog_list_families` | `GET /families` | `parentId`, `includeAttributes` | `items` |
| `catalog_health` | `GET /health` | ninguna | El objeto de salud |

Reglas de la forma MCP:

- La entrada de cada herramienta es un objeto JSON con las mismas claves que los parámetros REST. La única diferencia es `attributes`: en REST va como `attr.<nombre>` por ser parámetros de URL; en MCP, como objeto.
- La salida es el mismo JSON, devuelto como contenido estructurado de la herramienta. Los errores usan el mismo objeto `error` con `code`, `message` y `details`.
- Transporte: MCP sobre HTTP (streamable) con el mismo token Bearer `[SUPUESTO]`. Un servidor MCP por `stdio` solo serviría si el conector corriera en la misma máquina que el runtime, lo que no es el caso previsto.
- Las herramientas son todas de solo lectura y así deben declararse (anotación de solo lectura de MCP).

## Autenticación

| Aspecto | Contrato |
|---|---|
| Esquema | `Authorization: Bearer <token>`, en REST y en MCP |
| Token | **Dedicado** a Commercial OS, distinto del de cualquier otro consumidor del backend de publiexpe. Un token por entorno (pruebas y producción) |
| Permisos | **Solo lectura** del catálogo. El token no debe poder invocar ninguna operación de escritura del backend, aunque exista |
| Alcance de datos | Solo catálogo. El token no da acceso a clientes, pedidos, presupuestos ni precios internos o de coste |
| Transporte | Solo HTTPS (TLS 1.2 o superior) |
| Rotación | Rotable sin parar el servicio: el conector acepta el token nuevo y el anterior durante una ventana de solapamiento `[SUPUESTO]` |
| Custodia | En Commercial OS, el token vive en `deployments/.env` como el resto de secretos y nunca en el repositorio |
| Restricción de red | Opcional: lista de IP de origen permitidas. Depende de [dónde corra el runtime](#preguntas-abiertas-para-la-reunión-de-revisión) |

## Versionado del contrato

El contrato lleva una versión semántica (`MAJOR.MINOR.PATCH`) separada de la versión del conector.

| Cambio | Versión | Ejemplo |
|---|---|---|
| Compatible hacia atrás: campo nuevo opcional, operación nueva, valor nuevo en un filtro | `MINOR` | Añadir `stock` a la ficha |
| Aclaración sin cambio de comportamiento | `PATCH` | Corregir un ejemplo o una descripción |
| Incompatible: quitar o renombrar un campo, cambiar un tipo, cambiar el significado de un filtro | `MAJOR` | `priceHint` pasa a ser lista |

- La versión `MAJOR` va en la ruta (`/catalog/v1`). Un cambio incompatible se publica en `/catalog/v2` y `v1` sigue disponible un periodo de transición de **90 días como mínimo** `[SUPUESTO]`.
- El conector informa su versión de contrato en `X-Catalog-Contract-Version` y en `/health`. El runtime lee `/health` al arrancar el servicio de catálogo y se niega a usar un `MAJOR` que no conoce.
- El contrato se publicará, una vez cerrado, como esquema JSON versionado en este repositorio (LLD v0.1, sección 21), con tests de contrato que ejecutan tanto nuestro stub como el conector real.

## Límites

Valores propuestos `[SUPUESTO]`; el equipo de publiexpe sabe qué aguanta su backend.

| Límite | Propuesta | Motivo |
|---|---|---|
| Frecuencia | 10 peticiones por segundo por token, con ráfagas de 20 | El uso normal es de decenas de consultas por ejecución de agente; la ingesta periódica es más intensa pero tolera esperar |
| `limit` por página | Por defecto 20, máximo 100 | Respuestas de unos pocos cientos de KB |
| Longitud de `q` | 200 caracteres | Evita consultas abusivas |
| Tamaño de respuesta | 1 MB como máximo | Una página de 100 resúmenes cabe de sobra |
| Longitud de `description` | 4.000 caracteres | Si la original es más larga, se trunca (y la ficha lo indica en `descriptionTruncated: true`) |
| Tiempo de respuesta | 10 s como máximo por petición; objetivo p95 de 1 s en búsqueda y de 300 ms en ficha | El agente espera cada llamada; el runtime corta a los 10 s |
| `429` | Con `Retry-After` en segundos | El cliente respeta la espera y reintenta con retardo exponencial, máximo 3 veces |
| Cursor | Válido al menos 10 minutos | Tiempo de sobra para recorrer el catálogo paginando |

## Qué no hace el conector

El conector es una ventana de lectura sobre el catálogo. No hace, ni ahora ni en versiones futuras de este contrato:

- **No escribe** nada en el backend de publiexpe.
- **No reserva stock** ni compromete existencias.
- **No genera presupuestos** ni calcula el precio de un pedido. Eso es del CMS de publiexpe, con su propio contrato (la tool `create_quote_request`, de riesgo alto y con aprobación humana, se tratará aparte).
- **No compromete precios.** Los importes son orientativos y se etiquetan así.
- **No expone datos de clientes**, pedidos ni márgenes.
- **No recomienda ni empareja productos.** Decidir qué producto encaja con una necesidad es trabajo del Catalog Service de Commercial OS (`match_products`, `build_bundle`).

## Cómo lo usa Commercial OS

El Catalog Service del LLD se construye sobre estas cuatro operaciones:

| Pieza del LLD §9 | Qué usa del conector |
|---|---|
| `search` (léxica) | Operación 1, con filtros por familia y atributos |
| `get_product` | Operación 2 |
| `semantic` (pgvector sobre descripciones) | Recorrido paginado de la operación 1 y ficha de la operación 2 para construir los embeddings en nuestro lado. Si el volumen lo pide, la [operación candidata de sincronización incremental](#operaciones-candidatas-fuera-del-mínimo) |
| `match_products`, `build_bundle` | Se calculan en Commercial OS sobre las dos anteriores; no necesitan operaciones propias del conector |
| `pricing` | Solo `priceHint`, mostrado como **orientativo**. Las hipótesis nunca cifran un precio como cierto |
| `get_active_offers` | Pendiente de decisión: consulta [Operaciones candidatas](#operaciones-candidatas-fuera-del-mínimo) |

Correspondencia con las tools actuales del runtime: `search_products` y `get_product` envuelven las operaciones 1 y 2. La forma mínima que el [LLD v0.2](LLD-0.2-especificacion.md) dio al stub (`ProductRef`, `priceEur`, `offerActive`) cambia en dos puntos al adoptar este contrato: el precio pasa de `priceEur` (un valor "vigente") a `priceHint` (un rango orientativo) y `offerActive` desaparece de la búsqueda hasta que se decida lo de las ofertas. `productId`, `sku` y `name` se mantienen, de modo que `recommendedProducts` de las hipótesis no cambia de forma.

## Operaciones candidatas fuera del mínimo

No forman parte de la v1 mínima. Se listan para decidir en la revisión si entran, se posponen o no hacen falta:

| Operación | Para qué | Cuándo hace falta |
|---|---|---|
| Sincronización incremental: `GET /products?updatedSince=<fecha>&cursor=...` (lista de resúmenes o fichas con `status` incluido, incluyendo descatalogados) | Mantener el índice semántico al día sin recorrer 15.000 productos cada vez | Si la ingesta periódica completa es demasiado pesada para el backend |
| Ofertas activas: `GET /offers` (producto, descuento orientativo, vigencia) | La tool `get_active_offers`: las ofertas son un diferencial de PubliEXPE frente a la competencia | Si el CMS modela ofertas y se pueden exponer sin comprometer precios |
| Productos relacionados o complementarios: `GET /products/{productId}/related` | Alimentar `build_bundle` con la lógica comercial que el CMS ya tenga | Si el CMS tiene relaciones curadas que valga la pena aprovechar en lugar de inferirlas |

## Preguntas abiertas para la reunión de revisión

Las preguntas están agrupadas por tema. Las que más condicionan el diseño van primero en cada grupo.

### Precios

1. ¿Qué precios expone el backend de forma segura para un tercero? ¿Precio de tarifa, precio por tramos de cantidad, precio con personalización incluida, coste?
1. ¿Se pueden dar **rangos orientativos** (`priceHint`)? ¿Por unidad o por pedido? ¿Para qué cantidad se calcula el rango?
1. ¿Hay un precio que publiexpe **no** quiere que salga del backend (por ejemplo, el coste o los márgenes)? ¿Hay que filtrarlo en el conector?
1. ¿Los importes son con o sin IVA? ¿Cambia con el país del cliente?
1. ¿Los tramos de cantidad (`quantity.breaks`) existen como dato estructurado o son texto libre?

### Datos del producto

1. ¿Cuál es la taxonomía real del CMS: familias, categorías, subcategorías? ¿Un producto puede estar en **varias** familias? ¿La estructura es un árbol?
1. ¿Hay **imágenes**? ¿Con URL pública estable y con derechos que permitan citarlas en una nota interna de Twenty? ¿Qué tamaños?
1. ¿Hay **stock** o disponibilidad? ¿Interesa exponerlo (aunque sin reservarlo) o publiexpe produce bajo pedido y no aplica?
1. ¿Existe un **plazo de producción** por producto (`leadTimeDays`)? Es relevante porque el taller propio es un diferencial cuando la feria está cerca.
1. ¿Qué datos de **personalización** estructurados hay (técnicas, zonas, colores máximos) y cuáles son texto libre?
1. ¿`sku` existe siempre? ¿`productId` es estable en el tiempo, incluso si se reorganiza el catálogo?
1. ¿Cómo se marca un producto **descatalogado**? ¿Se sigue pudiendo consultar su ficha?
1. ¿Los atributos tienen vocabulario controlado (valores cerrados) o texto libre? Condiciona los filtros `attr.<nombre>`.
1. ¿La descripción viene en texto plano, en HTML o en un formato propio del CMS?

### Idiomas

1. ¿El catálogo está solo en español? ¿Hay traducciones (catalán, inglés) que convenga exponer con un parámetro `lang`?

### Operación y servicio

1. ¿Qué **SLA** puede ofrecer el conector (disponibilidad, tiempos de respuesta)? ¿Hay ventanas de mantenimiento?
1. ¿Qué carga aguanta el backend? ¿Valen los límites propuestos o hay que bajarlos?
1. ¿Prefieren **API REST** o **servidor MCP** como forma principal? ¿Les resulta mucho más costoso ofrecer las dos?
1. ¿Hay un entorno de **pruebas** (staging) con un subconjunto del catálogo y un token propio, para construir y probar contra él antes de producción?
1. ¿Podemos recibir un **volcado de muestra** (unos cientos de productos reales, anonimizados si hace falta) para escribir los tests de contrato y los fixtures?

### Despliegue y mantenimiento

1. ¿**Dónde se despliega** el conector? ¿Dentro del backend de publiexpe, como servicio aparte, o en la infraestructura de Commercial OS apuntando a una réplica de su base de datos?
1. ¿Cómo llega el runtime de Commercial OS al conector? Hoy el runtime corre en Docker en local: ¿endpoint público con TLS y token, VPN, lista de IP?
1. ¿**Quién mantiene** el conector (publiexpe, Bitclick, ambos)? ¿Quién atiende un fallo a las 08:00, hora de la prospección diaria?
1. ¿Quién decide y cómo se comunica un cambio de contrato? ¿Valen 90 días de transición?

### Seguridad y cumplimiento

1. ¿Qué token, qué rotación y qué política de revocación exige su equipo de seguridad?
1. ¿Hay datos del catálogo que no deban salir de la infraestructura de publiexpe (por ejemplo, hacia el proveedor de LLM que procesa las hipótesis)? Las descripciones de producto sí se envían a un LLM.
1. ¿Quieren auditoría de las consultas (quién pidió qué)? Nosotros podemos registrar las nuestras en el `audit_log` del runtime; ¿necesitan el registro de su lado?

### Presupuestos (fuera de este contrato, pero condiciona el orden de trabajo)

1. El conector de presupuestos (`create_quote_request` en el CMS) ¿lo diseña el mismo equipo y en la misma reunión, o va después? ¿Comparte token, host y servidor con este conector, o es aparte (por ser de escritura)?

## Después de la revisión

1. Se resuelven las preguntas abiertas y se dan por cerrados los `[SUPUESTO]` que se confirmen; los que no, se corrigen.
1. Se fija la versión `1.0.0` del contrato y se publica como esquema JSON versionado en el repositorio, con ejemplos validados.
1. Commercial OS implementa su Catalog Service contra un **stub fiel al contrato** (con los datos de muestra) y tests de contrato, sin esperar al conector real.
1. El equipo de publiexpe implementa el conector; los tests de contrato se ejecutan contra el entorno de pruebas y deben pasar antes de cualquier integración real.
1. Con el conector real activo, se activan las tools `search_products` y `get_product`, y se recalculan las hipótesis con productos reales. Las tools `match_products` y `build_bundle` llegan después, sobre el índice semántico.

## Documentos relacionados

- [LLD v0.1, sección 9](LLD-0.1-publiexpe-commercial-os.md#9-catalog-service-c2): el Catalog Service y la decisión del conector.
- [LLD v0.2, sección 5](LLD-0.2-especificacion.md): tools del Catalog Service y forma mínima del stub.
- [Roadmap](ROADMAP.md): estado del Catalog Service.
