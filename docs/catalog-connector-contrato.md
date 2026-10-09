# Contrato del conector del catálogo de publiexpe (v1.1)

> **v1.1 — CERRADO para implementación, acordado 2026-10-09 entre Commercial OS y el backend de publiexpe.** Este documento es el contrato: el backend implementa el conector contra él y Commercial OS construye su cliente y su stub contra él. Parte del borrador v1 (Commercial OS) y de la [respuesta del backend](catalog-connector-respuesta-backend.md) (anexo), e incorpora los 18 cambios de esa respuesta, las decisiones de su tabla de pendientes y tres correcciones de Commercial OS. Lo que sigue abierto está en [Pendiente](#pendiente).

El Catalog Service del [LLD v0.1, sección 9](LLD-0.1-publiexpe-commercial-os.md#9-catalog-service-c2) da a los agentes acceso de **solo lectura** al catálogo de PubliEXPE (más de 15.000 productos) para que las hipótesis comerciales recomienden productos reales y no familias genéricas. Este documento define el conector que lo hace posible.

Para qué sirve cada lector:

- **Equipo del backend de publiexpe:** qué expone el conector, con qué forma y con qué límites, y qué no puede exponer nunca.
- **Equipo de Commercial OS:** contra qué se escribe el cliente HTTP, el stub fiel y los tests de contrato. El lado operativo de Commercial OS (flags, conmutación, degradado) está en [catalog-service.md](catalog-service.md).

## Contenido

1. [Decisiones cerradas](#decisiones-cerradas)
1. [Principios del contrato](#principios-del-contrato)
1. [Convenciones comunes](#convenciones-comunes)
1. [Operaciones](#operaciones)
1. [Forma MCP equivalente](#forma-mcp-equivalente)
1. [Autenticación y red](#autenticación-y-red)
1. [Disponibilidad y modo degradado](#disponibilidad-y-modo-degradado)
1. [Versionado del contrato](#versionado-del-contrato)
1. [Límites](#límites)
1. [Lo que el conector no expone nunca](#lo-que-el-conector-no-expone-nunca)
1. [Qué no hace el conector](#qué-no-hace-el-conector)
1. [Cómo lo usa Commercial OS](#cómo-lo-usa-commercial-os)
1. [Fuera de v1](#fuera-de-v1)
1. [Pendiente](#pendiente)
1. [Después del cierre](#después-del-cierre)

## Decisiones cerradas

### Del LLD v0.1, sección 9 (2026-10-06)

- La fuente es la base de datos de publiexpe, expuesta por un **conector en el backend de publiexpe**.
- **Este proyecto define el contrato** (operaciones, campos, filtros). El equipo del backend lo implementa.
- Los **presupuestos salen del CMS de publiexpe**, no de este sistema. Twenty guarda solo la referencia y el estado sobre la oportunidad. El presupuesto queda fuera de este contrato (consulta [Qué no hace el conector](#qué-no-hace-el-conector)).

### Acordadas el 2026-10-09

La columna "Origen" distingue lo que viene de la [respuesta del backend](catalog-connector-respuesta-backend.md) de lo que corrige Commercial OS.

| Tema | Decisión | Origen |
|---|---|---|
| Alcance del acuerdo | Los 18 cambios de la [respuesta del backend](catalog-connector-respuesta-backend.md#cambios-propuestos-al-contrato), tal cual, incorporados en el cuerpo de este documento | Backend, aceptado |
| Operaciones | Seis: búsqueda, ficha, estimación de marcaje, familias, `describe` y salud. REST en `/api/catalog/v1` y MCP en `/api/catalog/mcp`, sobre una única capa de servicio | Backend, aceptado |
| Forma | REST y MCP desde el inicio | Backend, aceptado |
| SKU | Existe siempre; `productId` es la clave primaria como cadena opaca | Backend, aceptado |
| Precio orientativo | El **de la tienda**, es decir, el precio de cada variante con el descuento global de tarifa. Sin IVA | Backend, aceptado |
| Ofertas | `onOffer` sí: si hay una oferta activa menor, el rango la refleja | Backend, aceptado |
| `customization.notes` | `null` en v1 | Backend, aceptado |
| Descatalogados | **Lápidas** en v1: el conector devuelve `DISCONTINUED` también para los productos que el proveedor retira y el importador borra. Despublicar en los importadores queda como tarea aparte del backend (consulta [Pendiente](#pendiente)) | Backend, aceptado |
| Versionado | 90 días de transición entre versiones mayores | Backend, aceptado |
| SLA | Sin SLA formal en v1: servicio interno. Objetivo de p95 de 1 s en búsqueda y 300 ms en ficha. Mantenimientos fuera de 07:00-10:00 | Backend, aceptado |
| Guardia | Sin guardia humana en v1. **Corrección de Commercial OS:** si `/health` falla a las 08:00, Commercial OS ejecuta la prospección **sin catálogo** y avisa con una **nota ⚠️ en Twenty y el evento `catalog.unavailable` para n8n, nunca por correo** (el runtime no envía correo por principio). Detalle en [Disponibilidad y modo degradado](#disponibilidad-y-modo-degradado) | Commercial OS, corrige al backend ("avisa por correo") |
| Red | **VPN**, montada en casa y en local de momento; sin endpoint público. **Corrección de Commercial OS:** el cliente del catálogo del runtime queda exento del guard anti-SSRF **únicamente para el host exacto configurado en `CATALOG_BASE_URL`**, nunca como exención general. Detalle en [Autenticación y red](#autenticación-y-red) | Backend (VPN) y Commercial OS (guard) |
| Confianza | **Corrección de Commercial OS:** las descripciones y los textos libres del catálogo (su origen son los proveedores) viajan a un LLM envueltos como contenido no confiable. Detalle en [Texto libre del catálogo](#texto-libre-del-catálogo-contenido-no-confiable) | Commercial OS |
| Imágenes | Publiexpe tiene licencia de los proveedores: se pueden citar en Twenty y enviar al LLM | Backend, aceptado |
| Token y auditoría | Alta, rotación, revocación y registro de consultas en Django (backend de publiexpe). Commercial OS solo custodia el token | Backend, aceptado |
| Volcado de muestra | No hace falta: los fixtures del stub y de los tests de contrato salen de la base local del backend | Backend, aceptado |
| Presupuestos | El conector de presupuestos se diseña **después** de este, con **token propio de escritura** | Backend, aceptado |

## Principios del contrato

1. **Solo lectura.** El conector no tiene ninguna operación que escriba, reserve o genere nada. La estimación de marcaje calcula; no guarda.
1. **Nunca un precio comprometido.** Todos los importes que salen del conector son **orientativos** y así se etiquetan (`basis: "INDICATIVE"`). El único precio que vincula a publiexpe es el del presupuesto del CMS.
1. **Una semántica, dos formas.** La API REST y el servidor MCP exponen las mismas operaciones con las mismas entradas y salidas, sobre una única capa de servicio. Un test de paridad del backend comprueba que la misma entrada da el mismo JSON por los dos caminos.
1. **Identificadores estables.** `productId` no cambia mientras el producto existe y no se reutiliza. Las hipótesis de Twenty guardan `productId` y `sku` (`recommendedProducts`). Si un producto se recrea con otro id, el filtro `sku` permite reencontrarlo.
1. **Campos opcionales explícitos.** Un dato que el backend no tiene se devuelve como `null`, no se omite ni se inventa. El consumidor distingue "no existe" de "no lo sabemos".
1. **Tolerancia a campos nuevos.** El consumidor ignora los campos que no conoce. Añadir campos no rompe el contrato (consulta [Versionado](#versionado-del-contrato)).
1. **Salida por lista blanca.** Toda respuesta se construye desde los DTO del contrato, nunca serializando un modelo entero. Por eso el conector expone herramientas de dominio y no un descubrimiento genérico de modelos.

## Convenciones comunes

| Aspecto | Contrato |
|---|---|
| Base de la API REST | `https://<host-del-conector>/api/catalog/v1`. El servidor web solo envía `/api/` al backend |
| Base del servidor MCP | `https://<host-del-conector>/api/catalog/mcp` |
| Formato | JSON UTF-8 (`Content-Type: application/json`), camelCase, como la API del runtime ([LLD v0.2, 6.1](LLD-0.2-especificacion.md)) |
| Identificadores | Cadenas opacas. `productId` es la clave primaria del producto como cadena (`"10482"`); `familyId` y `variantId` son los ids internos. `sku` es la referencia comercial |
| Fechas | ISO 8601 UTC |
| Moneda | `EUR`. Importes como números con punto decimal, sin símbolo, **siempre sin IVA**. El país del cliente cambia el IVA del pedido, no el del catálogo |
| Idioma | Solo español (`es`). No hay parámetro `lang` en v1 |
| Paginación | Por cursor (`cursor` y `limit`), nunca por desplazamiento |
| Cabecera de respuesta | `X-Catalog-Contract-Version: 1.1.0` en todas las respuestas |
| Esquema ejecutable | El backend genera JSON Schema desde los DTO (`schemas/v1/*.json`). Es la referencia ejecutable de este contrato para los tests de contrato |

> **Nota:** `sku` puede repetirse entre productos y lleva el prefijo del proveedor con barra (por ejemplo `1/3920`). Por eso no sirve como id de ruta: la ficha se pide siempre por `productId`, y el SKU se usa como dato y como filtro.

**Formato de error** (el mismo del runtime, para que el cliente lo trate igual):

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "No existe el producto 10482.",
    "details": { "productId": "10482" }
  }
}
```

| HTTP | `code` | Uso |
|---|---|---|
| 400 | `BAD_REQUEST` | Parámetro mal formado, fuera de rango o incompatible con el producto (por ejemplo, una técnica que el producto no admite) |
| 401 | `UNAUTHENTICATED` | Falta el token o no es válido |
| 403 | `FORBIDDEN` | El token es válido pero no tiene permiso de lectura del catálogo, o la IP de origen no está permitida |
| 404 | `NOT_FOUND` | El producto o la familia no existen (y no hay lápida) |
| 429 | `RATE_LIMITED` | Se superó el límite por token; la respuesta trae `Retry-After` (segundos) |
| 503 | `UNAVAILABLE` | El conector o la base de datos del catálogo no están disponibles; reintentable |

## Operaciones

Seis operaciones. Las rutas son de la forma REST; la [forma MCP](#forma-mcp-equivalente) es equivalente.

| REST | MCP | Para qué |
|---|---|---|
| `GET /api/catalog/v1/products` | `catalog_search_products` | Buscar y filtrar, con resumen por producto |
| `GET /api/catalog/v1/products/{productId}` | `catalog_get_product` | Ficha completa |
| `GET /api/catalog/v1/products/{productId}/customization-estimate` | `catalog_estimate_customization` | Estimar el marcaje, con margen aplicado |
| `GET /api/catalog/v1/families` | `catalog_list_families` | Árbol de familias |
| `GET /api/catalog/v1/describe` | `catalog_describe` | Vocabulario de filtros y límites |
| `GET /api/catalog/v1/health` | `catalog_health` | Salud y versión del contrato |

### 1. Buscar productos

`GET /api/catalog/v1/products`

Búsqueda por texto, familia, SKU y atributos, con paginación. Devuelve un **resumen** por producto; la ficha completa se pide con la operación 2. La búsqueda de texto es la de la tienda (texto completo en español, sin tildes, más similitud por trigramas sobre nombre y referencia), así que tienda y conector dan los mismos resultados. No busca dentro de atributos ni etiquetas: color, talla, material y marca se filtran con `attr.<nombre>`.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `q` | texto (máx. 200 caracteres) | No | Búsqueda de texto sobre nombre y referencia. Sin `q`, lista por familia, SKU o atributos |
| `sku` | texto | No | Coincidencia **exacta** con el `sku` del producto. Puede devolver más de un producto, porque el SKU puede repetirse. Sirve para reencontrar una hipótesis antigua si el producto se recreó con otro id |
| `familyId` | id | No | Restringe a una familia **y a sus descendientes**. Incluye también los productos que la tienen como familia secundaria |
| `attr.<nombre>` | texto | No | Filtro por atributo, repetible: `attr.color=azul&attr.size=M`. Los nombres son los de [Atributos](#atributos). Los valores válidos de color y talla los publica `describe` |
| `quantity` | entero ≥ 1 | No | Cantidad que se quiere pedir. Devuelve solo productos cuyo pedido mínimo (`quantity.min`) es menor o igual |
| `sort` | `relevance` \| `name` \| `updatedAt` | No | Por defecto `relevance` si hay `q`, `name` si no |
| `limit` | entero 1-100 | No | Por defecto 20 |
| `cursor` | texto opaco | No | El `nextCursor` de la página anterior. Válido 10 minutos |

Ejemplo de petición:

```sh
curl -s "https://<host-del-conector>/api/catalog/v1/products?q=bolsa%20tote&attr.color=beige&quantity=300&limit=2" \
  -H "Authorization: Bearer $CATALOG_API_TOKEN"
```

Ejemplo de respuesta (datos ficticios):

```json
{
  "items": [
    {
      "productId": "10482",
      "sku": "12/BT-ALG-140",
      "name": "Bolsa tote de algodón 140 g",
      "familyId": "f-bolsas",
      "familyName": "Bolsas",
      "shortDescription": "Bolsa de algodón natural con asas largas, personalizable en serigrafía.",
      "minQuantity": 100,
      "variantCount": 3,
      "colors": ["beige", "negro", "azul"],
      "inStock": true,
      "priceHint": {
        "fromEur": 1.2,
        "toEur": 1.35,
        "basis": "INDICATIVE",
        "forQuantity": null,
        "perUnit": true,
        "includesCustomization": false,
        "onOffer": false
      },
      "imageUrl": "https://publiexpe.example/media/p/10482-800.webp",
      "productUrl": "https://publiexpe.example/producto/bolsa-tote-algodon-140/",
      "updatedAt": "2026-09-30T08:12:44Z"
    },
    {
      "productId": "10517",
      "sku": "12/BT-ALG-220",
      "name": "Bolsa tote de algodón 220 g reforzada",
      "familyId": "f-bolsas",
      "familyName": "Bolsas",
      "shortDescription": "Algodón grueso con fondo reforzado.",
      "minQuantity": 50,
      "variantCount": 1,
      "colors": ["beige"],
      "inStock": false,
      "priceHint": {
        "fromEur": 1.9,
        "toEur": 1.9,
        "basis": "INDICATIVE",
        "forQuantity": null,
        "perUnit": true,
        "includesCustomization": false,
        "onOffer": true
      },
      "imageUrl": null,
      "productUrl": "https://publiexpe.example/producto/bolsa-tote-algodon-220/",
      "updatedAt": "2026-08-14T11:03:02Z"
    }
  ],
  "page": { "limit": 2, "nextCursor": "eyJvIjoyfQ", "totalApprox": 37 }
}
```

`totalApprox` es opcional: si calcularlo es caro, puede ser `null`. El fin de la lista se detecta porque `nextCursor` es `null`. En el resumen, `variantCount`, `colors[]` e `inStock` resumen las variantes; el detalle por variante está en la ficha.

### 2. Ficha de producto

`GET /api/catalog/v1/products/{productId}`

La ficha completa de un producto. Es lo que lee el agente antes de recomendarlo.

| Campo | Tipo | Descripción |
|---|---|---|
| `productId`, `sku`, `name` | texto | Identificación. `sku` es la referencia del producto padre (`root_reference`) y **siempre existe**, aunque puede repetirse |
| `family` | objeto | Familia principal: `{ familyId, name, path }`; `path` es la lista de nombres desde la raíz, por ejemplo `["Textil", "Bolsas"]`. El árbol tiene hasta 5 niveles |
| `secondaryFamilies` | lista | Familias secundarias, con la misma forma que `family`. Un producto puede estar en varias familias y las secundarias no tienen por qué estar en la misma rama. Puede estar vacía |
| `description` | texto (máx. 4.000 caracteres) | Descripción comercial más la descripción adicional. Texto plano: el poco HTML que hay se limpia en el conector. **Texto libre de proveedor**: consulta [Texto libre del catálogo](#texto-libre-del-catálogo-contenido-no-confiable) |
| `descriptionTruncated` | booleano | `true` si la descripción original era más larga y se ha recortado |
| `attributes` | lista | Atributos del producto: `{ name, label, values[] }`. `name` es una de las claves fijas de [Atributos](#atributos) |
| `dimensions` | objeto | `{ widthCm, heightCm, depthCm, weightG }`. Cada medida puede ser `null`. No son filtrables |
| `variants` | lista | Variantes del producto (consulta abajo) |
| `customization` | objeto o `null` | Cómo se personaliza (consulta abajo) |
| `quantity` | objeto | `{ min, step, breaks }`. `min = max(minimum_order, sales_multiple, 1)`; `step = sales_multiple`; `breaks` es **siempre `[]`**, porque el producto tiene un precio único por variante |
| `priceHint` | objeto | Rango **orientativo** (consulta abajo) |
| `leadTimeDays` | objeto | `{ min, max, source }`. Hoy `{ "min": null, "max": 15, "source": "DEFAULT" }`: 15 días por defecto. `source` admitirá más adelante `PRODUCT` o `TECHNIQUE`, cuando haya plazo por producto o técnica |
| `images` | lista | `{ url, kind, width }` con `kind` en `MAIN` o `GALLERY` y `width` en píxeles (800, en WEBP). Puede estar vacía |
| `productUrl` | texto o `null` | Página pública del producto. `null` si el producto no está `ACTIVE`, porque la página da 404 |
| `status` | `ACTIVE` \| `DISCONTINUED` | `ACTIVE` si está publicado y todas sus variantes tienen precio. Si no, `DISCONTINUED` |
| `statusReason` | `UNPUBLISHED` \| `REMOVED` \| `null` | Solo con `DISCONTINUED`. `UNPUBLISHED`: despublicado en la tienda. `REMOVED`: retirado por el proveedor y borrado por el importador (lo devuelve la [lápida](#descatalogados-y-lápidas)) |
| `updatedAt` | fecha | Última modificación. **Indicativa**: unas importaciones la mueven aunque no cambie nada y otras no la mueven |

#### Variantes

Cada variante tiene su propio precio y su propio stock.

| Campo | Tipo | Descripción |
|---|---|---|
| `variantId` | texto | Id de la variante |
| `sku` | texto | Referencia de la variante. Siempre existe y no se repite |
| `name` | texto | Nombre de la variante |
| `color` | objeto o `null` | `{ name, group }`: nombre del color y grupo normalizado (el que usa el filtro `attr.color`) |
| `size` | texto o `null` | Talla (`S`, `M`, `L`, `XL`...) |
| `priceEur` | número | Precio de venta por unidad, sin IVA, con el descuento global de tarifa de la tienda. Es el mismo cálculo que la tienda (`get_global_price`), nunca el que suma el IVA |
| `stock` | entero o `null` | Unidades según la última sincronización del proveedor. **Orientativo**, y no se reserva |
| `availableFrom` | fecha o `null` | Fecha de reposición, si la hay |
| `imageUrl` | texto o `null` | Imagen de la variante |

#### Atributos

Vocabulario fijo de `name`. Son también los nombres admitidos en `attr.<nombre>`.

| `name` | Vocabulario | Cómo filtra |
|---|---|---|
| `color` | Semicontrolado | Por el grupo normalizado de color |
| `size` | Controlado y pequeño (S, M, L, XL...) | Por valor exacto |
| `material` | Texto libre | Por contenido |
| `brand` | Texto libre | Por contenido |
| `tag` | Lista libre, hasta 10 por producto | Por valor |

#### Personalización

`customization` es `null` si el producto no admite marcaje.

| Campo | Tipo | Descripción |
|---|---|---|
| `techniques` | lista de texto | Técnicas **normalizadas** a una familia de técnica: `Serigrafía`, `Tampografía`, `Láser`, `Bordado`, `DTF`... Los nombres originales del proveedor llevan sufijos de tramo (`SERIGRAFÍA A…H`) que no salen |
| `areas` | lista | Zonas personalizables: `{ name, maxColors, widthMm, heightMm }` |
| `maxColors` | entero o `null` | El máximo de colores del producto (el mayor de sus zonas) |
| `notes` | texto o `null` | **`null` en v1.** Las condiciones de cada técnica no salen hasta revisar su texto |

#### Precio orientativo

| Campo | Tipo | Descripción |
|---|---|---|
| `fromEur`, `toEur` | número | Mínimo y máximo de `variants[].priceEur`, **o la oferta activa si es menor**. Sin IVA. `fromEur ≤ toEur` |
| `basis` | `INDICATIVE` | Siempre este valor. Un precio comprometido no existe en este contrato |
| `forQuantity` | `null` | Siempre `null`: el precio del producto no depende de la cantidad |
| `perUnit` | `true` | Precio por unidad |
| `includesCustomization` | `false` | El rango no incluye marcaje. Para estimarlo, la [operación 3](#3-estimar-el-marcaje) |
| `onOffer` | booleano | `true` si el rango refleja una oferta activa |

Ejemplo de respuesta (datos ficticios):

```json
{
  "productId": "10482",
  "sku": "12/BT-ALG-140",
  "name": "Bolsa tote de algodón 140 g",
  "family": { "familyId": "f-bolsas", "name": "Bolsas", "path": ["Textil", "Bolsas"] },
  "secondaryFamilies": [
    { "familyId": "f-ecologico", "name": "Regalos ecológicos", "path": ["Ecológico", "Regalos ecológicos"] }
  ],
  "description": "Bolsa de algodón natural de 140 g con asas largas de 70 cm. Apta para serigrafía a una o dos tintas.",
  "descriptionTruncated": false,
  "attributes": [
    { "name": "color", "label": "Color", "values": ["beige", "negro", "azul"] },
    { "name": "material", "label": "Material", "values": ["algodón"] },
    { "name": "brand", "label": "Marca", "values": ["Pxe Basics"] },
    { "name": "tag", "label": "Etiquetas", "values": ["ecológico", "bolsa", "feria"] }
  ],
  "dimensions": { "widthCm": 38, "heightCm": 42, "depthCm": null, "weightG": 95 },
  "variants": [
    {
      "variantId": "20931",
      "sku": "12/BT-ALG-140-NAT",
      "name": "Bolsa tote de algodón 140 g natural",
      "color": { "name": "Natural", "group": "beige" },
      "size": null,
      "priceEur": 1.2,
      "stock": 4200,
      "availableFrom": null,
      "imageUrl": "https://publiexpe.example/media/v/20931-800.webp"
    },
    {
      "variantId": "20932",
      "sku": "12/BT-ALG-140-NEG",
      "name": "Bolsa tote de algodón 140 g negro",
      "color": { "name": "Negro", "group": "negro" },
      "size": null,
      "priceEur": 1.35,
      "stock": 0,
      "availableFrom": "2026-11-10T00:00:00Z",
      "imageUrl": null
    }
  ],
  "customization": {
    "techniques": ["Serigrafía"],
    "areas": [
      { "name": "Frontal", "maxColors": 2, "widthMm": 300, "heightMm": 300 }
    ],
    "maxColors": 2,
    "notes": null
  },
  "quantity": { "min": 100, "step": 50, "breaks": [] },
  "priceHint": {
    "fromEur": 1.2,
    "toEur": 1.35,
    "basis": "INDICATIVE",
    "forQuantity": null,
    "perUnit": true,
    "includesCustomization": false,
    "onOffer": false
  },
  "leadTimeDays": { "min": null, "max": 15, "source": "DEFAULT" },
  "images": [
    { "url": "https://publiexpe.example/media/p/10482-800.webp", "kind": "MAIN", "width": 800 }
  ],
  "productUrl": "https://publiexpe.example/producto/bolsa-tote-algodon-140/",
  "status": "ACTIVE",
  "statusReason": null,
  "updatedAt": "2026-09-30T08:12:44Z"
}
```

> **Aviso:** la URL de una imagen puede cambiar si el backend reimporta las fotos. Una hipótesis guarda `productId` y `sku`, nunca la URL de la imagen.

#### Descatalogados y lápidas

Un producto `DISCONTINUED` se sigue devolviendo para que las hipótesis antiguas no apunten a un 404. Hay dos casos:

- **Despublicado** (`UNPUBLISHED`): el producto sigue en la base de datos; la ficha sale completa con `productUrl: null`.
- **Retirado por el proveedor** (`REMOVED`): los importadores **borran** de la base de datos los productos que el proveedor retira, y si el producto vuelve se crea con otro id. Para que el id antiguo no dé 404, el backend guarda una **lápida** (`ProductTombstone`) con el id, el SKU, el nombre y la familia. La ficha de una lápida devuelve esos datos con `status: "DISCONTINUED"` y `statusReason: "REMOVED"`; el resto de campos salen `null` (o lista vacía).

```json
{
  "productId": "9871",
  "sku": "12/BT-ALG-100",
  "name": "Bolsa tote de algodón 100 g",
  "family": { "familyId": "f-bolsas", "name": "Bolsas", "path": ["Textil", "Bolsas"] },
  "secondaryFamilies": [],
  "description": null,
  "variants": [],
  "customization": null,
  "priceHint": null,
  "productUrl": null,
  "status": "DISCONTINUED",
  "statusReason": "REMOVED",
  "updatedAt": null
}
```

Un consumidor trata `priceHint: null`, `variants: []` y `customization: null` como "no hay datos", nunca como "gratis" o "no personalizable". Despublicar en los importadores en lugar de borrar queda como tarea aparte del backend ([Pendiente](#pendiente)); no cambia este contrato.

### 3. Estimar el marcaje

`GET /api/catalog/v1/products/{productId}/customization-estimate`

Los marcajes tienen precio propio y su cálculo vive en el backend. Esta operación devuelve una estimación **orientativa** con el margen de publiexpe ya aplicado. Va aparte de la ficha para que esta siga siendo cacheable. Las tarifas crudas no salen nunca ([Lo que el conector no expone nunca](#lo-que-el-conector-no-expone-nunca)).

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `technique` | texto | Sí | Una de `customization.techniques` de la ficha |
| `area` | texto | Sí | El `name` de una de `customization.areas` |
| `colors` | entero ≥ 1 | Sí | Colores de la marca; no puede superar el `maxColors` de la zona |
| `quantity` | entero ≥ 1 | Sí | Unidades del pedido; debe cumplir `quantity.min` y `quantity.step` de la ficha |

```sh
curl -s "https://<host-del-conector>/api/catalog/v1/products/10482/customization-estimate?technique=Serigraf%C3%ADa&area=Frontal&colors=2&quantity=300" \
  -H "Authorization: Bearer $CATALOG_API_TOKEN"
```

```json
{
  "unitEur": 0.46,
  "setupEur": 45,
  "totalEur": 183,
  "forQuantity": 300,
  "basis": "INDICATIVE"
}
```

| Campo | Descripción |
|---|---|
| `unitEur` | Precio del marcaje por unidad |
| `setupEur` | Coste fijo de preparación (por ejemplo, pantallas) |
| `totalEur` | Total del marcaje: `unitEur × forQuantity + setupEur`. **No incluye el producto** |
| `forQuantity` | Cantidad para la que se calculó |
| `basis` | Siempre `INDICATIVE` |

Todos los importes van sin IVA y con el margen de publiexpe aplicado. Un parámetro incompatible con el producto (técnica que no admite, más colores de los permitidos, cantidad por debajo del mínimo) devuelve `400 BAD_REQUEST` con el motivo en `details`.

### 4. Familias y categorías

`GET /api/catalog/v1/families`

Devuelve el árbol de familias como lista plana con `parentId`. Sirve para que el agente sepa qué familias existen antes de buscar y para que `familyId` tenga valores válidos.

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

El árbol completo no se pagina (unos cientos de nodos como mucho; el backend lo sirve desde caché). `productCount` cuenta los productos `ACTIVE` de la familia **y de sus descendientes**.

### 5. Describir el vocabulario

`GET /api/catalog/v1/describe`

El agente necesita saber qué puede pedir sin conocer el esquema interno de Django. Esta operación publica el vocabulario de filtros, los valores de `sort` y los límites vigentes. No recibe parámetros.

```json
{
  "contractVersion": "1.1.0",
  "filters": {
    "attributes": ["color", "size", "material", "brand", "tag"],
    "color": { "groups": ["beige", "negro", "azul", "rojo", "verde"] },
    "size": { "values": ["XS", "S", "M", "L", "XL", "XXL"] }
  },
  "customization": {
    "techniques": ["Serigrafía", "Tampografía", "Láser", "Bordado", "DTF"]
  },
  "sort": ["relevance", "name", "updatedAt"],
  "limits": {
    "defaultLimit": 20,
    "maxLimit": 100,
    "maxQueryLength": 200,
    "maxDescriptionLength": 4000,
    "requestsPerMinute": 600,
    "cursorTtlSeconds": 600
  }
}
```

> **Nota:** los valores del ejemplo son ficticios. La forma exacta del objeto (nombres de las claves de `filters` y `limits`) la fija el JSON Schema `schemas/v1` que genera el backend; este ejemplo es ilustrativo de su contenido, que sí es contrato: técnicas normalizadas, grupos de color, tallas, valores de `sort` y límites.

### 6. Salud y versión

`GET /api/catalog/v1/health`

Permite al runtime comprobar que el conector responde y con qué contrato habla, antes de depender de él.

```json
{
  "status": "ok",
  "contractVersion": "1.1.0",
  "connectorVersion": "0.1.0",
  "catalog": { "productCount": 15342, "lastUpdatedAt": "2026-10-08T06:00:11Z" }
}
```

| Campo | Descripción |
|---|---|
| `status` | `ok` o `degraded` (responde, pero con la base de datos lenta o con datos antiguos). Si no puede responder, la API devuelve `503` |
| `contractVersion` | La versión de este contrato que implementa el conector |
| `connectorVersion` | Versión interna del conector; informativa |
| `catalog.productCount` | Productos `ACTIVE` |
| `catalog.lastUpdatedAt` | Última modificación de cualquier producto. **Indicativa**, como `updatedAt` |

`/health` exige el mismo token. Si el equipo de publiexpe necesita un `/health` público para su monitorización, puede devolver solo `{ "status": "ok" }` sin autenticar.

## Forma MCP equivalente

El servidor MCP expone **seis herramientas** de dominio con la misma semántica. Los nombres llevan el prefijo `catalog_` para no chocar con las tools del runtime (`search_products`, `get_product`...), que las envuelven. El MCP no ofrece descubrimiento genérico de modelos ni de campos.

| Herramienta MCP | Equivale a | Entrada | Salida |
|---|---|---|---|
| `catalog_search_products` | `GET /products` | `q`, `sku`, `familyId`, `attributes` (objeto `{ nombre: valor }`), `quantity`, `sort`, `limit`, `cursor` | Igual que la respuesta REST: `items` y `page` |
| `catalog_get_product` | `GET /products/{productId}` | `productId` | La ficha completa |
| `catalog_estimate_customization` | `GET /products/{productId}/customization-estimate` | `productId`, `technique`, `area`, `colors`, `quantity` | La estimación |
| `catalog_list_families` | `GET /families` | `parentId`, `includeAttributes` | `items` |
| `catalog_describe` | `GET /describe` | ninguna | El objeto de vocabulario |
| `catalog_health` | `GET /health` | ninguna | El objeto de salud |

Reglas de la forma MCP:

- La entrada de cada herramienta es un objeto JSON con las mismas claves que los parámetros REST. La única diferencia es `attributes`: en REST va como `attr.<nombre>` por ser parámetros de URL; en MCP, como objeto.
- La salida es el mismo JSON, devuelto como contenido estructurado de la herramienta. Los errores usan el mismo objeto `error` con `code`, `message` y `details`.
- Transporte: MCP sobre HTTP (streamable) en `/api/catalog/mcp`, con el mismo token Bearer. Un servidor por `stdio` no se usa: el conector no corre en la máquina del runtime.
- El servidor MCP corre como **proceso aparte** (con la misma imagen del backend) y se conecta a PostgreSQL con un **rol de solo lectura** que solo ve las tablas del catálogo y, de la configuración de la empresa, solo las columnas que el cálculo del precio necesita.
- Las herramientas son todas de solo lectura y así se declaran (anotación de solo lectura de MCP).

## Autenticación y red

| Aspecto | Contrato |
|---|---|
| Esquema | `Authorization: Bearer <token>`, en REST y en MCP |
| Token | Dedicado a Commercial OS, con prefijo `pxcat_`, guardado como hash en el backend. Uno por entorno (local y preproducción, y después producción) |
| Ámbito | **Solo lectura del catálogo.** Un token de catálogo no sirve en ninguna otra ruta del backend, y un token de usuario no sirve en el catálogo. No da acceso a clientes, pedidos, presupuestos ni precios internos o de coste |
| Vida del token | Caducidad configurable e IP permitidas opcionales (el rango de la VPN). Alta, rotación y revocación en Django, en el backend de publiexpe |
| Rotación | Dos tokens activos a la vez durante el solapamiento, sin parar el servicio |
| Auditoría | Cada consulta queda registrada en el backend (`CatalogRequestLog`): token, operación, parámetros, resultado y tiempo. El `audit_log` del runtime de Commercial OS sigue registrando las suyas |
| Custodia en Commercial OS | `CATALOG_API_TOKEN` en `deployments/.env`, como el resto de secretos; nunca en el repositorio. Commercial OS solo custodia el token |
| Transporte | HTTPS (TLS 1.2 o superior) sobre la VPN |

### Red: VPN y guard anti-SSRF

El conector **no tiene endpoint público**. Commercial OS llega a él por **VPN** (montada en casa y en local de momento), y el conector acepta solo el rango de IP de la VPN.

Esto choca con el guard anti-SSRF del runtime, que rechaza por diseño las IP privadas ([`fetch_url`](LLD-0.2-especificacion.md), webhooks de n8n). La decisión de Commercial OS es:

- El **cliente del catálogo** del runtime queda exento del guard **únicamente para el host exacto configurado en `CATALOG_BASE_URL`** (coincidencia exacta de host, y de puerto si lo lleva; sin subdominios).
- **Jamás es una exención general.** Ni `fetch_url`, ni `render_url`, ni los webhooks, ni ninguna otra tool ven relajado su guard. Si cambia `CATALOG_BASE_URL`, cambia el único host exento.

Del lado del backend, el limitador de peticiones por IP del middleware de seguridad (100 por minuto por IP, con bloqueo de 10 minutos) bloquearía al conector en segundos. Se exime `/api/catalog/` cuando la petición lleva un token `pxcat_`, y el límite pasa a aplicarse por token ([Límites](#límites)). La detección de patrones de ataque se mantiene.

### Texto libre del catálogo: contenido no confiable

Las descripciones, los nombres y los demás textos libres del catálogo (`description`, `shortDescription`, nombres de variante, valores de `material`, `brand` y `tag`) **provienen de los proveedores**. Publiexpe los importa, pero no los escribe. Pueden contener instrucciones dirigidas a un agente.

La regla de Commercial OS: todo texto libre del catálogo que viaje a un LLM va envuelto como **contenido no confiable**, con el mismo mecanismo que el contenido web (bloques `<<<DATOS_NO_CONFIABLES …>>>`, solo en mensajes de usuario; consulta el [LLD v0.3](LLD-0.3-estado-real.md#adr-09)). Los identificadores, los importes y los campos de vocabulario controlado no necesitan envoltorio.

El backend, por su parte, limpia el HTML de las descripciones y las limita a 4.000 caracteres. No intenta filtrar instrucciones: esa defensa es del consumidor.

## Disponibilidad y modo degradado

El conector es un servicio interno con un compromiso modesto:

| Aspecto | Acuerdo |
|---|---|
| SLA | Sin SLA formal en v1 |
| Objetivo de rendimiento | p95 de 1 s en búsqueda y de 300 ms en ficha |
| Mantenimientos | Fuera de la franja 07:00-10:00 |
| Guardia | Sin guardia humana en v1. El mantenimiento del conector es del equipo del backend de publiexpe, que lo aloja |

La prospección diaria arranca a las 08:00, dentro de la franja protegida. Commercial OS no depende de que el conector esté siempre arriba, sino que **degrada con elegancia**:

1. Antes de la tarea que usa el catálogo, el runtime comprueba `/health`.
1. Si falla (no responde, `503`, error de red, `401`/`403` o un `contractVersion` con un `MAJOR` que el runtime no conoce), el runtime ejecuta la prospección **sin catálogo**: las hipótesis salen con familias genéricas, como antes de este conector.
1. Avisa con una **nota ⚠️ en Twenty** y el evento **`catalog.unavailable`** (para que n8n lo redirija a donde quiera el equipo). **Nunca por correo:** el runtime no envía correo por principio; el correo del comercial es siempre un borrador HITL.
1. La ejecución no falla ni se pospone por la ausencia del catálogo.

El comportamiento operativo (qué ve el comercial, aviso único diario) está en [catalog-service.md](catalog-service.md#qué-pasa-si-el-catálogo-no-está-disponible).

> **Nota:** la respuesta del backend proponía "avisa por correo". Esa parte queda sustituida por la nota ⚠️ y el evento `catalog.unavailable`.

## Versionado del contrato

El contrato lleva una versión semántica (`MAJOR.MINOR.PATCH`) separada de la versión del conector. Esta es la `1.1.0`.

| Cambio | Versión | Ejemplo |
|---|---|---|
| Compatible hacia atrás: campo nuevo opcional, operación nueva, valor nuevo en un filtro | `MINOR` | Añadir un campo a la ficha; que `leadTimeDays.source` pase a `PRODUCT` |
| Aclaración sin cambio de comportamiento | `PATCH` | Corregir un ejemplo o una descripción |
| Incompatible: quitar o renombrar un campo, cambiar un tipo, cambiar el significado de un filtro | `MAJOR` | `priceHint` pasa a ser lista |

- La versión `MAJOR` va en la ruta (`/api/catalog/v1`). Un cambio incompatible se publica en `/api/catalog/v2` y `v1` sigue disponible un periodo de transición de **90 días**.
- El conector informa su versión de contrato en `X-Catalog-Contract-Version` y en `/health`. El runtime lee `/health` al arrancar el servicio de catálogo y se niega a usar un `MAJOR` que no conoce.
- El contrato ejecutable es el JSON Schema `schemas/v1/*.json` que el backend genera desde los DTO. Los tests de contrato lo ejecutan tanto contra el stub de Commercial OS como contra el conector real.

## Límites

| Límite | Valor | Motivo |
|---|---|---|
| Frecuencia | **600 peticiones por minuto por token** | Cubre los 10 por segundo del borrador. Se aplica por token, no por IP |
| `limit` por página | Por defecto 20, máximo 100 | Respuestas de unos pocos cientos de KB |
| Longitud de `q` | 200 caracteres | Evita consultas abusivas |
| Tamaño de respuesta | 1 MB como máximo | Una página de 100 resúmenes cabe de sobra |
| Longitud de `description` | 4.000 caracteres | Si la original es más larga, se trunca (y la ficha lo indica en `descriptionTruncated: true`) |
| Tiempo de respuesta | 10 s como máximo por petición | El runtime corta a los 10 s. Los objetivos de p95 están en [Disponibilidad](#disponibilidad-y-modo-degradado) |
| `429` | Con `Retry-After` en segundos | El cliente respeta la espera y reintenta con retardo exponencial, máximo 3 veces |
| Cursor | Válido **10 minutos** | Tiempo de sobra para recorrer el catálogo paginando |

## Lo que el conector no expone nunca

- **Datos del proveedor**: margen, datos de tarifa e identidad del proveedor. Con el margen se puede deducir el coste.
- **Tarifas crudas de marcaje** (`Technique` y `TechniquePrice`): son coste antes del margen. Solo sale el resultado de la estimación, con margen.
- **Configuración de la empresa**: el descuento global y el margen de marcaje se usan en el cálculo, pero no se devuelven.
- **Datos internos de producto**: identificadores de CRM, huellas de importación, visitas, más vendidos y reseñas (llevan datos de usuario).
- **Clientes, carritos, pedidos, presupuestos, facturación y ERP**.

Los tests del conector comprueban que ninguna respuesta contiene estas claves.

## Qué no hace el conector

El conector es una ventana de lectura sobre el catálogo. No hace, ni ahora ni en versiones futuras de este contrato:

- **No escribe** nada en el backend de publiexpe.
- **No reserva stock** ni compromete existencias. El stock es informativo.
- **No genera presupuestos** ni calcula el precio de un pedido. Eso es del CMS de publiexpe, con su propio contrato (la tool `create_quote_request`, de riesgo alto y con aprobación humana, se tratará aparte). La estimación de marcaje es orientativa y no es un presupuesto.
- **No compromete precios.** Los importes son orientativos y se etiquetan así.
- **No expone datos de clientes**, pedidos ni márgenes.
- **No recomienda ni empareja productos.** Decidir qué producto encaja con una necesidad es trabajo del Catalog Service de Commercial OS.

## Cómo lo usa Commercial OS

El Catalog Service del LLD se construye sobre estas seis operaciones:

| Pieza del LLD §9 | Qué usa del conector |
|---|---|
| `search` | Operación 1, con filtros por familia, SKU y atributos |
| `get_product` | Operación 2 |
| Estimación de marcaje | Operación 3. Alimenta la tool de estimación; el número es siempre orientativo |
| Vocabulario | Operaciones 4 y 5, para que el agente pida valores válidos |
| Disponibilidad | Operación 6, que es el gate de salud ([Disponibilidad y modo degradado](#disponibilidad-y-modo-degradado)) |
| `semantic` (pgvector sobre descripciones) | Recorrido paginado de la operación 1 y ficha de la operación 2 para construir los embeddings en nuestro lado. Posterior |
| `match_products`, `build_bundle` | Se calculan en Commercial OS sobre las anteriores; no necesitan operaciones propias del conector. Posteriores |
| `pricing` | Solo `priceHint` y la estimación de marcaje, mostrados como **orientativos**. Las hipótesis nunca cifran un precio como cierto |
| `get_active_offers` | Cubierto solo en parte por `priceHint.onOffer`. No hay operación de ofertas en v1 |

Correspondencia con las tools del runtime: las tools `catalog_*` de lectura envuelven las operaciones. La forma mínima que el [LLD v0.2](LLD-0.2-especificacion.md) dio al stub (`ProductRef`, `priceEur`, `offerActive`) cambia: el precio pasa de `priceEur` (un valor "vigente") a `priceHint` (un rango orientativo), y `offerActive` pasa a `priceHint.onOffer`. `productId`, `sku` y `name` se mantienen.

Qué gana la hipótesis: `recommended_products` pasa de familias genéricas a una lista de `{ productId, sku, name, priceHint }`. El `priceHint` es solo orientativo; el presupuesto sigue siendo del CMS. Consulta [catalog-service.md](catalog-service.md#qué-gana-la-hipótesis).

## Fuera de v1

No forman parte de esta versión y no se prometen:

| Operación | Estado |
|---|---|
| Sincronización incremental (`updatedSince`) | No se promete en v1. `updatedAt` y `lastUpdatedAt` son indicativos (las importaciones los mueven sin cambios reales, y otras actualizaciones no los mueven), así que no servirían de base para un delta fiable. La ingesta semántica recorre el catálogo paginado |
| Ofertas activas (`GET /offers`) | Sin operación propia. La oferta activa se refleja en `priceHint` (`onOffer`) |
| Productos relacionados (`GET /products/{productId}/related`) | Sin operación. El emparejamiento se infiere en Commercial OS |
| Idiomas (`lang`) | Solo `es` |

Cualquiera de ellas entraría como cambio `MINOR` si hiciera falta.

## Pendiente

Lo único que queda abierto. Ninguno bloquea la implementación de este contrato.

| Tema | Qué queda | Quién |
|---|---|---|
| Conector de presupuestos | Se diseña **después** de este, con **token propio de escritura** (no comparte token con el de lectura del catálogo). Cubre la tool `create_quote_request` y la referencia sobre la oportunidad en Twenty | Commercial OS y backend, posterior |
| Despublicar en los importadores | En v1 las lápidas cubren los productos que el proveedor retira. Cambiar los importadores para despublicar en vez de borrar es más limpio a largo plazo; es una tarea aparte, **interna del backend**, y no cambia el contrato | Backend |

## Después del cierre

1. El backend implementa el conector (estimación del backend: unos 16 días de un desarrollador con REST y MCP, unos 13 solo con REST) y despliega en preproducción con su token. Los fixtures salen de su base local.
1. Commercial OS implementa su cliente y un **stub fiel a este contrato**, detrás de `CATALOG_ENABLED=false` y `CATALOG_PROVIDER=stub|http`, con tests de contrato. No espera al conector real.
1. Los tests de contrato (JSON Schema `schemas/v1`) se ejecutan contra el stub y, al entregar el backend, contra preproducción. Deben pasar antes de cualquier integración real.
1. Al entregar, el operador conmuta de `stub` a `http` siguiendo la [lista de comprobación](catalog-service.md#el-día-de-la-conmutación-stub-a-http) y se recalculan las hipótesis con productos reales. `match_products` y `build_bundle` llegan después, sobre el índice semántico.

## Anexo

- [Respuesta del backend de publiexpe](catalog-connector-respuesta-backend.md): cómo se rellena cada campo desde el backend, respuestas a las preguntas del borrador v1, los 18 cambios, la estimación y la tabla de pendientes. Donde difiera de este documento, manda este (en particular, el aviso de indisponibilidad por correo que proponía queda sustituido por la nota ⚠️ y el evento `catalog.unavailable`).

## Documentos relacionados

- [Catalog Service en Commercial OS](catalog-service.md): flags, stub, conmutación, degradado y seguridad en el lado de Commercial OS.
- [LLD v0.1, sección 9](LLD-0.1-publiexpe-commercial-os.md#9-catalog-service-c2): el Catalog Service y la decisión del conector.
- [LLD v0.2, sección 5](LLD-0.2-especificacion.md): tools del Catalog Service y forma mínima del stub.
- [Roadmap](ROADMAP.md): estado del Catalog Service.
