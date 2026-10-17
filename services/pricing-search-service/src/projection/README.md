# Lado escritura del CQRS — proyección al índice

Este servicio no es dueño de ningún dato. Todo lo que devuelve es un **read
model** derivado de tres fuentes que viven en otros servicios:

| Fuente | Servicio dueño | Cómo llega acá |
|---|---|---|
| Ficha técnica y mapeo de SKUs | `catalog-service` | evento `catalogo.producto_catalogado` |
| Precio de lista por fabricante | `import-service` | evento `precios.lista_actualizada` |
| Unidades libres por producto | `stock-service` | evento `stock.existencia_cambiada` |

## El documento proyectado

Un documento por **producto canónico**, con las ofertas de todos los fabricantes
que lo venden ya resueltas a costo unitario final y costo por Watt. Desnormalizar
así es lo que permite responder una búsqueda facetada con una sola consulta a
Elasticsearch, sin llamar a los otros tres servicios.

```json
{
  "sku": "HEL-PAN-550-JKM",
  "tipo": "panel",
  "modelo": "Tiger Neo 550W Bifacial",
  "potencia_w": 550,
  "tecnologia_celda": "topcon",
  "certificaciones": ["IEC 61215", "IEC 61730", "CE"],
  "multiplo_de_embalaje": 36,
  "ofertas": [
    {
      "fabricante": "Jinko Solar",
      "precio_lista": 85.00,
      "costo_unitario_final": 100.10,
      "costo_por_watt": 0.182,
      "unidades_libres": 1840,
      "dias_de_entrega": 45
    }
  ],
  "mejor_costo_por_watt": 0.182,
  "unidades_libres_total": 1840,
  "proyectado_en": "2026-10-09T14:22:05Z"
}
```

`mejor_costo_por_watt` y `unidades_libres_total` están precalculados a propósito:
son el criterio de ordenamiento y el filtro más usados, y calcularlos en consulta
obligaría a ordenar sobre un campo anidado.

## Sincronización del índice

El índice se actualiza **ante cada cambio en los datos fuente**, consumiendo los
eventos de dominio. No se reconstruye al momento de la búsqueda: una búsqueda
nunca dispara trabajo de indexación.

- **Retraso máximo tolerable: 60 segundos** entre el commit en el servicio dueño
  y la aparición del cambio en los resultados. Se mide con
  `helios_retraso_indice_segundos`, calculado como `proyectado_en` menos el
  `ocurrido_en` del evento, y se alerta si el p99 supera los 60 s.
- **Consumidor idempotente**: cada evento trae `id_mensaje`; se registra en
  `evento_consumido` antes de aplicar, así que una reentrega no duplica ofertas.
- **Orden**: los eventos de un mismo SKU se enrutan por la misma clave, y la
  escritura usa `version` del documento para descartar eventos viejos que lleguen
  después de uno nuevo.
- **Reconstrucción completa**: `POST /interno/indice/reconstruir` relee el estado
  de `catalog-service` y `stock-service` y reindexa desde cero contra un índice
  nuevo, que se expone con un alias cuando termina. Es el plan para cuando cambia
  el mapeo del índice o cuando se pierden eventos.
- **Mensajes no procesables**: después de 3 intentos el mensaje va a
  `helios.eventos.dlq` con el motivo. La cola muerta se revisa manualmente; un
  mensaje ahí no bloquea el resto de la proyección.

## Estado

| Archivo | Responsabilidad | Estado |
|---|---|---|
| `mapeo-indice.js` | mapping estricto, índice `helios-productos-v1` detrás del alias `helios-productos` | **Listo** |
| `proyector.js` | datos fuente → documento del índice (función pura) | **Listo** |
| `datos-demo.js` | carga inicial **provisoria** con productos y precios de demo | **Listo** |
| `consumidor-eventos.js` | suscripción a RabbitMQ, idempotencia, DLQ | Entrega 2 |
| `reconstruccion.js` | reindexado completo con alias | Entrega 2 |

### La carga de demo es provisoria

Mientras no exista la cadena de eventos, el índice se puebla al arrancar con
`CARGAR_DATOS_DEMO=true` (el valor por defecto en `docker compose`). Los
documentos se arman con el **mismo** `proyector.js` que va a usar el consumidor
de eventos, así que reemplazar la fuente no cambia lo que ve la búsqueda.

La carga usa `create`: no sobrescribe un documento que ya exista. Un reinicio no
pisa con precios de demo lo que haya proyectado un evento, y las dos instancias
la pueden correr a la vez.

### Costo de referencia en el índice

`costo_unitario_final` y `costo_por_watt` de cada oferta son un costo de
**referencia**: precio de lista menos la bonificación base del fabricante, más
IVA, **sin flete ni bonificación por volumen**. Sirve para ordenar el catálogo
y rankear fabricantes. La cotización recalcula con la cantidad y el destino
reales, que son los que definen esos dos términos.

El cálculo que alimenta la proyección (costo unitario final, costo por Watt y
ranking) ya está implementado y testeado en
[`../query/precios.js`](../query/precios.js).
