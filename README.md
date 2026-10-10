# Helios — Plataforma mayorista de equipamiento solar

Sistema de microservicios para un mayorista de paneles solares, inversores,
estructuras y baterías: importa listas de precios de múltiples fabricantes,
unifica el catálogo, compara el costo por Watt para encontrar al proveedor más
conveniente y gestiona el inventario con reservas transaccionales.

**Trabajo Práctico Integrador — Arquitectura de Software 2026, Universidad
Católica de Córdoba.**

## Grupo 11

| Integrante | Legajo |
|---|---|
| Federico Almada | *pendiente* |
| Joaquín Bonino | *pendiente* |
| Demetrio Rufeil | *pendiente* |
| Santino Vercesi | *pendiente* |

Repositorio: <https://github.com/matiasdemetriorufeil/grupo11-arqui-de-software>

---

## El problema que resuelve

Un mayorista de equipamiento solar le compra a cinco fabricantes que mandan sus
listas de precios en cinco formatos distintos, con cinco nomenclaturas de
producto distintas. Para saber a quién conviene comprarle hay que resolver tres
cosas que el software tiene que hacer bien:

1. **Unificar catálogos heterogéneos.** Un fabricante manda
   `Model No. | Pmax (W) | FOB Price USD/pc`, otro manda
   `CODIGO | POTENCIA | PRECIO UNIT.` con el encabezado en la fila 3 y coma
   decimal. Y el mes que viene cambian las columnas.
2. **Comparar costos de forma significativa.** Un panel de 550 W a USD 100 y uno
   de 580 W a USD 110 no se comparan por precio: se comparan por **costo por
   Watt**, después de bonificaciones por volumen, flete e impuestos.
3. **Comprometer stock sin equivocarse.** Un pallet reservado dos veces es un
   pedido que no se puede cumplir.

### El flujo principal

```
Fabricantes              Helios                            Cliente comercial
    │                       │                                     │
    │─ lista de precios ───>│ import-service                      │
    │  (CSV/XLSX)           │   normaliza y valida                │
    │                       │        ↓                            │
    │                       │ catalog-service                     │
    │                       │   unifica SKUs                      │
    │                       │        ↓                            │
    │                       │ pricing-search-service              │
    │                       │   costo por Watt + ranking   <──────│ 1. busca
    │                       │                              <──────│ 2. cotiza
    │                       │        ↓                            │
    │                       │ stock-service                       │
    │                       │   reserva transaccional      <──────│ 3. reserva
    │<── orden de ──────────│   + orden de reposición      <──────│ 4. confirma
    │    reposición         │        ↓                            │
    │                       │   proveedor de pagos (otro grupo)   │
```

La **acción principal** es reservar un pedido mayorista contra una cotización
vigente: una operación transaccional multi-línea con bloqueo de inventario,
cupos por cliente, precio congelado, vencimiento automático y generación de
órdenes de reposición. Las seis reglas que se validan están en
[`SPEC.md`](SPEC.md) § HU-04.

---

## Levantar el sistema

**Requisitos:** Docker y Docker Compose. Al menos **4 GB de RAM libres**
(Elasticsearch pide ~1 GB).

```bash
git clone https://github.com/matiasdemetriorufeil/grupo11-arqui-de-software.git
cd grupo11-arqui-de-software
docker compose up --build
```

Un solo comando, sin configuración previa: todas las variables tienen un valor
por defecto de desarrollo, y los esquemas de las tres bases se crean con datos de
demostración al arrancar.

Para generar credenciales locales propias en lugar de los valores por defecto:

```bash
./scripts/bootstrap.sh          # Linux / macOS / Git Bash
./scripts/bootstrap.ps1         # PowerShell
```

Crea un `.env` (ignorado por git) con un secreto JWT aleatorio.

### Verificar que quedó funcionando

```bash
./scripts/humo.sh
```

Comprueba el mock del contrato, la autenticación del gateway, la validación de
parámetros, el balanceo entre las dos instancias y la inicialización de las tres
bases.

### Apagar

```bash
docker compose down        # conserva los datos
docker compose down -v     # borra también los volúmenes
```

---

## Qué está disponible en local

| URL | Qué es |
|---|---|
| `http://localhost:8000` | **API Gateway** — el único punto de entrada del sistema |
| `http://localhost:4010/v1/**` | **Mock del contrato** publicado (Prism) |
| `http://localhost:8000/mock/v1/**` | El mismo mock, a través del gateway |
| `http://localhost:8001` | Kong Admin API *(sólo local)* |
| `http://localhost:8100/metrics` | Métricas del gateway, incluida la salud por instancia |
| `http://localhost:15672` | Consola de RabbitMQ *(`helios` / `helios_dev`)* |
| `http://localhost:9200` | Elasticsearch |

### Rutas del gateway

| Ruta | Va a | Auth |
|---|---|---|
| `/v1/proveedor/catalogo`, `/v1/proveedor/cotizaciones` | `pricing-search-service` *(balanceado)* | JWT |
| `/v1/proveedor/disponibilidad`, `/v1/pedidos/**` | `stock-service` | JWT |
| `/interno/catalogo/**` | `catalog-service` | JWT |
| `/interno/importaciones/**` | `import-service` | JWT |
| `/interno/stock/**` | `stock-service` | JWT |
| `/mock/**` | Mock del contrato | — |
| `/salud/{catalogo,precios,stock,importaciones}/**` | Salud de cada servicio | — |

### Probar el flujo publicado

El mock responde los ejemplos del contrato, incluidos los errores:

```bash
# Buscar en el catálogo
curl "http://localhost:4010/v1/proveedor/catalogo?tipo=panel&orden=costo_por_watt_asc" \
  -H "Authorization: Bearer token-de-prueba"

# Forzar el error de stock insuficiente
curl -X POST "http://localhost:4010/v1/pedidos/reservar" \
  -H "Authorization: Bearer token-de-prueba" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3d1a0d7c-8f52-4c64-9b6e-1f0a2e5c7d93" \
  -H "Prefer: code=409" \
  -d '{"cotizacion_id":"7f1c9d3e-5b42-4a1f-9d0e-2c7b8a6f4e11","lineas":[{"sku":"HEL-PAN-550-JKM","cantidad":108}]}'
```

Para llamar a los servicios reales hace falta un JWT firmado con
`HELIOS_JWT_SECRET`. `scripts/token.sh` genera uno de desarrollo:

```bash
TOKEN=$(./scripts/token.sh)
curl "http://localhost:8000/v1/proveedor/catalogo" -H "Authorization: Bearer $TOKEN" -i
```

---

## Los servicios

| Servicio | Responsabilidad | Almacén | Patrón interno |
|---|---|---|---|
| [`import-service`](services/import-service/) | Ingesta y normaliza listas de precios de fabricantes | MongoDB | Pipeline por etapas |
| [`catalog-service`](services/catalog-service/) | Catálogo canónico y mapeo de SKUs | PostgreSQL | Capas |
| [`pricing-search-service`](services/pricing-search-service/) | Costo por Watt, ranking y búsqueda facetada | Elasticsearch + Redis | CQRS |
| [`stock-service`](services/stock-service/) | Inventario, reservas transaccionales, reposición | PostgreSQL | Hexagonal + DDD |

Cada servicio es **dueño exclusivo de sus datos**: ninguno lee la base de otro.
El razonamiento está en
[`docs/adr/ADR-001`](docs/adr/ADR-001-limites-de-servicios.md).

`pricing-search-service` corre en **dos instancias** detrás del balanceador del
gateway, con health checks activos.

---

## Correr los tests

62 tests unitarios sobre las reglas de negocio, sin necesidad de infraestructura:

```bash
cd services/stock-service          && npm install && npm test   # 14 — reglas de la reserva
cd services/pricing-search-service && npm install && npm test   # 18 — costo por Watt y ranking
cd services/catalog-service        && npm install && npm test   # 10 — identidad de SKUs
cd services/import-service         && npm install && npm test   # 20 — normalización de planillas
```

O dentro de los contenedores, sin instalar Node:

```bash
docker compose run --rm --entrypoint npm stock-service test
```

Son testeables sin base de datos porque las reglas están aisladas en módulos
puros. Eso no es casualidad: es la razón por la que `stock-service` usa
arquitectura hexagonal.

---

## Documentación

| Documento | Qué contiene |
|---|---|
| [`SPEC.md`](SPEC.md) | Historias de usuario, reglas de negocio numeradas y criterios de aceptación |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Estrategia de ramas, revisiones e integración, con su justificación |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Diagramas C4, responsabilidades, comunicación, consistencia, resiliencia, observabilidad y **limitaciones conocidas** |
| [`docs/contracts/README.md`](docs/contracts/README.md) | **Guía para el grupo consumidor**: flujo, autenticación, idempotencia, tabla de errores y cómo probar contra el mock |
| [`docs/contracts/openapi.yaml`](docs/contracts/openapi.yaml) | Contrato formal OpenAPI 3.0.3, versión `1.0.0` |
| [`docs/adr/`](docs/adr/) | Decisiones arquitectónicas, una por archivo, con las alternativas evaluadas |

### Decisiones registradas

| # | Decisión | ADR |
|---|---|---|
| D1 | Límites de los servicios y propiedad de los datos | [ADR-001](docs/adr/ADR-001-limites-de-servicios.md) |
| D3 | Persistencia por servicio | [ADR-003](docs/adr/ADR-003-persistencia.md) |
| D5 | Comunicación síncrona y asíncrona | [ADR-005](docs/adr/ADR-005-comunicacion.md) |
| D8 | Contrato propio: diseño, publicación y versionado | [ADR-008](docs/adr/ADR-008-contrato-propio.md) |

El estado de las 13 decisiones obligatorias está en
[`docs/adr/README.md`](docs/adr/README.md).

---

## Integración entre grupos

**Capacidad que publicamos:** cotización y reserva de equipamiento solar.
Contrato en [`docs/contracts/`](docs/contracts/), mock operativo desde esta
entrega. Un grupo externo puede integrarse completo —incluidos los caminos de
error— sin que exista todavía nuestra implementación real.

**Capacidad que consumimos:** autorización de pagos. La llamada sale de
`stock-service`, que es el servicio dueño de la confirmación del pedido, y no del
frontend ni del gateway. Si el proveedor no responde, el pedido queda
`pendiente_de_pago` **conservando el stock reservado**.

---

## Estado del proyecto

**Entrega 1 — Diseño y contrato con mock.** Lo que ya funciona:

- `docker compose up --build` levanta 13 contenedores, todos con health check.
- Mock del contrato sirviendo los ejemplos y permitiendo forzar errores.
- Gateway con JWT, rate limiting, correlación de pedidos y balanceo con health
  checks activos — con failover verificado al detener una instancia.
- Esquemas de las tres bases, con restricciones que hacen imposible la sobreventa
  y los mapeos de SKU ambiguos, más datos de demostración.
- Las reglas de negocio de la reserva, el cálculo de costo por Watt, el ranking de
  fabricantes y la normalización de planillas: implementados y testeados.

Lo que falta y cuándo llega está en
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) § 14 y en [`SPEC.md`](SPEC.md) § 3.

**Los endpoints del contrato responden `501`** con un `problem+json` que apunta al
mock. Es deliberado: preferimos que el consumidor vea "esto todavía no existe,
usá el mock" antes que datos inventados por el servicio real, que serían
indistinguibles de una implementación con bugs.

---

## Notas sobre secretos

Ningún secreto de un entorno real está versionado.

- Lo que sí está en el repositorio son **valores por defecto de desarrollo**
  (`.env.example` y los defaults de `docker-compose.yml`): existen para que
  `docker compose up` funcione sin pasos previos y sólo son válidos dentro de la
  red de Docker en la máquina de quien levanta el proyecto. El secreto JWT de
  ejemplo se llama literalmente `dev-only-no-usar-en-la-nube`.
- `.env` está en `.gitignore`. `scripts/bootstrap.sh` genera uno con un secreto
  JWT aleatorio para quien no quiera usar el valor de ejemplo.
- La configuración del gateway **no contiene el secreto**:
  `api-gateway/kong.template.yml` tiene un marcador que se reemplaza en el
  arranque con la variable de entorno `HELIOS_JWT_SECRET`.
- En la nube, las variables se inyectan por el panel del proveedor y nunca por
  archivo.
