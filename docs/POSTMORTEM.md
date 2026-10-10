# Informe de incidente — jornada de fallas controladas

> **Estado: pendiente.** Este informe se completa durante la jornada de fallas
> controladas, previa a la presentación grupal. La estructura está definida de
> antemano para que durante el incidente se registren los datos y no haya que
> reconstruirlos de memoria después — que es exactamente el error que hace que
> los informes de incidente no sirvan.

---

## Resumen

*(Qué falló, qué impacto tuvo y qué se hizo. Tres o cuatro oraciones, legibles
por alguien que no estuvo.)*

## Qué se provocó

| | |
|---|---|
| **Dependencia caída** | *(a definir: `pricing-search-service`, el proveedor externo de pagos, o ambas)* |
| **Cómo se provocó** | |
| **Momento de inicio** | |
| **Momento de recuperación** | |
| **Duración** | |

### Escenarios candidatos

Los tres que vale la pena ejercitar, en orden de interés:

1. **Caída de `pricing-search-service` completo** (las dos instancias) durante
   una reserva. Hipótesis: `POST /v1/pedidos/reservar` devuelve `503` con
   `Retry-After` porque sin cotización no hay reserva posible, mientras
   `GET /v1/proveedor/disponibilidad` sigue respondiendo porque va contra
   `stock-service`. El circuit breaker debería abrir a las 5 fallas y dejar de
   gastar el timeout en cada llamada.
2. **Caída del proveedor externo de pagos** durante una confirmación. Hipótesis:
   el pedido queda en `pendiente_de_pago` **conservando el stock reservado**, y el
   consumidor recibe `202` con `Retry-After`. La reserva no se pierde por una
   falla de un tercero.
3. **Caída de RabbitMQ** mientras se generan reservas. Hipótesis: las reservas se
   completan normalmente, los eventos se acumulan en `outbox_evento` y se publican
   al volver el broker. El índice de búsqueda queda atrasado y se recupera.

La caída de **una sola instancia** de `pricing-search-service` ya está verificada
y no cuenta como incidente: Kong la marca `UNHEALTHY` en ~14 s y el tráfico sigue
en la otra sin que el cliente note nada.

## Impacto

| | |
|---|---|
| **Operaciones afectadas** | |
| **Peticiones fallidas** | |
| **Qué vio el usuario** | |
| **Qué vio el grupo consumidor** | |
| **Datos perdidos o inconsistentes** | *(la respuesta esperada es "ninguno")* |

## Línea temporal

| Hora | Qué pasó | Quién / qué lo detectó |
|---|---|---|
| | | |

## Detección

- ¿Qué señal avisó primero: la alerta, el tablero, una petición fallida?
- ¿Cuánto pasó entre la falla y la detección?
- ¿La alerta que esperábamos que disparara, disparó?

## Respuesta

- ¿Qué mecanismo de protección actuó (timeout, reintento, circuit breaker,
  degradación, health check)?
- ¿Actuó como estaba diseñado, o hizo algo distinto de lo previsto?
- ¿Hizo falta intervención manual?

## Causa

*(La causa técnica del fallo provocado, y por qué el sistema se comportó como se
comportó. Si el comportamiento difirió de la hipótesis, decirlo: ese es el
hallazgo valioso del ejercicio.)*

## Qué funcionó

*(Los mecanismos que cumplieron. Vale registrarlos: un informe que sólo lista
problemas no permite saber qué no hay que tocar.)*

## Qué no funcionó

*(Incluido lo que descubrimos que no estaba cubierto.)*

## Acciones de mejora

| # | Acción | Por qué | Responsable | Estado |
|---|---|---|---|---|
| 1 | | | | |

---

## Evidencia a capturar durante el ejercicio

Checklist para no quedarse sin datos:

- [ ] Logs correlacionados de una petición afectada (`correlation_id` completo,
      atravesando los servicios).
- [ ] Captura del tablero durante la falla y después de la recuperación.
- [ ] Métrica del circuit breaker (`helios_circuito_estado`) mostrando apertura y
      cierre.
- [ ] `kong_upstream_target_health` durante el incidente.
- [ ] Respuesta HTTP exacta que recibió el consumidor, con `trace_id`.
- [ ] Estado de la cola y de la DLQ (`helios.eventos.dlq`) si estuvo involucrada
      la mensajería.
- [ ] Profundidad del outbox durante la caída del broker, y que se haya vaciado al
      recuperarse.
- [ ] Verificación de que no se duplicó ni se perdió ninguna reserva: conteo de
      `reserva` contra asientos de `movimiento_stock`.
