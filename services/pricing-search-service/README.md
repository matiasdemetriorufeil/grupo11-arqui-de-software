# pricing-search-service

Comparador de precios y motor de búsqueda. Convierte precios de lista
incomparables en un ranking por **costo por Watt**.

| | |
|---|---|
| **Puerto** | 3003 (instancia 1) y 3013 (instancia 2) en el host |
| **Almacén** | Elasticsearch 8.15 (índice) + Redis 7 (caché) |
| **Patrón interno** | CQRS con read model |
| **Expuesto por el gateway** | `/v1/proveedor/catalogo`, `/v1/proveedor/cotizaciones` *(balanceado)* |
| **Instancias** | **Dos**, con health checks activos en el gateway |

## Responsabilidad

Calcular el costo unitario final, rankear fabricantes, resolver búsquedas
facetadas y emitir cotizaciones firmes.

## No es dueño de ningún dato

Todo lo que sirve es **derivado** de los otros tres servicios:

| Fuente | Servicio dueño | Cómo llega |
|---|---|---|
| Ficha técnica y mapeo de SKUs | `catalog-service` | evento `catalogo.producto_catalogado` |
| Precio de lista por fabricante | `import-service` | evento `precios.lista_actualizada` |
| Unidades libres | `stock-service` | evento `stock.existencia_cambiada` |

Que el almacén sea reconstruible desde cero es una **propiedad**, no una
limitación: ante una corrupción del índice o un cambio de mapping, se reindexa.
Es también la razón por la que este es el servicio que se replica: si una
instancia se cae, la otra responde con el mismo índice.

## Por qué CQRS acá

```
src/
├── projection/     Lado ESCRITURA: evento → documento del índice
├── query/          Lado LECTURA: búsqueda y cotización
│   └── precios.js    cálculo de costo, costo por Watt, ranking (puro)
└── http/
    ├── rutas-busqueda.js   capacidad pública (contrato)
    ├── rutas-internas.js   API para otros servicios (no pasa por el gateway)
    └── rutas-metricas.js   métricas Prometheus
```

Separar proyección de consulta permite responder una búsqueda facetada con una
sola consulta a Elasticsearch, **sin llamar a los otros tres servicios**, y
escalar la lectura por separado. El costo aceptado es consistencia eventual, con
un retraso máximo tolerable de 60 segundos.

## El cálculo

El orden de aplicación importa y es la parte que hay que poder defender:

```
precio de lista
  − bonificación (base del fabricante + por volumen)
  + flete prorrateado entre las unidades del envío
  × (1 + impuestos)
  = costo unitario final
  ÷ potencia nominal
  = costo por Watt          ← el criterio de comparación
```

Bonificación por volumen, escalonada: 100 u → 1,5 %; 200 → 3 %; 500 → 4,5 %;
1000 → 6 %.

El ranking **excluye a los fabricantes sin stock** (recomendar al más barato que
no puede entregar no sirve de nada) y desempata de forma determinista por costo
por Watt → costo unitario → plazo de entrega → nombre, para que dos consultas
iguales devuelvan el mismo orden.

## Búsqueda

| | |
|---|---|
| **Paginación** | `pagina` / `tamanio_pagina` (máx. 100) |
| **Filtros** | tipo, fabricante, rango de potencia, tecnología de celda, costo por Watt máximo, sólo disponibles |
| **Ordenamiento** | `costo_por_watt_asc` (por defecto), `costo_por_watt_desc`, `potencia_w_desc`, `relevancia` |
| **Facetas** | conteos por fabricante y tecnología |
| **Retraso máximo del índice** | **60 segundos**, medido y alertado |

El índice se actualiza **ante cada cambio en los datos fuente**, consumiendo
eventos. Una búsqueda nunca dispara trabajo de indexación. Detalle en
[`src/projection/README.md`](src/projection/README.md).

## Cotizaciones

El precio sale del índice (read model), nunca de una llamada a otro servicio.
Por línea: precio de lista del fabricante elegido, menos su bonificación base
más la bonificación por volumen, más el flete prorrateado entre **todas** las
unidades, más IVA. La bonificación por volumen se calcula sobre el total de
unidades de la cotización (R4.2).

| | |
|---|---|
| **Vigencia** | 15 minutos (`vigente_hasta`) |
| **Almacén** | Redis, clave `cotizacion:{id}`, retenida 24 h para que un `GET` posterior responda `estado: expirada` y no `404` |
| **Dueño** | El consumidor que la pidió (cabecera `X-Consumer-Username` que agrega el gateway). Otro consumidor recibe `404` |
| **Total** | Suma exacta de los subtotales por línea: es lo que congela `stock-service` al reservar. Los impuestos se obtienen por diferencia para que el desglose cierre al centavo |
| **Flete** | Tabla por provincia en [`src/query/flete.js`](src/query/flete.js), desde el depósito de Córdoba. Simplificación documentada. Una provincia desconocida se rechaza con `400`: nunca se cobra un flete inventado |
| **Moneda** | Sólo USD: los fabricantes cotizan en USD y Helios no convierte monedas |
| **Si Redis falla** | `503` con `Retry-After`: una cotización que no se puede guardar no sirve para reservar |

## Caché

Cache-aside en Redis sobre la búsqueda de catálogo, que es el flujo de lectura
más pesado.

- **TTL 60 s**, igual al retraso tolerable del índice: la caché no puede ser más
  vieja que lo que el índice ya admite.
- **Clave normalizada**: parámetros ordenados, en minúsculas, vacíos descartados.
  Así dos consultas equivalentes escritas distinto comparten entrada y la tasa de
  aciertos que se mide es real.
- **Ante falla de Redis**, se consulta Elasticsearch directo. Un fallo de caché
  nunca convierte una lectura en un error.
- **Observable** en la cabecera `X-Cache` y en
  `helios_cache_busqueda_total{resultado}`.

## Las dos instancias

Cada respuesta lleva `X-Instancia`, que es la evidencia directa de la
distribución.

- **Tráfico externo:** upstream `precios-upstream` de Kong, round-robin, health
  checks activos cada 5 s sobre `/salud/viva`. Dos fallos sacan la instancia del
  anillo; un éxito la devuelve.
- **Tráfico interno:** las dos comparten el alias de red `precios-interno`, así
  que el DNS de Docker reparte las llamadas de otros servicios sin pasar por el
  gateway.

```bash
# Verificar el failover
docker compose stop pricing-search-1
curl "http://localhost:8001/upstreams/precios-upstream/health"
```

## Dependencias

| Dependencia | Tipo | Si falla |
|---|---|---|
| Elasticsearch | esencial para búsqueda | `503`; `/v1/proveedor/disponibilidad` sigue funcionando porque va contra `stock-service` |
| Redis | esencial para cotizar; opcional para la búsqueda | Cotizar responde `503`; la búsqueda consulta Elasticsearch directo |
| RabbitMQ | asíncrona | El índice se congela; los eventos esperan |

## Correr los tests

```bash
npm install && npm test        # sin infraestructura
```

Los de integración necesitan Elasticsearch. Usan un alias descartable, así que
no tocan el índice del servicio:

```bash
docker compose up -d elasticsearch
TEST_ELASTICSEARCH_URL=http://localhost:9200 npm run test:integracion
```

## Estado

| Parte | Estado |
|---|---|
| Cálculo de costo, costo por Watt y ranking | **Implementados y testeados** |
| Normalización de la clave de caché | Implementada y observable (`X-Clave-Cache`) |
| Validación de parámetros del contrato | Implementada |
| Endpoint de métricas Prometheus | Implementado |
| Dos instancias con failover | **Funcionando y verificado** |
| Índice en Elasticsearch (mapping, alias, carga de demo) | **Implementado y testeado contra Elasticsearch** |
| `GET /interno/ranking/{sku}` (para la reposición de `stock-service`) | **Implementado** |
| `POST` y `GET /v1/proveedor/cotizaciones` | **Implementados**: precio desde el índice, guardadas en Redis |
| `GET /v1/proveedor/catalogo` | Valida parámetros; responde `501` apuntando al mock |
| Proyección por eventos | Entrega 2 — ver [`src/projection/`](src/projection/README.md) |
