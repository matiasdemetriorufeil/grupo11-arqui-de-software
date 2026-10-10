# ADR-008 — Diseño, publicación y versionado del contrato propio

| | |
|---|---|
| **Decisión obligatoria** | D8 |
| **Estado** | Aceptada |
| **Fecha** | 2026-10-09 |
| **Entrega** | 1 |
| **Reemplaza a** | — |
| **Reemplazada por** | — |

## Contexto

Tenemos que publicar una capacidad de Helios para que la consuma otro grupo, y
ese grupo tiene que poder integrarse **sin pedirnos explicaciones**. Eso impone
condiciones que no son negociables:

- El contrato tiene que ser formal, versionado y procesable por herramientas.
- Tiene que describir operaciones, datos de entrada y salida, errores,
  autenticación, idempotencia y versión vigente.
- Tiene que incluir ejemplos suficientes para implementar y probar.
- Tiene que haber una primera versión operativa en un entorno accesible desde
  esta entrega, antes de que exista la implementación real.
- La capacidad tiene que quedar incorporada a un flujo importante del consumidor:
  una llamada aislada sin consecuencias de negocio no cuenta.

Además, cuando empecemos a implementar vamos a descubrir cosas que nos van a dar
ganas de cambiar el contrato. El consumidor ya va a estar escribiendo código
contra él. Esa tensión es el problema central de esta decisión.

## Decisión

### Qué capacidad publicamos

**Cotización y reserva de equipamiento solar mayorista.** Es nuestra capacidad
central y la que tiene consecuencias de negocio reales: el consumidor que reserva
bloquea stock nuestro, y si confirma, nos obliga a entregar.

Cuatro operaciones en el flujo principal, más tres de soporte:

| Operación | Para qué | Servicio que la implementa |
|---|---|---|
| `GET /v1/proveedor/catalogo` | Descubrir productos: paginado, filtrado, ordenado por costo por Watt | `pricing-search-service` |
| `GET /v1/proveedor/disponibilidad` | Verificar una cantidad antes de cotizar (informativo) | `stock-service` |
| `POST /v1/proveedor/cotizaciones` | Obtener precio firme con vigencia acotada | `pricing-search-service` |
| `GET /v1/proveedor/cotizaciones/{id}` | Reconsultar una cotización | `pricing-search-service` |
| **`POST /v1/pedidos/reservar`** | **Reservar stock. Es la operación con consecuencias.** | `stock-service` |
| `GET /v1/pedidos/{id}` | Estado del pedido | `stock-service` |
| `POST /v1/pedidos/{id}/confirmar` | Confirmar y disparar el cobro | `stock-service` |
| `DELETE /v1/pedidos/{id}` | Cancelar y liberar el stock | `stock-service` |

Deliberadamente **no** publicamos el catálogo maestro ni las importaciones: son
detalles internos que atarían nuestro modelo de datos al consumidor.

### Formato: OpenAPI 3.0.3

[`../contracts/openapi.yaml`](../contracts/openapi.yaml). Elegimos 3.0.3 en lugar
de 3.1 porque el soporte de herramientas es mejor — en particular Prism, que es
lo que usamos para el mock, y los generadores de cliente que probablemente use el
grupo consumidor.

### Decisiones de diseño del contrato

**1. Dos pasos obligatorios: cotizar y después reservar.**
No se puede reservar enviando SKUs y cantidades sueltas; hace falta un
`cotizacion_id` vigente. Es más trabajo para el consumidor, y lo elegimos igual
porque resuelve tres cosas de una: el precio queda congelado y acordado antes de
comprometer stock, las bonificaciones por volumen se calculan sobre el pedido
completo (no línea por línea), y la vigencia de 15 minutos nos da una ventana
acotada de exposición al riesgo de precio.

**2. `Idempotency-Key` obligatorio en las escrituras.**
Un `POST /v1/pedidos/reservar` que se reintenta porque se cortó la red **no puede**
crear dos reservas. Lo hacemos obligatorio y no opcional: si fuera opcional, el
consumidor que lo omite tiene un bug latente y nosotros no tenemos forma de
protegerlo. Rechazar la llamada sin clave es más amable que duplicarle un pedido.

**3. Errores en `application/problem+json` (RFC 9457) con un campo `codigo`.**
`type` y `title` son para humanos; `codigo` es un identificador estable y
documentado contra el que el consumidor programa. Prometemos que un `codigo`
nunca cambia de significado: agregamos códigos nuevos, no reinterpretamos los
existentes.

**4. `reintentable` y `Retry-After` explícitos en cada error.**
El consumidor no tiene que inferir de un número de estado si vale la pena
reintentar. `409 STOCK_INSUFICIENTE` trae `reintentable: false` (reintentar no va
a crear stock); `503` trae `reintentable: true` y `Retry-After`.

**5. Montos como string decimal, no como número.**
`{"monto": "19872.00", "moneda": "USD"}`. Un `float` JSON no representa dinero sin
pérdida, y el redondeo de un flotante en el cliente puede producir un total
distinto del nuestro. El string es exacto y obliga a parsearlo con el tipo
correcto.

**6. `trace_id` en los errores.**
Cuando el consumidor reporta un problema, nos manda el `trace_id` y encontramos
la operación en nuestros logs. Evita el intercambio de "¿a qué hora fue?".

**7. SKU canónico opaco para el consumidor.**
El consumidor guarda `HEL-PAN-550-JKM` y no necesita saber cómo se construye.
Eso nos deja cambiar el criterio de generación sin romper nada, con una
condición que asumimos: **un SKU publicado es inmutable**.

**8. Errores con contexto accionable.**
`409 STOCK_INSUFICIENTE` incluye `lineas_en_conflicto` con las unidades libres
reales, y `422` incluye `errores_de_validacion` con el campo y el motivo. El
consumidor puede corregir y reintentar sin adivinar ni pedirnos ayuda.

### Autenticación

`Authorization: Bearer <JWT>` HS256, validado en el API Gateway antes de llegar a
cualquier servicio. El claim `iss` identifica al consumidor y es la clave con la
que Kong encuentra su credencial; `scope` acota qué puede hacer
(`catalogo:leer`, `cotizaciones:escribir`, `pedidos:escribir`). Rate limiting de
60 req/min por consumidor.

Los únicos endpoints sin autenticación son los de salud (`/salud/**`), que el
balanceador necesita sondear y que no exponen ningún dato del negocio.

La configuración del gateway **no contiene el secreto de firma**:
`api-gateway/kong.template.yml` tiene un marcador que se reemplaza en el arranque
con la variable de entorno `HELIOS_JWT_SECRET`. Lo que sí está versionado es el
valor por defecto de desarrollo (`dev-only-no-usar-en-la-nube`), que existe para
que `docker compose up` funcione sin pasos previos y no da acceso a nada: el
secreto real se inyecta por variable de entorno del proveedor en la nube, y
`scripts/bootstrap.sh` genera uno aleatorio para quien quiera trabajar en local
sin el valor de ejemplo.

### Publicación y mock

La capacidad se publica en tres niveles, en este orden:

1. **Contrato versionado en el repositorio** —
   [`../contracts/openapi.yaml`](../contracts/openapi.yaml) más
   [`../contracts/README.md`](../contracts/README.md) con la guía de uso, la
   tabla de errores y el comportamiento esperado del consumidor.
2. **Mock operativo (Entrega 1)** — Prism 4 sirviendo el mismo `openapi.yaml`:
   `http://localhost:4010/v1/**`, y a través del gateway en
   `http://localhost:8000/mock/v1/**`. Devuelve los ejemplos del contrato y
   permite forzar cualquier respuesta con el header `Prefer: code=409`. El grupo
   consumidor puede escribir y probar su integración completa contra el mock.
3. **Implementación real en la nube (Entrega 2)** — misma URL base, mismo
   contrato. Hasta entonces, los endpoints reales responden `501` con un
   `problem+json` que apunta explícitamente al mock, en lugar de devolver datos
   inventados que serían indistinguibles de una implementación con bugs.

**Los paths del contrato incluyen `/v1`** (`/v1/proveedor/catalogo`) en lugar de
dejarlo en el `basePath` de `servers`. Es una decisión práctica: Prism ignora el
base path de `servers` y serviría las rutas sin prefijo, con lo cual el mock y la
implementación real tendrían URLs distintas. Con el prefijo en el path, la URL es
idéntica en mock, local y producción. Encontrado y corregido probando el mock.

### Versionado y compatibilidad

**SemVer sobre la versión del contrato, con la major en la ruta.**

| Tipo de cambio | Qué se hace | Ejemplo |
|---|---|---|
| Agregar un endpoint | minor, dentro de `/v1` | `GET /v1/pedidos` |
| Agregar un campo **opcional** a una petición | minor | `destino.codigo_postal` |
| Agregar un campo a una respuesta | minor | `costo_por_watt` |
| Agregar un valor a un enum **de respuesta** | minor, documentado | nuevo estado de pedido |
| Corregir documentación o ejemplos | patch | — |
| Quitar o renombrar un campo | **major → `/v2`** | — |
| Volver obligatorio un campo opcional | **major → `/v2`** | — |
| Cambiar el tipo de un campo | **major → `/v2`** | — |
| Cambiar el significado de un `codigo` de error | **major → `/v2`** | — |

Compromisos con el consumidor:

- Dentro de `/v1`, **sólo cambios aditivos**. Un cliente escrito hoy sigue
  funcionando.
- Un `codigo` de error nunca cambia de significado. Pueden aparecer códigos
  nuevos, así que el consumidor debe tratar un código desconocido según el número
  de estado HTTP, no fallar.
- El consumidor debe **ignorar campos desconocidos** en las respuestas. Está
  dicho explícitamente en la documentación del contrato, porque es la condición
  que nos permite evolucionar sin romperlo.
- **Depreciación anunciada:** cuando `/v2` exista, `/v1` sigue operativo al menos
  30 días, respondiendo con headers `Deprecation` y `Sunset` (RFC 8594). No se
  apaga una versión sin aviso en los headers de las respuestas.
- `info.version` en el `openapi.yaml` es la fuente de verdad de la versión, y el
  changelog vive en [`../contracts/README.md`](../contracts/README.md).

**Si el contrato cambia antes de la Entrega 2**, este ADR se actualiza y el
cambio se registra en el changelog del contrato con su justificación. Si el
cambio es incompatible, se avisa al grupo consumidor antes de publicarlo.

## Alternativas evaluadas

### A. Versionar por header en lugar de por ruta

`Accept: application/vnd.helios.v1+json`.

- **A favor:** URLs limpias y permanentes; es lo que recomienda la ortodoxia REST.
- **En contra:** mucho más difícil de probar (no se puede pegar una URL en el
  navegador ni en un `curl` simple), el enrutamiento en Kong se complica, y el
  consumidor que olvida el header obtiene una versión por defecto que puede
  cambiar bajo sus pies. Para una integración entre dos grupos que se tienen que
  entender rápido, la versión visible en la URL es menos ambigua.
- **Descartada.**

### B. Reservar en un solo paso, sin cotización previa

`POST /v1/pedidos/reservar` con SKUs y cantidades, calculando el precio en el momento.

- **A favor:** la mitad de llamadas; integración más simple para el consumidor.
- **En contra:** el consumidor no sabría cuánto va a pagar hasta después de
  comprometerse, y nosotros tendríamos que calcular precio dentro de la
  transacción de reserva — alargando el tiempo con las filas de existencia
  bloqueadas, que es exactamente lo que no queremos. Además las bonificaciones por
  volumen no se pueden calcular línea por línea.
- **Descartada.** El costo de la llamada extra lo paga el consumidor una vez; el
  costo de bloquear filas mientras se calcula precio lo pagaríamos en cada reserva.

### C. Contrato basado en eventos (webhooks) en lugar de REST síncrono

Publicar eventos y que el consumidor reaccione.

- **A favor:** desacopla, absorbe picos, no requiere que estemos disponibles en el
  momento exacto.
- **En contra:** reservar stock **necesita** una respuesta inmediata. El cliente
  que arma un pedido tiene que saber ahora si tiene las unidades. Un contrato
  asíncrono trasladaría al consumidor la complejidad de esperar y conciliar.
- **Descartada para el flujo principal.** Queda como extensión futura:
  notificaciones de `pedido.estado_cambiado` por webhook, para que el consumidor
  se entere de un pago rechazado o una expiración sin hacer polling. Sería un
  cambio minor (aditivo) sobre `/v1`.

### D. GraphQL

- **A favor:** el consumidor pide exactamente los campos que necesita; una sola
  ruta.
- **En contra:** nuestra capacidad son cuatro operaciones bien definidas, no un
  grafo de datos para explorar. GraphQL agregaría complejidad de esquema, de
  caché y de rate limiting sin resolver ningún problema que tengamos. Y el mock
  automático a partir del esquema es mucho más pobre que lo que da Prism con
  OpenAPI.
- **Descartada.**

### E. No publicar mock, esperar a tener la implementación real

- **A favor:** menos trabajo ahora; el consumidor no se integra contra algo que
  puede cambiar.
- **En contra:** bloquea al grupo consumidor hasta la Entrega 2 y nos deja sin
  retroalimentación sobre el contrato hasta que ya sea caro cambiarlo. El mock es
  justamente el mecanismo para descubrir que el contrato está mal **antes** de
  implementarlo.
- **Descartada.** Y la decisión se validó sola: probar el mock reveló el problema
  del prefijo `/v1`, que habría significado un cambio incompatible si lo
  hubiéramos descubierto con el consumidor ya integrado.

## Consecuencias

### Aceptamos

- **El consumidor hace dos llamadas para reservar.** Documentado como el flujo
  obligatorio desde el primer párrafo del contrato.
- **Mantener dos cosas en sincronía durante la Entrega 2:** el contrato y la
  implementación. Mitigación: un test de contrato en CI que valide las respuestas
  reales contra el `openapi.yaml`, de forma que una divergencia rompa el build y
  no la integración del otro grupo.
- **Compromiso de compatibilidad.** Una vez publicado `/v1` no podemos quitarle
  campos. Si descubrimos un error de diseño grave, el costo es abrir `/v2` y
  mantener las dos.
- **Las cotizaciones tienen vigencia de 15 minutos**, lo que obliga al consumidor
  a manejar `409 COTIZACION_EXPIRADA` y recotizar. Es una regla de negocio real
  —no podemos congelar un precio indefinidamente— pero es trabajo para el otro
  grupo y hay que documentarlo bien.
- **El mock puede dar una falsa sensación de completitud.** Mitigación: el mock
  está etiquetado como tal en `servers`, y los endpoints reales responden `501`
  con un mensaje explícito en lugar de datos falsos.

### Ganamos

- El grupo consumidor puede implementar su integración completa **desde hoy**,
  incluidos los caminos de error, sin esperar nuestra implementación.
- El contrato es la fuente de verdad única: documentación, mock y tests salen del
  mismo archivo.
- La forma de los errores (`codigo` + `reintentable` + contexto) hace que el
  consumidor pueda construir su manejo de fallas sin negociar con nosotros caso
  por caso.

### Cómo se verifica

- **El mock responde el contrato:** `docker compose up` y
  `curl http://localhost:4010/v1/proveedor/catalogo -H "Authorization: Bearer <cualquiera>"`
  devuelve los ejemplos. Con `Prefer: code=409` devuelve el error de stock
  insuficiente con `lineas_en_conflicto`. Verificado.
- **El gateway exige JWT:** una llamada a `/v1/**` sin token devuelve `401`.
  Verificado.
- **Validación acorde al contrato:** `?pagina=0&orden=precio` devuelve `400` con
  un `errores_de_validacion` por campo; un `POST /v1/pedidos/reservar` sin
  `Idempotency-Key` devuelve `400` nombrando el header. Verificado.
- **Entrega 2:** test de contrato en CI y la URL pública operativa.
