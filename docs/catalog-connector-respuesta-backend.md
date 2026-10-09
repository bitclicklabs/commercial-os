# Respuesta del backend de publiexpe al contrato del conector de catálogo

> **BORRADOR para revisar con el equipo de Commercial OS — 2026-10-09.** Responde a [catalog-connector-contrato.md](catalog-connector-contrato.md) (borrador v1) desde el lado del backend de publiexpe. Sale de revisar el código del backend (rama `staging`) y la base de datos local, y de las decisiones de negocio confirmadas el 2026-10-09. Nada está implementado todavía. Lo que sigue abierto está en [Pendiente de decidir](#pendiente-de-decidir).

El conector es **viable** y la mayoría de los campos del contrato tienen una fuente directa en el backend. Este documento:

- fija cómo se rellena cada campo;
- responde a las preguntas abiertas del borrador;
- propone los cambios al contrato que salen de cómo son los datos de verdad.

## Contenido

1. [Resumen](#resumen)
1. [Decisiones de negocio confirmadas](#decisiones-de-negocio-confirmadas)
1. [Arquitectura del conector](#arquitectura-del-conector)
1. [Correspondencia de campos](#correspondencia-de-campos)
1. [Respuestas a las preguntas abiertas](#respuestas-a-las-preguntas-abiertas)
1. [Cambios propuestos al contrato](#cambios-propuestos-al-contrato)
1. [Lo que el conector no expone nunca](#lo-que-el-conector-no-expone-nunca)
1. [Trabajo previo en el backend](#trabajo-previo-en-el-backend)
1. [Estimación](#estimación)
1. [Pendiente de decidir](#pendiente-de-decidir)

## Resumen

| Tema | Resultado |
|---|---|
| Viabilidad | Viable. Las cuatro operaciones mínimas se pueden servir con los datos actuales |
| Forma | **REST y MCP**, las dos sobre una única capa de servicio. El MCP expone **herramientas de dominio** (`catalog_*`), no un descubrimiento genérico de modelos |
| Identificador | `productId` = clave primaria del producto, como cadena opaca. `sku` es un campo y un filtro, no el id |
| Precio | Precio de venta por variante, **sin IVA**, como rango orientativo. No hay tramos por cantidad en el producto |
| Marcaje | Tiene precio propio y cálculo propio en el backend: se propone una operación nueva para estimarlo |
| Stock | Se expone, **por variante** |
| Plazo | 15 días por defecto |
| Descatalogados | Hoy algunos se **borran** de la base de datos. Hace falta cambiar algo en el backend para devolverlos como `DISCONTINUED` |
| Estimación | Unos 16 días de un desarrollador con REST y MCP; unos 13 solo con REST |

## Decisiones de negocio confirmadas

Confirmadas por publiexpe el 2026-10-09:

| Tema | Decisión | Efecto en el contrato |
|---|---|---|
| SKU | Siempre existe. El del producto padre es `root_reference`; el de cada variante es su `reference` | `sku` deja de poder ser `null`. Las variantes llevan su propio `sku` |
| Descatalogado | Un producto no publicado (`is_published = false`) está descatalogado | `status: DISCONTINUED` |
| Precios | Son siempre **sin IVA** y viven en cada variante: cada variante tiene su precio | `priceHint` es el mínimo y el máximo de las variantes; la ficha lleva el precio de cada variante |
| Stock | Se expone. Vive en la variante | `stock` por variante en la ficha y `inStock` en el resumen |
| Plazo de producción | 15 días por defecto | `leadTimeDays` deja de ser `null` |
| Marcajes | Tienen precio propio (modelo `TechniquePrice`) y su cálculo vive en el backend (`utils/pricing.py`) | Operación nueva de estimación de marcaje, orientativa |
| Imágenes | Publiexpe tiene licencia de los proveedores | Se pueden citar en Twenty y enviar al LLM |
| Red | **VPN**, montada en casa y en local de momento | Sin endpoint público; el conector acepta solo el rango de la VPN |
| Token y auditoría | Viven en Django: alta, rotación, revocación y registro de consultas en el backend de publiexpe | Commercial OS solo custodia el token |
| Volcado de muestra | No hace falta: la base local tiene productos, áreas, precios y marcajes reales | Los fixtures salen de la base local |

## Arquitectura del conector

El conector es una app nueva del backend, `catalog_connector`:

```
catalog_connector/
  services.py        lógica única: search_products, get_product, list_families,
                     estimate_customization, describe, health
  dto.py             modelos del contrato (pydantic, camelCase) — lista blanca de campos
  schemas/v1/*.json  JSON Schema generado desde los DTO; es el contrato ejecutable
  mappers.py         modelo → DTO (precio, imágenes, personalización, limpieza de HTML)
  queries.py         consultas optimizadas y árbol de familias en caché
  models.py          CatalogApiToken, CatalogRequestLog, ProductTombstone
  api/               vistas DRF bajo /api/catalog/v1/
  mcp_server/        servidor MCP (FastMCP, HTTP streamable) bajo /api/catalog/mcp
```

Las reglas:

- **Una sola lógica.** Las vistas REST y las herramientas MCP solo traducen la entrada y llaman a `services`. Un test de paridad comprueba que la misma entrada da el mismo JSON por los dos caminos.
- **Herramientas de dominio, no descubrimiento de modelos.** Exponer modelos y campos genéricos dejaría salir datos de coste (consulta [Lo que el conector no expone nunca](#lo-que-el-conector-no-expone-nunca)) y ataría a Commercial OS al esquema interno de Django. El vocabulario que el agente necesita para filtrar lo da la operación `describe`.
- **Solo lectura, de verdad.** El servidor MCP corre como proceso aparte y se conecta a PostgreSQL con un **rol de solo lectura** que solo ve las tablas del catálogo y, en la configuración de la empresa, solo las columnas que el cálculo de precio necesita.
- **Salida por lista blanca.** Toda respuesta se construye desde los DTO, nunca serializando un modelo entero.

## Correspondencia de campos

Las rutas de código son del backend de publiexpe.

### Identificación y estado

| Campo | Fuente | Notas |
|---|---|---|
| `productId` | `Product.pk` como cadena (`"10482"`) | Opaco y estable mientras el producto existe |
| `sku` | `Product.root_reference` | Siempre existe. **Puede repetirse** y lleva el prefijo del proveedor con barra (`1/3920`), por eso no sirve como id de ruta |
| `variants[].sku` | `ProductVariant.reference` | Siempre existe y no se repite |
| `name` | `Product.product_name` | |
| `status` | `Product.is_published` y la regla `published_and_valid()` de la tienda | `ACTIVE` si está publicado y todas sus variantes tienen precio. Si no, `DISCONTINUED` |
| `updatedAt` | El mayor `updated_at` entre el producto y sus variantes | **Indicativo**: unas importaciones lo mueven aunque no cambie nada y otras no lo mueven |

### Familia y descripción

| Campo | Fuente | Notas |
|---|---|---|
| `family` | `Product.category` y el árbol por `Category.parent_category` | Árbol de hasta 5 niveles |
| `secondaryFamilies` (nuevo) | `Product.sub_category` (varios a varios) | Un producto puede estar en varias familias, y las secundarias no tienen por qué estar en la misma rama |
| `description` | `product_description` + `product_description_additional` | Texto plano; el poco HTML que hay se limpia en el conector |
| `shortDescription` | Las primeras ~200 letras de la descripción, o la meta descripción SEO | |

### Atributos

| `name` | Fuente | Vocabulario |
|---|---|---|
| `color` | `ProductVariant.color` → `Color.color_group` | Semicontrolado; se filtra por el grupo normalizado |
| `size` | `ProductVariant.size` → `Size` | Controlado y pequeño (S, M, L, XL…) |
| `material` | `Product.material` | Texto libre; el filtro busca por contenido |
| `brand` | `Product.brand` | Texto libre |
| `tag` | `Product.tags` | Lista libre, hasta 10 por producto |

Las medidas (`width`, `height`, `depth`, `weight`) van aparte, en `dimensions`, y no son filtrables.

### Personalización

| Campo | Fuente | Notas |
|---|---|---|
| `techniques` | `Product.print_jobs` → `Technique.name` | Los nombres vienen del proveedor con sufijo de tramo (`SERIGRAFÍA A…H`). Se normalizan a una familia de técnica: Serigrafía, Tampografía, Láser, Bordado, DTF… |
| `areas` | `PrintJob.areas` → `Area` | Nombre, colores máximos y medidas de la zona |
| `maxColors` | `Area.max_colour` | El máximo del producto |
| `notes` | — | `null` en v1 |

### Cantidad, precio, stock y plazo

| Campo | Fuente | Notas |
|---|---|---|
| `quantity.min` | `max(minimum_order, sales_multiple, 1)` | Muchos productos tienen `minimum_order = 0`; la fórmula lo corrige |
| `quantity.step` | `Product.sales_multiple` | |
| `quantity.breaks` | — | Siempre `[]`: el producto tiene un precio único por variante |
| `variants[].priceEur` | `ProductVariant.price` con el descuento global de tarifa de la tienda | Sin IVA. Es el mismo cálculo que la tienda (`get_global_price`). **Nunca** `get_prices()`, que suma el IVA |
| `priceHint` | Mínimo y máximo de `variants[].priceEur`, o la oferta activa si es menor | Por unidad, sin personalización |
| `variants[].stock` | `ProductVariant.stock` y `available_from` | Stock del proveedor sincronizado en cada importación: orientativo |
| `leadTimeDays` | Valor por defecto del backend: 15 días | Configurable en el backend; más adelante podrá concretarse por producto o técnica |
| Estimación de marcaje | `calculate_customization_breakdown` en `utils/pricing.py`, sobre `TechniquePrice` | Devuelve el precio con el margen de publiexpe ya aplicado. Las tarifas crudas no salen nunca |

### Imágenes y enlace

| Campo | Fuente | Notas |
|---|---|---|
| `images[]` | `ProductImage` → `MediaGallery` | `MAIN` si es la principal; el resto `GALLERY`. Tamaño de 800 px en WEBP. Las URL se normalizan al dominio público |
| `productUrl` | `{FRONTEND_URL}/producto/{slug}/` | `null` si el producto no está `ACTIVE`, porque la página da 404 |

### Búsqueda

La búsqueda reutiliza la de la tienda (texto completo en español, sin tildes, más similitud por trigramas sobre nombre y referencia), extraída a una función común para que tienda y conector den los mismos resultados. Hoy no busca en atributos ni etiquetas: color, talla y material se filtran con `attr.<nombre>`.

## Respuestas a las preguntas abiertas

### Precios

1. **Qué precios se exponen.** El precio de venta de cada variante, sin IVA, con el descuento global de tarifa que aplica la tienda, y la oferta activa si la hay. **No** se expone el coste ni nada que permita deducirlo.
1. **Rangos orientativos.** Sí, por unidad. `forQuantity` es `null` porque el precio del producto no depende de la cantidad.
1. **Lo que no sale.** El coste, los márgenes y las tarifas crudas de marcaje. Detalle en [Lo que el conector no expone nunca](#lo-que-el-conector-no-expone-nunca).
1. **IVA.** Todo sin IVA. El país del cliente cambia el IVA del pedido, no el del catálogo.
1. **Tramos.** No existen en el producto. Sí existen, estructurados, en el precio del marcaje, y los aplica la [estimación de marcaje](#cambios-propuestos-al-contrato).

### Datos del producto

1. **Taxonomía.** Un árbol de categorías. Cada producto tiene una categoría principal y puede tener varias secundarias, que no tienen por qué estar en la misma rama.
1. **Imágenes.** Sí, con licencia del proveedor. Se sirven desde el dominio público de publiexpe o desde el del proveedor. Pueden cambiar de URL si se reimportan las fotos.
1. **Stock.** Sí, por variante. Es el stock que informa el proveedor en cada sincronización, más la fecha de reposición si la hay.
1. **Plazo de producción.** 15 días por defecto.
1. **Personalización.** Técnicas, zonas y colores máximos están estructurados. El vocabulario de técnicas es el de cada proveedor y el conector lo normaliza.
1. **`sku` y estabilidad de `productId`.** `sku` existe siempre. `productId` es estable mientras el producto existe, pero consulta el punto siguiente.
1. **Descatalogados.** Un producto despublicado se sigue pudiendo consultar y sale como `DISCONTINUED`. **Pero los importadores de proveedor borran de la base de datos los productos que el proveedor retira**, y si el producto vuelve se crea con otro id. Para cumplir el contrato hay que elegir una de las dos soluciones de [Trabajo previo en el backend](#trabajo-previo-en-el-backend).
1. **Vocabularios.** Color y talla son vocabulario controlado; material y marca, texto libre.
1. **Formato de la descripción.** Texto plano, con algo de HTML ocasional que el conector limpia.

### Idiomas

1. Solo español. No hace falta `lang` en v1.

### Operación y servicio

1. **SLA y guardia.** Pendiente: consulta [Pendiente de decidir](#pendiente-de-decidir).
1. **Carga.** Los límites propuestos valen, con dos condiciones: el limitador por IP del backend tiene que dejar pasar al conector, y el límite se aplica por token. Detalle en [Trabajo previo en el backend](#trabajo-previo-en-el-backend).
1. **REST o MCP.** Las dos, sobre la misma lógica. Solo REST ahorra unos 3 días.
1. **Entorno de pruebas.** Sí: local y preproducción, cada uno con su token.
1. **Volcado de muestra.** No hace falta. La base local tiene productos, áreas, precios y marcajes reales, y de ahí salen los fixtures de los tests de contrato y del stub de Commercial OS.

### Despliegue y mantenimiento

1. **Dónde.** Dentro del backend de publiexpe: la API REST en el proceso de Django y el MCP como proceso aparte con la misma imagen.
1. **Cómo llega el runtime.** Por **VPN**, montada en casa y en local de momento. El token puede limitarse al rango de IP de la VPN.
1. **Quién mantiene.** Pendiente, junto con el SLA.
1. **Cambios de contrato.** Pendiente: consulta [Pendiente de decidir](#pendiente-de-decidir).

### Seguridad y cumplimiento

1. **Token.** Vive en Django: token dedicado con prefijo `pxcat_`, guardado como hash, con ámbito de solo lectura del catálogo, caducidad e IP permitidas opcionales. La rotación admite dos tokens activos a la vez durante el solapamiento. Un token de catálogo no sirve en ninguna otra ruta del backend, y un token de usuario no sirve en el catálogo.
1. **Datos hacia el LLM.** Descripciones, atributos e imágenes pueden enviarse: las imágenes tienen licencia del proveedor. Coste y márgenes nunca salen del backend.
1. **Auditoría.** En Django: cada consulta queda registrada con el token, la operación, los parámetros, el resultado y el tiempo. El `audit_log` del runtime de Commercial OS sigue registrando las suyas.

### Presupuestos

1. Sigue fuera de este contrato y pendiente de orden.

## Cambios propuestos al contrato

| # | Cambio | Motivo |
|---|---|---|
| 1 | **Ruta base** `https://<host>/api/catalog/v1` y MCP en `/api/catalog/mcp` | El servidor web solo envía `/api/` al backend; el resto va a la tienda |
| 2 | **`productId`** = clave primaria como cadena opaca | El SKU puede repetirse y lleva barras |
| 3 | **`sku`** obligatorio (`root_reference`) y filtro nuevo `GET /products?sku=` de coincidencia exacta | Permite reencontrar hipótesis antiguas si un producto se recrea con otro id |
| 4 | **`variants[]`** en la ficha: `{ variantId, sku, name, color: { name, group }, size, priceEur, stock, availableFrom, imageUrl }`. En el resumen, `variantCount`, `colors[]` e `inStock` | Cada variante tiene su precio y su stock |
| 5 | **`priceHint`**: mínimo y máximo de las variantes, `forQuantity: null`, `perUnit: true`, `basis: "INDICATIVE"`, más `includesCustomization: false` y `onOffer` | Refleja cómo se fija el precio |
| 6 | **`quantity`**: `min = max(minimum_order, sales_multiple, 1)`, `step = sales_multiple`, `breaks = []`. El filtro `quantity` usa la misma fórmula | No hay tramos de producto |
| 7 | **`leadTimeDays`**: `{ min: null, max: 15, source: "DEFAULT" }`. `source` admite más adelante `PRODUCT` o `TECHNIQUE` | 15 días por defecto, sin dato por producto todavía |
| 8 | **`status`**: `ACTIVE` \| `DISCONTINUED`, con `statusReason` opcional (`UNPUBLISHED` \| `REMOVED`). `productUrl` es `null` si no es `ACTIVE` | Distingue despublicado de retirado por el proveedor |
| 9 | **`secondaryFamilies[]`** (`{ familyId, name, path }`). El filtro `familyId` incluye descendientes y familias secundarias | Un producto puede estar en varias familias |
| 10 | **Atributos** con vocabulario fijo de `name`: `color`, `size`, `material`, `brand`, `tag`. Las medidas pasan a `dimensions: { widthCm, heightCm, depthCm, weightG }` | Material y marca son texto libre; las medidas no se filtran |
| 11 | **`customization`**: técnicas normalizadas; `areas` como `{ name, maxColors, widthMm, heightMm }` en vez de cadenas; `notes: null` en v1 | Las técnicas vienen con sufijos del proveedor |
| 12 | **Operación nueva: estimar marcaje.** `GET /products/{productId}/customization-estimate?technique=&area=&colors=&quantity=` y su herramienta `catalog_estimate_customization`. Devuelve `{ unitEur, setupEur, totalEur, forQuantity, basis: "INDICATIVE" }`, sin IVA y con el margen de publiexpe aplicado | Los marcajes tienen precio y el cálculo ya existe. Va aparte para que la ficha siga siendo cacheable |
| 13 | **Imágenes**: `{ url, kind, width }`, 800 px como principal | Aviso: la URL cambia si se reimportan las fotos |
| 14 | **`description`** = descripción + descripción adicional, en texto plano | |
| 15 | **`updatedAt` y `lastUpdatedAt` indicativos.** `updatedSince` no se promete en v1 | Las importaciones mueven la fecha sin cambios reales, y otras actualizaciones no la mueven |
| 16 | **Límites**: 600 peticiones por minuto por token, `limit` máximo 100, cursor válido 10 minutos | Los 10 por segundo del borrador caben |
| 17 | **Idioma**: solo `es`, sin `lang` | Confirmado |
| 18 | **Operación nueva: `describe`.** `GET /describe` y `catalog_describe`, con el vocabulario de filtros (técnicas normalizadas, grupos de color, tallas), los valores de `sort` y los límites | El agente sabe qué puede pedir sin conocer el esquema interno |

Con estos cambios, el contrato pasa de cuatro a seis operaciones:

| REST | MCP |
|---|---|
| `GET /products` | `catalog_search_products` |
| `GET /products/{productId}` | `catalog_get_product` |
| `GET /products/{productId}/customization-estimate` | `catalog_estimate_customization` |
| `GET /families` | `catalog_list_families` |
| `GET /describe` | `catalog_describe` |
| `GET /health` | `catalog_health` |

Para el stub de Commercial OS: `productId`, `sku` y `name` no cambian de forma, así que `recommendedProducts` de las hipótesis sigue igual.

## Lo que el conector no expone nunca

- **Datos del proveedor**: margen, datos de tarifa e identidad del proveedor. Con el margen se puede deducir el coste.
- **Tarifas crudas de marcaje** (`Technique` y `TechniquePrice`): son coste antes del margen. Solo sale el resultado de la estimación, con margen.
- **Configuración de la empresa**: el descuento global y el margen de marcaje se usan en el cálculo, pero no se devuelven.
- **Datos internos de producto**: identificadores de CRM, huellas de importación, visitas, más vendidos y reseñas (llevan datos de usuario).
- **Clientes, carritos, pedidos, presupuestos, facturación y ERP**.

Los tests del conector comprueban que ninguna respuesta contiene estas claves.

## Trabajo previo en el backend

Tres cambios fuera de la app son condición para cumplir el contrato:

1. **Productos retirados por el proveedor.** Los importadores los borran. Hay dos soluciones:
   - **Lápidas**: una tabla que guarda id, sku, nombre y familia del producto al borrarse. El conector la consulta y devuelve `DISCONTINUED` con `statusReason: REMOVED`. Va dentro del conector y no toca los importadores.
   - **Despublicar en vez de borrar** en los importadores. Es más limpia a largo plazo, pero cambia los importadores y deja más productos en la base de datos.
1. **Limitador de peticiones por IP.** El middleware de seguridad limita a 100 peticiones por minuto por IP y bloquea 10 minutos. Bloquearía al conector en segundos. Se exime `/api/catalog/` cuando la petición lleva un token `pxcat_` y el límite pasa a aplicarse por token. La detección de patrones de ataque se mantiene.
1. **Búsqueda compartida.** La búsqueda de la tienda se extrae a una función común, sin cambiar su comportamiento.

## Estimación

Para un desarrollador que conoce el backend:

| Pieza | Días |
|---|---|
| DTO, JSON Schema y mappers (precio, imágenes, personalización, HTML) | 1,5 |
| Servicios: búsqueda extraída, filtros, árbol y recuentos, ficha, `describe` y salud | 2,5 |
| Variantes con stock y plazo por defecto | 0,5 |
| Estimación de marcaje sobre `utils/pricing.py` | 1 |
| Paginación por cursor | 1 |
| Token: modelo, admin, autenticación, permiso, límite por token y exención del middleware | 1,5 |
| Registro de consultas (auditoría) | 0,5 |
| Vistas REST, errores, cabecera de versión | 1 |
| Lápidas | 0,5 |
| Servidor MCP: FastMCP, proceso ASGI, despliegue y servidor web | 2 |
| Rol de solo lectura y segunda conexión | 0,5 |
| Caché e invalidación | 0,5 |
| Tests de contrato, seguridad y paridad REST/MCP | 2 |
| Documentación y despliegue en preproducción con token | 1 |
| **Total** | **unos 16 días** |

Solo REST, sin MCP: unos 13 días.

## Pendiente de decidir

| Tema | Pregunta | Propuesta |
|---|---|---|
| SLA | ¿Qué disponibilidad y tiempos de respuesta se comprometen, y hay ventanas de mantenimiento? | Sin SLA formal en v1: es un servicio interno. Objetivo de p95 de 1 s en búsqueda y 300 ms en ficha, y mantenimientos fuera de 07:00-10:00 |
| Guardia | ¿Quién atiende un fallo del conector a las 08:00, cuando arranca la prospección diaria? | Commercial OS comprueba `/health` antes de la tarea y, si falla, la ejecuta sin catálogo y avisa por correo. Sin guardia humana en v1 |
| Precio orientativo | ¿El rango es el precio de la tienda (con el descuento global de tarifa) o el precio de la variante tal cual? | El de la tienda, para que coincida con lo que ve el cliente |
| Ofertas | ¿Se expone la oferta activa en `priceHint` (`onOffer`)? | Sí |
| Condiciones de técnica | ¿El texto de condiciones de la técnica puede salir como `customization.notes`? | `null` en v1 hasta revisarlo |
| Descatalogados | ¿Lápidas o despublicar en los importadores? | Lápidas en v1; despublicar como tarea aparte |
| Versionado | ¿Valen 90 días de transición entre versiones mayores? | Sí |
| Presupuestos | ¿Cuándo se diseña el conector de presupuestos? ¿Comparte token y servidor? | Después de este, con token propio por ser de escritura |

## Documentos relacionados

- [Contrato del conector (borrador v1)](catalog-connector-contrato.md)
- [LLD v0.1, sección 9](LLD-0.1-publiexpe-commercial-os.md#9-catalog-service-c2): el Catalog Service y la decisión del conector.
