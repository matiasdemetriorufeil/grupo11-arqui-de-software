# ADR-005 — Comunicación entre servicios

| | |
|---|---|
| **Decisión obligatoria** | D5 |
| **Estado** | Aceptada — versión inicial |
| **Fecha** | 2026-10-09 |
| **Entrega** | 1 (se valida con evidencia en la Entrega 2) |
| **Reemplaza a** | — |
| **Reemplazada por** | — |

## Contexto

Con cuatro servicios dueños de sus propios datos ([ADR-001](ADR-001-limites-de-servicios.md)),
toda información que cruce un límite necesita un mecanismo. El enunciado pide
implementar comunicación síncrona **y** asíncrona, con timeouts, manejo de
errores, política de reintentos, publicación y consumo de un evento de dominio y
tratamiento de mensajes fallidos.

Los flujos reales del sistema son cinco:

| # | Flujo | ¿El emisor puede seguir sin la respuesta? |
|---|---|---|
| 1 | Al reservar, obtener la cotización y su precio congelado | **No.** Sin precio firme no hay reserva posible. |
| 2 | Al confirmar, autorizar el pago contra el proveedor externo | **No**, pero se puede diferir conservando el stock. |
| 3 | Al aplicar un lote, resolver códigos de fabricante a SKU | **No**, pero el lote puede quedar en espera. |
| 4 | Al reponer, saber qué fabricante es el más barato por Watt | **Sí.** Es conveniencia, no requisito. |
| 5 | Mantener el índice de búsqueda al día con precios, catálogo y stock | **Sí.** Nadie espera por esto. |

## Decisión

**El criterio es uno: síncrono cuando el que pregunta no puede continuar sin la
respuesta; asíncrono en todos los demás casos.** No se elige por comodidad ni por
uniformidad.

### Comunicación síncrona — HTTP/JSON

| Flujo | Origen → destino | Timeout | Reintentos | Si falla |
|---|---|---|---|---|
| 1 | `stock-service` → `pricing-search-service` | 2 s | 1, sólo error de red o 5xx | `503` al consumidor, con `Retry-After` |
| 2 | `stock-service` → proveedor de pagos | 2 s | 2, misma `Idempotency-Key` | Pedido en `pendiente_de_pago`, **stock conservado** |
| 3 | `import-service` → `catalog-service` | 3 s | 2 con backoff | Lote queda en `normalizado`, se reanuda |
| 4 | `stock-service` → `pricing-search-service` | 2 s | 1 | Orden con `origen_del_precio = sin_ranking` |

**Los flujos 1 y 4 van al mismo servicio con criterios de degradación opuestos, y
eso es deliberado.** El 1 es esencial: sin cotización, reservar es imposible y hay
que fallar. El 4 es conveniencia: no saber qué fabricante conviene no justifica
rechazar una reserva que el cliente ya pagó mentalmente. Si los tratáramos igual,
una falla secundaria tiraría abajo la operación crítica.

Reglas que valen para toda llamada saliente:

- **Timeout siempre explícito** (`AbortSignal.timeout`). Una llamada sin timeout
  es una forma lenta de caerse: el pool de conexiones se agota esperando.
- **Reintento sólo para fallas transitorias**: error de red, timeout, `5xx`.
  **Nunca** para `4xx` — reintentar un `409 STOCK_INSUFICIENTE` no va a crear
  stock, y reintentar un `422` no va a volver válido el cuerpo.
- **Circuit breaker por dependencia**: abre a las 5 fallas consecutivas,
  half-open a los 30 s, cierra con un éxito. Mientras está abierto se falla
  rápido en lugar de agotar el timeout en cada llamada.
- **Propagación de `X-Correlation-Id`** en todas las llamadas, para que una
  operación se pueda seguir de punta a punta.
- **El tráfico este-oeste no pasa por el gateway.** Las llamadas internas van
  directo al servicio, y en el caso de `pricing-search-service` al alias de red
  `precios-interno` (round-robin por DNS entre las dos instancias). El punto de
  entrada público es para el tráfico que entra al sistema, no para el interno.

### Comunicación asíncrona — RabbitMQ

Exchange `helios.eventos` de tipo `topic`, una cola por consumidor, una DLQ
compartida `helios.eventos.dlq`.

```
import-service   --precios.lista_actualizada-->     ┌──────────────────┐
catalog-service  --catalogo.producto_catalogado-->  │  helios.eventos  │
stock-service    --stock.*, pedido.*-->             │  (topic)         │
                                                    └────────┬─────────┘
                           ┌─────────────────────────────────┤
                           ▼                                 ▼
              cola precios.proyeccion            cola stock.catalogo
                           │                                 │
                  pricing-search-service              stock-service
                           │
                 (3 fallos) └──> helios.eventos.dlq
```

Exchange `topic` y no `fanout` porque los consumidores se suscriben a subconjuntos
distintos (`pricing-search` quiere `precios.*`, `catalogo.*` y `stock.*`;
`stock-service` sólo `catalogo.producto_catalogado`). Una cola por consumidor y no
una compartida porque cada uno avanza a su ritmo y un consumidor lento no debe
frenar al otro.

### Catálogo de eventos de dominio

| Evento | Emisor | Consumidores | Efecto |
|---|---|---|---|
| `precios.lista_actualizada` | `import-service` | `pricing-search-service` | Reproyecta los productos del fabricante con los precios nuevos |
| `catalogo.producto_catalogado` | `catalog-service` | `pricing-search-service`, `stock-service` | Alta en el índice y creación de la existencia inicial |
| `stock.existencia_cambiada` | `stock-service` | `pricing-search-service` | Actualiza `unidades_libres` en el índice |
| `stock.bajo_minimo` | `stock-service` | `stock-service` (job de reposición) | Genera o actualiza la orden de reposición |
| `pedido.reservado` / `pedido.confirmado` / `pedido.expirado` | `stock-service` | `pricing-search-service`, observabilidad | Consolida o libera disponibilidad proyectada |

**Envoltorio común** (estilo CloudEvents), igual para todos:

```json
{
  "id_mensaje": "018f3a2b-...",
  "tipo": "precios.lista_actualizada",
  "version": 1,
  "ocurrido_en": "2026-10-09T14:22:05.123Z",
  "clave_agregado": "Jinko Solar",
  "correlation_id": "8a7cd6a5-...",
  "emisor": "import-service",
  "datos": { }
}
```

`id_mensaje` habilita la idempotencia del consumidor. `ocurrido_en` permite medir
el retraso de proyección. `correlation_id` conecta el evento con la petición HTTP
que lo originó. `version` permite evolucionar el formato sin romper consumidores.

### Las tres garantías del lado asíncrono

**1. Publicación sin pérdida: outbox transaccional.**

El problema: si `stock-service` hace `COMMIT` de una reserva y después publica
`pedido.reservado`, un reinicio entre las dos cosas pierde el evento para siempre,
y el índice queda inconsistente sin que nadie se entere.

La solución: el evento se escribe en la tabla `outbox_evento` **dentro de la misma
transacción** que el cambio de estado. Un publicador lee las filas con
`publicado_en IS NULL`, las envía con `publisher confirms` y recién entonces marca
la fila. Si RabbitMQ está caído, los eventos se acumulan y salen al volver.

Consecuencia aceptada: el publicador puede enviar un evento dos veces si falla
justo después del confirm y antes del `UPDATE`. Por eso los consumidores son
idempotentes — es decir, **entrega al menos una vez, no exactamente una vez**.

**2. Consumo idempotente.**

Cada consumidor registra `id_mensaje` **antes** de aplicar el efecto, en una tabla
con restricción de unicidad (`evento_consumido` en PostgreSQL, colección con
índice único y TTL de 7 días en MongoDB). Si el `INSERT` falla por duplicado, el
mensaje se confirma y se descarta sin reprocesar.

Para la proyección del índice hay además control de orden: la escritura usa la
`version` del documento, de forma que un evento viejo que llega tarde no sobrescribe
uno más nuevo.

**3. Mensajes no procesables: DLQ.**

Tres intentos con backoff exponencial (1 s, 5 s, 25 s). Al cuarto, el mensaje va a
`helios.eventos.dlq` con los headers `x-motivo-descarte`, `x-intentos` y el
`correlation_id` original. Se alerta sobre la profundidad de la DLQ. Un mensaje
envenenado nunca bloquea la proyección del resto.

Distinguimos dos clases de fallo al consumir:

- **Transitorio** (la base no responde, el índice rechaza por carga): se reintenta.
- **Permanente** (el evento trae datos que no validan, el SKU no existe): va
  directo a la DLQ sin gastar reintentos. Reintentar un mensaje malformado tres
  veces sólo retrasa el resto de la cola.

### La topología se declara en el código

Cada servicio declara su exchange, sus colas y sus bindings al arrancar, de forma
idempotente, en lugar de cargarse desde un `definitions.json` de RabbitMQ. Así la
topología vive junto al código que la usa y un servicio nuevo no requiere tocar la
configuración del broker.

### Qué NO es asíncrono y por qué

- **La reserva.** El cliente necesita saber ahora si tiene el stock. Una reserva
  asíncrona trasladaría al consumidor la complejidad de esperar y conciliar
  (ver [ADR-008](ADR-008-contrato-propio.md), alternativa C).
- **Las notificaciones al grupo consumidor.** Hoy el consumidor consulta
  `GET /v1/pedidos/{id}`. Un webhook `pedido.estado_cambiado` sería una mejora
  (ahorra polling cuando un pago se rechaza o una reserva expira) y es un cambio
  aditivo sobre `/v1`. Queda para después de la Entrega 2.

## Alternativas evaluadas

### A. Todo síncrono, sin broker

Que `import-service` llame por HTTP a `pricing-search-service` para reindexar, y
que `stock-service` le avise cada cambio de existencia.

- **A favor:** un componente menos de infraestructura, consistencia inmediata, y
  depurar es mucho más fácil — el stack trace cruza los servicios.
- **En contra:** acopla la disponibilidad. Si `pricing-search-service` está caído,
  no se puede aplicar un lote de precios ni reservar, aunque ninguna de las dos
  cosas lo necesite realmente. Y reindexar 5000 filas dentro de la petición de
  importación la vuelve inviable.
- **Descartada.** Es el acoplamiento temporal que el broker existe para evitar.

### B. Todo asíncrono, incluso la reserva

Reservar publica un comando, el consumidor recibe un `202` y consulta después.

- **A favor:** absorbe picos de demanda, tolera que `stock-service` esté caído.
- **En contra:** el cliente que arma un pedido tiene que saber **ahora** si tiene
  las unidades. Un `202` seguido de polling es peor experiencia y más código para
  el grupo consumidor, por un beneficio que no necesitamos: el volumen de reservas
  es bajo.
- **Descartada.**

### C. Saga coreografiada para la confirmación del pedido

Confirmar publica un evento, un servicio de pagos reacciona, publica el resultado
y `stock-service` reacciona a eso.

- **A favor:** desacopla del proveedor externo; tolera que el proveedor esté
  caído sin bloquear nada.
- **En contra:** complejidad considerable (compensaciones, estados intermedios,
  timeouts de saga) para un flujo que es una sola llamada remota. Y el consumidor
  igual necesita saber el resultado.
- **Descartada.** La degradación controlada que elegimos — el pedido queda en
  `pendiente_de_pago` **conservando el stock** y el consumidor reconsulta —
  obtiene el 90 % del beneficio con una fracción de la complejidad. Si el
  proveedor externo resulta muy inestable en la práctica, se reconsidera.

### D. Kafka en lugar de RabbitMQ

- **A favor:** log persistente que permite reproducir eventos desde el principio,
  que es exactamente lo que querríamos para reconstruir el índice de búsqueda.
  Mejor rendimiento a gran escala.
- **En contra:** mucho más pesado de operar para nuestro volumen, y el patrón de
  trabajo por cola con DLQ — que es lo que necesitamos para el tratamiento de
  mensajes fallidos — es más natural en RabbitMQ.
- **Descartada.** La reproducción de eventos la cubrimos de otra forma:
  `POST /interno/indice/reconstruir` relee el estado actual de los servicios
  dueños, que es más simple y no depende de retener el historial completo.

### E. Confiar en `publisher confirms` sin outbox

Publicar después del commit y confiar en el confirm del broker.

- **A favor:** una tabla menos, un publicador menos.
- **En contra:** no cubre el caso que importa. El confirm garantiza que RabbitMQ
  recibió el mensaje; no garantiza nada si el proceso muere **entre** el commit de
  la transacción y la publicación. Ese es justamente el hueco por el que se
  pierden los eventos.
- **Descartada.** El outbox resuelve el problema real; los confirms son
  complementarios y los usamos igual.

## Consecuencias

### Aceptamos

- **Entrega al menos una vez, no exactamente una vez.** Todo consumidor debe ser
  idempotente. Es el requisito que viaja con esta decisión y está implementado en
  el esquema de los dos almacenes (`evento_consumido`).
- **Consistencia eventual en todo lo que viaja por eventos.** El índice puede
  estar hasta 60 s atrasado. Acotado y medido (ver
  [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §6).
- **Una tabla de outbox y un publicador por servicio emisor**, más el job que lo
  ejecuta periódicamente.
- **Depurar un flujo que cruza tres servicios necesita correlación.** Por eso los
  logs estructurados con `correlation_id` y las trazas distribuidas dejan de ser
  opcionales.
- **RabbitMQ es un componente crítico.** Si se cae, el índice se congela.
  Mitigado: los eventos no se pierden (outbox), y la reserva —que es la operación
  crítica— no depende del broker para completarse.
- **Dos semánticas de degradación hacia el mismo servicio.** Es correcto, pero
  hay que documentarlo bien para que nadie "unifique" los dos clientes HTTP de
  `stock-service` → `pricing-search-service` creyendo que simplifica.

### Ganamos

- Aplicar un lote de precios no requiere que el motor de búsqueda esté arriba.
- Una reserva se completa sin esperar la reindexación.
- Un mensaje envenenado queda aislado en la DLQ sin frenar la proyección.
- Un reintento del consumidor o del broker no duplica efectos.
- La operación crítica tiene atomicidad real, porque todo lo que necesita
  atomicidad está dentro de `stock-service` y de una sola transacción.

### Cómo se verifica

Verificado en esta entrega:

- Las URLs de las dependencias de cada servicio están declaradas como variables de
  entorno y el readiness probe (`/salud/lista`) reporta el estado real de cada
  una: `curl http://localhost:8000/salud/stock/salud/lista` devuelve
  `{"estado":"operativo","dependencias":{"postgres":"disponible","rabbitmq":"disponible"}}`.
- Las tablas `outbox_evento` y `evento_consumido` existen en los esquemas de
  PostgreSQL, y la colección `evento_consumido` con índice único y TTL en MongoDB.
- `stock-service` apunta a `precios-interno` (alias compartido por las dos
  instancias), no al gateway: el tráfico interno no atraviesa el punto de entrada
  público.

Pendiente para la Entrega 2:

- Publicar y consumir `precios.lista_actualizada` de punta a punta, con el
  retraso de proyección medido contra el objetivo de 60 s.
- Entregar dos veces el mismo mensaje y comprobar que el efecto ocurre una sola vez.
- Enviar un evento malformado y comprobar que termina en la DLQ con su motivo, sin
  bloquear la cola.
- Apagar RabbitMQ, generar reservas, comprobar que se completan y que los eventos
  se publican al volver.
- Abrir el circuit breaker provocando la caída de `pricing-search-service` y
  verificar el `503` con `Retry-After` (queda documentado en `POSTMORTEM.md`).
