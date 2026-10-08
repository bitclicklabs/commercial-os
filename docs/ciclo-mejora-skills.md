# Ciclo de mejora de skills

> **Nota:** desde la tanda 11 existe un **modo automático**, el [Skill Optimizer](skill-optimizer.md) (`pnpm optimize:run --skill <nombre>`), que recorre por ti la cosecha de fallos, su agrupación, la candidata, el experimento y el gate, y deja una propuesta de promoción en Twenty. Este procedimiento manual **sigue siendo válido como alternativa**: úsalo cuando el optimizador termine en `BLOCKED_NO_DATA`, cuando quieras escribir las operaciones tú o cuando una candidata necesite iterar con criterio humano. Consulta [Modo automático](#modo-automático-skill-optimizer).

Este procedimiento explica cómo mejorar una skill del Agent OS con datos reales y sin poner en riesgo producción: del análisis de trazas a una versión candidata, su comparación offline, la decisión humana, la activación, la medición y el rollback. Es la versión manual del ciclo del LLD v0.1 §6.3 (la versión automática es el [Skill Optimizer](skill-optimizer.md), MVP-3) y respeta P5: nunca se evalúa sobre los datos que generaron el cambio.

El ejemplo completo de una vuelta es [EXP-001 · Prospector v2](experimentos/EXP-001-prospector-v2.md), que terminó en «iterar»; su iteración, con datos de validación nuevos, es [EXP-002 · Prospector v3](experimentos/EXP-002-prospector-v3.md). Desde EXP-003 la comparación, la evaluación y la decisión del gate las hace `pnpm experiment:run` ([EXP-003 · Prospector v4](experimentos/EXP-003-auto/informe.md), el primero automático).

```
SKILL ACTIVA → TRAZAS REALES → PATRONES → OPERACIONES ACOTADAS → CANDIDATA (DRAFT)
            → pnpm experiment:run (P5 + comparación + evaluación + RELEASE GATE)
            → DECISIÓN HUMANA → ACTIVAR (el gate la deja pasar) | ITERAR | DESCARTAR
            → MEDIR ACEPTACIÓN POR VERSIÓN → (ROLLBACK si empeora)
```

> **Nota:** desde el MVP-3, el [Skill Optimizer](../runtime/agent-runtime/README.md#skill-optimizer) hace solo los pasos 2 a 4 (`pnpm optimize:run --skill <skill>` o `POST /optimizer/skills/:name/run`): cosecha los fallos de la versión activa, los agrupa, escribe la candidata como operaciones acotadas, quema como `design` las entidades de esos fallos (P5) y ejecuta el experimento. Si los datos no bastan, termina en `BLOCKED_NO_DATA` sin gastar. Los pasos 5 a 8 (decidir, activar, medir y rollback) siguen siendo humanos; si el gate pasa, el optimizador deja una nota «Propuesta de promoción» en Twenty.

> **Importante:** ningún agente activa una versión. La activación es siempre una decisión humana (LLD §19, regla de oro), y desde el MVP-2 la API la hace cumplir: `POST /skills/:id/versions/:v/activate` exige un experimento `COMPLETED` con decisión `PASS` o `PASS_FORM` frente a la versión activa, o un override humano con motivo. Un agente puede analizar, proponer, crear la versión `DRAFT` y ejecutar el experimento.

## Antes de empezar

- Trabaja en `runtime/agent-runtime` con un `.env` local (está en `.gitignore`) que tenga `GEMINI_API_KEY` y, si lees la base de datos, `DATABASE_URL`. Copia las claves de `deployments/.env`; no las escribas en ningún fichero versionado.
- El runtime tiene que responder en `http://127.0.0.1:4020` (las herramientas leen y crean versiones por la API).
- En la base de datos compartida, haz **solo lecturas**. Una forma segura con el contenedor de desarrollo:

  ```sh
  docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on" pxos-postgres psql -U agentos -d agentos
  ```

- Ten a mano el texto de la versión activa:

  ```sh
  curl -s http://127.0.0.1:4020/skills/<skill> -H 'x-tenant-id: publiexpe'
  ```

## 1. Fija el reparto de datos antes de mirar

> **Nota:** con el dataset `prospeccion-v1` (consulta [Datasets de evaluación](../runtime/agent-runtime/README.md#datasets-de-evaluación)) el reparto ya está fijado: split determinista por entidad y registro P5 en `used_by`. `pnpm experiment:run` reserva el split `VALIDATION` con `markUsed` antes de ejecutar y aborta si hay contaminación. Esta sección sigue valiendo para elegir los datos de **diseño** (las trazas que analizas en el paso 2): anótalos en `design_data` del fichero de operaciones.

Decide **antes** de analizar qué datos sirven para diseñar el cambio (*train*) y cuáles para validarlo (*validation*). Si lo decides después, sin querer elegirás la validación que favorece a tu candidata.

- Usa una regla mecánica y escríbela: un tramo del catálogo para diseñar (en EXP-001, expositores 1-60) y otro para validar (61-91), y dentro del tramo de validación un muestreo sistemático (uno de cada cuatro desde el 62).
- Añade un control de regresión con casos que ya funcionan bien (en EXP-001, el fixture `feria-ejemplo.json`: un expositor claro, un competidor parcial y un organismo público).
- No mires las decisiones del modelo sobre el tramo de validación. Mirar sus entradas (nombre, sector) sí está permitido: es lo que verá la candidata.
- Un conjunto de validación se **gasta** en cuanto lo usas para decidir un cambio. Si la comparación revela un fallo y lo corriges, ese conjunto pasa a ser de diseño para la siguiente versión y necesitas otro para validarla.

## 2. Analiza trazas y evaluaciones

Busca patrones concretos y citables, con al menos dos ejemplos reales cada uno (ejecución, paso de la traza y campo).

1. Localiza las ejecuciones reales del agente (excluye `[TEST]`, `it-*` y el proveedor `stub`):

   ```sql
   select e.id, a.name, av.version, e.status, e.created_at, e.output->'counters'
   from agent_executions e
   join agents a on a.id = e.agent_id
   join agent_versions av on av.id = e.agent_version_id
   where av.model like 'gemini%' and a.name = 'Prospector'
   order by e.created_at;
   ```

   > **Nota:** una ejecución `FAILED` por `OrphanedRun` puede tener la traza completa. Mira `trace_steps` aunque `agent_executions` diga otra cosa.

2. Extrae las decisiones de los pasos `MODEL` (una por expositor en el Prospector):

   ```sql
   select ts.sequence, ts.input->>'exhibitor' as exhibitor, ts.output->'decision' as decision,
          ts.input_tokens, ts.output_tokens
   from traces t join trace_steps ts on ts.trace_id = t.id
   where t.execution_id = '<ejecución>' and ts.type = 'MODEL' and ts.input ? 'exhibitor'
   order by ts.sequence;
   ```

3. Cruza con el feedback humano (`evaluations`, solo `details.actor.human = true`): qué se aceptó, qué se editó (`details.edited_fields`) y qué se descartó.
4. Cuantifica antes de concluir. Para el Prospector, en EXP-001 resultaron útiles: horquillas de cantidad y presupuesto repetidas, amplitud máx./mín., `need` con cantidades, confianza según los datos que llegaban (solo nombre, sector, descripción), suposiciones escritas como hechos y estabilidad entre ejecuciones con la misma entrada.
5. Separa los patrones en dos listas: los que vas a corregir y los que observas pero **no** tocas (y por qué). Un patrón que la skill pide a propósito no es un fallo.

## 3. Escribe la candidata como operaciones acotadas

Una candidata es la versión base más una lista explícita de operaciones, cada una anclada en texto que aparece una sola vez:

| Operación | Qué hace |
|---|---|
| `ADD` | Inserta líneas después (o antes, con `"position": "before"`) de la línea que contiene `anchor` |
| `REMOVE` | Borra el fragmento exacto `find` |
| `REPLACE` | Sustituye el fragmento exacto `find` por `text` |
| `MOVE` | Mueve las líneas de `find` detrás de la línea que contiene `anchor` |
| `REORDER` | Reordena las secciones `## ` (`order` lista todos los títulos) |

Cada operación lleva un `why` con el patrón y los ejemplos que la justifican. Guarda el fichero junto al experimento (`docs/experimentos/EXP-NNN-<skill>.ops.json`; consulta el de EXP-001 como plantilla).

Reglas:

- Nunca reescribas la skill entera. La herramienta rechaza la candidata si borra o sustituye más del 35 % del texto base o añade más del 50 %.
- Cambia lo mínimo que corrige el patrón. Cinco operaciones ya son muchas para atribuir un efecto.
- Conserva la regla de contenido no confiable (`UNTRUSTED_SYSTEM_RULE`); la API avisa si falta.
- No edites la constante de código del agente: la skill vive en la base de datos.

Revisa el diff sin escribir nada y, cuando esté bien, crea la versión `DRAFT`:

```sh
cd runtime/agent-runtime
pnpm skill:candidate <skill> --ops ../../docs/experimentos/EXP-NNN-<skill>.ops.json
pnpm skill:candidate <skill> --ops ../../docs/experimentos/EXP-NNN-<skill>.ops.json --post --created-by "<quién>"
```

`--post` llama a `POST /skills/:id/versions` con `copy_from` = versión base y guarda en `metadata` las operaciones, su justificación, los datos de diseño y de validación y el tamaño de la edición. El `change_reason` (máximo 2.000 caracteres) resume patrones, operaciones y datos de validación. El contenido de una versión es inmutable: si te equivocas en una cifra, corrígelo en el documento del experimento.

## 4. Ejecuta el experimento: `pnpm experiment:run`

El paso manual de EXP-001 y EXP-002 (elegir fixtures, `skill:compare`, `pnpm evaluate`, calcular a mano la decisión) es ahora un solo comando:

```sh
pnpm experiment:run --subject skill:<skill> --candidate <v> --dry-run      # qué reservaría, sin escribir
pnpm experiment:run --subject skill:<skill> --candidate <v> --dataset prospeccion-v1 --budget 0.30 --today <AAAA-MM-DD>
```

1. Crea `EXP-NNN` (tabla `experiments`) con la versión `ACTIVE` como baseline.
1. Reserva el split `VALIDATION` con `markUsed` (P5). Si otro experimento ya lo usó, el `409` aborta el experimento. Si el split no tiene etiquetas, añade una muestra de forma de `TRAIN` sin quemar.
1. Ejecuta las dos versiones con `skill:compare` (Gemini, FakeTwenty, `--repeat 2` por defecto).
1. Evalúa con los evaluadores automáticos (RULEs, juez y composite) en el tenant `experiments`.
1. Aplica el Release Gate: composite ≥ baseline + 0,02, 0 fallos duros, seesaw (ninguna regla que la baseline resolvía cae), coste/decisión ≤ ×1,25 y, con etiquetas, accuracy ≥ baseline. Sin etiquetas la decisión máxima es `PASS_FORM` (modo forma). `TEST` solo se gasta tras un `PASS` estricto.
1. Escribe `docs/experimentos/EXP-NNN-auto/informe.md` (y `.json`, con los fixtures) y cierra el experimento, inmutable.

Los detalles y las opciones están en el [README del runtime](../runtime/agent-runtime/README.md#experiments-y-release-gate).

### Comparación suelta (exploración)

`pnpm skill:compare` sigue disponible para explorar sin dejar rastro en `experiments` (no reserva casos ni decide nada; su resultado no desbloquea la activación). `pnpm skill:compare` ejecuta la misma entrada con las dos versiones, con el proveedor real y un CRM en memoria (FakeTwenty), y saca la comparación:

```sh
pnpm skill:compare <skill> --versions <base>,<candidata> \
  --fixture test/fixtures/feria-ejemplo.json --fixture test/fixtures/<holdout>.json \
  --repeat 2 --max-cost-eur 0.15 --today <AAAA-MM-DD> --out ../../docs/experimentos/EXP-NNN/compare
```

- Lee las versiones por la API (solo lectura) y comprueba que el texto renderizado coincide con su `content_hash`.
- Cada ejecución usa un FakeTwenty nuevo: no se escribe nada en Twenty.
- `--repeat 2` repite cada versión y alterna el orden; así ves el ruido del modelo y no lo confundes con el efecto de la candidata.
- `--max-cost-eur` corta las llamadas al modelo al llegar al presupuesto; el informe lo marca como incompleto.
- `--today` fija la fecha que ve el agente (el `timing` depende de ella). Usa la de las trazas reales si quieres reproducir su contexto.
- `--rerender <informe.json>` recalcula métricas e informe sin llamar al modelo, por ejemplo después de corregir una métrica.

El informe incluye relevantes y escribibles, confianza por nivel de datos, incoherencias (no relevantes con confianza alta), forma de la hipótesis (horquillas, amplitud, cantidades en `need`, precio unitario implícito), estabilidad, tokens y coste por versión, y la tabla lado a lado por expositor con la razón y la necesidad.

> **Nota:** hoy solo hay *harness* para `prospector-event-exhibitors` (modo directo del Prospector). Para otra skill, añade en `src/skills/compare.ts` qué agente la ejecuta y cómo se leen sus decisiones.

## 5. Decide (humano)

El informe automático ya trae la decisión del gate, cada criterio con sus valores, los casos usados y las tablas lado a lado. Léelo entero (sobre todo las razones por expositor: las métricas no lo ven todo) y, si hace falta, complétalo en `docs/experimentos/EXP-NNN-<skill>.md` con estas secciones: hipótesis de mejora, datos de diseño, patrones, operaciones, datos de validación y por qué no contaminan, resultados lado a lado, recomendación, medición en producción y rollback. Contrasta cada criterio de la hipótesis con el resultado.

| Decisión | Cuándo |
|---|---|
| **Activar** | El gate da `PASS` (o `PASS_FORM`, sabiendo que falta re-validar con etiquetas), cumple la hipótesis y la lectura cualitativa no muestra problemas |
| **Iterar** | Mejora lo propuesto pero rompe algo, o el efecto no se distingue del ruido. Crea otra versión desde la base con la operación que falte y valídala con datos nuevos |
| **Descartar** | No mejora o empeora. Depreca la versión: `POST /skills/<skill>/versions/<v>/deprecate` |

Ninguna mejora compensa una regresión sobre lo que ya funcionaba (LLD §11.6, *seesaw constraint*).

## 6. Activa

Solo con la decisión humana escrita en el experimento:

```sh
curl -s -X POST "http://127.0.0.1:4020/skills/<skill>/versions/<v>/activate" -H 'x-tenant-id: publiexpe'
```

El Release Gate la deja pasar si el último experimento `COMPLETED` de esa versión contra la versión activa actual decidió `PASS` o `PASS_FORM` (la respuesta trae `gate`). Si no, responde `409 release_gate_blocked`. Si la persona responsable decide activar igualmente, lo fuerza con motivo, que queda en el log y en la respuesta:

```sh
curl -s -X POST "http://127.0.0.1:4020/skills/<skill>/versions/<v>/activate" -H 'x-tenant-id: publiexpe'   -H 'content-type: application/json' -d '{"force": true, "reason": "<por qué, mínimo 10 caracteres>", "by": "<quién>"}'
```

La versión activa anterior pasa a `DEPRECATED` en la misma transacción. Las ejecuciones en curso no cambian; la siguiente resuelve la nueva versión al arrancar. Anota la fecha y hora de activación en el experimento.

> **Nota:** si el gate dio `PASS_FORM` o prefieres no pasar de 0 a 100 %, puedes poner la candidata en **canario** (`POST /skills/<skill>/versions/<v>/canary`) y decidir tras comparar con la activa. Consulta [Canario](skill-optimizer.md#canario-despliegue-gradual-tras-el-gate).

### Revalida un PASS_FORM cuando lleguen etiquetas

Un `PASS_FORM` queda pendiente de revalidar. No hace falta repetir el experimento: el experimento guardó lo que decidió cada versión en cada caso, y la revalidación mide la accuracy de las dos sobre esas decisiones con los veredictos que el comercial dé después en Twenty. No llama a ningún modelo (coste 0).

1. Re-cosecha el dataset para que los veredictos nuevos entren como casos: `POST /datasets/<id>/build`.
1. Mira qué experimentos se pueden revalidar: `GET /experiments/pending-revalidation` (o `pnpm experiment:revalidate --pending`). Solo salen los `PASS_FORM` cuya versión sigue `ACTIVE` o en canario, con cuántas etiquetas hay y cuántas son frescas.
1. Revalida: `POST /experiments/EXP-NNN/revalidate` (o `pnpm experiment:revalidate --id EXP-NNN`).

El resultado es `CONFIRMED` (la candidata iguala o supera a la baseline en accuracy), `REFUTED` o `INSUFFICIENT` (faltan etiquetas; por defecto se piden 5). Nunca cuentan los casos de diseño de la candidata (P5). Si sale `REFUTED` y la versión sigue activa o en canario, aparece en Twenty la nota «⚠️ Revalidación fallida» con los números y las opciones (rollback, canario o iterar): nada se desactiva solo, decides tú. Detalles en el [README del runtime](../runtime/agent-runtime/README.md#revalidación-de-los-pass_form).

## 7. Mide la aceptación por versión

- `GET /metrics/agents` agrupa por versión de **agente**. Activar una versión de skill no crea una versión de agente, así que esa vista mezcla las dos versiones de la skill. Úsala para volumen y coste y separa por la hora de activación.
- Desde la tanda 11, `GET /metrics/agents` también desglosa por versión de **skill** y las métricas comerciales cuentan solo evaluaciones `kind='HUMAN'`, de modo que las evaluaciones automáticas de los experimentos no las contaminan. Si tu runtime es anterior, usa la consulta siguiente.
- La aceptación por versión de **skill** sale de cruzar `evaluations` con `traces.skill_versions` (solo lectura):

  ```sql
  select sv->>'version' as skill_version, ev.feedback, count(*) as n
  from evaluations ev
  join traces t on t.execution_id = ev.agent_execution_id
  cross join lateral jsonb_array_elements(t.skill_versions) sv
  where ev.tenant_id = 'publiexpe'
    and sv->>'name' = '<skill>'
    and (ev.details->'actor'->>'human')::boolean
  group by 1, 2
  order by 1, 2;
  ```

- Mira también `details.edited_fields`: qué campos corrige el comercial con cada versión.
- Espera al menos 30 hipótesis revisadas por versión antes de concluir, y compara en la misma ventana de tiempo.

## 8. Rollback

Si la versión activa empeora:

```sh
# La versión activa pasa a DEPRECATED y vuelve la activada antes que ella.
curl -s -X POST "http://127.0.0.1:4020/skills/<skill>/versions/<v>/deprecate" -H 'x-tenant-id: publiexpe'
```

El rollback no pasa por el Release Gate: deprecar la activa, o activar una versión que ya estuvo `ACTIVE`, no necesita experimento (`gate.mode: rollback`). Si no hay una versión anterior que restaurar, la API responde `409`; en ese caso activa explícitamente la versión que quieras. Comprueba en `traces.skill_versions` de la siguiente ejecución qué versión se inyectó. No se borra nada: las versiones descartadas quedan en `DEPRECATED` con su historial. Si la versión estaba en canario, el rollback del canario la retira sin tocar la activa (consulta [Skill Optimizer](skill-optimizer.md#canario-despliegue-gradual-tras-el-gate)).

## Modo automático: Skill Optimizer

`pnpm optimize:run --skill <nombre>` (o `POST /optimizer/skills/:name/run`) encadena los pasos 2 a 4 sin intervención y se detiene antes de la decisión. Es solo manual: nada lo programa. El detalle, los estados y la revisión de la propuesta están en [Skill Optimizer](skill-optimizer.md).

| Paso manual | Qué hace el optimizador |
|---|---|
| 1. Fija el reparto de datos | Respeta P5 por construcción: el dataset y `used_by` marcan lo quemado; sin casos etiquetados frescos termina en `BLOCKED_NO_DATA` |
| 2. Analiza trazas y evaluaciones | Fase `HARVESTING` (evaluaciones humanas negativas y fallos duros de las reglas) y `CLUSTERED` (agrupación con LLM) |
| 3. Escribe la candidata | Fase `CANDIDATE_CREATED`: el LLM propone operaciones `ADD`/`REMOVE`/`REPLACE`/`MOVE`/`REORDER` con los mismos topes del 35 % y el 50 %; crea la `DRAFT` con un changelog que cita los clusters |
| 4. Ejecuta el experimento | Fase `EXPERIMENT_RUNNING`: el mismo runner de `pnpm experiment:run` |
| 5. Decide | **Humana**, a partir de la nota «Propuesta de promoción» en Twenty (solo si el gate da `GATE_PASS`) |
| 6-8. Activa, mide, rollback | Iguales a los de este documento; el canario es opcional |

El optimizador no sustituye al criterio humano: la lectura cualitativa del paso 5 sigue siendo imprescindible (EXP-003 lo demostró).

## Lista de comprobación

- [ ] Reparto *train* / *validation* fijado por escrito antes del análisis.
- [ ] Cada patrón con dos o más ejemplos citables (ejecución, paso, campo).
- [ ] Operaciones acotadas, cada una con su `why`; diff revisado sin `--post`.
- [ ] Versión creada como `DRAFT` por la API, sin activar.
- [ ] `pnpm experiment:run` ejecutado (P5 reservado por el runner, repetición y presupuesto).
- [ ] Informe automático leído y, si hace falta, completado con la recomendación razonada.
- [ ] Decisión humana registrada antes de activar.
- [ ] Medición por versión de skill y plan de rollback.
