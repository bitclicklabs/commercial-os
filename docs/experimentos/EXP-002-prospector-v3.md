# EXP-002 · Prospector v3: la confianza mide el encaje comercial

Segunda vuelta del ciclo de mejora de skills y continuación de [EXP-001](EXP-001-prospector-v2.md), que terminó en **iterar**: la v2 corregía F1-F3 pero invertía la semántica de la confianza en los descartes. Este documento recoge la v3, su validación offline con datos nuevos y la recomendación. El procedimiento general está en [Ciclo de mejora de skills](../ciclo-mejora-skills.md).

| Campo | Valor |
|---|---|
| Fecha | 2026-10-07 |
| Skill | `prospector-event-exhibitors` |
| Base | v1 `ACTIVE` · `c204154d-3cc0-4d99-80be-5891bd1359e2` |
| Candidata | v3 `DRAFT` · `317ee89f-0bff-4525-83b5-ae49dbe03119` · `content_hash` `f8078d67b891…` |
| Operaciones | 6 sobre v1 (2 `ADD`, 4 `REPLACE`): las 5 de v2 sin cambios + OP6. 9,7 % del texto base sustituido, 37,2 % añadido |
| Validación | `pnpm skill:compare` v1 vs v3, Gemini `gemini-flash-latest`, FakeTwenty, 13 expositores × 2 repeticiones × 2 versiones |
| Coste de la validación | 0,1067 € (presupuesto: 0,15 €) |
| Estado | v3 **no activada**; v2 sigue en `DRAFT` (no se ha tocado) |
| Recomendación | **Activar v3** (decisión del PM; ningún agente activa) |

Archivos del experimento:

- [`EXP-002-prospector-v3.ops.json`](EXP-002-prospector-v3.ops.json): las 6 operaciones y su justificación (lo que se envió a la API).
- [`EXP-002/compare-v1-v3.md`](EXP-002/compare-v1-v3.md): informe completo de la comparación, lado a lado.
- [`EXP-002/compare-v1-v3.json`](EXP-002/compare-v1-v3.json): todas las decisiones de las 12 ejecuciones (para recalcular métricas con `--rerender`).
- Fixtures nuevos: [`gastronoma-holdout-2.json`](../../runtime/agent-runtime/test/fixtures/gastronoma-holdout-2.json) y [`organismos-publicos-sinteticos.json`](../../runtime/agent-runtime/test/fixtures/organismos-publicos-sinteticos.json).

## Resumen

v3 conserva las tres mejoras de v2 sobre expositores que nadie había mirado: el 100 % de las necesidades llevan desglose de unidades (v1: 0 %), ninguna horquilla de cantidad supera 2,5× (v1: todas), la confianza de los casos «solo nombre» baja de 0,67 a 0,55 de media (máximo 0,58) y 9 de 10 razones «solo nombre» marcan la suposición (v1: 0 de 10).

Y la regresión de v2 desaparece: los 6 descartes de v3 (4 sobre organismos públicos sintéticos nuevos y 2 sobre el fixture) llevan confianza 0,05, igual que v1. Ningún expositor cambia de relevante o escribible entre versiones ni entre repeticiones, y el sobrecoste es del 10,9 % por decisión.

## 1. Datos de diseño

v3 no añade datos de diseño para OP1-OP5: son las operaciones de v2, copiadas sin cambios y diseñadas en EXP-001 con los expositores 1-60 de Gastrónoma (ejecuciones `e67cba89`, `44e35e27` y `7eaa0dd4`; consulta EXP-001 §1).

OP6 sí sale de datos nuevos para el diseño: la validación de EXP-001. Con eso, esos datos quedan **quemados** como validación (P5):

| Dato | Qué mostró | Estado tras EXP-002 |
|---|---|---|
| `gastronoma-holdout.json` (posiciones 62, 66, 70, 74, 78, 82, 86 y 90) | XUNTA DE GALICIA, `relevant = false` con 0,05 / **0,95** en v2 | Diseño de OP6 |
| `feria-ejemplo.json` | Instituto Regional de Promoción Agroalimentaria, `relevant = false` con **0,95** / 0,05 en v2 | Diseño de OP6; sigue sirviendo como control de regresión de los casos con datos ricos, no como prueba de OP6 |

## 2. Patrón que corrige OP6

**F4 · La confianza de los descartes mide la seguridad del veredicto.** En v2, 2 de 4 decisiones sobre organismos públicos salen con `relevant = false` y confianza 0,95 (una en cada fixture), mientras que v1 da 0,05 en las cuatro. La escala de la skill ya dice «0-0,19: no hay encaje», pero el «techo de confianza» que añadió OP1 lleva al modelo a leer `confidence` como «cuán seguro estoy» y no como «cuánto encaja comercialmente». Con un descarte claro (un organismo público que compra por licitación) eso da una cifra alta.

Las dos razones de v2 con 0,95 justifican el descarte con la misma claridad que las de 0,05: no es una duda del modelo, es una lectura distinta de la escala.

## 3. Hipótesis de mejora

Fijada antes de ejecutar la comparación. Si la skill (a) mantiene OP1-OP5 y (b) define en el título de la calibración que la confianza mide el encaje comercial y acota los descartes a 0-0,19, entonces, sobre expositores no vistos y frente a la v1 `ACTIVE`:

1. **F1:** `need` lleva cantidades en más hipótesis que v1 y baja el número de hipótesis con máx./mín. > 2,5.
2. **F2:** la confianza media de los relevantes «solo nombre» baja y no supera 0,6 salvo notoriedad declarada.
3. **F3:** sube la proporción de razones «solo nombre» que marcan la suposición.
4. **Regresión de v2 (métrica nueva):** la confianza de los descartes (`relevant = false`) queda por debajo de 0,2 en v1 **y** en v3; «no relevantes con confianza > 0,19» = 0 en las dos. Si v3 mantiene la regresión, veredicto NO.
5. **Sin regresiones nuevas:** mismos relevantes y escribibles que v1, el control con datos ricos no empeora y el sobrecoste por decisión es ≤ 15 %.

## 4. Operaciones aplicadas

Seis operaciones acotadas sobre el texto de v1. El resto del texto, incluida la regla de contenido no confiable, queda byte a byte.

| # | Tipo | Dónde | Cambio | Patrón |
|---|---|---|---|---|
| OP1 | `ADD` | tras «0-0,19: no hay encaje.» | Techo: solo nombre ≤ 0,6; nombre y sector ≤ 0,75; superarlo solo por notoriedad, dicho en `reason` | F2 (de v2) |
| OP2 | `REPLACE` | viñeta `need` | `need` incluye unidades aproximadas por producto, con un ejemplo de desglose | F1 (de v2) |
| OP3 | `REPLACE` | viñeta `quantity_min / quantity_max` | Cantidades a partir del desglose; stand pequeño o mediano si no se conoce el tamaño; máx. ≤ 2,5 × mín. | F1 (de v2) |
| OP4 | `REPLACE` | viñeta `budget_min_eur / budget_max_eur` | Presupuesto = unidades × precio unitario orientativo | F1 (de v2) |
| OP5 | `ADD` | tras «No inventes hechos…» | Lo deducido del nombre se escribe como suposición | F3 (de v2) |
| **OP6** | `REPLACE` | título `## Calibración de "confidence" (0 a 1)` | El título añade «mide el encaje comercial del expositor con PubliEXPE, no tu seguridad en la decisión» y una primera viñeta: «Si relevant es false, la confianza está siempre entre 0 y 0,19, por muy seguro que estés del descarte: un organismo público claro lleva 0,05, nunca 0,95» | F4 |

### Base de la candidata

v3 se creó con `base_version: 1` y las seis operaciones, no con `base_version: 2` y solo OP6. El texto es el mismo (se comprobó antes de crearla: v1 + OP1-OP5 = v2 byte a byte, y v1 + OP1-OP6 = v2 + OP6), pero así `metadata.operations` de v3 describe el cambio completo frente a la versión con la que compite, y el tamaño de la edición se mide contra ella.

### ¿Necesita OP6 un ejemplo en `examples`?

No. El contraejemplo va en línea, dentro de la propia OP6 («0,05, nunca 0,95»), por cuatro motivos:

- El campo `examples` se renderiza al final del prompt (`## Ejemplos`, después de la sección de seguridad), lejos de la calibración que tiene que corregir.
- Un ejemplo JSON completo de un descarte cuesta más tokens que una frase, y uno de un relevante podría anclar cantidades y presupuestos: justo el patrón F1 que corrigen OP2-OP4.
- Cambiar lo mínimo que corrige el patrón (regla del ciclo): una frase basta para atribuir el efecto a OP6.
- `pnpm skill:candidate` solo edita `instructions`; usar `examples` exigiría ampliar la herramienta sin una necesidad demostrada.

Si una iteración futura mostrara que la frase no basta, el siguiente paso sería un ejemplo de descarte (sin hipótesis) en `examples`, validado con datos nuevos.

La versión se creó así (simulación primero, sin `--post`, para revisar el diff):

```sh
cd runtime/agent-runtime
pnpm skill:candidate prospector-event-exhibitors --ops ../../docs/experimentos/EXP-002-prospector-v3.ops.json
pnpm skill:candidate prospector-event-exhibitors --ops ../../docs/experimentos/EXP-002-prospector-v3.ops.json --post --created-by "skill-cycle EXP-002 (agente, gate humano)"
```

## 5. Datos de validación y por qué no contaminan (P5)

El reparto se fijó por escrito y se guardó en un commit (`ad162d0`) **antes** de crear la v3 y de ejecutar la comparación.

| Fixture | Qué contiene | Por qué no contamina |
|---|---|---|
| `test/fixtures/gastronoma-holdout-2.json` | 8 expositores reales de Gastrónoma: MYBAOS SL, PREZO, QBO DELICIAS SL, SERHS PROJECTS, TEMPLO CAFÉS, UNOX, VINO CAÑAS Y BARRO - VIÑAS DEL PORTILLO, ZERO,O MIXERS | Posiciones 63, 67, 71, 75, 79, 83, 87 y 91: uno de cada cuatro desde el 63, la regla que EXP-001 §7 dejó escrita antes de este experimento. No están en el tramo de diseño (1-60) ni en el holdout quemado (62, 66… 90). Nadie ha mirado decisiones del modelo sobre ellos |
| `test/fixtures/organismos-publicos-sinteticos.json` | 2 organismos públicos sintéticos nuevos (dominios `.example`, provincia ficticia): DIPUTACIÓN PROVINCIAL DE MONTEALTO (nombre y sector «Organismos públicos», la misma forma de entrada que XUNTA DE GALICIA) y Mercamontealto, Unidad Alimentaria de Montealto S.A. (empresa pública con nombre comercial, datos ricos y licitación explícita: un descarte del que el modelo está muy seguro) | Escritos para EXP-002, nunca ejecutados antes. Atacan la regresión directamente: son los casos donde un modelo que lee «seguridad del veredicto» daría 0,95 |
| `test/fixtures/feria-ejemplo.json` | 3 expositores sintéticos con datos ricos | **No** es dato limpio para OP6: su organismo público informó OP6. Se usa solo como control de regresión de los casos que ya funcionaban (expositor claro, competidor parcial) |

Los datos de Gastrónoma salen del JSON del catálogo (`POST /api/puisearch`, capturado con el renderer, 91 registros) con la misma función que usa el scout en producción (`findExhibitorListInJson`): nombre y, si existe, sector. El orden coincide con el de la traza `7eaa0dd4` (comprobado con los nombres de entrada de sus pasos `MODEL`, sin leer sus decisiones). Cinco de los ocho llegan solo con el nombre.

> **Nota:** el holdout fresco de Gastrónoma no contiene ningún organismo público (la regla mecánica no cayó en ninguno). La prueba limpia de la regresión son los 2 sintéticos × 2 repeticiones; el fixture la refuerza, pero no cuenta como prueba independiente.

Las dos versiones vieron exactamente la misma entrada (hash en el informe), la misma fecha (`--today 2026-10-07`) y el mismo modelo y configuración del agente (`desiredProspectorVersion()`: `gemini-flash-latest`, `thinking_level: low`, umbral 0,5). El orden alterna entre repeticiones (v1, v3 / v3, v1). CRM: un FakeTwenty en memoria nuevo por ejecución (8 escrituras en memoria, 0 en Twenty).

## 6. Resultados

Comando:

```sh
pnpm skill:compare prospector-event-exhibitors --versions 1,3 \
  --fixture test/fixtures/organismos-publicos-sinteticos.json \
  --fixture test/fixtures/gastronoma-holdout-2.json \
  --fixture test/fixtures/feria-ejemplo.json \
  --repeat 2 --max-cost-eur 0.15 --today 2026-10-07 --out ../../docs/experimentos/EXP-002/compare-v1-v3
```

### Confianza de los descartes (métrica nueva)

Todas las decisiones con `relevant = false` de los tres fixtures. `skill:compare` aún no la calcula; sale del JSON del informe:

```sh
node -e "const j=require('./docs/experimentos/EXP-002/compare-v1-v3.json');for(const v of [1,3]){const c=j.reports.flatMap(r=>r.report.runs).filter(r=>r.version===v).flatMap(r=>r.decisions).filter(d=>d.relevant===false).map(d=>d.confidence);console.log('v'+v,c.length,Math.max(...c))}"
```

| Métrica | v1 | v3 | v2 en EXP-001 (referencia) |
|---|---|---|---|
| Descartes (`relevant = false`) | 6 | 6 | 4 |
| Confianza media / máx. de los descartes | 0,05 / 0,05 | 0,05 / 0,05 | 0,50 / 0,95 |
| No relevantes con confianza > 0,19 | 0 | **0** | 2 |

| Expositor | Datos | v1 | v3 |
|---|---|---|---|
| DIPUTACIÓN PROVINCIAL DE MONTEALTO | sector (público) | 0,05 / 0,05 | 0,05 / 0,05 |
| Mercamontealto, Unidad Alimentaria de Montealto S.A. | datos ricos (empresa pública) | 0,05 / 0,05 | 0,05 / 0,05 |
| Instituto Regional de Promoción Agroalimentaria | datos ricos (fixture) | 0,05 / 0,05 | 0,05 / 0,05 |

Las razones de v3 descartan por el motivo correcto («empresa de capital íntegramente público que gestiona sus compras mediante licitación pública sujeta a la LCSP»), con la misma claridad que v1.

### Holdout fresco de Gastrónoma (8 expositores × 2 repeticiones)

| Métrica | v1 | v3 |
|---|---|---|
| Relevantes / escribibles (≥ 0,5) | 16 / 16 | 16 / 16 |
| Relevantes solo nombre: confianza media / máx. (n = 10) | 0,67 / 0,75 | **0,55 / 0,58** |
| Relevantes nombre + sector: confianza media / máx. (n = 6) | 0,82 / 0,85 | 0,79 / 0,85 |
| No relevantes con confianza > 0,19 | 0 | 0 |
| `need` con cantidades | 0/16 | **16/16** |
| Hipótesis con máx./mín. > 2,5 | 16/16 | **0/16** |
| Amplitud media de cantidad | 3,70 | 1,76 |
| Horquillas distintas / hipótesis (más repetida) | 0,88 (250-1.000 u / 600-2.200 €, ×3) | 1,00 (×1) |
| Solo nombre: la razón marca la suposición | 0/10 | **9/10** |
| Precio unitario implícito en 0,50-15 € | 16/16 | 16/16 |
| Tokens de entrada / salida | 26.002 / 5.393 | 30.974 / 5.434 |
| Coste (por decisión) | 0,0342 € (0,0021 €) | 0,0375 € (0,0023 €) |
| Estabilidad: desviación media de la confianza | 0,006 | 0,005 |

Lado a lado (confianza de las dos repeticiones; cantidad y presupuesto de la última):

| Expositor | Datos | v1 | v3 |
|---|---|---|---|
| MYBAOS SL | solo nombre | 0,65 / 0,65 · 150-600 u · 500-2.200 € | 0,55 / 0,55 · 260-500 u · 580-1.250 € |
| PREZO | solo nombre | 0,70 / 0,65 · 300-800 u · 600-1.800 € | 0,55 / 0,55 · 260-500 u · 650-1.400 € |
| QBO DELICIAS SL | solo nombre | 0,65 / 0,65 · 250-800 u · 600-1.800 € | 0,55 / 0,55 · 350-600 u · 650-1.400 € |
| SERHS PROJECTS | solo nombre | 0,75 / 0,70 · 250-800 u · 850-2.600 € | 0,55 / 0,58 · 465-750 u · 1.100-2.200 € |
| TEMPLO CAFÉS | sector | 0,85 / 0,85 · 300-1.200 u · 1.200-4.500 € | 0,80 / 0,85 · 700-1.020 u · 2.100-3.800 € |
| UNOX | sector | 0,85 / 0,85 · 300-1.000 u · 900-3.500 € | 0,85 / 0,85 · 720-1.200 u · 1.800-3.200 € |
| VINO CAÑAS Y BARRO - VIÑAS DEL PORTILLO | sector | 0,75 / 0,75 · 250-1.000 u · 600-2.500 € | 0,70 / 0,70 · 410-650 u · 850-1.600 € |
| ZERO,O MIXERS | solo nombre | 0,65 / 0,65 · 250-800 u · 600-2.200 € | 0,55 / 0,55 · 465-900 u · 850-1.800 € |

Lectura cualitativa:

- **El desglose explica la cifra.** En las 20 hipótesis de v3 (holdout y fixture), la suma de unidades de `need` cae dentro de la horquilla de cantidad; en 16 de 20 coincide con `quantity_min`. SERHS PROJECTS: «unas 250 libretas… 200… lanyards… 15 polos» = 465 = `quantity_min`. Un detalle a vigilar: esa misma hipótesis habla de «200 metros de lanyards», una unidad rara para un comercial.
- **Las suposiciones se marcan.** SERHS PROJECTS pasa de un hecho en v1 («es una división especializada… del Grupo SERHS») a una suposición en v3 («Por el nombre y el evento Gastrónoma, suponemos que es la división… de Grup SERHS»). El único caso «solo nombre» sin marcador es PREZO en una repetición, que lo atribuye a «conocimiento general del sector horeca»: lo declara, pero como dato y no como suposición.
- **El techo con sector se supera por notoriedad.** TEMPLO CAFÉS (0,80 / 0,85) y UNOX (0,85 / 0,85) superan el techo de 0,75. UNOX lo justifica en las dos repeticiones («por conocimiento general»), y TEMPLO CAFÉS en una de las dos. v1 les daba lo mismo o más (0,85), así que no es una regresión, pero OP1 se cumple solo en parte en ese caso.
- **Ningún cambio de qué entra en el CRM.** Con el umbral de 0,5, las dos versiones escriben los mismos 16 de 16 casos. Los «solo nombre» bajan a 0,55 y siguen por encima del umbral: v3 ordena mejor, pero no filtra más.

### Fixture `feria-ejemplo` (control de regresión, 3 expositores × 2 repeticiones)

| Métrica | v1 | v3 |
|---|---|---|
| Relevantes / escribibles | 4 / 2 | 4 / 2 |
| Conservas Marineras (datos ricos) | 0,88 / 0,90 | 0,88 / 0,88 |
| Envases Garrido (competidor parcial) | 0,45 / 0,45 | 0,45 / 0,45 |
| Instituto Regional (organismo público, no relevante) | 0,05 / 0,05 | 0,05 / 0,05 |
| `need` con cantidades / máx./mín. > 2,5 | 0/4 · 4/4 | 4/4 · 0/4 |
| Coste (por decisión) | 0,0111 € (0,0019 €) | 0,0125 € (0,0021 €) |

Sin regresión en los casos con datos ricos: el expositor claro sigue claro, el competidor parcial sigue por debajo del umbral y el organismo público sigue descartado con 0,05.

### Totales

| | v1 | v3 |
|---|---|---|
| Decisiones (errores) | 26 (0) | 26 (0) |
| Coste | 0,0506 € | 0,0561 € |
| Coste por decisión | 0,00195 € | 0,00216 € (+10,9 %) |
| Expositores que cambian relevante / escribible entre repeticiones | 0 / 0 | 0 / 0 |

Coste total de la comparación: **0,1067 €** de 0,15 €.

### Frente a la hipótesis de mejora

| Criterio | Resultado |
|---|---|
| 1. F1: cantidades en `need` y amplitud ≤ 2,5 | Cumplido: 0/20 → 20/20 con cantidades; 20/20 → 0/20 con amplitud > 2,5 (holdout y fixture) |
| 2. F2: confianza «solo nombre» baja y ≤ 0,6 | Cumplido: 0,67 → 0,55 de media; máximo 0,75 → 0,58 |
| 3. F3: suposiciones marcadas | Cumplido: 0/10 → 9/10 |
| 4. Regresión de v2: descartes < 0,2 en v1 y v3 | Cumplido: 6/6 descartes con 0,05 en las dos versiones; 0 incoherencias |
| 5a. Sin cambios de relevancia | Cumplido: mismos relevantes y escribibles (16/16 y 2 de 4 en el fixture) |
| 5b. Sin regresión con datos ricos | Cumplido: Conservas 0,88, Envases 0,45, Instituto 0,05 |
| 5c. Sobrecoste ≤ 15 % por decisión | Cumplido: +10,9 % (+19 % de tokens de entrada por el prompt más largo, +1,4 % de salida) |

## 7. Recomendación: activar v3

v3 cumple todos los criterios fijados antes de ejecutar: mejora F1, F2 y F3 frente a la v1 `ACTIVE`, la regresión de v2 no aparece y no hay regresiones nuevas en relevancia, en el control con datos ricos ni en estabilidad. El sobrecoste (~0,0002 € por expositor; ~0,02 € por una feria de 91) es aceptable.

Límites de la evidencia, para que la decisión los tenga presentes:

- **Muestra pequeña para la regresión.** v2 fallaba en 2 de 4 descartes (50 %). Si v3 conservara esa tasa, la probabilidad de ver 0 fallos en los 4 descartes limpios (los sintéticos) sería del 6 %, y del 1,6 % en los 6 contando el fixture. Es evidencia razonable, no una garantía: por eso la medición en producción vigila esta métrica en la primera ejecución real.
- **No filtra más.** Los «solo nombre» quedan en 0,55, por encima del umbral de 0,5: v3 no cambia qué entra en el CRM, solo cómo se explica y se ordena.
- **Un modelo, una fecha.** Todo con `gemini-flash-latest`, `thinking_level: low`, el 2026-10-07.

Siguiente paso propuesto (decisión humana del PM):

1. Activa la v3: `POST /skills/prospector-event-exhibitors/versions/3/activate`. La v1 pasa a `DEPRECATED` en la misma transacción. Anota aquí la fecha y hora.
2. La v2 puede quedarse en `DRAFT` como referencia o deprecarse; no compite.
3. Si el PM no activa, la v3 queda en `DRAFT` sin efecto: la v1 sigue en producción.

## 8. Cómo se mediría en producción

- **Vigilancia de la regresión.** En la primera ejecución real con v3 (por ejemplo, Gastrónoma completa, cuyo catálogo incluye al menos cuatro entidades públicas: DENOMINACIÓN DE ORIGEN UTIEL-REQUENA, IGP CASTELLÓ, GRADO CIENCIAS GASTRONÓMICAS - UNIVERSIDAD DE VALENCIA y XUNTA DE GALICIA), cuenta los descartes con confianza > 0,19 (solo lectura):

  ```sql
  select ts.input->>'exhibitor' as exhibitor, ts.output->'decision'->>'confidence' as confidence
  from traces t join trace_steps ts on ts.trace_id = t.id
  where t.execution_id = '<ejecución>' and ts.type = 'MODEL' and ts.input ? 'exhibitor'
    and (ts.output->'decision'->>'relevant')::boolean = false
    and (ts.output->'decision'->>'confidence')::numeric > 0.19;
  ```

  Si devuelve filas, la regresión ha vuelto: haz rollback (§9) y abre una iteración con un ejemplo de descarte en `examples`.

- **Aceptación por versión de skill.** La misma consulta de EXP-001 §8 sobre `evaluations` y `traces.skill_versions`, con al menos 30 hipótesis revisadas por versión, en la misma ventana de tiempo. `GET /metrics/agents` agrupa por versión de agente y mezcla v1 y v3 de la skill: úsalo solo para volumen y coste.
- **Campos editados.** Si v3 cumple su propósito, bajan las ediciones de `quantityMin`, `quantityMax`, `budgetMinEur` y `budgetMaxEur` en `evaluations.details.edited_fields`.

## 9. Rollback

```sh
# Vuelve a la versión activa anterior (la v1): la v3 pasa a DEPRECATED.
curl -s -X POST "http://127.0.0.1:4020/skills/prospector-event-exhibitors/versions/3/deprecate" -H 'x-tenant-id: publiexpe'
# Alternativa equivalente: activar explícitamente la v1.
curl -s -X POST "http://127.0.0.1:4020/skills/prospector-event-exhibitors/versions/1/activate" -H 'x-tenant-id: publiexpe'
```

Comprueba en `traces.skill_versions` de la siguiente ejecución que aparece `"version": 1`. No se borra nada.

## 10. Erratas y límites

- **Métrica de descartes fuera de la herramienta.** «Confianza de los descartes» se calcula con el comando de §6 sobre el JSON del informe; `skill:compare` solo cuenta los descartes > 0,19. Añadirla al informe es una mejora de la herramienta pendiente, no necesaria para esta decisión.
- **Métricas aproximadas.** «La razón marca la suposición» se mide con una lista de marcadores; la lectura lado a lado del informe completo es la que manda.
- **Holdout de Gastrónoma sin organismos públicos.** La regla mecánica no cayó en ninguno; la prueba de la regresión descansa en los dos sintéticos (y, como refuerzo no independiente, en el fixture).
- **Datos quemados para la siguiente vuelta.** `gastronoma-holdout-2.json` y `organismos-publicos-sinteticos.json` quedan gastados como validación en cuanto se use este resultado para decidir. Una v4 necesitaría otra feria o el resto de posiciones libres de Gastrónoma (61, 64, 65, 68, 69, 72, 73, 76, 77, 80, 81, 84, 85, 88 y 89).
