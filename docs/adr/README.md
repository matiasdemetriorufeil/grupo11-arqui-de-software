# Registros de decisiones arquitectónicas (ADR)

Cada decisión arquitectónica se conserva como un archivo independiente. El
objetivo de un ADR es explicar **por qué** se eligió una alternativa, qué otras
se evaluaron y qué consecuencias se aceptaron — no describir la solución, que
para eso está [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Estado de las decisiones obligatorias

| # | Decisión | Archivo | Estado | Entrega |
|---|---|---|---|---|
| D1 | Límites de los servicios | [ADR-001](ADR-001-limites-de-servicios.md) | Aceptada | 1 |
| D2 | Arquitectura interna de los servicios | — | pendiente | 2 |
| D3 | Persistencia | [ADR-003](ADR-003-persistencia.md) | Aceptada (versión inicial) | 1 → se valida en 2 |
| D4 | Consistencia y concurrencia | — | pendiente | 2 |
| D5 | Comunicación entre servicios | [ADR-005](ADR-005-comunicacion.md) | Aceptada (versión inicial) | 1 → se valida en 2 |
| D6 | Búsqueda | — | pendiente | 2 |
| D7 | Caché | — | pendiente | 2 |
| D8 | Contrato propio | [ADR-008](ADR-008-contrato-propio.md) | Aceptada | 1 |
| D9 | Consumo del proveedor | — | pendiente | 2 |
| D10 | Resiliencia | — | pendiente | 2 |
| D11 | Observabilidad | — | pendiente | 2 |
| D12 | Balanceo de carga | — | pendiente | 2 |
| D13 | Capacidad y costos | — | pendiente | 2 |

Las decisiones pendientes están **preanticipadas** en
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) (secciones 6 a 12): el diseño ya está
tomado y en parte verificado, pero el ADR formal con alternativas y consecuencias
se escribe en la entrega que corresponde.

## Formato

Cada ADR tiene:

- **Encabezado** con la decisión obligatoria que cubre, estado, fecha, entrega y
  las referencias de reemplazo.
- **Contexto** — qué problema concreto hay que resolver y qué restricciones
  existen. Sin esto, la decisión no se puede evaluar.
- **Decisión** — qué se eligió, con el detalle suficiente para implementarlo.
- **Alternativas evaluadas** — cada una con lo que tenía a favor y en contra, y
  por qué se descartó. Las alternativas que eran razonables se registran como
  tales: si la descartada era mejor en algún aspecto, se dice.
- **Consecuencias** — lo que se acepta (con mitigaciones) y lo que se gana.
- **Cómo se verifica** — qué evidencia confirma que la decisión funciona.

## Si una decisión cambia

El ADR anterior **no se borra ni se edita**: se marca como `Reemplazada por
ADR-XXX` y el nuevo indica a cuál reemplaza y por qué fue necesario revisarla. La
historia de las decisiones es parte de la documentación.

## Puntos abiertos conocidos

| Tema | ADR | Qué falta decidir |
|---|---|---|
| Persistencia de las cotizaciones | [ADR-003](ADR-003-persistencia.md) | Redis con TTL o tabla propia. Impacta en qué pasa si el servicio reinicia. |
| Herramienta de migraciones | [ADR-003](ADR-003-persistencia.md) | Hoy el esquema se crea sólo en base vacía. |
| Elasticsearch vs. Meilisearch | [ADR-003](ADR-003-persistencia.md) | Reversible si la memoria resulta un problema. |
| Webhooks al consumidor | [ADR-008](ADR-008-contrato-propio.md) | `pedido.estado_cambiado` para evitar polling. Cambio aditivo. |
| Separar cotizaciones como servicio | [ADR-001](ADR-001-limites-de-servicios.md) | Sólo si ganan reglas propias de negocio. |
