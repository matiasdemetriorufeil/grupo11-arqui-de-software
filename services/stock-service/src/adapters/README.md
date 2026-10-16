# Adaptadores de `stock-service`

Implementaciones concretas de los puertos declarados en
[`../application/puertos.js`](../application/puertos.js). Esta carpeta es el
borde del hexágono: todo lo que sabe de PostgreSQL, RabbitMQ o HTTP vive acá y
nada de eso entra al dominio.

## Estado por adaptador

| Adaptador | Puerto que implementa | Estado | Entrega |
|---|---|---|---|
| `repositorio-postgres.js` | `RepositorioDeStock` | **listo** — falta conectarlo a las rutas | 2 |
| `precios-http.js` | `ServicioDePrecios` | pendiente | 2 |
| `pagos-proveedor-http.js` | `ProveedorDePagos` | pendiente | Presentación |
| `publicador-rabbitmq.js` | `PublicadorDeEventos` | pendiente | 2 |

En la Entrega 1 el contrato está cerrado y el dominio implementado y testeado;
los adaptadores son lo que falta para que la operación deje de responder `501`.

## Decisiones ya tomadas para cuando se escriban

**`repositorio-postgres.js`** — driver `pg` con un pool por proceso. `enTransaccion`
toma un cliente del pool, emite `BEGIN`, pasa el cliente envuelto al trabajo y
hace `COMMIT`/`ROLLBACK`. El aislamiento es `READ COMMITTED`: no hace falta más,
porque la exclusión mutua la da `SELECT ... FOR UPDATE` sobre las existencias.
`bloquearExistenciasPorSku` ordena siempre por `(producto_id, deposito_id)`, que
es lo que evita deadlocks entre pedidos con las mismas líneas en otro orden.

Dos decisiones que se tomaron al implementarlo, porque el esquema no las fijaba:

- **Depósito asignado.** Un SKU puede tener existencia en varios depósitos, pero
  la reserva trabaja con una existencia por SKU. El adaptador bloquea sólo las
  del depósito configurado en `DEPOSITO_ASIGNADO` (por defecto `DEP-CBA-01`),
  según el supuesto 6 de `SPEC.md`. Asignar el depósito por destino del pedido
  es un cambio dentro del adaptador.
- **Cupo por cliente (R4.5).** No hay tabla de cupos: el cupo usado se calcula
  sumando las líneas de las reservas del cliente dentro de `VENTANA_CUPO_HORAS`
  (24 por defecto) que no terminaron rechazadas, canceladas ni expiradas. El
  máximo es `CUPO_UNIDADES_POR_CLIENTE` (5000). Para que dos pedidos simultáneos
  del mismo cliente sobre SKUs distintos no pasen los dos, se toma un
  `pg_advisory_xact_lock` por cliente, siempre después de los locks de
  existencia.

El libro mayor guarda el delta con signo sobre lo reservado: `reserva` +N,
`liberacion` -N.

**`precios-http.js`** — `fetch` con `AbortSignal.timeout(2000)`, un único
reintento para errores de red y `5xx` (nunca para `4xx`), y circuit breaker que
abre a las 5 fallas consecutivas y entra en half-open a los 30 s. Cada llamada
propaga `X-Correlation-Id`.

**`pagos-proveedor-http.js`** — se escribe contra el contrato publicado por el
grupo proveedor asignado por la cátedra, con un test de contrato que falla si
ese contrato cambia de forma incompatible. Reintentos siempre con la misma clave
de idempotencia. Si el proveedor no responde, el pedido queda en
`pendiente_de_pago` y **conserva el stock reservado**: degradar no significa
perder la reserva.

**`publicador-rabbitmq.js`** — lee la tabla `outbox_evento`, publica en el
exchange `helios.eventos` con `publisher confirms` y recién entonces marca
`publicado_en`. Un mensaje que falla N veces va a la DLQ `helios.eventos.dlq`.
