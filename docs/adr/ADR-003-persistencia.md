# ADR-003 — Persistencia por servicio

| | |
|---|---|
| **Decisión obligatoria** | D3 |
| **Estado** | Aceptada — versión inicial |
| **Fecha** | 2026-10-09 |
| **Entrega** | 1 (se valida con evidencia en la Entrega 2) |
| **Reemplaza a** | — |
| **Reemplazada por** | — |

## Contexto

Con los límites de [ADR-001](ADR-001-limites-de-servicios.md) trazados, cada
servicio elige su almacén. El enunciado pide al menos dos tipos distintos (uno
relacional y uno no relacional) y que la elección se justifique por patrones de
acceso, volumen, necesidad de consulta y garantías de consistencia — no por
cumplir el requisito.

Los cuatro servicios tienen necesidades claramente distintas:

| Servicio | Escrituras | Lecturas | Esquema | Consistencia |
|---|---|---|---|---|
| `import-service` | Ráfagas de miles de filas por lote, pocas veces al día | Por lote, para revisar errores | **Distinto por fabricante y cambiante** | Eventual alcanza |
| `catalog-service` | Pocas, con invariantes entre entidades | Por SKU y por código de fabricante | Estable, relacional | Integridad referencial estricta |
| `pricing-search-service` | Reproyección masiva por evento | **Búsqueda facetada, texto libre, ordenamiento, paginación** | Desnormalizado | Eventual, con retraso acotado |
| `stock-service` | Pocas pero críticas, concurrentes sobre las mismas filas | Por producto y depósito | Estable, relacional | **ACID, sin excepción** |

## Decisión

**Persistencia políglota: cada servicio tiene su almacén y nadie lee el del otro.**
Cinco almacenes en total, tres tecnologías.

### `import-service` → MongoDB 7

**La razón concreta:** las listas de precios no tienen un esquema común. Un
fabricante manda `Model No. | Pmax (W) | FOB Price USD/pc | Pcs/Pallet`, otro
manda `CODIGO | POTENCIA | PRECIO UNIT. | DTO % | BULTO` con el encabezado en la
fila 3 y coma decimal. Y el mes que viene cambian las columnas sin avisar.

Guardamos la fila cruda **tal como vino**, sin interpretarla, en la colección
`fila_cruda` — que a propósito **no tiene validador de esquema**. Eso nos permite:

- aceptar un archivo de un fabricante nuevo sin una migración de esquema previa;
- conservar la evidencia exacta de qué recibimos, para discutir con el fabricante
  cuando un precio no cierra;
- reprocesar un lote viejo con un perfil de mapeo nuevo, porque el original está
  intacto.

Donde el esquema **sí es nuestro** aplicamos validación: `lote_importacion`,
`fila_normalizada` y `perfil_mapeo` tienen `$jsonSchema` con `validationAction:
error`. "Schema-on-read" se aplica a los datos de terceros, no a los nuestros.

Índices que importan: `archivo.huella_sha256` **único y sparse** (el mismo
archivo no se importa dos veces: idempotencia de la ingesta),
`(fabricante, recibido_en desc)` para el panel, `(estado, recibido_en)` para que
el pipeline encuentre lo pendiente, y un TTL de 7 días sobre `evento_consumido`.

### `catalog-service` → PostgreSQL 16

**La razón concreta:** acá los invariantes son entre entidades, y queremos que la
base los garantice, no el código.

- Un producto pertenece a un fabricante que existe → clave foránea.
- Un código de fabricante no puede apuntar a dos productos →
  `UNIQUE (fabricante_id, codigo_fabricante)` en `mapeo_sku`. Esto es lo que hace
  **imposible** que una importación cree un mapeo ambiguo.
- Un panel sin potencia no se puede rankear por costo por Watt →
  `CHECK (tipo <> 'panel' OR potencia_w IS NOT NULL)`.
- El SKU tiene un formato que el contrato publica →
  `CHECK (sku ~ '^HEL-[A-Z]{3}-[A-Z0-9-]{3,20}$')`.

Son invariantes que un documento no puede imponer y que, si se violan, rompen el
comparador de precios de forma silenciosa.

Detalles aplicados: identificadores en minúsculas (sin comillas en las consultas),
`timestamptz` en lugar de `timestamp`, `bigint generated always as identity` en
lugar de `serial`, índices explícitos sobre las claves foráneas (PostgreSQL no los
crea solo) e índice parcial `(tipo, potencia_w) WHERE estado = 'activo'`, porque
las consultas siempre filtran por activo.

### `pricing-search-service` → Elasticsearch 8.15 + Redis 7

**La razón concreta:** el requisito es búsqueda facetada con texto libre,
múltiples filtros de rango, ordenamiento y conteos por faceta. Eso es lo que hace
un motor de búsqueda y lo que una base relacional hace mal.

Este servicio **no es dueño de ningún dato**: su índice es un read model derivado
de los otros tres servicios (ver [ADR-005](ADR-005-comunicacion.md)). Que el
almacén sea reconstruible desde cero es una propiedad, no una limitación: ante
una corrupción del índice o un cambio de mapping, se reindexa.

- **Elasticsearch** guarda un documento por producto canónico con las ofertas de
  cada fabricante anidadas y ya resueltas a costo por Watt. `mejor_costo_por_watt`
  y `unidades_libres_total` están **precalculados** porque son el criterio de
  orden y el filtro más usados; calcularlos en consulta obligaría a ordenar por un
  campo anidado.
- **Redis** es la caché cache-aside de las respuestas de búsqueda, con TTL de 60 s
  —igual al retraso tolerable del índice, porque la caché no puede ser más vieja
  que lo que el índice ya admite— y política `allkeys-lru` con `maxmemory` acotada.
  Sin persistencia (`--save '' --appendonly no`): es caché, no almacén. Si se
  pierde, se recalcula.

### `stock-service` → PostgreSQL 16

**La razón concreta:** es la única operación del sistema que no puede
equivocarse. Necesitamos transacciones multi-fila, bloqueo explícito de filas
(`SELECT ... FOR UPDATE`), restricciones `CHECK` e `UNIQUE` que valgan bajo
concurrencia. Eso es exactamente lo que da un motor relacional con ACID.

Lo que la base garantiza por sí sola, sin confiar en el código de aplicación:

| Garantía | Mecanismo |
|---|---|
| Nunca se reserva más de lo que hay | `CHECK (cantidad_reservada <= cantidad_fisica)` |
| Una fila de existencia por producto y depósito | `UNIQUE (producto_id, deposito_id)` |
| No hay dos reservas con la misma clave de idempotencia | `PRIMARY KEY` en `clave_idempotencia` |
| No se acumulan órdenes de reposición abiertas duplicadas | índice único parcial `(producto_id, deposito_id) WHERE estado IN ('sugerida','emitida')` |
| Un estado terminal no queda con vencimiento pendiente | `CHECK` de coherencia sobre `estado`/`expira_en`/`cerrado_en` |

Decisiones de modelado:

- **`cantidad_fisica` y `cantidad_reservada` separadas.** El stock libre es la
  resta. Reservar no baja el físico (la mercadería sigue en el depósito); baja al
  despachar. Modelarlo con un solo número obligaría a inventar movimientos falsos.
- **Libro mayor `movimiento_stock`, append-only.** Toda variación deja asiento.
  Permite auditar y reconstruir cualquier saldo, y es la evidencia concreta de que
  no se perdió ni duplicó información.
- **Dinero en `numeric(14,2)`**, nunca `float`. Un redondeo de punto flotante en
  un total de pedido es un error de facturación.
- **Índices parciales para los jobs:** `WHERE estado IN ('reservado',
  'pendiente_de_pago')` sobre `expira_en` para el job de expiración, y
  `WHERE cantidad_fisica - cantidad_reservada <= punto_de_reposicion` para el de
  reposición. Los índices parciales son chicos porque la mayoría de las filas no
  califican.

### Dos bases PostgreSQL, no una con dos esquemas

`postgres-catalog` y `postgres-stock` son **instancias separadas**, no dos
esquemas de la misma. Una sola instancia con dos esquemas sería más barata en
recursos, pero permitiría físicamente que un servicio consultara las tablas del
otro con un `JOIN`, y ese atajo tarde o temprano se toma. Separar las instancias
hace que el acoplamiento sea imposible, no sólo desaconsejado. Cada servicio sólo
tiene credenciales de la suya.

## Alternativas evaluadas

### A. PostgreSQL para todo, con `JSONB` para las listas de precios

Una sola tecnología, usando `JSONB` donde el esquema es variable y
`tsvector`/`pg_trgm` para la búsqueda.

- **A favor:** una tecnología menos que operar, una menos que aprender, y
  transacciones entre lo que hoy son servicios distintos. Es una alternativa
  seria: `JSONB` con índices GIN cubre bien el caso semiestructurado.
- **En contra:** la búsqueda es lo que no cierra. Facetas con conteos, relevancia
  sobre texto libre y ordenamiento por un campo derivado se pueden hacer en
  PostgreSQL, pero a costa de consultas que no escalan en el patrón de lectura
  que esperamos (es lo primero que hace el consumidor y lo que el frontend
  consulta en cada cambio de filtro). Y el requisito de "motor de búsqueda" del
  enunciado apunta explícitamente a otra cosa.
- **Descartada**, aunque reconocemos que para un volumen chico `JSONB` +
  `pg_trgm` sería suficiente y más simple. Si en la Entrega 2 las pruebas de carga
  muestran que el volumen real es bajo, esta alternativa vuelve a la mesa.

### B. MongoDB para todo

- **A favor:** un solo motor; el modelo de documento se adapta a casi todo.
- **En contra:** la reserva necesita bloquear filas específicas y validar
  invariantes bajo concurrencia. MongoDB tiene transacciones multi-documento desde
  la 4.0, pero no `SELECT ... FOR UPDATE` con el mismo control, y las restricciones
  `CHECK` que hoy nos garantizan la ausencia de sobreventa no tienen equivalente.
  Poner la operación crítica del sistema en el motor que menos garantías le da es
  la peor decisión disponible.
- **Descartada.**

### C. Meilisearch en lugar de Elasticsearch

- **A favor:** mucho más liviano (arranca en segundos, ~100 MB de RAM contra ~1 GB),
  configuración mínima, facetas y filtros listos sin tocar un mapping. Para una
  demo en una laptop es claramente mejor.
- **En contra:** menos control sobre el scoring y el análisis de texto, y menos
  flexibilidad para documentos anidados como nuestras ofertas por fabricante.
- **Descartada, con reserva.** Elegimos Elasticsearch por el control sobre
  documentos anidados y porque es la herramienta que se trabaja en la materia.
  **Si el consumo de memoria resulta un problema en las máquinas del equipo o en
  el despliegue en nube, migrar a Meilisearch es una decisión de bajo costo**
  (el índice se reconstruye por definición) y se registraría reemplazando este ADR.

### D. Redis como almacén de las cotizaciones, no sólo como caché

- **A favor:** una cotización tiene vigencia de 15 minutos; un TTL de Redis es la
  expresión natural de eso.
- **En contra:** si Redis se reinicia, se pierden las cotizaciones vigentes y los
  consumidores que estaban a punto de reservar reciben `409 COTIZACION_EXPIRADA`
  sin motivo. Y perdemos la trazabilidad de qué cotizamos, que es información
  comercial útil.
- **Pendiente.** Es el punto abierto de esta decisión: ver "Qué queda por
  resolver".

### E. Base compartida entre `catalog-service` y `stock-service`

Ambos usan PostgreSQL y `stock-service` replica `producto_id`/`sku`.

- **A favor:** eliminaría la réplica de identidad y permitiría una clave foránea
  real, con integridad garantizada por la base.
- **En contra:** rompe la propiedad de los datos de ADR-001 y acopla los
  despliegues: una migración del catálogo pasaría a ser una migración del stock.
- **Descartada.** La réplica de identidad es un costo acotado y conocido; la base
  compartida es un acoplamiento que crece.

## Consecuencias

### Aceptamos

- **Tres tecnologías de almacenamiento y cinco instancias que operar**, con sus
  respaldos, actualizaciones y monitoreo. Es el costo directo de la decisión.
- **Elasticsearch pide memoria.** Con `-Xms512m -Xmx512m` funciona, pero es el
  contenedor más pesado del compose y en máquinas con poca RAM es el primero que
  molesta. Documentado en el README como requisito.
- **Ninguna consulta puede cruzar servicios.** Un informe que combine precio y
  stock se arma en el read model de `pricing-search-service` o en la capa de
  aplicación, nunca con un `JOIN`.
- **No hay transacciones distribuidas.** Lo que necesita atomicidad real está
  todo dentro de `stock-service` (ver [ADR-005](ADR-005-comunicacion.md) y la
  §8 de [`../ARCHITECTURE.md`](../ARCHITECTURE.md)).
- **Cuatro juegos de migraciones** con convenciones distintas.

### Ganamos

- La operación crítica tiene las garantías que necesita, impuestas por la base y
  no por el código.
- Un fabricante con una planilla nueva no requiere una migración de esquema.
- La búsqueda facetada es una consulta simple sobre un documento desnormalizado.
- El índice y la caché son reconstruibles: perderlos es una molestia, no una
  pérdida de datos.

### Cómo se verifica

Ya verificado en esta entrega (`docker compose up` deja los tres almacenes
inicializados):

- **PostgreSQL catálogo:** 6 tablas en el esquema `catalogo`, 5 productos de demo
  con sus mapeos de SKU.
- **PostgreSQL stock:** 6 existencias de demo; la vista `existencia_disponible`
  marca correctamente `requiere_reposicion = true` para `HEL-PAN-540-LNG`
  (144 libres contra un punto de reposición de 360).
- **MongoDB:** colecciones con validador creadas y los dos perfiles de mapeo
  cargados, con separadores decimales distintos (`.` y `,`).
- **Elasticsearch y Redis:** sondeados por el readiness probe de
  `pricing-search-service` (`/salud/lista` reporta ambos como disponibles).

Pendiente para la Entrega 2 (evidencia de que la elección era correcta):

- Prueba de concurrencia real: N reservas simultáneas sobre la misma existencia
  deben resultar en exactamente las que el stock permite.
- Medición del retraso de proyección del índice contra el objetivo de 60 s.
- Medición comparativa de latencia de búsqueda con y sin caché.

## Qué queda por resolver

1. **Dónde viven las cotizaciones.** Hoy `pricing-search-service` las emite pero
   no están persistidas de forma durable. Hay que decidir entre Redis con TTL
   (natural para la vigencia, pero volátil) y una tabla propia (durable y
   trazable, pero agrega un almacén relacional a un servicio que no tenía
   ninguno). Impacta en qué pasa con una cotización si el servicio reinicia.
   **Se resuelve en la Entrega 2 y actualiza este ADR.**
2. **Herramienta de migraciones.** Hoy el esquema se crea con los scripts de
   `docker-entrypoint-initdb.d`, que sólo corren en una base vacía. Para la
   Entrega 2 hace falta una herramienta de migraciones versionadas por servicio.
3. **Respaldos.** Sin definir para el despliegue en nube.
