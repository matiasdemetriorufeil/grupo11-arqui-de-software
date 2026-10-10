# ADR-001 — Límites de los servicios y propiedad de los datos

| | |
|---|---|
| **Decisión obligatoria** | D1 |
| **Estado** | Aceptada |
| **Fecha** | 2026-10-09 |
| **Entrega** | 1 |
| **Reemplaza a** | — |
| **Reemplazada por** | — |

## Contexto

Helios es un mayorista de equipamiento solar. El negocio tiene cuatro
capacidades que se comportan de forma muy distinta:

1. **Recibir listas de precios de fabricantes.** Llegan como archivos CSV/Excel,
   cada fabricante con sus columnas, su separador decimal y sus códigos de
   producto. Los formatos cambian sin aviso. El trabajo es por lotes, tolera
   latencia de minutos y falla seguido por datos sucios.
2. **Definir qué productos existen.** Un modelo relacional estable: productos,
   fabricantes, certificaciones, y el mapeo de los códigos de cada fabricante a
   un SKU canónico. Cambia poco y necesita integridad referencial estricta.
3. **Comparar precios y buscar.** Lectura intensiva, con filtros facetados,
   ordenamiento por costo por Watt y texto libre. Tolera datos de hasta un
   minuto de antigüedad. Es lo que más tráfico recibe.
4. **Comprometer stock.** Escritura con garantías fuertes: una reserva no puede
   duplicarse ni perderse, y dos clientes no pueden quedarse con el mismo pallet.
   Volumen bajo, consecuencias altas.

Estas cuatro cosas tienen patrones de acceso, requisitos de consistencia,
perfiles de carga y ritmos de cambio incompatibles entre sí. Meterlas en un
único servicio obliga a elegir un compromiso que es malo para todas.

El enunciado exige al menos tres microservicios y una api gateway, y al menos
dos servicios con patrones de arquitectura interna diferentes.

## Decisión

Cuatro microservicios, separados por **propiedad de los datos**: cada servicio
es el único que escribe en su almacén y la única autoridad sobre su parte del
dominio. Ningún servicio lee la base de otro.

| Servicio | Es dueño de | Decide sobre | Almacén |
|---|---|---|---|
| `import-service` | Lotes de importación, filas crudas, filas normalizadas, perfiles de mapeo | Si una lista de precios es aceptable y cómo se interpreta cada columna | MongoDB |
| `catalog-service` | Productos, fabricantes, certificaciones, unidad de embalaje, mapeos de SKU | Qué productos existen y qué código de fabricante corresponde a cuál | PostgreSQL |
| `pricing-search-service` | Índice de búsqueda, caché de consultas, cotizaciones emitidas | Cuánto cuesta algo puesto en destino y qué fabricante conviene | Elasticsearch + Redis |
| `stock-service` | Existencias, reservas, movimientos, órdenes de reposición, claves de idempotencia, cupos | Si una reserva se puede concretar y cuándo hay que reponer | PostgreSQL |

### Criterios usados para trazar los límites

1. **Un dueño por dato.** El criterio principal. Si dos servicios necesitaran
   escribir el mismo dato, el límite está mal trazado.
2. **Requisitos de consistencia homogéneos dentro del servicio.** `stock-service`
   necesita ACID en todas sus operaciones; `pricing-search-service` tolera
   consistencia eventual en todas. Un servicio que necesitara las dos cosas
   estaría mezclando dos problemas.
3. **Ritmo de cambio.** El catálogo cambia por semana, los precios por día, el
   stock por minuto. Separarlos permite desplegar lo que cambia seguido sin
   tocar lo que está estable.
4. **Perfil de carga.** La búsqueda es lectura masiva y se replica; la reserva es
   escritura serializada y no se replica. Separarlos permite escalar sólo lo que
   hace falta.
5. **Lenguaje del dominio.** "lote", "perfil de mapeo" y "fila cruda" sólo tienen
   sentido en importación. "existencia", "reserva" y "punto de reposición" sólo
   en inventario. Cuando el vocabulario no se cruza, el límite es natural.

### Relaciones entre servicios

```
import-service ──HTTP──> catalog-service        (resolver código → SKU canónico)
               ──evento─> pricing-search         (precios.lista_actualizada)

catalog-service ─evento─> pricing-search, stock  (catalogo.producto_catalogado)

stock-service  ──HTTP──> pricing-search          (cotización al reservar; ranking al reponer)
               ──HTTP──> proveedor de pagos      (capacidad externa, otro grupo)
               ──evento─> pricing-search         (stock.existencia_cambiada, pedido.*)
```

Las dependencias síncronas van en una sola dirección por caso de uso y no hay
ciclos. El detalle de timeouts, reintentos y degradación está en
[ADR-005](ADR-005-comunicacion.md).

### Identidad compartida sin base compartida

`stock-service` guarda `producto_id` y `sku` en sus tablas **sin clave foránea**:
son una réplica de la identidad que define `catalog-service`, mantenida por el
evento `catalogo.producto_catalogado`. Es la consecuencia directa de no compartir
base, y la aceptamos porque:

- el SKU es **inmutable una vez publicado** (el grupo consumidor lo tiene
  guardado en sus propios pedidos), así que la réplica no puede quedar
  inconsistente por una modificación;
- un producto que se descontinúa no se borra, se marca, así que no hay borrados
  en cascada que cruzar.

### Patrones internos por servicio

La elección responde al problema de cada uno, no a la uniformidad:

| Servicio | Patrón | Razón |
|---|---|---|
| `stock-service` | Hexagonal + DDD táctico | Tiene las reglas más densas y la operación crítica. Aislar el dominio permite testear las seis reglas de la reserva sin levantar PostgreSQL, y cambiar el adaptador del proveedor de pagos — que es de otro grupo y puede cambiar — sin tocar ninguna regla. |
| `pricing-search-service` | CQRS con read model | No es dueño de ningún dato: todo es derivado. Separar proyección de consulta permite responder búsquedas facetadas sin consultar a los otros tres servicios, y escalar la lectura por separado. |
| `import-service` | Pipeline por etapas | El trabajo es una transformación de varios pasos donde cada paso falla por sus propias razones y hay que reanudar desde donde se cortó. El estado del lote dice en qué etapa está. |
| `catalog-service` | Capas | Modelo relacional estable con invariantes que la base ya garantiza. Un hexágono acá sería ceremonia sin beneficio, y decidirlo explícitamente también es una decisión. |

## Alternativas evaluadas

### A. Un monolito modular

Un solo servicio con módulos internos bien separados, una sola base PostgreSQL.

- **A favor:** la reserva podría leer el catálogo y el precio en la misma
  transacción, sin consistencia eventual ni réplica de identidad. Mucho menos
  código de infraestructura. Es, honestamente, lo que elegiríamos para este
  tamaño de problema en un contexto real.
- **En contra:** no cumple el enunciado, que pide microservicios. Y obligaría a
  un solo motor de almacenamiento para los cuatro patrones de acceso, cuando
  las listas de precios semiestructuradas y la búsqueda facetada piden otra cosa.
- **Descartada** por requisito del trabajo práctico, y lo registramos para no
  sobrevender la arquitectura: el costo de los microservicios acá es real.

### B. Dos servicios: "catálogo y precios" + "operaciones"

Fusionar importación con catálogo y precios, y dejar stock aparte.

- **A favor:** menos servicios, menos eventos, menos superficie de falla. La
  importación y el catálogo comparten vocabulario parcial ("producto", "fabricante").
- **En contra:** la importación necesita un almacén sin esquema rígido y el
  catálogo necesita integridad estricta. Juntarlos fuerza a elegir uno: o se
  pierden las garantías del catálogo, o cada fabricante nuevo obliga a una
  migración de esquema. Además la búsqueda, que es lectura masiva, quedaría
  atada al despliegue del catálogo, que casi no cambia.
- **Descartada.** El conflicto de requisitos de persistencia es el argumento
  decisivo; está desarrollado en [ADR-003](ADR-003-persistencia.md).

### C. Separar "cotizaciones" como quinto servicio

Sacar la emisión de cotizaciones de `pricing-search-service`.

- **A favor:** una cotización es un documento con ciclo de vida (vigente,
  expirada, consumida), más parecido a un pedido que a un resultado de búsqueda.
- **En contra:** emitir una cotización es exactamente aplicar el cálculo de costo
  y el ranking que ya vive en `pricing-search-service`. Separarlos partiría ese
  cálculo en dos o lo duplicaría, y agregaría una llamada síncrona en el camino
  crítico de la reserva.
- **Descartada por ahora.** Si las cotizaciones ganan reglas propias — descuentos
  negociados por cliente, aprobaciones internas, vigencias distintas por
  segmento — la decisión se revisa y este ADR se reemplaza.

### D. Separar "reposición" de "inventario"

Dejar `stock-service` sólo con existencias y reservas, y mover las órdenes de
reposición a un servicio de compras.

- **A favor:** reponer es un proceso de compras, con proveedores y plazos, no de
  inventario.
- **En contra:** la orden de reposición se dispara **dentro de la transacción de
  la reserva**, en el momento en que el stock libre cruza el punto de reposición.
  Sacarla fuera obliga a coordinar dos servicios en la operación crítica o a
  aceptar que la reposición se pierda si falla el segundo paso.
- **Descartada para esta etapa.** Si la reposición crece hacia órdenes de compra
  reales con seguimiento de importación, se separa y se registra el cambio.

## Consecuencias

### Aceptamos

- **Consistencia eventual entre servicios.** El índice de búsqueda puede estar
  hasta 60 s atrasado respecto del stock real. Mitigado donde importa: la
  disponibilidad que muestra la búsqueda es informativa, y el valor autoritativo
  se revalida bajo lock al reservar. El índice informa; no decide.
- **Identidad replicada sin integridad referencial de base.** Ver arriba.
- **Infraestructura de mensajería como componente crítico.** Sin RabbitMQ el
  índice se congela. Mitigado con outbox transaccional: los eventos no se
  pierden, sólo se retrasan.
- **Un flujo de negocio atraviesa tres servicios** (cotizar → reservar →
  confirmar). Depurar eso necesita correlación de logs y trazas distribuidas, que
  pasan de ser deseables a obligatorias.
- **Cuatro repositorios de esquema y cuatro conjuntos de migraciones.**

### Ganamos

- Cada servicio elige el almacén que le corresponde (ver ADR-003).
- `pricing-search-service` se replica sin replicar el resto del sistema.
- Las reglas de la reserva se testean sin infraestructura, porque están aisladas
  en un dominio puro.
- Una lista de precios con formato roto no puede dejar el catálogo inconsistente:
  el daño queda contenido en `import-service`.

### Cómo se verifica

- **Propiedad de los datos:** ningún servicio tiene credenciales de la base de
  otro. Se puede comprobar leyendo las variables de entorno en
  `docker-compose.yml`: hay una `DATABASE_URL`/`MONGO_URL` por servicio y ninguna
  compartida.
- **Ausencia de ciclos síncronos:** las llamadas HTTP salientes declaradas en
  cada servicio forman un grafo dirigido acíclico (ver §5.1 de
  [`../ARCHITECTURE.md`](../ARCHITECTURE.md)).
- **Validación en la Entrega 2:** con los adaptadores conectados, una reserva
  concurrente sobre el mismo producto debe rechazar la segunda por stock
  insuficiente, y el índice debe reflejar el cambio en menos de 60 s.
