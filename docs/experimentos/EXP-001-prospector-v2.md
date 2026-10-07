# EXP-001 · Prospector v2: confianza según los datos y cantidades con desglose

Primera vuelta real del ciclo de mejora de skills (LLD v0.1 §6.3, en versión manual: el optimizador automático es MVP-3). Este documento recoge el análisis, la candidata, la validación offline y la decisión que se propone. El procedimiento general está en [Ciclo de mejora de skills](../ciclo-mejora-skills.md).

| Campo | Valor |
|---|---|
| Fecha | 2026-10-07 |
| Skill | `prospector-event-exhibitors` |
| Base | v1 `ACTIVE` · `c204154d-3cc0-4d99-80be-5891bd1359e2` (migración byte a byte de la constante `PROSPECTOR_SYSTEM_PROMPT`) |
| Candidata | v2 `DRAFT` · `19587041-b7d8-4113-8871-1e042ab27a68` · `content_hash` `40c99c45e676…` |
| Operaciones | 5 (2 `ADD`, 3 `REPLACE`): 8,8 % del texto base sustituido, 30,6 % añadido |
| Validación | `pnpm skill:compare`, Gemini `gemini-flash-latest`, FakeTwenty, 11 expositores × 2 repeticiones × 2 versiones |
| Coste de la validación | 0,0903 € (presupuesto: 0,15 €) |
| Estado | v2 **no activada** |
| Recomendación | **Iterar**: no activar v2 tal cual; crear una v3 con una operación más y validarla con datos nuevos |

Archivos del experimento:

- [`EXP-001-prospector-v2.ops.json`](EXP-001-prospector-v2.ops.json): operaciones exactas y su justificación (lo que se envió a la API).
- [`EXP-001/compare-v1-v2.md`](EXP-001/compare-v1-v2.md): informe completo de la comparación, lado a lado.
- [`EXP-001/compare-v1-v2.json`](EXP-001/compare-v1-v2.json): todas las decisiones de las 8 ejecuciones (para recalcular métricas con `--rerender`).

## Resumen

v2 hace lo que se le pidió en las hipótesis: el 100 % de las necesidades llevan desglose de unidades (v1: 0 %), ninguna horquilla de cantidad supera 2,5× (v1: todas) y la confianza de los expositores de los que solo llega el nombre baja de 0,68 a 0,60 de media. No cambia qué expositores pasan al CRM: con el umbral de 0,5, las dos versiones escriben los mismos 12 de 16 casos de Gastrónoma.

A cambio, v2 introduce una incoherencia que v1 no tenía: en 2 de 4 decisiones sobre organismos públicos marca `relevant = false` con confianza 0,95. El modelo lee la confianza como «seguridad del veredicto» y no como «encaje comercial». No llega al CRM (las decisiones no relevantes no se escriben), pero rompe la escala de la propia skill. Por eso la recomendación es iterar con una operación más, no activar.

## 1. Datos de diseño

Las operaciones de v2 se diseñaron **solo** con estos datos (el *train split* de P5):

| Ejecución | Qué es | Expositores usados |
|---|---|---|
| `e67cba89-4252-45bd-bb25-b15ca0268a6c` | Scout de Gastrónoma 2026, primera página del catálogo (Prospector v4 de agente) | 1-20 |
| `44e35e27-b991-467e-988a-6f0c591669cb` | Scout de Gastrónoma con el atajo JSON (traza `ed8e30bf-…`) | 1-60 |
| `7eaa0dd4-930b-4ea6-bdd2-c558c597b97a` | Scout de Gastrónoma completo, 91 expositores (traza `9d934b83-…`) | **solo 1-60** |

> **Nota:** `44e35e27` y `7eaa0dd4` figuran como `FAILED` en `agent_executions` (el reconciliador las marcó `OrphanedRun` y dejó el coste a 0), pero sus trazas están completas: 63 y 93 pasos `MODEL`. Los datos de este análisis salen de `trace_steps`. Solo sus pasos de evaluación de expositores suman 0,1426 USD y 0,2200 USD.

Las tres ejecuciones usaron el texto de v1 (la constante de código, idéntica a la v1 de la base de datos). Los expositores siguen el orden alfabético del JSON del catálogo (`POST /api/puisearch`, 91 registros).

Evaluaciones humanas: la tabla `evaluations` tiene 275 filas, de las que 6 son humanas (`details.actor.human = true`). Las 5 que enlazan con el Prospector son de `44e35e27` y todas son `ACCEPTED` sin edición: ARCECARNE (`c782fd42`), BAUUMAN (`c3214ab6`), BICO DE XEADO (`12010b9c`), CULLIGAN PREMIUM WATER (`b0c4b5aa`) y DOMINIOS DE MGP (`e081b88e`). Las cinco caen en el tramo 1-60 y las cinco tenían sector en el catálogo.

> **Importante:** con 5 aceptaciones y ningún rechazo, el feedback humano no permite decir que v1 produzca hipótesis malas. Los patrones de este experimento son estructurales (salen de comparar muchas hipótesis entre sí), no de rechazos. v2 no se puede justificar como «sube la aceptación»; se justifica como «la hipótesis explica de dónde salen sus números y la confianza respeta su propia escala».

Lo que **no** se usó para diseñar:

- Los expositores 61-91 de Gastrónoma en cualquier traza. La única lectura que los incluyó fue un recuento agregado (87 relevantes de 91 en `7eaa0dd4`), sin ver ninguna decisión concreta.
- Las ~28 ejecuciones directas del fixture `feria-ejemplo.json` (Prospector v2 a v5 de agente, 2026-10-06 y 2026-10-07). Se consultaron durante la exploración, antes de fijar el reparto; ninguna operación se justifica con ellas. El fixture se usa en la validación como control de regresión (expositores con datos ricos), no como prueba de mejora.

## 2. Patrones encontrados

Cifras sobre `7eaa0dd4` (expositores 1-60) salvo que se indique otra ejecución. «Solo nombre» significa que el catálogo no daba sector, descripción ni web: 46 de los 60 expositores.

### F1 · Cantidades y presupuestos de plantilla

Las hipótesis reutilizan unas pocas horquillas que no dependen del expositor, y la necesidad no dice de dónde salen las unidades.

| Señal | e67cba89 (20) | 44e35e27 (56 hip.) | 7eaa0dd4 (57 hip.) |
|---|---|---|---|
| `budget_min_eur` = 600 € | 9/20 | 28/56 | 27/57 |
| `budget_max_eur` = 2.200 € o 1.800 € | 12/20 | 40/56 | 36/57 |
| Horquilla más repetida | 150-500 u / 450-1.800 € (×3) | 250-800 u / 600-2.200 € (×10) | 250-1.000 u / 600-2.200 € (×5) |
| Cantidad máx./mín. > 2,5 | 20/20 | 54/56 | 57/57 |
| `need` con alguna cantidad | 0/20 | 0/56 | 0/57 |

Ejemplos: HOSTECO (`44e35e27`, paso 51: 250-800 u / 650-2.200 €; `7eaa0dd4`, paso 50: 250-800 u / 600-2.200 €), GREMIO DE MAESTROS CONFITEROS (`7eaa0dd4`, paso 48: 250-800 u / 600-2.200 €), INNOVA CHEF (`7eaa0dd4`, paso 58: 250-800 u / 600-2.200 €), MEDITERRÁNEO CULINARY CENTER (`44e35e27`, paso 68: 250-800 u / 600-2.200 €). Cuatro entidades distintas (equipamiento, gremio, distribución, formación) con la misma horquilla.

### F2 · La confianza no baja cuando solo llega el nombre

La escala de v1 reserva 0,5-0,79 para «encaje razonable con algún dato que falta». El modelo aplica esa franja también cuando falta todo salvo el nombre.

- 34 de 46 expositores solo con nombre tienen confianza > 0,6 en `7eaa0dd4` (32 de 46 en `44e35e27`). Media: 0,62 y 0,60.
- INNOVA CHEF (`44e35e27`, paso 59): confianza 0,75 con la razón «Aunque solo disponemos del nombre comercial…».
- MEDITERRÁNEO CULINARY CENTER (`44e35e27`, paso 68 y `7eaa0dd4`, paso 67): 0,75 en las dos ejecuciones, solo con el nombre.
- CAFÉS EL CRIOLLO (`7eaa0dd4`, paso 21): 0,85 solo con el nombre.
- BICO DE XEADO (`e67cba89`, paso 25; `44e35e27`, paso 18; `7eaa0dd4`, paso 17): 0,85 con nombre y un sector genérico («Alimentación / Food, Productos artesanos»).

Efecto: el umbral de 0,5 descarta muy poco (2 de 20 en `e67cba89`; 7 de 60 en `7eaa0dd4`, contando no relevantes y confianza baja), y la confianza no ordena: casi todo cae entre 0,65 y 0,75.

### F3 · Suposiciones a partir del nombre escritas como hechos

v1 ya dice «si supones algo, dilo en reason», pero el modelo identifica entidades a partir del nombre y lo escribe como un dato.

- FEGREPPA: «es el Gremio de Panaderos y Pasteleros de Valencia» (`44e35e27`, paso 40) y «es la Federación Gremial y Empresarial de Panadería y Pastelería de la C.V.» (`7eaa0dd4`, paso 39). Dos identidades distintas para la misma entrada; además, el catálogo tiene otro expositor llamado GREMIO DE PANADEROS Y PASTELEROS DE VALENCIA.
- GRECARVAL: «(Gremio de Carniceros y Charcuteros de Valencia)» (`44e35e27`, paso 48; `7eaa0dd4`, paso 47), sin dato de entrada que lo diga.
- HOSTELERÍA VALENCIA: «Se identifica como la Federación Empresarial de Hostelería de Valencia» (`44e35e27`, paso 53).
- COMINPORT: «distribuidor consolidado de productos gastronómicos prémium (especialmente cocina japonesa)» (`e67cba89`, paso 40).

### Patrones observados que v2 no toca

Se documentan para no actuar sobre ellos sin más evidencia:

- **Diferenciales y `why_now` repetidos.** `TALLER_PROPIO` va primero en el 100 % de las hipótesis (57/57) y `why_now` lo cita siempre; `OFERTAS` aparece 1 vez. Pero la feria está a 19 días y la propia skill dice «taller propio si el plazo es corto»: es coherente, no un fallo. `timing` = `IMMEDIATE` en el 100 %, correcto por la fecha.
- **Productos.** La bolsa tote aparece en 53/57 hipótesis y el delantal en 50/57, pero los productos sí se adaptan al expositor: CULLIGAN recibe botellas y vasos reutilizables (`7eaa0dd4`, paso 29), FOODLUS no recibe delantales (paso 41). Sin catálogo conectado, no hay base para cambiarlo.
- **¿Son creíbles los 20/20 relevantes de `e67cba89`?** La relevancia sí: la skill define como relevante a toda empresa privada que expone, y los organismos públicos se descartan bien (DENOMINACIÓN DE ORIGEN UTIEL-REQUENA, IGP CASTELLÓ y GRADO CIENCIAS GASTRONÓMICAS de la Universitat de València, con 0,05-0,1 en las dos ejecuciones de 60). Lo blando es la confianza (F2), no el criterio de relevancia. Los gremios y asociaciones salen relevantes con 0,55-0,65: es una decisión comercial que corresponde a PubliEXPE, no a esta skill.
- **Inestabilidad en casos sin datos.** CEG es `relevant = false` con 0,1 en `44e35e27` (paso 23) y `relevant = true` con 0,45 en `7eaa0dd4` (paso 22). Las dos acaban descartadas, así que no tiene efecto en el CRM.

## 3. Hipótesis de mejora

Si la skill (a) pone un techo de confianza según los datos que llegan y (b) obliga a derivar cantidades y presupuesto de un desglose por producto escrito en `need`, entonces, sobre expositores no vistos:

1. la confianza media de los casos «solo nombre» baja y deja de superar 0,6 salvo notoriedad declarada;
2. `need` lleva cantidades y la horquilla de cantidad se estrecha (máx./mín. ≤ 2,5);
3. la razón marca como suposición lo que se deduce del nombre;
4. sin cambiar qué expositores son relevantes ni empeorar los casos con datos ricos (fixture), y con un sobrecoste por decisión ≤ 15 %.

## 4. Operaciones aplicadas

Cinco operaciones acotadas sobre el texto de v1 (`pnpm skill:candidate`). Nada más cambia: el resto del texto, incluida la regla de contenido no confiable, queda byte a byte.

| # | Tipo | Dónde | Cambio | Patrón |
|---|---|---|---|---|
| OP1 | `ADD` | tras «0-0,19: no hay encaje.» | Techo: solo nombre ≤ 0,6; nombre y sector ≤ 0,75; superarlo solo por notoriedad, dicho en `reason` | F2 |
| OP2 | `REPLACE` | viñeta `need` | `need` incluye unidades aproximadas por producto, con un ejemplo de desglose | F1 |
| OP3 | `REPLACE` | viñeta `quantity_min / quantity_max` | Cantidades a partir del desglose; stand pequeño o mediano si no se conoce el tamaño (y se dice); máx. ≤ 2,5 × mín. | F1 |
| OP4 | `REPLACE` | viñeta `budget_min_eur / budget_max_eur` | Presupuesto = unidades × precio unitario orientativo, no una horquilla genérica | F1 |
| OP5 | `ADD` | tras «No inventes hechos…» | Lo deducido del nombre es una suposición y se escribe como tal («por el nombre, parece…») | F3 |

La versión se creó así (simulación primero, sin `--post`, para revisar el diff):

```sh
cd runtime/agent-runtime
pnpm skill:candidate prospector-event-exhibitors --ops ../../docs/experimentos/EXP-001-prospector-v2.ops.json
pnpm skill:candidate prospector-event-exhibitors --ops ../../docs/experimentos/EXP-001-prospector-v2.ops.json --post --created-by "skill-cycle EXP-001 (agente, gate humano)"
```

El `change_reason` y las operaciones con su justificación quedan en `skill_versions.metadata` de v2 (`operations`, `design_data`, `validation_data`, `removed_ratio`, `added_ratio`).

## 5. Datos de validación y por qué no contaminan (P5)

| Fixture | Qué contiene | Por qué no contamina |
|---|---|---|
| `test/fixtures/feria-ejemplo.json` | 3 expositores sintéticos con descripción y dominio | No es Gastrónoma ni se usó para justificar ninguna operación. Sirve de control de regresión con datos ricos |
| `test/fixtures/gastronoma-holdout.json` | 8 expositores reales de Gastrónoma: MUÑOZ BOSCH S.L., ORIENTE EXQUISITO, QANTIMA GROUP, REY JAYÓN, STEEL-INOX S.L., UNIFORMES SANTA BÁRBARA, VICENTE GANDIA PLA S.A., XUNTA DE GALICIA | Posiciones 62, 66, 70, 74, 78, 82, 86 y 90 del catálogo: muestreo sistemático (uno de cada cuatro desde el 62) dentro del tramo 61-91, fijado antes de ejecutar y excluido del análisis |

Los datos de cada expositor del holdout salen del JSON del catálogo con la misma función que usa el scout en producción (`findExhibitorListInJson`): nombre y, si existe, sector. Seis de los ocho llegan solo con el nombre, la misma proporción aproximada que en producción (46 de 60).

Las dos versiones vieron exactamente la misma entrada (hash de la entrada en el informe), la misma fecha (`--today 2026-10-07`, la del scout real) y el mismo modelo y configuración del agente (`desiredProspectorVersion()`: `gemini-flash-latest`, `thinking_level: low`, umbral 0,5). El orden alterna entre repeticiones (v1, v2 / v2, v1). El CRM es un FakeTwenty en memoria nuevo por ejecución: 8 escrituras en memoria, 0 en Twenty.

## 6. Resultados

Comando:

```sh
pnpm skill:compare prospector-event-exhibitors --versions 1,2 \
  --fixture test/fixtures/feria-ejemplo.json --fixture test/fixtures/gastronoma-holdout.json \
  --repeat 2 --max-cost-eur 0.15 --today 2026-10-07 --out ../../docs/experimentos/EXP-001/compare-v1-v2
```

### Holdout de Gastrónoma (8 expositores × 2 repeticiones)

| Métrica | v1 | v2 |
|---|---|---|
| Relevantes / escribibles (≥ 0,5) | 14 / 12 | 14 / 12 |
| Relevantes solo nombre: confianza media / máx. | 0,68 / 0,85 (n = 12) | 0,60 / 0,85 (n = 12) |
| No relevantes con confianza > 0,19 | 0 | **1** (XUNTA DE GALICIA, 0,95) |
| `need` con cantidades | 0/14 | 14/14 |
| Hipótesis con máx./mín. > 2,5 | 14/14 | 0/14 |
| Amplitud media de cantidad | 3,69 | 1,80 |
| Horquillas distintas / hipótesis | 0,93 | 1,00 |
| Solo nombre: la razón marca la suposición | 2/12 | 8/12 |
| Precio unitario implícito en 0,50-15 € | 14/14 | 14/14 |
| Tokens de entrada / salida | 25.996 / 4.749 | 29.874 / 4.885 |
| Coste (por decisión) | 0,0321 € (0,0020 €) | 0,0350 € (0,0022 €) |

Lado a lado (confianza de las dos repeticiones; cantidad y presupuesto de la última):

| Expositor | Datos | v1 | v2 |
|---|---|---|---|
| MUÑOZ BOSCH S.L. | solo nombre | 0,75 / 0,85 · 300-1.200 u · 1.200-4.500 € | 0,60 / 0,60 · 715-1.200 u · 1.400-2.800 € |
| ORIENTE EXQUISITO | sector | 0,65 / 0,70 · 250-1.000 u · 600-2.200 € | 0,65 / 0,65 · 260-500 u · 650-1.350 € |
| QANTIMA GROUP | solo nombre | 0,70 / 0,70 · 250-1.000 u · 750-2.800 € | 0,60 / 0,55 · 460-750 u · 950-1.850 € |
| REY JAYÓN | solo nombre | 0,55 / 0,65 · 250-800 u · 600-2.200 € | 0,55 / 0,55 · 560-1.200 u · 650-1.400 € |
| STEEL-INOX, S.L. | solo nombre | 0,65 / 0,65 · 150-500 u · 600-2.200 € | 0,55 / 0,55 · 210-350 u · 550-1.100 € |
| UNIFORMES SANTA BÁRBARA | solo nombre | 0,45 / 0,45 · 200-600 u · 350-1.200 € | 0,45 / 0,45 · 450-750 u · 600-1.250 € |
| VICENTE GANDIA PLA, S.A. | solo nombre | 0,85 / 0,85 · 300-1.500 u · 900-3.500 € | 0,85 / 0,85 · 725-1.500 u · 1.800-3.800 € |
| XUNTA DE GALICIA | sector (público) | no relevante · 0,05 / 0,05 | no relevante · **0,05 / 0,95** |

Lectura cualitativa:

- **El desglose es coherente.** En v2, `quantity_min` es la suma del desglose de `need`. MUÑOZ BOSCH: «unas 400 bolsas … 300 libretas … 15 delantales o polos» = 715 = `quantity_min`. STEEL-INOX: 200 libretas + 10 polos = 210. Un comercial puede corregir una línea en vez de adivinar una horquilla.
- **La excepción por notoriedad funciona como se diseñó.** VICENTE GANDIA PLA queda en 0,85 con la razón «Por conocimiento general, … bodega valenciana líder … su notoriedad sectorial justifica superar el techo». MUÑOZ BOSCH, en cambio, pasa de 0,75-0,85 («distribuidor consolidado», escrito como hecho) a 0,60 («al recibir únicamente el nombre, la confianza se sitúa en 0,6»).
- **Las suposiciones se marcan.** STEEL-INOX en v2: «Por el nombre, parece una empresa privada proveedora de equipamiento … en acero inoxidable». En v1 la misma idea era un hecho («Empresa privada de equipamiento o carpintería metálica en acero inoxidable»).
- **Cantidades más altas en algunos casos.** REY JAYÓN sube de 250-800 u a 560-1.200 u; UNIFORMES SANTA BÁRBARA de 200-600 u a 450-750 u. El desglose suma artículos baratos (bolígrafos, libretas) y el presupuesto baja o se mantiene. Es una estimación distinta, no necesariamente mejor; solo el comercial puede juzgarla.
- **Competidor parcial estable.** UNIFORMES SANTA BÁRBARA (vestuario laboral) se queda en 0,45 en las dos versiones y las dos lo explican como posible competencia en textil.

### Fixture `feria-ejemplo` (3 expositores × 2 repeticiones)

| Métrica | v1 | v2 |
|---|---|---|
| Relevantes / escribibles | 4 / 2 | 4 / 2 |
| Confianza de Conservas Marineras (datos ricos) | 0,90 / 0,90 | 0,85 / 0,88 |
| Confianza de Envases Garrido (competidor parcial) | 0,45 / 0,45 | 0,45 / 0,45 |
| Instituto Regional (organismo público, no relevante) | 0,05 / 0,05 | **0,95** / 0,05 |
| `need` con cantidades / máx./mín. > 2,5 | 0/4 · 4/4 | 4/4 · 0/4 |
| Coste (por decisión) | 0,0111 € (0,0018 €) | 0,0121 € (0,0020 €) |

Sin regresión en los casos con datos ricos: el expositor claro sigue claro (0,85-0,88), el competidor parcial sigue por debajo del umbral y el organismo público sigue descartado.

### Frente a la hipótesis de mejora

| Criterio | Resultado |
|---|---|
| 1. Confianza «solo nombre» baja y ≤ 0,6 salvo notoriedad | Cumplido: 0,68 → 0,60; el único caso > 0,6 es VICENTE GANDIA y lo justifica en `reason` |
| 2. `need` con cantidades y amplitud ≤ 2,5 | Cumplido: 0/14 → 14/14; 14/14 → 0/14 |
| 3. Suposiciones marcadas | Cumplido en parte: 2/12 → 8/12 (medido con una lista de marcadores; MUÑOZ BOSCH aún afirma «conocida en el sector» sin marcarlo) |
| 4a. Sin cambios de relevancia | Cumplido: 14/14 relevantes y 12/12 escribibles en las dos |
| 4b. Sin regresión con datos ricos | Cumplido en relevancia y confianza de los relevantes; **no** en la coherencia de la escala (organismos públicos con 0,95) |
| 4c. Sobrecoste ≤ 15 % por decisión | Cumplido: +9 % en el holdout (+15 % de tokens de entrada por el prompt más largo, +3 % de salida) y +9 % en el fixture |

Estabilidad entre repeticiones: la desviación media de la confianza sube en v2 (0,016 → 0,059 en el holdout; 0 → 0,155 en el fixture), pero la sube solo el salto 0,05 ↔ 0,95 de los organismos públicos. Sin esos dos casos, v2 es más estable que v1 en los relevantes (desviación media 0,004 frente a 0,018). Ningún expositor cambia de relevante o escribible entre repeticiones en ninguna versión.

## 7. Recomendación: iterar, no activar

v2 mejora lo que se propuso (cantidades explicables, confianza que respeta los datos, suposiciones marcadas) sin cambiar qué entra en el CRM y con un sobrecoste pequeño (~0,0002 € por expositor; ~0,02 € por una feria de 91). Pero introduce una regresión de semántica: en 2 de 4 decisiones sobre organismos públicos (una en cada fixture) la confianza pasa de 0,05 a 0,95 con `relevant = false`. La causa probable es OP1: al hablar de «techo de confianza», el modelo interpreta la confianza como seguridad del juicio.

No tiene efecto en el CRM hoy (los no relevantes no se escriben), pero la regla de oro del LLD (§11.6, *seesaw constraint*) no acepta regresiones sobre lo que ya funcionaba, y cualquier consumidor futuro de `confidence` (ordenación, métricas, scorer) se vería afectado. Con 11 expositores y 2 repeticiones la muestra es pequeña: sirve para detectar esta regresión, no para estimar una mejora de aceptación.

Siguiente paso propuesto (decisión humana):

1. Depreca la v2 como borrador descartado: `POST /skills/prospector-event-exhibitors/versions/2/deprecate` (no toca la v1 `ACTIVE`). Opcional: puedes dejarla en `DRAFT` como referencia.
2. Crea una v3 desde v1 con las cinco operaciones de v2 más una sexta, `REPLACE` del título de la sección de calibración, del tipo: «## Calibración de "confidence" (0 a 1): mide el encaje comercial del expositor, no tu seguridad en la decisión; si relevant es false, la confianza está entre 0 y 0,19».
3. Valida v3 con datos **nuevos**: los 8 expositores de este holdout ya se usaron para detectar el fallo que corrige OP6, así que para v3 pasan a ser datos de diseño. Usa otro muestreo del tramo 61-91 (por ejemplo, las posiciones 63, 67, 71, 75, 79, 83, 87 y 91) o los expositores de otra feria, y repite la comparación v1 vs v3 con el mismo presupuesto.
4. Activa v3 solo si conserva las mejoras de v2 y la métrica «No relevantes con confianza > 0,19» queda en 0.

## 8. Cómo se mediría en producción

Si se activa una versión candidata, mide su aceptación humana frente a la anterior:

- **`GET /metrics/agents` no basta por sí solo.** Agrupa por versión de *agente*, y activar una versión de skill no crea una versión de agente nueva: v1 y v2 de la skill quedarían mezcladas en la misma fila. Úsalo para el contexto (volumen, coste por run) y anota la hora de activación.
- **Aceptación por versión de skill**, con SQL de solo lectura sobre `evaluations` y `traces.skill_versions`:

  ```sql
  select sv->>'version' as skill_version, ev.feedback, count(*) as n
  from evaluations ev
  join traces t on t.execution_id = ev.agent_execution_id
  cross join lateral jsonb_array_elements(t.skill_versions) sv
  where ev.tenant_id = 'publiexpe'
    and sv->>'name' = 'prospector-event-exhibitors'
    and (ev.details->'actor'->>'human')::boolean
  group by 1, 2
  order by 1, 2;
  ```

- **Campos editados.** `evaluations.details.edited_fields` dice qué cambió el comercial. Si v2 (o v3) cumple su propósito, deberían bajar las ediciones de `quantityMin`, `quantityMax`, `budgetMinEur` y `budgetMaxEur`.
- **Criterio de decisión.** Al menos 30 hipótesis revisadas por versión (la muestra de AC-21) y una tasa de `ACCEPTED + EDITED` no inferior a la de v1 en la misma ventana. Hoy v1 tiene 5 de 5 aceptadas: es una base demasiado pequeña para comparar, así que la primera ventana sirve sobre todo para vigilar regresiones.

## 9. Rollback

Una versión activa se revierte en un paso y sin desplegar código:

```sh
# Vuelve a la versión activa anterior (la v1): la candidata pasa a DEPRECATED.
curl -s -X POST "http://127.0.0.1:4020/skills/prospector-event-exhibitors/versions/<v>/deprecate" -H 'x-tenant-id: publiexpe'
# Alternativa equivalente: activar explícitamente la v1.
curl -s -X POST "http://127.0.0.1:4020/skills/prospector-event-exhibitors/versions/1/activate" -H 'x-tenant-id: publiexpe'
```

Las ejecuciones en curso no cambian; la siguiente ejecución resuelve la versión activa al arrancar. Comprueba en `traces.skill_versions` de la siguiente ejecución que aparece `"version": 1`.

## 10. Erratas y límites

- **Errata en el `change_reason` de v2.** El texto guardado en la base de datos dice «solo 2/57 "need" con cantidades». Las dos coincidencias eran el año del evento («Gastrónoma 2026»); la cifra correcta es 0/57 (y 0/56, 0/20). El contenido de una versión es inmutable, así que la corrección queda aquí. La métrica de `skill:compare` ya no cuenta los años como cantidades.
- **Métricas aproximadas.** «La razón marca la suposición» se mide con una lista de marcadores (parece, por el nombre, previsiblemente, se asume…). Es un indicador, no un juicio; la lectura lado a lado del informe completo es la que manda.
- **Un modelo, una fecha.** Todo se midió con `gemini-flash-latest` y `thinking_level: low` el 2026-10-07. Un cambio de modelo exige repetir la comparación.
- **Medida del tamaño de la edición.** En el desarrollo de `skill:candidate`, la primera métrica sumaba lo borrado y lo añadido (39,4 % con estas operaciones) y bloqueaba la candidata. Se separó en «texto base borrado o sustituido» (8,8 %, máximo 35 %) y «texto añadido» (30,6 %, máximo 50 %), que distingue una reescritura de una ampliación acotada. Se cambió la definición, no las operaciones.
