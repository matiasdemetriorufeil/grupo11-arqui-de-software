# Alcance y requisitos — Helios

Funcionalidades, reglas de negocio y criterios de aceptación del sistema.

Este documento es el contrato interno del equipo: lo que decimos acá es lo que
hay que poder demostrar. Los criterios de aceptación están escritos para ser
verificables, no para ser leídos.

| | |
|---|---|
| **Estado** | Entrega 1 — 9 de octubre de 2026 |
| **Arquitectura** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| **Decisiones** | [`docs/adr/`](docs/adr/) |
| **Contrato publicado** | [`docs/contracts/`](docs/contracts/) |

---

## 1. El negocio

Helios es un **mayorista de equipamiento solar**: compra paneles, inversores,
estructuras y baterías a varios fabricantes y los revende a clientes comerciales
— por ejemplo una cadena de tiendas que abastece sus depósitos y sucursales.

El negocio gana plata por diferencia de precio y por volumen. Eso impone tres
cosas al software:

1. **Comprarle al fabricante más barato**, lo que exige comparar precios que
   llegan en formatos incompatibles.
2. **No quedarse sin stock** de lo que más rota, lo que exige detectar el punto
   de reposición y reponer a tiempo.
3. **No vender lo que no tiene**, lo que exige que el compromiso de stock sea
   transaccional.

### Glosario

| Término | Qué es |
|---|---|
| **SKU canónico** | Identificador único de Helios para un producto (`HEL-PAN-550-JKM`). Unifica los códigos de los distintos fabricantes. Inmutable una vez publicado. |
| **Mapeo de SKU** | Relación entre el código propio de un fabricante y el SKU canónico. |
| **Perfil de mapeo** | Reglas versionadas que dicen cómo leer la planilla de un fabricante: qué columna es cada campo, separador decimal, fila de encabezado. |
| **Lote de importación** | Un archivo de lista de precios recibido de un fabricante, con su ciclo de vida. |
| **Costo unitario final** | Precio de lista menos bonificaciones, más flete prorrateado, más impuestos. Es lo que realmente cuesta una unidad puesta en destino. |
| **Costo por Watt** | Costo unitario final dividido por la potencia nominal. La métrica que vuelve comparables productos de distinta potencia. |
| **Unidad de embalaje** | Unidades por pallet. Toda compra mayorista es múltiplo de este valor. |
| **Existencia** | Stock de un producto en un depósito: cantidad física y cantidad reservada. |
| **Unidades libres** | Física menos reservada. Es lo único que se puede comprometer. |
| **Punto de reposición** | Umbral de unidades libres por debajo del cual hay que reponer. |
| **Cotización** | Precio firme por un conjunto de líneas y un destino, con vigencia de 15 minutos. |
| **Reserva** | Compromiso de stock contra una cotización vigente. Bloquea inventario. |
| **Cupo** | Límite de unidades que un cliente puede reservar en una ventana de tiempo. |

### La acción principal

**Reservar un pedido mayorista contra una cotización vigente.**

No es un ABM. Involucra restricciones (stock disponible, múltiplos de embalaje,
monto mínimo, cupo del cliente), estados (reservado → pendiente de pago →
confirmado / rechazado / cancelado / expirado), validaciones cruzadas (el pedido
tiene que coincidir con lo cotizado, la cotización tiene que estar vigente) y
consecuencias de negocio (bloqueo de inventario, precio congelado, vencimiento
automático, generación de órdenes de reposición y solicitud de cobro a un
proveedor externo).

---

## 2. Historias de usuario

### HU-01 — Importar una lista de precios de un fabricante

> Como **analista de compras**, quiero subir la planilla de precios que me mandó
> un fabricante y que el sistema la interprete sola, para no tener que copiar
> 5000 filas a mano ni corregir formatos.

**Reglas de negocio**

| # | Regla |
|---|---|
| R1.1 | Cada fabricante tiene un **perfil de mapeo versionado** que dice qué columna es cada campo, el separador decimal, la moneda y la fila de encabezado. |
| R1.2 | La fila cruda se guarda **tal como vino**, sin interpretar. Es la evidencia de qué recibimos. |
| R1.3 | El **formato decimal lo declara el perfil**, no se adivina. `1.234` vale 1,234 con separador `.` y 1234 con separador `,`. |
| R1.4 | Una fila sin **código de fabricante** o sin **precio interpretable** se marca con error e indica el nombre de la columna del fabricante donde falló. |
| R1.5 | Un lote con **más del 10 % de filas con error se rechaza completo**. No se aplica parcialmente. |
| R1.6 | El **mismo archivo no se importa dos veces**: se identifica por hash SHA-256. |
| R1.7 | Un lote aplicado publica `precios.lista_actualizada`. |

> **Por qué R1.5:** aplicar media lista deja el comparador en un estado peor que
> no haber importado nada, porque los productos que entraron compiten contra
> precios viejos de los que no entraron.

**Criterios de aceptación**

- [x] Dos planillas con columnas, separador decimal y fila de encabezado
      distintos se normalizan correctamente con su perfil. — *20 tests en
      `services/import-service/test/normalizador.test.js`*
- [x] `1.234` se interpreta como 1,234 o como 1234 según el separador del perfil.
- [x] `550`, `550W`, `550 Wp` y `0.55 kW` dan todos 550 W.
- [x] Una fila sin precio interpretable se rechaza nombrando la columna del
      fabricante (`FOB Price USD/pc`, no `precio_lista`).
- [x] Un lote con 25 % de filas con error se rechaza con el porcentaje en el motivo.
- [ ] Subir el mismo archivo dos veces devuelve el lote original. — *Entrega 2*
- [ ] Aplicar un lote publica el evento y el índice se actualiza. — *Entrega 2*

---

### HU-02 — Unificar el catálogo

> Como **analista de compras**, quiero que el mismo panel de cinco fabricantes
> distintos aparezca como un solo producto, para poder comparar precios.

**Reglas de negocio**

| # | Regla |
|---|---|
| R2.1 | Cada producto tiene un **SKU canónico** con formato `HEL-{TIPO}-{POTENCIA}-{MARCA}`. |
| R2.2 | El SKU es **inmutable una vez publicado**: el grupo consumidor lo tiene guardado en sus pedidos. |
| R2.3 | Un código de fabricante **no puede mapear a dos productos**. Garantizado por la base. |
| R2.4 | Los códigos se **normalizan** antes de comparar: `JKM550N 72HL4 BDV`, `jkm550n-72hl4-bdv` y `JKM550N--72HL4-BDV.` son el mismo. |
| R2.5 | Un **panel sin potencia** no se puede dar de alta: sin potencia no hay costo por Watt. Garantizado por la base. |
| R2.6 | Un producto que se deja de vender se marca `descontinuado`, **no se borra**. |
| R2.7 | Cada producto declara su **unidad de embalaje**. |

**Criterios de aceptación**

- [x] Seis escrituras distintas del mismo código de fabricante normalizan al
      mismo valor. — *10 tests en `services/catalog-service/test/skus.test.js`*
- [x] Dos códigos realmente distintos no se confunden.
- [x] Un panel se nombra por potencia en Watts y un inversor en kW.
- [x] "Jinko Solar" y "Jinko Solar Co. Ltd." generan la misma marca.
- [x] La base rechaza un SKU con formato inválido y un panel sin potencia. —
      *`CHECK` en `001_esquema.sql`, verificado al inicializar*
- [x] La base rechaza un segundo mapeo del mismo código del mismo fabricante. —
      *`UNIQUE (fabricante_id, codigo_fabricante)`*

---

### HU-03 — Comparar precios y buscar en el catálogo

> Como **vendedor**, quiero buscar paneles filtrando por potencia y ordenar por
> costo por Watt, para recomendar la opción más conveniente.

**Reglas de negocio**

| # | Regla |
|---|---|
| R3.1 | El **costo unitario final** se calcula en este orden: precio de lista → menos bonificación → más flete prorrateado entre las unidades del envío → más impuestos. |
| R3.2 | La **bonificación por volumen** es escalonada: 100 u → 1,5 %; 200 → 3 %; 500 → 4,5 %; 1000 → 6 %. Se acumula con la bonificación base del fabricante. |
| R3.3 | El **costo por Watt** es el costo unitario final sobre la potencia nominal. Un producto sin potencia no se compara por Watt. |
| R3.4 | El ranking **excluye a los fabricantes sin stock**: recomendar al más barato que no puede entregar no sirve. |
| R3.5 | Los **empates se resuelven de forma determinista**: costo por Watt, costo unitario, plazo de entrega, nombre. Dos consultas iguales dan el mismo orden. |
| R3.6 | La búsqueda soporta **paginación** (máx. 100), **filtros** (tipo, fabricante, rango de potencia, tecnología, costo por Watt máximo, sólo disponibles) y **ordenamiento**. |
| R3.7 | El índice se sincroniza **ante cada cambio en los datos fuente**, con un retraso máximo tolerable de **60 segundos**. Una búsqueda nunca dispara indexación. |
| R3.8 | La disponibilidad que muestra la búsqueda es **informativa**. El valor autoritativo se revalida al reservar. |

> **Por qué R3.5:** sin un criterio de desempate estable, dos búsquedas idénticas
> devuelven órdenes distintos y el vendedor no puede confiar en lo que ve.

**Criterios de aceptación**

- [x] Un panel de 550 W a USD 100 resulta más barato por Watt que uno de 580 W a
      USD 110. — *18 tests en `services/pricing-search-service/test/precios.test.js`*
- [x] Bonificación, flete e impuestos se aplican en el orden de R3.1.
- [x] Un fabricante sin stock queda fuera del ranking aunque sea el más barato.
- [x] El ranking es estable: invertir el orden de entrada no cambia el resultado.
- [x] La búsqueda rechaza `pagina=0` y un `orden` inválido, nombrando cada campo.
      — *verificado contra el servicio en ejecución*
- [x] Dos consultas equivalentes escritas distinto comparten clave de caché.
- [ ] Un cambio de precio aparece en los resultados en menos de 60 s. — *Entrega 2*
- [ ] La caché mejora la latencia de forma medible. — *Entrega 2*

---

### HU-04 — Reservar un pedido mayorista *(acción principal)*

> Como **sistema cliente**, quiero reservar equipamiento contra una cotización
> vigente, para asegurarme el stock y el precio mientras completo mi orden de compra.

**Reglas de negocio — se validan en este orden**

| # | Regla | Error |
|---|---|---|
| R4.1 | La cotización **existe, es del solicitante y está vigente** (15 min). | `409 COTIZACION_EXPIRADA` |
| R4.2 | El pedido **coincide línea por línea** con la cotización. | `422 LINEAS_NO_COINCIDEN` |
| R4.3 | Cada cantidad es **múltiplo de la unidad de embalaje**. | `422 CANTIDAD_NO_MULTIPLO_EMBALAJE` |
| R4.4 | El monto total alcanza el **mínimo mayorista**. | `422 MONTO_MINIMO_NO_ALCANZADO` |
| R4.5 | El solicitante no excede su **cupo vigente**. | `422 CUPO_CLIENTE_EXCEDIDO` |
| R4.6 | Hay **unidades libres suficientes** en el depósito asignado. | `409 STOCK_INSUFICIENTE` |

**Reglas de la operación**

| # | Regla |
|---|---|
| R4.7 | **Todo o nada.** Si una sola línea falla, no se reserva ninguna. |
| R4.8 | **Sin sobreventa.** Dos reservas concurrentes sobre el mismo producto se serializan; la segunda ve el stock ya comprometido. |
| R4.9 | **Idempotente** por `Idempotency-Key`. Reintentar con la misma clave y el mismo cuerpo devuelve la misma reserva, no crea una segunda. |
| R4.10 | **Precio congelado**: el cliente paga lo cotizado aunque la lista del fabricante cambie después. |
| R4.11 | La reserva **expira a los 15 minutos** sin confirmar y libera el stock. |
| R4.12 | Si la reserva deja una existencia **bajo el punto de reposición**, se genera una orden de reposición en la misma transacción. |
| R4.13 | Reservar **no baja el stock físico**: incrementa el reservado. El físico baja al despachar. |
| R4.14 | Toda variación de stock deja **asiento en el libro mayor**. |
| R4.15 | El error de stock insuficiente informa las **unidades libres reales** por línea. |

> **Por qué R4.2:** las bonificaciones por volumen se calculan sobre el pedido
> completo. Aceptar un pedido distinto del cotizado significaría vender a un
> precio que no se calculó para esa combinación de líneas.
>
> **Por qué R4.5:** en un pico de demanda, un solo cliente podría acaparar todo
> el stock disponible y dejar sin abastecimiento al resto de la cartera.

**Criterios de aceptación**

- [x] Un pedido que cumple las seis reglas se aprueba y congela el precio
      cotizado. — *14 tests en `services/stock-service/test/reserva.test.js`*
- [x] Una cotización vencida un segundo antes se rechaza.
- [x] Pedir 144 unidades de una cotización por 108 se rechaza.
- [x] 100 unidades de un producto con pallet de 36 se rechaza.
- [x] Un pedido por debajo del mínimo mayorista se rechaza.
- [x] Un pedido que excede el cupo se rechaza.
- [x] Pedir 108 unidades con 72 libres se rechaza **informando las 72**.
- [x] Con dos líneas y una sin stock, **no se devuelve plan parcial**.
- [x] Una reserva que deja la existencia bajo el punto de reposición genera la
      reposición, redondeada al lote y al embalaje.
- [x] `POST /v1/pedidos/reservar` sin `Idempotency-Key` devuelve `400` nombrando
      el header. — *verificado contra el servicio en ejecución*
- [x] La base impide `cantidad_reservada > cantidad_fisica`. — *`CHECK` en
      `001_esquema.sql`*
- [x] N reservas concurrentes sobre la misma existencia resultan en exactamente
      las que el stock permite. — *6 reservas simultáneas contra PostgreSQL en
      `repositorio-postgres.integracion.test.js`: pasa una, las otras cinco
      reciben `STOCK_INSUFICIENTE` con las unidades libres reales*
- [x] Reintentar con la misma clave devuelve la misma reserva con
      `Idempotency-Replayed: true`. — *verificado a través del gateway; dos
      reintentos simultáneos también crean una sola reserva*
- [x] El flujo cotizar → reservar → consultar funciona de punta a punta contra
      los servicios reales, a través del gateway.
- [x] Con `pricing-search-service` caído, la reserva responde `503` con
      `Retry-After` y no escribe nada. — *verificado deteniendo las dos instancias*
- [x] Una reserva no confirmada libera el stock a los 15 minutos. — *job de
      expiración cada 30 s; verificado de punta a punta con la vigencia en 1
      minuto. Dos jobs en paralelo liberan el stock una sola vez
      (`repositorio-postgres.integracion.test.js`)*
- [x] Un pedido `pendiente_de_pago` no vence: conserva el stock mientras se
      espera al proveedor de pagos (R5.6).

---

### HU-05 — Confirmar el pedido y cobrar

> Como **sistema cliente**, quiero confirmar mi reserva y que se procese el pago,
> para cerrar la compra.

**Reglas de negocio**

| # | Regla |
|---|---|
| R5.1 | Sólo se confirma un pedido en estado `reservado`. |
| R5.2 | No se puede confirmar una reserva **expirada**. |
| R5.3 | La autorización de pago se solicita al **proveedor externo**, desde `stock-service`. |
| R5.4 | Pago autorizado → `confirmado`. |
| R5.5 | Pago rechazado → `rechazado` y el stock se libera. |
| R5.6 | **Proveedor no disponible → `202` y el pedido queda `pendiente_de_pago` conservando el stock.** Degradar no significa perder la reserva. |
| R5.7 | Los reintentos al proveedor usan **siempre la misma clave de idempotencia**. |
| R5.8 | La confirmación es idempotente por `Idempotency-Key`. |

> **Por qué R5.6:** si liberáramos el stock cuando el proveedor de pagos no
> responde, una falla de un tercero le costaría la compra al cliente. El stock
> se conserva y el cliente ve "pago en verificación".

**Criterios de aceptación**

- [ ] Confirmar un pedido `reservado` con pago autorizado lo deja `confirmado`. — *Presentación*
- [ ] Un pago rechazado libera el stock. — *Presentación*
- [ ] Con el proveedor caído, el pedido queda `pendiente_de_pago` y **mantiene el
      stock**. — *Presentación / `POSTMORTEM.md`*
- [ ] Confirmar un pedido expirado devuelve `409 RESERVA_EXPIRADA`. — *Presentación*

---

### HU-06 — Reponer stock automáticamente

> Como **analista de compras**, quiero que el sistema me avise qué reponer y a
> qué fabricante conviene comprarlo, para no quedarme sin lo que más rota.

**Reglas de negocio**

| # | Regla |
|---|---|
| R6.1 | Se repone cuando las **unidades libres** quedan en o por debajo del punto de reposición. Se compara contra las libres, no contra el físico. |
| R6.2 | La cantidad se redondea **hacia arriba** al lote de compra y al múltiplo de embalaje. |
| R6.3 | El fabricante elegido es el de **mejor costo por Watt** con stock. |
| R6.4 | Si el ranking de precios **no está disponible**, la orden se registra sin fabricante y con `origen_del_precio = sin_ranking`. **No se aborta la reserva.** |
| R6.5 | **No se acumulan órdenes abiertas duplicadas** para el mismo producto y depósito. Garantizado por la base. |
| R6.6 | La detección publica `stock.bajo_minimo`. |

> **Por qué R6.4:** la reposición es importante pero secundaria. Hacer que una
> falla del servicio de precios tire abajo una reserva que el cliente ya tiene
> acordada sería dejar que un problema menor cause uno mayor.

**Criterios de aceptación**

- [x] `requiereReposicion` compara contra las unidades libres: 1000 físicas con
      400 reservadas y punto de reposición 720 **sí** requiere reposición. —
      *tests en `reserva.test.js`*
- [x] La cantidad a reponer se redondea al lote y al embalaje.
- [x] Una existencia sobre su punto de reposición no genera orden.
- [x] La base impide dos órdenes abiertas del mismo producto y depósito. —
      *índice único parcial*
- [x] La vista `existencia_disponible` marca `requiere_reposicion` correctamente.
      — *verificado: `HEL-PAN-540-LNG` con 144 libres y punto 360 → `true`*
- [x] Con el servicio de precios caído, la orden se registra con
      `origen_del_precio = sin_ranking` y la reserva se completa. —
      *`reservar-pedido.test.js` y `repositorio-postgres.integracion.test.js`*
- [x] Con el ranking disponible, la orden elige al fabricante de mejor costo
      por Watt. — *verificado de punta a punta: reservar 108 `HEL-PAN-540-LNG`
      genera una orden de 720 unidades a Longi con `origen_del_precio =
      ranking_vigente`*

---

### HU-07 — Publicar la capacidad a otro grupo

> Como **grupo proveedor**, quiero publicar un contrato formal y un mock, para
> que el grupo consumidor se integre sin depender de explicaciones nuestras.

**Reglas de negocio**

| # | Regla |
|---|---|
| R7.1 | El contrato es **OpenAPI 3.0.3 versionado** en el repositorio. |
| R7.2 | Documenta operaciones, datos, **errores**, autenticación, idempotencia, versión vigente y ejemplos. |
| R7.3 | El mock responde con los **ejemplos del contrato** y permite forzar errores. |
| R7.4 | Dentro de `/v1` sólo cambios **aditivos**. Un cambio incompatible abre `/v2`. |
| R7.5 | `/v1` se deprecia con **30 días de aviso** y headers `Deprecation`/`Sunset`. |
| R7.6 | Un `codigo` de error **nunca cambia de significado**. |
| R7.7 | La mock y la implementación real usan **la misma URL**. |

**Criterios de aceptación**

- [x] `docker compose up` deja el mock respondiendo el contrato en
      `localhost:4010/v1/**` y vía gateway en `localhost:8000/mock/v1/**`.
- [x] El mock devuelve los ejemplos del contrato para catálogo, cotización y reserva.
- [x] `Prefer: code=409` devuelve `STOCK_INSUFICIENTE` con `lineas_en_conflicto`.
- [x] El mock valida la autenticación declarada: sin `Authorization` devuelve el
      `401` del contrato.
- [x] Un `openapi.yaml` parseable y con los 7 paths declarados bajo `/v1`.
- [ ] URL pública operativa. — *Entrega 2*
- [ ] Test de contrato en CI. — *Entrega 2*

---

### HU-08 — Operar el sistema

> Como **responsable técnico**, quiero poder ver el estado del sistema y que una
> instancia caída no afecte el servicio.

**Reglas de negocio**

| # | Regla |
|---|---|
| R8.1 | **Punto de entrada único** con autenticación, enrutamiento y control de tráfico. |
| R8.2 | `pricing-search-service` corre en **al menos dos instancias** balanceadas. |
| R8.3 | El balanceador **detecta** una instancia no disponible y la saca del anillo. |
| R8.4 | Cada respuesta identifica **qué instancia** la atendió. |
| R8.5 | Todo log es **JSON estructurado** con `servicio`, `instancia` y `correlation_id`. |
| R8.6 | El readiness probe reporta el estado **real** de cada dependencia. |
| R8.7 | El sistema se levanta con **un solo comando**, sin pasos manuales. |
| R8.8 | **Ningún secreto en el repositorio.** |

**Criterios de aceptación**

- [x] `docker compose up --build` levanta los 13 contenedores y todos quedan
      `healthy`, sin configuración previa.
- [x] `/v1/**` sin JWT devuelve `401`; con JWT válido llega al servicio.
- [x] 10 peticiones se reparten 5 y 5 entre las dos instancias de
      `pricing-search-service` (cabecera `X-Instancia`).
- [x] Al detener `pricing-search-1`, Kong la marca `UNHEALTHY` en ~14 s y las 8
      peticiones siguientes van a `pricing-search-2`. Al reiniciarla, vuelve a
      `HEALTHY`.
- [x] `kong_upstream_target_health` expone el estado por instancia.
- [x] `/salud/lista` reporta el estado real de PostgreSQL y RabbitMQ.
- [x] El secreto JWT no está en el repositorio: `kong.template.yml` tiene un
      marcador que se reemplaza en el arranque.
- [ ] Tablero de observabilidad y alertas. — *Entrega 2*
- [ ] Trazas distribuidas del flujo principal. — *Entrega 2*

---

## 3. Alcance por entrega

### Entrega 1 — Diseño y contrato con mock *(esta entrega)*

| Requisito | Estado |
|---|---|
| `README.md` | Listo |
| Documentación de alcance (este archivo) | Listo |
| `docs/ARCHITECTURE.md` | Listo |
| Diagramas de contexto y contenedores | Listo (C4 en Mermaid) |
| Límites, responsabilidades y propiedad de los datos | Listo |
| Capacidad propia seleccionada y documentada | Listo |
| Estructura inicial de los servicios y dependencias | Listo, levanta y responde |
| Mock operativo del contrato | Listo (Prism) |
| D1 y D8 | Listos |
| Versiones iniciales de D3 y D5 | Listas |
| Puesta en marcha automatizada | Listo (`docker compose up --build`) |

**Extras no exigidos en esta entrega**, incluidos porque validan el diseño antes
de implementarlo:

- 62 tests unitarios de reglas de negocio, todos pasando.
- Esquemas de las tres bases con restricciones y datos de demostración.
- Gateway con JWT, rate limiting y balanceo con health checks **funcionando**.
- Dos instancias de `pricing-search-service` con failover verificado.

### Entrega 2 — Dominio de punta a punta (23 de octubre)

Adaptadores de persistencia y mensajería; flujo cotizar → reservar funcionando
contra base real; índice sincronizado por eventos; logs correlacionados y primera
traza distribuida; D2, D6, D7, D9, D10, D12, D13; validación de D1, D3 y D5;
primera versión de D11.

### Presentación grupal (11 o 13 de noviembre)

Frontend completo; capacidad propia desplegada en la nube con URL pública;
capacidad del proveedor incorporada al flujo principal; caché con medición
comparativa; evento de dominio publicado y consumido con consumidor idempotente y
DLQ; búsqueda indexada completa; `POSTMORTEM.md` de la caída controlada; tests de
carga.

---

## 4. Fuera de alcance

Explícitamente **no** se construye:

- Facturación y emisión de comprobantes fiscales.
- Logística de despacho y seguimiento de envíos.
- Gestión de usuarios y roles más allá de la autenticación del gateway.
- Compras reales a fabricantes (las órdenes de reposición se generan, no se envían).
- Pagos propios: se delega en el proveedor externo.
- Aplicación móvil.
- Multimoneda real con cotización en vivo (se modela `USD`/`ARS`, sin conversión
  automática).

---

## 5. Supuestos

1. Los fabricantes mandan listas de precios con una periodicidad de días, no de
   minutos.
2. El volumen de reservas es bajo (decenas por día), pero cada una es de alto
   valor. De ahí que optimicemos correctitud sobre throughput en la reserva.
3. El catálogo tiene cientos de productos, no millones.
4. Los clientes son comerciales y conocen el concepto de compra por pallet.
5. El proveedor externo de pagos responde en menos de 2 segundos en condiciones
   normales.
6. Un depósito por provincia alcanza: la asignación de depósito es simple.
