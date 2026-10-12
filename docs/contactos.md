# Búsqueda de contactos: de quién es el email al que escribir

Hasta la tanda 16, el sistema encontraba empresas y redactaba borradores, pero nadie buscaba el destinatario: ninguna hipótesis validada tenía **Email to** y, por tanto, no salía ningún email. Desde la tanda 17, cuando validas una hipótesis el sistema busca el contacto de la empresa y te lo deja en **Email to**, con la página exacta de donde lo ha sacado.

Este documento es la referencia del diseño: por qué se hace así, qué hace cada fase, qué no hará nunca y en qué se apoya legalmente. Lo que ve y hace el comercial está en la [guía del equipo comercial](guia-comercial.md#cuando-validas-el-sistema-busca-el-contacto); la operación (variables, backfill) está en el [runbook](runbook-local.md#backfill-de-contactos).

> **Nota:** este documento describe la especificación de la tanda 17. Los nombres exactos de variables, endpoints y comandos son los del código y del [README del runtime](../runtime/agent-runtime/README.md); si alguno difiere, manda el README.

## Contenido

1. [Por qué este diseño](#por-qué-este-diseño)
1. [Fase 1: la web de la propia empresa](#fase-1-la-web-de-la-propia-empresa)
1. [Prioridad entre candidatos](#prioridad-entre-candidatos)
1. [Fase 2: enriquecimiento externo](#fase-2-enriquecimiento-externo)
1. [Qué nunca hace](#qué-nunca-hace)
1. [Base legal, en términos llanos](#base-legal-en-términos-llanos)
1. [Cómo leer el Research de contacto](#cómo-leer-el-research-de-contacto)
1. [Backfill de las hipótesis existentes](#backfill-de-las-hipótesis-existentes)
1. [Variables](#variables)
1. [Apollo y otras bases de datos](#apollo-y-otras-bases-de-datos)
1. [Limitaciones](#limitaciones)
1. [Documentos relacionados](#documentos-relacionados)

## Por qué este diseño

El problema es doble: el destinatario falta, y la forma de obtenerlo tiene consecuencias legales y de reputación. Una base de datos de contactos comprada resuelve lo primero a costa de lo segundo, y un email inventado o erróneo daña el dominio de envío, que está en pleno [warm-up](email-warmup.md).

Por eso el diseño va en **dos fases, en este orden**:

| Fase | Fuente | Coste | Por qué en este lugar |
|---|---|---|---|
| **1. Web de la propia empresa** | Páginas públicas de la empresa (portada, contacto, aviso legal, equipo) | Gratis | Es la base legal más sólida: la dirección la publica la propia empresa para ser contactada. Además, cada dato lleva su URL de origen, así que el comercial lo audita en un clic. |
| **2. Enriquecimiento externo** | Un proveedor de pago (Hunter.io primero) | Por consulta, con tope diario | Solo rellena los huecos que la fase 1 no ha podido cerrar. Está apagada por defecto. |

La fase 2 nunca se consulta antes que la 1 ni para una empresa que ya tiene destinatario. El criterio es: **primero lo que la empresa ha publicado, después lo que un tercero afirma saber**.

El sistema sigue sin enviar nada. Encontrar el contacto solo rellena **Email to** y deja el rastro; el clic de enviar sigue siendo del comercial.

## Fase 1: la web de la propia empresa

Se dispara al validar una hipótesis, **antes** de redactar el borrador (flujo draft-on-validated: primero contacto, después borrador), para que el borrador salga ya con destinatario.

1. **Visita la web de la empresa**: portada y las páginas habituales de contacto (`/contacto`, `/aviso-legal`, `/equipo` y similares), con un máximo aproximado de 6 páginas por empresa. Respeta el mismo guard anti-SSRF y el tratamiento de contenido no confiable que el resto de herramientas web del runtime.
1. **Extrae los emails publicados**: enlaces `mailto:`, texto visible y ofuscaciones simples (`info [arroba] empresa.com`, `info(at)empresa.com`).
1. **Solo del dominio de la empresa.** Un email de otro dominio (una gestoría, un proveedor, un correo personal) se descarta aunque aparezca en la web.
1. **Clasifica y ordena** los candidatos según la [tabla de prioridades](#prioridad-entre-candidatos) y descarta los que no deben usarse.
1. **Verifica** cada candidato por sintaxis y por registro MX del dominio. No se hace sondeo SMTP en esta versión: no se "llama" al servidor de la empresa para comprobar si el buzón existe.
1. **Escribe el resultado**:
   - Si **Email to** estaba vacío y hay un candidato válido, lo rellena con el mejor.
   - Siempre crea un Research **«Contacto — empresa»** con cada candidato encontrado y la URL exacta de origen.
   - Si no hay nada publicado, crea el Research **«Sin contacto público»** y la hipótesis pasa a la fase 2 (si está activada).

La fase 1 no necesita ninguna clave ni cuenta externa.

## Prioridad entre candidatos

| Orden | Tipo | Ejemplos | Notas |
|---|---|---|---|
| 1º | **Persona con cargo relevante publicado** | `marta.lopez@empresa.com` junto a «Directora de marketing» en la página de equipo | Solo si la web asocia a esa persona con un cargo relacionado con compras, marketing, comercial o dirección. |
| 2º | **Buzón de función** | `comercial@`, `ventas@`, `marketing@`, `export@` | No es dato personal: corresponde a un departamento. |
| 3º | **Genérico** | `info@`, `contacto@` | Último recurso: sirve, pero tiene menos probabilidad de llegar a quien decide. |
| Nunca | **Descartados** | `noreply@`, `no-reply@`, `dpo@`, `privacy@`, `baja@`, direcciones de baja o protección de datos, y cualquier dirección o dominio en la lista de supresión | No se proponen ni como candidato de reserva. |

Dentro de un mismo nivel, gana el candidato con la fuente más específica (página de equipo antes que pie de página). Los demás candidatos no se pierden: quedan listados en el Research, por si el comercial prefiere otro.

## Fase 2: enriquecimiento externo

Se activa solo si configuras un proveedor. Por defecto está **apagada**: sin variables, el sistema no consulta nada externo.

Condiciones para que se haga una consulta, todas a la vez:

- La hipótesis está `VALIDATED`.
- Tras la fase 1, **sigue sin email** (**Email to** vacío).
- Queda cupo diario (`ENRICH_MAX_LOOKUPS_PER_DAY`, 25 por defecto).
- El dominio no está en la lista de supresión.

Qué hace con la respuesta del proveedor:

| Confianza devuelta | Qué ocurre |
|---|---|
| **0,70 o más** | Rellena **Email to** (si sigue vacío) y lo anota en el Research. |
| **Menos de 0,70** | **No rellena.** El resultado queda como candidato en el Research, para que lo valore el comercial. |

Todo dato obtenido por esta vía queda con **proveedor, confianza y fecha** en el Research. Es la trazabilidad que hace falta para atender un derecho de acceso o de supresión: se puede decir de dónde salió cada dirección y cuándo.

El proveedor `stub` (para desarrollo y pruebas) devuelve datos ficticios sin salir a la red. `hunter` usa Hunter.io con `ENRICH_API_KEY`.

## Qué nunca hace

- **No inventa emails.** Nunca construye una dirección a partir de un patrón (`nombre.apellido@dominio`) ni adivina buzones. Si no hay un email publicado o devuelto por un proveedor, la hipótesis queda sin destinatario.
- **No pisa lo manual.** Si **Email to** ya tiene un valor, el sistema no lo cambia, aunque encuentre otro mejor: el candidato queda en el Research y la decisión es tuya. Lo que escribes tú manda siempre.
- **No envía nada.** Ni emails ni mensajes. Rellenar **Email to** no avisa a nadie.
- **No consulta proveedores sin un hueco real.** Si la hipótesis ya tiene destinatario, o la fase 1 lo ha encontrado, no se gasta ninguna consulta.
- **No usa direcciones de otros dominios** distintos del de la empresa.
- **No usa direcciones de la lista de supresión**, ni de dominios suprimidos.
- **No sondea buzones por SMTP** en esta versión.
- **No borra nada.** Los Research de contacto se acumulan como historial.

## Base legal, en términos llanos

> **Nota:** esto es una explicación operativa, no asesoramiento jurídico. Ante cualquier duda de fondo, consúltalo con quien lleve la protección de datos de PubliEXPE.

- **Comunicación comercial a empresas (LSSI, art. 21).** Un correo comercial no solicitado se admite cuando existe una base que lo permita. Para el contacto entre empresas (B2B), la práctica y el criterio del regulador aceptan escribir a la dirección que la empresa publica precisamente para ser contactada, con identificación clara del remitente y una forma sencilla de darse de baja.
- **Protección de datos (RGPD).** Un buzón de función o genérico (`info@`, `comercial@`) corresponde a un departamento, no a una persona: **no es dato personal**. Una dirección con nombre y cargo sí lo es; ahí se aplica el **interés legítimo** de PubliEXPE en contactar con un profesional por su cargo, sobre un dato que la propia empresa ha hecho público, para una oferta relacionada con su actividad.
- **Fuente citada.** Cada dirección lleva la URL de donde se obtuvo y la fecha. Si alguien pregunta «¿de dónde han sacado mi correo?», la respuesta existe y es verificable.
- **Supresión respetada.** Nada de la [lista de supresión](email-warmup.md#gestión-de-bajas-y-lista-de-supresión) se propone como destinatario, ni la dirección ni el dominio. Una baja o un «no me interesa» es permanente.
- **Derechos atendidos vía `baja@`.** Todo correo lleva la línea de baja y la dirección `baja@publiexpe.info`. Las solicitudes de acceso, rectificación o supresión que lleguen por ahí se atienden con el rastro del Research (fuente, proveedor, fecha) y, si procede, se añaden a la lista de supresión.
- **Por qué la fase 2 pesa más.** Un dato que viene de una base de terceros no lo ha publicado la empresa para ser contactada con ese fin; por eso va después, solo en huecos reales, con umbral de confianza y con trazabilidad completa.

## Cómo leer el Research de contacto

En **Commercial OS → Research**, junto a la empresa de la hipótesis, hay un registro con el título **«Contacto — empresa»**. Contiene:

| Elemento | Qué significa |
|---|---|
| **Candidato elegido** | La dirección que se ha escrito en **Email to** (o la que se habría escrito si ya había una manual). |
| **Tipo** | Persona con cargo, buzón de función o genérico (la [prioridad](#prioridad-entre-candidatos)). |
| **Fuente (URL)** | La página exacta donde aparece la dirección. Ábrela: es la comprobación de que existe y de que la publica la empresa. |
| **Otros candidatos** | Los demás emails válidos encontrados, con su fuente, por si prefieres otro. |
| **Verificación** | Resultado de sintaxis y MX. No garantiza que el buzón exista. |
| **Fase 2** (si aplica) | Proveedor, confianza y fecha de la consulta. |

El título **«Sin contacto público»** significa que la fase 1 no ha encontrado ningún email publicado del dominio de la empresa. La hipótesis no tiene destinatario hasta que lo pongas tú o lo rellene la fase 2 (si está activada y supera el umbral de confianza).

Un email en **Email to** cuyo Research no encuentras suele significar que lo escribió una persona: el sistema nunca rellena sin dejar el Research.

## Backfill de las hipótesis existentes

Las hipótesis validadas **antes** de la tanda 17 no tienen contacto. El backfill las recorre una vez y aplica el mismo proceso (fase 1 y, si está activada, fase 2) a las que siguen sin **Email to**.

- Comando: `pnpm contacts:backfill` (desde `runtime/agent-runtime/`).
- Endpoint equivalente: `POST /contacts/backfill`.
- Es idempotente y no pisa lo manual: puedes repetirlo sin duplicar nada ni cambiar destinatarios ya escritos.

Cuándo y cómo ejecutarlo: [Backfill de contactos en el runbook](runbook-local.md#backfill-de-contactos). Para el warm-up, es lo que por fin dará volumen real de borradores con destinatario ([nota en el plan](email-warmup.md#cuánto-enviar-cuando-hay-destinatarios)).

## Variables

Todas con valor por defecto seguro. La tabla completa con el resto de variables del runtime está en el [runbook](runbook-local.md#variables-del-runtime).

| Variable | Por defecto | Uso |
|---|---|---|
| `ENRICH_PROVIDER` | vacía (apagado) | `stub` o `hunter`. Sin valor, la fase 2 no hace nada. La fase 1 no depende de esta variable. |
| `ENRICH_API_KEY` | vacía | Clave del proveedor. Es un secreto: solo en `deployments/.env`. Obligatoria con `ENRICH_PROVIDER=hunter`. |
| `ENRICH_MAX_LOOKUPS_PER_DAY` | `25` | Tope diario de consultas al proveedor. Al agotarse, las hipótesis sin email esperan al día siguiente. |

## Apollo y otras bases de datos

La pregunta natural es por qué no empezar por una base grande como Apollo. La decisión, razonada:

| Criterio | Hunter.io | Apollo |
|---|---|---|
| **Cobertura de PYME europea** | Mejor: parte de emails públicos de dominios, útil donde no hay perfiles profesionales con mucha huella. | Sólida en EE. UU. y en empresas medianas y grandes; más débil en PYME europea. |
| **Verificación** | Integrada: devuelve un estado y una puntuación por dirección. | Existe, pero la base mezcla datos de calidad desigual. |
| **Riesgo RGPD** | Menor: trabaja por dominio y devuelve las fuentes públicas donde vio la dirección. | Mayor: es una base de datos de personas con su perfil, construida con datos de terceros. |
| **Encaje con la trazabilidad** | Cada resultado trae su origen público. | Hay que fiarse de la base. |

Por eso **Hunter va primero**. Apollo queda como **posible proveedor futuro**: el diseño de proveedores (`ENRICH_PROVIDER`) permite añadirlo sin tocar el resto del flujo.

**Cuándo reconsiderar Apollo:**

- Si la tasa de huecos tras las fases 1 y 2 es alta de forma sostenida y el cuello de botella pasa a ser el volumen de contactos, no su calidad.
- Si PubliEXPE empieza a prospectar de forma estable empresas medianas o grandes, o fuera de Europa, donde Apollo cubre mejor.
- Si se resuelve la base legal de forma explícita (evaluación de impacto y política de transparencia revisadas por quien lleve la protección de datos).
- Si Hunter deja de dar cobertura útil: se compara con el mismo conjunto de dominios antes de decidir.

Hasta entonces, la regla es la de este documento: web propia primero, un proveedor con trazabilidad después, y siempre una persona delante del clic.

## Limitaciones

- **La web puede no publicar nada.** Muchas PYME solo tienen un formulario de contacto: en ese caso no hay email que extraer y la hipótesis queda en «Sin contacto público».
- **Webs que cargan el contenido con JavaScript.** La fase 1 lee el HTML de las páginas; un email que solo aparece tras ejecutar JavaScript puede no verse.
- **MX no garantiza que el buzón exista.** Un dominio con MX puede rechazar la dirección concreta; si pasa, el rebote lo recoge el [triaje del inbound](inbound-triaje.md) y te deja una nota.
- **El mejor candidato no es siempre el decisor.** Un buzón genérico llega a alguien de la empresa, no necesariamente a quien compra: por eso se prefiere la persona con cargo cuando la web la publica.
- **El tope diario de la fase 2 retrasa, no pierde.** Lo que no cabe hoy se procesa mañana.

## Documentos relacionados

- [Guía del equipo comercial](guia-comercial.md#cuando-validas-el-sistema-busca-el-contacto): qué ves y qué haces.
- [Runbook de operación local](runbook-local.md#backfill-de-contactos): variables, backfill y problemas frecuentes.
- [Plan de warm-up del canal de email](email-warmup.md): el calendario que limita cuántos borradores envías.
- [Triaje del inbound](inbound-triaje.md): rebotes y bajas.
- [Enviar los borradores desde Twenty](twenty-envio-email.md): el clic de envío.
- [Roadmap](ROADMAP.md): lugar de la tanda 17 en el plan.
