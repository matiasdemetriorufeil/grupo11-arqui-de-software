# stock-service

Inventario, reservas transaccionales y órdenes de reposición. **Acá vive la
operación crítica del sistema.**

| | |
|---|---|
| **Puerto** | 3004 |
| **Almacén** | PostgreSQL 16 (`helios_stock`) |
| **Patrón interno** | Hexagonal (puertos y adaptadores) + DDD táctico |
| **Expuesto por el gateway** | `/v1/pedidos/**`, `/v1/proveedor/disponibilidad`, `/interno/stock/**` |

## Responsabilidad

Saber cuánto hay, comprometerlo sin sobreventa y disparar la reposición. Es el
dueño del ciclo de vida del pedido, de principio a fin.

## De qué datos es dueño

| Tabla | Qué guarda |
|---|---|
| `deposito` | Centros de distribución |
| `existencia` | Stock por producto y depósito: físico, reservado, umbrales de reposición |
| `reserva` / `reserva_linea` | Pedidos y sus líneas, con el precio congelado |
| `movimiento_stock` | Libro mayor append-only de toda variación de stock |
| `orden_reposicion` | Órdenes generadas al cruzar el punto de reposición |
| `clave_idempotencia` | Respuestas de operaciones ya ejecutadas |
| `evento_consumido` | Idempotencia del consumo de eventos |
| `outbox_evento` | Eventos pendientes de publicar |

`producto_id` y `sku` aparecen **sin clave foránea**: son una réplica de la
identidad que define `catalog-service`, mantenida por eventos. Es el costo
aceptado de no compartir base — ver
[ADR-001](../../docs/adr/ADR-001-limites-de-servicios.md).

## Por qué arquitectura hexagonal acá

Es el servicio con las reglas de negocio más densas y con la única operación que
no puede equivocarse. Aislar el dominio nos da dos cosas concretas:

1. Las seis reglas de la reserva se testean **sin levantar PostgreSQL**. Hay 14
   tests que corren en 130 ms.
2. El adaptador del proveedor externo de pagos —que es de otro grupo y puede
   cambiar— se reemplaza sin tocar ninguna regla.

```
src/
├── domain/              Reglas puras. No conocen HTTP ni SQL.
│   └── reserva.js         las 6 reglas, reposición, unidades libres
├── application/         Casos de uso y declaración de puertos
│   ├── reservar-pedido.js   orquesta la transacción
│   └── puertos.js           contratos que el dominio exige al exterior
├── adapters/            Implementaciones de los puertos (Entrega 2)
└── http/                Adaptador de entrada
    ├── rutas-pedidos.js     capacidad pública (contrato)
    └── rutas-internas.js    API del frontend propio
```

## Las garantías de la reserva

La transacción hace ocho cosas o ninguna:

```
┌─ BEGIN (READ COMMITTED) ────────────────────────────────────────┐
│ 1. SELECT ... FOR UPDATE de las existencias,                    │
│    SIEMPRE ordenadas por (producto_id, deposito_id)             │
│ 2. Validar las 6 reglas sobre datos ya bloqueados               │
│ 3. INSERT reserva + reserva_linea                               │
│ 4. UPDATE existencia.cantidad_reservada += cantidad             │
│ 5. INSERT movimiento_stock                                      │
│ 6. INSERT orden_reposicion si cruzó el punto de reposición      │
│ 7. INSERT outbox_evento                                         │
│ 8. INSERT clave_idempotencia                                    │
└─ COMMIT / ROLLBACK ─────────────────────────────────────────────┘
```

| Riesgo | Qué lo impide |
|---|---|
| Sobreventa | `FOR UPDATE` + `CHECK (cantidad_reservada <= cantidad_fisica)` |
| Deadlock | Orden de bloqueo fijo por `(producto_id, deposito_id)` |
| Pedido duplicado | `PRIMARY KEY` de `clave_idempotencia`, insertada en la misma transacción |
| Evento perdido | Outbox transaccional |
| Stock bloqueado para siempre | `expira_en` + job de expiración |

El `CHECK` es lo que vuelve la sobreventa imposible **incluso ante un bug en el
código de este servicio**. Las garantías importantes no se delegan a la
aplicación.

## Eventos

**Publica:** `pedido.reservado`, `pedido.confirmado`, `pedido.expirado`,
`stock.bajo_minimo`, `stock.existencia_cambiada`

**Consume:** `catalogo.producto_catalogado` (crea la existencia inicial)

## Dependencias

| Dependencia | Tipo | Si falla |
|---|---|---|
| PostgreSQL | esencial | `503`; el readiness probe lo reporta |
| `pricing-search-service` (cotización) | síncrona, esencial | `503` al consumidor. Sin precio firme no hay reserva |
| `pricing-search-service` (ranking) | síncrona, conveniencia | La orden se registra con `origen_del_precio = sin_ranking` |
| Proveedor de pagos (otro grupo) | síncrona | Pedido en `pendiente_de_pago`, **stock conservado** |
| RabbitMQ | asíncrona | Los eventos esperan en el outbox |

Las dos llamadas a `pricing-search-service` tienen criterios de degradación
**opuestos** a propósito: una es esencial, la otra es conveniencia. No unificar
los dos clientes creyendo que simplifica — ver
[ADR-005](../../docs/adr/ADR-005-comunicacion.md).

## Correr los tests

```bash
npm install && npm test        # 14 tests, sin infraestructura
```

## Estado

| Parte | Estado |
|---|---|
| Esquema completo con restricciones y datos de demo | Listo |
| Reglas de negocio del dominio | **Implementadas y testeadas** |
| Caso de uso de reserva (orquestación) | Escrito contra los puertos |
| Endpoints del contrato | Responden `501` apuntando al mock |
| Validación de `Idempotency-Key` | Implementada |
| Simulador de reposición (`/interno/stock/simular-reposicion`) | Implementado |
| Adaptadores (PostgreSQL, RabbitMQ, HTTP saliente) | Entrega 2 — ver [`src/adapters/`](src/adapters/README.md) |
