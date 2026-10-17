// ---------------------------------------------------------------------------
// Puertos de stock-service.
//
// Son los contratos que el dominio y los casos de uso exigen al exterior. Cada
// puerto se implementa en src/adapters/. Declararlos acá, en el centro, es lo
// que permite cambiar PostgreSQL por otra cosa, o el proveedor de pagos por el
// de otro grupo, sin tocar una sola regla de negocio.
//
// Están escritos como typedefs de JSDoc: documentan y dan autocompletado sin
// agregar un paso de compilación al proyecto.
// ---------------------------------------------------------------------------

/**
 * Operaciones disponibles dentro de una transacción ya abierta.
 * Todo lo que recibe el caso de uso de reserva pasa por acá.
 *
 * @typedef {object} TransaccionDeStock
 * @property {(skus: string[]) => Promise<object[]>} bloquearExistenciasPorSku
 *   SELECT ... FOR UPDATE sobre las existencias de esos SKUs, ordenado por
 *   (producto_id, deposito_id) para que el orden de bloqueo sea siempre el mismo.
 * @property {(consumidor: string) => Promise<{unidades_usadas: number, unidades_maximas: number}>} obtenerCupoVigente
 * @property {(datos: object) => Promise<object>} crearReserva
 * @property {(datos: {existencia_id: number, cantidad: number, reserva_id: string}) => Promise<void>} comprometerStock
 *   Incrementa `cantidad_reservada` y deja un asiento en `movimiento_stock`.
 * @property {(datos: {existencia_id: number, cantidad: number, reserva_id: string}) => Promise<void>} liberarStock
 * @property {(datos: object) => Promise<void>} registrarOrdenDeReposicion
 * @property {(evento: {tipo: string, clave_agregado: string, cuerpo: object}) => Promise<void>} encolarEvento
 *   Escribe en la tabla outbox, dentro de la transacción.
 * @property {(registro: object) => Promise<void>} registrarClaveIdempotencia
 */

/**
 * @typedef {object} RepositorioDeStock
 * @property {<T>(trabajo: (tx: TransaccionDeStock) => Promise<T>) => Promise<T>} enTransaccion
 *   Abre la transacción, la confirma si el trabajo termina bien y la revierte si
 *   lanza. El nivel de aislamiento es READ COMMITTED: alcanza porque la
 *   exclusión mutua la da el FOR UPDATE sobre las existencias.
 * @property {(sku: string) => Promise<{sku: string, cantidad_fisica: number, cantidad_reservada: number, multiplo_de_embalaje: number}|null>} existenciaPorSku
 *   Lectura SIN bloqueo de la existencia del depósito asignado. Sirve para
 *   consultas informativas: el valor autoritativo se relee bajo lock al reservar.
 * @property {(clave: string) => Promise<object|null>} buscarClaveIdempotencia
 * @property {() => Promise<object[]>} reservasVencidas
 *   Reservas en estado `reservado`/`pendiente_de_pago` cuyo `expira_en` ya pasó.
 *   Las consume el job de expiración, que libera el stock.
 */

/**
 * Cliente de pricing-search-service. Comunicación SÍNCRONA porque la reserva no
 * puede avanzar sin el precio firme.
 *
 * El adaptador agrega, en este orden: timeout por intento, un reintento sólo
 * para errores de red o 5xx (nunca para 4xx), y un circuit breaker que corta
 * después de N fallas consecutivas. Ver docs/adr/ADR-005-comunicacion.md.
 *
 * @typedef {object} ServicioDePrecios
 * @property {(cotizacionId: string, ctx: {consumidor: string}) => Promise<object|null>} obtenerCotizacion
 * @property {(sku: string) => Promise<{fabricante: string, costo_unitario: number, costo_por_watt: number, origen: 'ranking_vigente'|'ultimo_ranking_en_cache'}|null>} mejorFabricantePorCostoPorWatt
 *   Para la orden de reposición. Si el ranking no está disponible devuelve null:
 *   la reposición se registra sin fabricante en lugar de abortar la reserva.
 */

/**
 * Proveedor externo de pagos — capacidad consumida de otro grupo (D9).
 *
 * La llamada sale de este servicio, que es el dueño de la funcionalidad, y no
 * del frontend ni del gateway. El adaptador define timeout, reintentos
 * idempotentes y qué ve el cliente cuando el proveedor no responde: el pedido
 * queda en `pendiente_de_pago` conservando el stock, nunca se pierde la reserva.
 *
 * @typedef {object} ProveedorDePagos
 * @property {(datos: {pedido_id: string, monto: number, moneda: string, idempotency_key: string}) => Promise<{autorizado: boolean, comprobante?: string}>} autorizarPago
 */

/**
 * @typedef {object} PublicadorDeEventos
 * @property {() => void} vaciarOutboxEnSegundoPlano
 *   Dispara la publicación de los eventos pendientes sin bloquear la respuesta.
 * @property {() => Promise<number>} vaciarOutbox
 *   Publica los eventos pendientes y devuelve cuántos envió. Lo usa el job
 *   periódico y los tests de integración.
 */

export {};
