# Estrategia de ramas, revisiones e integración

Grupo 11 — Arquitectura de Software 2026, UCC.

Este documento define cómo trabajamos sobre el repositorio. El enunciado (§2.12)
exige definir **y utilizar** una estrategia acorde a nuestra forma de trabajo, y
que la versión final evaluable esté en la rama principal.

---

## La estrategia: *trunk-based* con ramas de vida corta y Pull Request

```
main  ──●───────●───────────●──────────●─────────●──────>   siempre evaluable
         \     /             \        /         (tag entrega-2)
          ●───●               ●──────●
      feat/stock-reserva   fix/precios-redondeo
         (< 2 días)             (< 2 días)
```

**Reglas**

1. `main` **siempre** tiene que levantar con `docker compose up --build` y pasar
   los tests. Es la rama que evalúa la cátedra.
2. Todo cambio entra por una rama corta y un Pull Request. Nadie commitea a
   `main` directamente (salvo la excepción documentada más abajo).
3. Las ramas viven **menos de dos días**. Si una rama se extiende, se parte.
4. Un PR necesita **al menos una aprobación** de otro integrante.
5. `main` no se reescribe: nada de `force-push` ni de `rebase` sobre lo ya
   publicado.
6. Cada entrega se **etiqueta**: `entrega-1`, `entrega-2`, `presentacion`.

---

## Por qué esta estrategia y no otra

### Por qué *trunk-based*

El requisito del enunciado es que **la versión evaluable esté en la rama
principal**. Trunk-based lo garantiza por construcción: no existe otra rama donde
"viva la verdad". En cualquier momento, lo que la cátedra ve en `main` es lo que
tenemos.

Además encaja con nuestra realidad: cuatro personas, tres fechas de entrega
separadas por dos semanas, y un sistema que tiene que estar siempre levantable.
Las ramas cortas mantienen el costo de integración bajo — el conflicto grande
aparece cuando dos personas trabajan una semana por separado, no cuando integran
todos los días.

### Por qué descartamos Git Flow

Git Flow (`develop` + `release/*` + `hotfix/*` + `main`) está diseñado para
productos con versiones publicadas y varias soportadas en paralelo. Nosotros
tenemos **un solo entorno evaluable** y ninguna versión vieja a la que darle
soporte: las ramas de release y de hotfix serían ceremonia vacía.

Y tiene un problema concreto para este trabajo: pondría el desarrollo real en
`develop` y dejaría `main` desactualizado entre entregas. Eso es exactamente lo
que el enunciado no quiere.

### Por qué descartamos commitear directo a `main`

Es más simple y más rápido, y para un proyecto de una sola persona sería la
opción correcta. Acá no, por dos razones específicas de este sistema:

- **El contrato público lo consume otro grupo.** Un cambio en
  `docs/contracts/openapi.yaml` que rompa compatibilidad sin que nadie lo mire le
  rompe la integración a un equipo que no controlamos.
- **Cada servicio tiene su propio esquema de datos y sus invariantes.** Un cambio
  en `services/stock-service/db/init/` que relaje una restricción podría habilitar
  sobreventa sin que se note hasta que falle en producción. Son justamente los
  cambios que conviene que una segunda persona lea.

La revisión no está para controlar a nadie: está para los dos o tres archivos del
repositorio donde un error pasa desapercibido y después cuesta caro.

### Por qué merge commit y no squash

Los PR se integran con **merge commit (`--no-ff`)**, no con squash. El historial
de `main` muestra qué conjunto de cambios entró como una unidad, lo cual importa
en una materia donde hay que **defender** las decisiones: se puede señalar un
merge y decir "esto es lo que entró cuando implementamos la reserva".

El costo es un historial menos lineal. Lo aceptamos a cambio de la trazabilidad.

---

## Convenciones

### Nombres de rama

| Prefijo | Para qué | Ejemplo |
|---|---|---|
| `feat/` | Funcionalidad nueva | `feat/stock-adaptador-postgres` |
| `fix/` | Corrección de un defecto | `fix/importacion-separador-decimal` |
| `docs/` | Documentación y ADRs | `docs/adr-004-consistencia` |
| `chore/` | Infraestructura, dependencias, scripts | `chore/ci-tests-en-pr` |
| `test/` | Sólo tests | `test/reserva-concurrencia` |

Cuando el cambio es de un servicio, el nombre lo dice: `feat/<servicio>-<qué>`.

### Mensajes de commit

[Conventional Commits](https://www.conventionalcommits.org/), con el servicio
como *scope*:

```
feat(stock): reserva transaccional con bloqueo de existencias
fix(importacion): el separador decimal se interpretaba dos veces
docs(adr): ADR-004 consistencia y concurrencia
chore(infra): health checks activos en el upstream de precios
```

El cuerpo del commit explica **por qué**, no qué — el qué ya está en el diff.

### Checklist de un Pull Request

Antes de pedir revisión:

- [ ] Los tests del servicio pasan (`npm test`).
- [ ] `docker compose up --build` sigue levantando todo, y `./scripts/humo.sh`
      da 18/18.
- [ ] Si cambió una decisión arquitectónica, el ADR está actualizado (o hay uno
      nuevo que reemplaza al anterior).
- [ ] Si cambió el contrato público, está reflejado en `openapi.yaml`, en
      `docs/contracts/README.md` y en el changelog, y **se avisó al grupo
      consumidor** si el cambio es incompatible.
- [ ] Si cambió el esquema de una base, hay migración (no sólo el script de
      inicialización, que corre únicamente en base vacía).

### Flujo completo

```bash
git switch main && git pull
git switch -c feat/stock-adaptador-postgres

# ... trabajo, commits chicos ...

npm test                       # desde el servicio tocado
docker compose up --build -d && ./scripts/humo.sh

git push -u origin feat/stock-adaptador-postgres
gh pr create --fill            # o desde la web

# tras la aprobación:
gh pr merge --merge --delete-branch
```

---

## Excepción documentada: el commit inicial

El historial de arranque del repositorio (la Entrega 1) se publicó **directamente
en `main`**, en una serie de commits por unidad lógica. No se usó un Pull Request
porque en un repositorio vacío no hay nada contra lo que revisar: el PR habría
sido "todo el proyecto contra la nada", que es la forma menos útil de revisar
código.

Desde el primer PR en adelante, la regla general aplica sin excepciones.

---

## Etiquetas por entrega

| Etiqueta | Fecha | Qué congela |
|---|---|---|
| `entrega-1` | 9 de octubre de 2026 | Diseño, contrato y mock operativo |
| `entrega-2` | 23 de octubre de 2026 | Dominio propio de punta a punta |
| `presentacion` | 11 o 13 de noviembre de 2026 | Sistema completo |

Las etiquetas existen para que quede claro **qué** se entregó en cada fecha,
independientemente de lo que se siga trabajando después.

```bash
git tag -a entrega-1 -m "Entrega 1: diseño y contrato con mock"
git push origin entrega-1
```
