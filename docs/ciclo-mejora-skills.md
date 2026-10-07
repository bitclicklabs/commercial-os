# Ciclo de mejora de skills

Este procedimiento explica cómo mejorar una skill del Agent OS con datos reales y sin poner en riesgo producción: del análisis de trazas a una versión candidata, su comparación offline, la decisión humana, la activación, la medición y el rollback. Es la versión manual del ciclo del LLD v0.1 §6.3 (el optimizador automático llega en MVP-3) y respeta P5: nunca se evalúa sobre los datos que generaron el cambio.

El ejemplo completo de una vuelta es [EXP-001 · Prospector v2](experimentos/EXP-001-prospector-v2.md).

```
SKILL ACTIVA → TRAZAS REALES → PATRONES → OPERACIONES ACOTADAS → CANDIDATA (DRAFT)
            → COMPARACIÓN OFFLINE (datos no usados) → DECISIÓN HUMANA → ACTIVAR | ITERAR | DESCARTAR
            → MEDIR ACEPTACIÓN POR VERSIÓN → (ROLLBACK si empeora)
```

> **Importante:** ningún agente activa una versión. La activación es siempre una decisión humana (LLD §19, regla de oro). Un agente puede analizar, proponer, crear la versión `DRAFT` y compararla.

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

## 4. Compara offline sin contaminar

`pnpm skill:compare` ejecuta la misma entrada con las dos versiones, con el proveedor real y un CRM en memoria (FakeTwenty), y saca la comparación:

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

Escribe el resultado en `docs/experimentos/EXP-NNN-<skill>.md` con estas secciones: hipótesis de mejora, datos de diseño, patrones, operaciones, datos de validación y por qué no contaminan, resultados lado a lado, recomendación, medición en producción y rollback. Contrasta cada criterio de la hipótesis con el resultado.

| Decisión | Cuándo |
|---|---|
| **Activar** | Cumple la hipótesis, no hay regresiones en el control (casos que ya funcionaban) ni incoherencias nuevas, y el sobrecoste es aceptable |
| **Iterar** | Mejora lo propuesto pero rompe algo, o el efecto no se distingue del ruido. Crea otra versión desde la base con la operación que falte y valídala con datos nuevos |
| **Descartar** | No mejora o empeora. Depreca la versión: `POST /skills/<skill>/versions/<v>/deprecate` |

Ninguna mejora compensa una regresión sobre lo que ya funcionaba (LLD §11.6, *seesaw constraint*).

## 6. Activa

Solo con la decisión humana escrita en el experimento:

```sh
curl -s -X POST "http://127.0.0.1:4020/skills/<skill>/versions/<v>/activate" -H 'x-tenant-id: publiexpe'
```

La versión activa anterior pasa a `DEPRECATED` en la misma transacción. Las ejecuciones en curso no cambian; la siguiente resuelve la nueva versión al arrancar. Anota la fecha y hora de activación en el experimento.

## 7. Mide la aceptación por versión

- `GET /metrics/agents` agrupa por versión de **agente**. Activar una versión de skill no crea una versión de agente, así que esa vista mezcla las dos versiones de la skill. Úsala para volumen y coste y separa por la hora de activación.
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

Si no hay una versión anterior que restaurar, la API responde `409`; en ese caso activa explícitamente la versión que quieras. Comprueba en `traces.skill_versions` de la siguiente ejecución qué versión se inyectó. No se borra nada: las versiones descartadas quedan en `DEPRECATED` con su historial.

## Lista de comprobación

- [ ] Reparto *train* / *validation* fijado por escrito antes del análisis.
- [ ] Cada patrón con dos o más ejemplos citables (ejecución, paso, campo).
- [ ] Operaciones acotadas, cada una con su `why`; diff revisado sin `--post`.
- [ ] Versión creada como `DRAFT` por la API, sin activar.
- [ ] Comparación con datos no usados en el diseño, con repetición y presupuesto.
- [ ] Experimento escrito con recomendación razonada.
- [ ] Decisión humana registrada antes de activar.
- [ ] Medición por versión de skill y plan de rollback.
