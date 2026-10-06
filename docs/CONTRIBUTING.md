# Guía de contribución

Esta guía describe cómo trabajar en el repositorio de PubliEXPE Commercial OS: ramas, worktrees, integración, convenciones y reglas de seguridad del host.

## Principios

- La rama `main` solo recibe cambios mediante pull request (PR).
- Cada línea de trabajo vive en su propia rama y en su propio worktree.
- Nada se borra: ni ramas, ni worktrees, ni contenedores, ni volúmenes, ni archivos ajenos a tu trabajo.
- Los puertos se reservan en [PORTS.md](PORTS.md) antes de usarlos.

## Flujo de ramas con worktrees

Un worktree es un directorio de trabajo adicional del mismo repositorio, con su propia rama. Permite que varias personas o agentes trabajen en paralelo sin pisarse los archivos.

### Nombres de ramas

| Tipo de trabajo | Patrón | Ejemplos |
|---|---|---|
| Funcionalidad o componente | `feat/<componente>` | `feat/agent-runtime`, `feat/twenty-app`, `feat/infra-docker` |
| Documentación | `docs/<tema>` | `docs/lld-0.2` |
| Corrección | `fix/<descripción-corta>` | `fix/trace-sequence-gap` |
| Mantenimiento | `chore/<descripción-corta>` | `chore/actualizar-twenty-tag` |

Usa minúsculas y guiones. Todas las ramas salen de `main`.

### Crear un worktree

1. Desde el directorio del repositorio principal (`commercial-os/`), actualiza `main` y crea el worktree junto al repositorio con una rama nueva:

   ```bash
   git worktree add ../wt-<nombre> -b feat/<componente> main
   ```

   Por convención, el directorio se llama `wt-<nombre>` y vive al lado de `commercial-os/`.

2. Trabaja **solo** dentro de tu worktree. Comprueba la rama antes de modificar nada:

   ```bash
   git branch --show-current
   ```

3. Para ver todos los worktrees activos:

   ```bash
   git worktree list
   ```

### Integración por PR

1. Haz commits pequeños y atómicos en tu rama (consulta [Commits](#commits)).
2. Sube tu rama: `git push -u origin feat/<componente>`.
3. Abre un PR hacia `main` con:
   - Qué cambia y por qué (en español).
   - Qué comprobaste (tests, `docker compose ps`, capturas si hay UI).
   - Si añade o cambia puertos, la actualización de [PORTS.md](PORTS.md).
4. Espera la revisión de otra persona. Nadie fusiona su propio PR sin revisión.
5. Antes de pedir revisión, trae los cambios de `main` a tu rama:

   ```bash
   git fetch origin
   git rebase origin/main    # solo sobre tu propia rama, aún sin PR abierto por otros
   ```

   Si tu rama ya tiene PR abierto y otras personas han basado trabajo en ella, usa `git merge origin/main` en lugar de `rebase`.

### Prohibido

| No hagas | Por qué |
|---|---|
| `git push --force` o `--force-with-lease` sobre `main` o sobre ramas compartidas | Reescribe la historia de otros. |
| `git branch -D`, `git push origin --delete`, `git worktree remove --force` | Pierdes trabajo de forma irrecuperable. Retirar una rama o un worktree ya fusionado lo hace el propietario del repositorio. |
| `git reset --hard`, `git clean -fd`, `git checkout -- .` sin confirmar qué se pierde | Descartan cambios sin guardar. |
| Modificar archivos de otro worktree | Cada línea de trabajo es dueña de su directorio. Si necesitas un cambio ajeno, pídelo o abre un PR. |
| `--no-verify` o saltarte hooks | Los hooks existen para proteger la calidad. Si fallan, corrige la causa. |
| Subir secretos (`.env`, claves de API, tokens) | `.env` está en `.gitignore`. Usa `.env.example` con valores de ejemplo. |

## Reglas del host y de Docker

El host ejecuta otras instancias Docker en producción. Para no afectarlas:

1. **Puertos.** Antes de exponer un puerto nuevo, ejecuta `docker ps` y consulta [PORTS.md](PORTS.md). Añade el puerto a la tabla de asignados en el mismo PR. Publica siempre en `127.0.0.1`, no en `0.0.0.0`, salvo necesidad justificada.
2. **Prefijo `pxos`.** Todos los contenedores, redes y volúmenes de este proyecto empiezan por `pxos`. Nunca pares, elimines ni modifiques recursos que no empiecen por `pxos`.
3. **Nada destructivo.** No ejecutes `docker compose down -v`, `docker volume rm`, `docker system prune` ni `rm -rf` fuera de tu worktree. Para parar el stack usa `docker compose stop`.
4. **Backups antes de migrar.** Haz un volcado de las bases de datos antes de actualizar Twenty o aplicar migraciones destructivas (consulta [runbook-local.md](runbook-local.md)).

## Convenciones

### Idioma

| Qué | Idioma |
|---|---|
| Código: identificadores, nombres de funciones, tipos, variables, nombres de tablas y campos | Inglés |
| Comentarios en el código | Inglés |
| Documentación (`docs/`, READMEs, runbooks) | Español |
| Mensajes de commit y descripciones de PR | Español |
| Textos para el usuario final (UI de Twenty, mensajes al comercial) | Español |

### Estilo de documentación

La documentación sigue el estilo de Google Developer Docs:

- Segunda persona ("ejecuta", "comprueba") y voz activa en presente.
- Pasos imperativos en listas numeradas.
- Títulos en *sentence case* (solo la primera palabra con mayúscula, salvo nombres propios).
- Código, comandos, rutas y nombres de campos en `formato de código`.
- Avisos con **Nota**, **Importante** y **Precaución**.
- Sin relleno: cada frase aporta información.

### Nombres en el código

| Contexto | Convención |
|---|---|
| Campos de objetos Twenty y payloads JSON | camelCase |
| Tablas y columnas PostgreSQL | snake_case |
| Valores de enum | `UPPER_SNAKE_CASE` |
| Nombres de tools del runtime | `snake_case` |
| Ficheros y carpetas TypeScript | kebab-case |
| Tipos e interfaces | PascalCase |

Los detalles completos están en la sección 2.2 del [LLD v0.2](LLD-0.2-especificacion.md).

### Herramientas del runtime

El runtime usa un stack fijado: TypeScript, Fastify, Drizzle ORM, BullMQ, Vitest y pnpm. No añadas otro gestor de paquetes (`npm`, `yarn`) ni otro framework de tests sin acuerdo previo.

- Instala dependencias con `pnpm install`.
- Ejecuta los tests con `pnpm test` (Vitest).
- Las migraciones de base de datos se generan con Drizzle y se versionan en el repositorio.

`[POR COMPLETAR]` Comandos exactos de lint, build y arranque cuando el trabajo del runtime los defina.

### Commits

Usa un prefijo de tipo en minúsculas, dos puntos y una descripción en español en presente, sin punto final:

```
<tipo>: <descripción en español>
```

| Tipo | Uso |
|---|---|
| `feat` | Funcionalidad nueva |
| `fix` | Corrección de un error |
| `docs` | Solo documentación |
| `infra` | Docker, despliegue |
| `test` | Tests |
| `refactor` | Cambio interno sin efecto funcional |
| `chore` | Mantenimiento |

Ejemplos:

```
docs: añade la especificación LLD v0.2 del MVP-0
feat: crea la tabla agent_executions con config_snapshot
fix: corrige la secuencia duplicada en trace_steps
```

Reglas:

- Un commit, un cambio lógico.
- La primera línea tiene como máximo 72 caracteres. Si hace falta contexto, añádelo en el cuerpo, separado por una línea en blanco.
- No mezcles en un mismo commit cambios de varias líneas de trabajo (por ejemplo, código y Docker).

## Revisión de un PR

Quien revisa comprueba:

1. El PR cumple su alcance y no toca archivos ajenos.
2. Los contratos (esquemas JSON, API, objetos Twenty) coinciden con el [LLD v0.2](LLD-0.2-especificacion.md), o el PR actualiza el LLD.
3. Las acciones con efecto externo mantienen su clase de riesgo y su *human gate*.
4. No hay secretos ni datos personales en el código, los tests o los logs.
5. Hay tests para el comportamiento nuevo y pasan.
6. [PORTS.md](PORTS.md) refleja cualquier puerto nuevo.

## Documentos relacionados

- [LLD v0.1](LLD-0.1-publiexpe-commercial-os.md): arquitectura.
- [LLD v0.2](LLD-0.2-especificacion.md): especificación de implementación del MVP-0.
- [Puertos reservados](PORTS.md)
- [Runbook de operación local](runbook-local.md)
