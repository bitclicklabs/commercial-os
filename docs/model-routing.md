# Model routing: roles en lugar de modelos

El runtime no decide "usa gemini-flash" en cada punto del código. Decide un **rol** (barato, razonador, juez, triaje) y una tabla de enrutado resuelve qué modelo lo cumple. Es la parte de *model routing* del [LLD v0.1, sección 18](LLD-0.1-publiexpe-commercial-os.md#18-optimización-automática) (simple a un modelo barato, investigación a uno razonador, evaluador a uno independiente) y llega a tiempo para el cambio de precio del 2027-01-01.

Este documento es para quien opera el runtime y para quien decide el gasto. Los nombres exactos de variables y opciones son los del [README del runtime](../runtime/agent-runtime/README.md); si alguno difiere, manda el README.

> **Importante:** por defecto **no cambia nada**. Sin ninguna variable `MODEL_ROUTE_*`, el ejecutor sigue siendo Gemini Flash y el juez, Gemini Pro, como hasta ahora. El routing es la palanca para cambiar de modelo cuando haga falta, no un cambio de comportamiento hoy.

## Roles

| Rol | Para qué se usa | Modelo por defecto |
|---|---|---|
| `executor_cheap` | Ejecutar agentes y skills de volumen: el Prospector, el EmailDrafter, la agrupación de fallos del optimizador | `gemini:gemini-flash-latest` |
| `executor_reasoner` | Tareas que piden razonar más (investigación, casos de riesgo alto). Hoy ninguna tarea lo pide | `gemini:gemini-flash-latest` |
| `judge` | El evaluador LLM_JUDGE de los experimentos | `gemini:gemini-pro-latest` |
| `triage` | Clasificación ligera de entradas: el triaje de respuestas del inbound | `gemini:gemini-flash-latest` |

> **Nota:** `gemini-flash-latest` es un alias. El 2026-10-06 lo servía `gemini-3.8-flash` y el coste se calcula por el modelo que responde de verdad, no por el alias. Con el routing eliges el alias o el modelo concreto: un alias se mueve cuando Google cambia el modelo, un modelo concreto no.

## Cambiar un modelo: `MODEL_ROUTE_<ROL>`

Un override se escribe como `proveedor:modelo` en una variable de entorno cuyo nombre es el rol en mayúsculas:

| Variable | Rol |
|---|---|
| `MODEL_ROUTE_EXECUTOR_CHEAP` | `executor_cheap` |
| `MODEL_ROUTE_EXECUTOR_REASONER` | `executor_reasoner` |
| `MODEL_ROUTE_JUDGE` | `judge` |
| `MODEL_ROUTE_TRIAGE` | `triage` |

```sh
# Ejemplo: el triaje con un modelo más barato, el resto igual
MODEL_ROUTE_TRIAGE=gemini:gemini-2.5-flash-lite
```

Reglas:

- El proveedor es uno de los que el runtime ya soporta (`gemini`, `anthropic` o `stub`). El modelo debe tener precio en la tabla de precios (`src/providers/gemini-pricing.ts` para Gemini); si no lo tiene, el coste no se puede calcular y el presupuesto de los experimentos no se puede hacer cumplir.
- Una variable vacía o ausente significa "el valor por defecto de la tabla".
- Un valor mal formado (sin `:` o con un proveedor desconocido) se rechaza al arrancar con un mensaje claro, en lugar de caer a otro modelo sin avisar.
- Dónde se fijan las variables: en el bloque `environment` de `pxos-runtime` ([Variables del runtime](runbook-local.md#variables-del-runtime)), o en `runtime/agent-runtime/.env` fuera de Docker.

> **Precaución:** cambiar el modelo ejecutor cambia el comportamiento de todas las skills, aunque ninguna versión de skill cambie. Antes de aplicar un override al ejecutor en producción, mide el efecto con un [experimento](ciclo-mejora-skills.md) (la misma skill contra el modelo nuevo) y no te fíes solo del precio.

## La regla juez distinto del ejecutor

**El juez nunca puede ser el mismo modelo que el ejecutor del experimento** ([LLD v0.1, sección 18](LLD-0.1-publiexpe-commercial-os.md#18-optimización-automática): "el evaluador no debe ser el mismo modelo que ejecuta"). Un modelo que puntúa su propia salida tiende a puntuarse bien, y entonces el composite deja de ser una medida independiente.

- La comprobación resuelve los alias antes de comparar: `gemini-flash-latest` y `gemini-3.8-flash` son el mismo modelo si el alias apunta a él.
- Si un override haría coincidir los dos roles (por ejemplo, `MODEL_ROUTE_JUDGE` igual que el ejecutor del experimento), el experimento **se rechaza** en lugar de ejecutarse con un juez que no es independiente.
- La regla es del experimento, no del runtime en general: el rol `judge` y `executor_cheap` pueden coincidir fuera de un experimento, pero en un experimento no.

## Costes: `pnpm models:costs`

Antes de decidir un cambio, mira cuánto cuesta cada rol hoy y cuánto costará:

```sh
cd runtime/agent-runtime
pnpm models:costs
```

Imprime una tabla con una fila por rol:

| Columna | Qué es |
|---|---|
| Rol | `executor_cheap`, `executor_reasoner`, `judge` o `triage` |
| Modelo | El modelo que resuelve la tabla (con los overrides aplicados) |
| Precio hoy | USD por millón de tokens, entrada y salida |
| Precio desde 2027-01-01 | El mismo precio con el periodo que empieza esa fecha |
| Proyección | Coste estimado de un mes con el **volumen real del último mes** (tokens de entrada y salida de las trazas), a precio de hoy y a precio de 2027 |

Forma ilustrativa de una fila (el resto de las columnas dependen de tus trazas):

| Rol | Modelo | Precio hoy (entrada / salida) | Desde 2027-01-01 (entrada / salida) |
|---|---|---|---|
| `executor_cheap` | `gemini-3.8-flash` | 0,75 / 3,75 | 1,50 / 7,50 |

Los precios salen de la tabla editable `src/providers/gemini-pricing.ts`: cuando Google cambie un precio, se añade un periodo nuevo con su fecha `from` sin tocar los anteriores, y `models:costs` lo recoge sin cambiar código. La proyección es una **estimación**: usa el volumen del último mes tal cual, sin prever crecimiento.

## El hito del 2027-01-01

El 2027-01-01 `gemini-3.8-flash` duplica su precio: la entrada pasa de 0,75 a 1,50 USD por millón de tokens y la salida de 3,75 a 7,50. Es el modelo que hoy sirve `gemini-flash-latest`, así que el ejecutor y el triaje lo notan directamente.

Antes de esa fecha:

1. Ejecuta `pnpm models:costs` y mira la proyección de cada rol.
1. Si el aumento es asumible (los costes de todo el proyecto han sido de céntimos), no hagas nada: el routing te deja cambiar luego sin tocar código.
1. Si quieres abaratar, elige un candidato de la tabla de precios y compáralo con un experimento antes de aplicar el override. Empieza por el rol de menor riesgo (`triage`), que clasifica y nunca responde, antes de tocar `executor_cheap`.
1. Revisa los costes orientativos de [Skill Optimizer](skill-optimizer.md#costes-orientativos), que están calculados con los precios de hoy.

Tras el cambio, vuelve a ejecutar `pnpm models:costs` para comprobar que la tabla refleja los overrides y anota la decisión en el [roadmap](ROADMAP.md#hitos-de-calendario-no-perder).

## Qué no hace

- No elige modelos automáticamente por coste ni por calidad: el enrutado es una tabla que decide una persona.
- No es un *Model Router Optimizer* (LLD §18, "más adelante"): no aprende de los resultados.
- No cambia versiones de skills ni de harness: solo qué modelo ejecuta, puntúa o clasifica.
- No sustituye al presupuesto en euros de los experimentos, que sigue cortando el gasto.

## Documentos relacionados

- [Runbook local](runbook-local.md#variables-del-runtime): dónde se fijan las variables.
- [Skill Optimizer](skill-optimizer.md#costes-orientativos): costes de una vuelta de optimización.
- [README del runtime](../runtime/agent-runtime/README.md): proveedores, tabla de precios y evaluadores.
- [Roadmap](ROADMAP.md): el hito del 2027-01-01.
