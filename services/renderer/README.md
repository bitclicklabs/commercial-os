# pxos-renderer

Servicio HTTP interno que renderiza páginas web con Chromium (Playwright) y devuelve el texto que muestran después de ejecutar su JavaScript. Lo usa la tool `render_url` del Agent Runtime para leer los catálogos de expositores que las ferias publican como aplicación JavaScript (por ejemplo, el catálogo de Gastrónoma en `apps.feriavalencia.com`), que `fetch_url` no puede leer.

El navegador vive en este servicio, no en el runtime: la imagen del runtime no crece y un fallo de Chromium no afecta a los workers.

## Stack

- Node.js 22, TypeScript, Fastify 5.
- Playwright 1.63.0 con Chromium. La imagen base es `mcr.microsoft.com/playwright:v1.63.0-noble`, que ya trae Chromium y sus dependencias del sistema.

> **Importante:** la versión de `playwright` en `package.json` y la etiqueta de la imagen base del `Dockerfile` tienen que coincidir. Si actualizas una, actualiza la otra.

## API

### `POST /render`

Cuerpo:

```json
{ "url": "https://apps.feriavalencia.com/catalog/gastronoma/exhibitors", "wait_ms": 2500, "max_chars": 40000, "min_text_chars": 200, "wait_until": "domcontentloaded", "max_pages": 1 }
```

| Campo | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `url` | string | — | URL pública `http` o `https` |
| `wait_ms` | entero, 0-10 000 | `2500` | Espera extra después de cargar, para catálogos que piden sus datos tarde |
| `max_chars` | entero, 500-40 000 | `40000` | Límite del texto devuelto |
| `min_text_chars` | entero, 0-5 000 | `200` | Espera de hidratación: después de `wait_ms`, el renderer mide el texto visible cada 700 ms y sigue esperando (dentro de los 25 s) hasta que alcanza esta longitud **y** deja de crecer entre dos muestras. `0` = solo `wait_ms` |
| `wait_until` | `domcontentloaded` \| `load` \| `networkidle` | `domcontentloaded` | Estado de carga que se espera tras navegar. Con `networkidle`, la espera de red inactiva sube de 8 s a 15 s |
| `max_pages` | entero, 1-5 | `1` | Paginación en el cliente: lee hasta este número de páginas del listado pulsando el control "siguiente" entre lecturas (consulta [Paginación](#paginación)). `1` = sin clics |

Respuesta `200`:

```json
{
  "text": "Catálogo de expositores\n…\nALBONS CHOCOLATES\nEspaña\n…",
  "title": "Catálogo de expositores | GASTRÕNOMA 2026",
  "links": [{ "url": "https://apps.feriavalencia.com/catalog/gastronoma/exhibitors/36157", "text": "" }],
  "final_url": "https://apps.feriavalencia.com/catalog/gastronoma/exhibitors",
  "status": 200,
  "truncated": false,
  "render_ms": 9073,
  "blocked_requests": 0,
  "hydration_ms": 710,
  "hydrated": true,
  "pages_read": 1,
  "page_urls": ["https://apps.feriavalencia.com/catalog/gastronoma/exhibitors"]
}
```

- `text`: `innerText` de la página y de hasta 5 iframes, sin `script`, `style`, `noscript`, `template` ni elementos con `hidden`. Los elementos con `aria-hidden="true"` se eliminan si son fragmentos (menos del 30 % del texto de la página), pero no si envuelven buena parte de ella: Vue, Vuetify o MUI marcan así la aplicación entera mientras hay un diálogo abierto. Lo que no se ve (`display:none`, `visibility:hidden`) no aparece en `innerText`.
- `hydrated` / `hydration_ms`: si el texto alcanzó `min_text_chars` y se estabilizó antes de agotar el presupuesto, y cuánto se esperó. El arranque de Chromium no cuenta en los 25 s.
- `links`: hasta 300 enlaces `http(s)` absolutos y las URL de los iframes, sin duplicados. Si varios enlaces comparten URL (el logo y el nombre de un expositor), se conserva el primer texto no vacío.
- `pages_read` / `page_urls`: páginas leídas con `max_pages` y la URL de cada una (la misma URL repetida si la paginación no cambia la dirección).
- `final_url`: URL final después de las redirecciones.
- `blocked_requests`: peticiones de la página rechazadas por la guarda de egreso.

Errores: `{ "error": { "code": "…", "message": "…" } }`.

| Código | HTTP | Cuándo |
|---|---|---|
| `INVALID_INPUT` | 400 | El cuerpo no cumple el esquema |
| `INVALID_URL` | 400 | La URL no se puede analizar |
| `URL_NOT_ALLOWED` | 400 | Esquema distinto de `http`/`https` (`data:`, `file:`, `javascript:`…), credenciales en la URL, puerto no permitido, host interno, IP literal no pública o host fuera de la allowlist |
| `SSRF_BLOCKED` | 400 | El host resuelve a alguna IP no pública |
| `NAVIGATION_BLOCKED` | 400 | Una redirección apunta a un destino rechazado |
| `DNS_ERROR` | 422 | El host no resuelve |
| `DOWNLOAD_BLOCKED` | 422 | La URL es una descarga (un PDF, por ejemplo: usa `fetch_url`) |
| `HTTP_ERROR` | 502 | El documento principal responde 4xx/5xx |
| `TOO_MANY_REDIRECTS` | 502 | Más de 5 redirecciones |
| `NAVIGATION_FAILED`, `RENDER_FAILED` | 502 | Fallo de navegación o del navegador |
| `RENDERER_BUSY` | 503 | Hay 2 renders en curso y la cola (4) está llena, o la espera supera 30 s |
| `RENDER_TIMEOUT` | 504 | Se agotó el presupuesto de 25 s |

### Paginación

Muchos catálogos JavaScript paginan en el navegador: el botón "siguiente" no es un enlace y la URL no cambia (Gastrónoma: 20 expositores por página, 91 en total). Con `max_pages` > 1, después de leer la primera página el renderer:

1. Busca el control "siguiente" más probable: `rel="next"`, texto o `aria-label` "Siguiente"/"Next", clases con `next` o iconos de flecha (`fa-arrow-right`, `mdi-chevron-right`...), con más peso dentro de un contenedor de paginación. Nunca elige controles desactivados, flechas de "última página" o dobles, flechas de carruseles (`swiper`, `slick`, `carousel`...) ni enlaces a otro origen; un enlace que navega solo se pulsa dentro de un paginador o con `rel="next"`.
2. Lo pulsa con un clic DOM (un aviso de cookies fijo encima del paginador no lo bloquea) y espera hasta 6 s a que el texto cambie y se estabilice.
3. Añade el texto de la página nueva tras una marca `[Página N del listado]`, sin las líneas iniciales y finales que comparte con la primera (cabecera, filtros, pie).

Se detiene al no encontrar el control, si el texto no cambia o se repite, al llegar a `max_chars` o cuando quedan menos de 3,5 s del presupuesto de 25 s. Todas las peticiones que provoque el clic pasan por la misma guarda de egreso. En Gastrónoma, 3 páginas (60 expositores) tardan unos 11 s.

### `GET /health`

`200 { "status": "ok", "active": 0, "queued": 0 }`.

## Seguridad

El renderer ejecuta JavaScript de terceros: se trata como hostil.

**Antes de navegar**, la URL pasa las mismas reglas que `fetch_url` (`src/ip-guard.ts`, copia exacta de `runtime/agent-runtime/src/tools/web/ip-guard.ts`; un test falla si las dos copias divergen): solo `http`/`https`, sin credenciales, puertos permitidos, allowlist/denylist, nombres internos (`localhost`, `*.internal`, nombres de una etiqueta como `pxos-twenty`) y **todas** las IP resueltas públicas. El documento principal se descarga primero fuera del navegador, resolviendo cada redirección con la misma guarda, y la página se abre en su URL final.

**Durante el render**, Chromium no abre ninguna conexión por sí mismo:

| Control | Implementación |
|---|---|
| Peticiones HTTP(S) de la página | Todas interceptadas (`context.route`) y servidas por `src/egress.ts` con `route.fulfill`: guarda de URL + DNS público + conexión fijada a la IP comprobada (sin rebinding) en cada petición y en cada redirección |
| Segunda barrera | Chromium arranca con un proxy muerto (`127.0.0.1:9`, loopback incluido): una petición que escapara a la interceptación falla en vez de salir a la red |
| WebSockets | Cerrados (`routeWebSocket`) |
| WebRTC | Sin UDP fuera del proxy (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`) |
| Service workers | Bloqueados |
| Descargas | Rechazadas (`acceptDownloads: false`) |
| Imágenes, vídeo, fuentes, beacons | Abortados: solo hace falta el texto |
| Ventanas emergentes y diálogos | Se cierran |
| Aislamiento | Un contexto de navegador nuevo por petición (sin cookies, almacenamiento ni caché compartidos), cerrado al terminar |
| Concurrencia | 2 renders a la vez como máximo (`RENDER_MAX_CONCURRENCY`, 1-2), cola de 4 |
| Tiempo | 25 s para navegación, JavaScript y esperas; el contexto se cierra a la fuerza 3 s después |
| Tamaño | 5 MB por respuesta, 30 MB y 400 peticiones por render; texto de salida de 40 000 caracteres |
| Cabeceras | `User-Agent` de Chromium con el sufijo `PubliexpeCommercialOS/0.1`; nunca `Proxy-Authorization`; `Cookie`/`Authorization` puestas por la propia página (su sesión anónima: el contexto empieza vacío y el renderer no tiene credenciales) se reenvían tal como las envía el navegador y se eliminan si una redirección cambia de origen |
| Red | Sin puerto publicado al host: solo `pxos-net` |

Las cookies de consentimiento no se aceptan: el banner aparece en el texto y el agente lo ignora.

> **Precaución:** Chromium se ejecuta sin su sandbox propio, que es el comportamiento por defecto de Playwright en Docker. Las barreras son las de la tabla, más el contenedor (usuario sin privilegios, sin capabilities, `no-new-privileges`, raíz de solo lectura, límites de memoria y procesos). Para activar el sandbox de Chromium, añade al servicio el perfil seccomp de Playwright (`security_opt: [seccomp=…/seccomp_profile.json]`, del repositorio de Playwright) y define `RENDER_CHROMIUM_SANDBOX=true`.

## Desarrollo local

1. Instala las dependencias y Chromium (se descarga en la caché de usuario de Playwright, `%LOCALAPPDATA%\ms-playwright` en Windows):

   ```sh
   cd services/renderer
   pnpm install
   pnpm browsers        # npx playwright install chromium
   ```

1. Arranca el servicio en `127.0.0.1:4030`:

   ```sh
   pnpm dev
   ```

1. Prueba una página:

   ```sh
   curl -s http://127.0.0.1:4030/render -H 'content-type: application/json' \
     -d '{"url":"https://apps.feriavalencia.com/catalog/gastronoma/exhibitors"}'
   ```

1. Para que un runtime local lo use, define `RENDERER_URL=http://127.0.0.1:4030` en `runtime/agent-runtime/.env`.

Variables (`.env.example`): `HOST`, `PORT`, `LOG_LEVEL`, `RENDER_MAX_CONCURRENCY`, `RENDER_CHROMIUM_SANDBOX` y las de la política de hosts de `fetch_url` (`FETCH_URL_ALLOWLIST`, `FETCH_URL_DENYLIST`, `FETCH_URL_ALLOWED_PORTS`).

## Tests

```sh
pnpm test:unit                                     # sin navegador ni red
pnpm vitest run test/integration/browser-guard.test.ts   # Chromium real, internet simulado
pnpm vitest run test/integration/live.test.ts      # contra `pnpm dev` y la web real
```

- `test/unit/egress.test.ts`: guarda de URL y DNS con `FakeWeb` (`data:`, `file:`, `localhost`, nombres internos, IP privadas, metadata, IPv6 incrustada, DNS mixto, puertos, credenciales, allow/denylist), cabeceras reenviadas, validación **antes** de lanzar Chromium y comprobación de que `ip-guard.ts` es idéntico al del runtime.
- `test/unit/server.test.ts`: contrato HTTP con Fastify `inject`, mapeo de errores y semáforo de concurrencia.
- `test/integration/browser-guard.test.ts`: Chromium real con `FakeWeb` como internet y un servidor HTTP/WebSocket real en `127.0.0.1` que hace de servicio interno. La página intenta llegar a él por `fetch` (IP literal, `localhost`, DNS privado, DNS mixto), WebSocket, `sendBeacon`, WebRTC, metadata, `file:`, un iframe y redirecciones; el servidor interno no recibe **ninguna** conexión. También: contenido oculto eliminado (sin perder una aplicación entera marcada `aria-hidden` por un diálogo), espera de hidratación de una lista que aparece 4 s tarde, redirecciones públicas seguidas, descargas rechazadas y bucle infinito de JavaScript cortado por tiempo. Se salta si Chromium no está instalado o con `SKIP_BROWSER_TESTS=1`.
- `test/integration/live.test.ts`: **en vivo**, contra el servicio arrancado con `pnpm dev` (`RENDERER_TEST_URL`, por defecto `http://127.0.0.1:4030`). Renderiza `gastronoma.es` y el catálogo JavaScript de Gastrónoma en Feria Valencia, y comprueba que `data:`, `localhost`, loopback, IP privadas, metadata y nombres internos se rechazan con `400`. Se salta si el servicio no responde o con `SKIP_LIVE_TESTS=1`.

## Docker

El `Dockerfile` es multi-stage sobre la imagen de Playwright (build con pnpm, imagen final solo con dependencias de producción, usuario `pwuser`, healthcheck sobre `/health`). Escucha en `0.0.0.0:3000` dentro del contenedor.

### Integración en deployments/docker-compose.yml

`docker-compose.renderer.yml` es el fragmento del servicio `pxos-renderer`. Quien mantenga `deployments/`:

1. Copia el bloque `pxos-renderer` a la sección `services:` de `deployments/docker-compose.yml`. El `build.context` (`../services/renderer`) ya es relativo a `deployments/`.
1. No añadas `ports:`. El runtime lo alcanza por `pxos-net` como `http://pxos-renderer:3000`, que es el valor por defecto de `RENDERER_URL` en el runtime: no hace falta definir nada en `pxos-runtime`.
1. Opcional, solo en desarrollo: para usarlo desde un runtime arrancado en el host, publica `"127.0.0.1:4030:3000"` y define `RENDERER_URL=http://127.0.0.1:4030` en el `.env` del runtime.
1. Construye y arranca: `docker compose -f deployments/docker-compose.yml up -d --build pxos-renderer`.
1. Comprueba desde el runtime: `docker exec pxos-runtime node -e "fetch('http://pxos-renderer:3000/health').then(r=>r.text()).then(console.log)"`.

Sin el servicio, el runtime sigue funcionando: `render_url` devuelve `RENDERER_NOT_CONFIGURED` y el scout se comporta como antes (señal de feria sin expositores cuando el catálogo es JavaScript).
