// ---------------------------------------------------------------------------
// Caso de uso: reservar un pedido mayorista.
//
// Orquesta la operación crítica del sistema. No contiene reglas de negocio
// (están en src/domain/reserva.js) ni detalles de infraestructura (están en los
// puertos que recibe por parámetro).
//
// GARANTÍAS QUE TIENE QUE DAR (D4 — consistencia y concurrencia):
//
//   1. Atomicidad multi-línea — todo ocurre en UNA transacción: descuento de
//      stock libre, alta de reserva y líneas, asientos del libro mayor, órdenes
//      de reposición y registro de la clave de idempotencia. O todo, o nada.
//
//   2. Sin sobreventa — las existencias involucradas se bloquean con
//      SELECT ... FOR UPDATE antes de validar. Dos reservas concurrentes sobre
//      el mismo producto se serializan: la segunda ve el stock ya comprometido.
//      Además la restricción CHECK (cantidad_reservada <= cantidad_fisica) hace
//      imposible la sobreventa incluso ante un bug de este archivo.
//
//   3. Sin deadlocks — las filas se bloquean SIEMPRE en el mismo orden
//      (producto_id, deposito_id ascendente). Dos pedidos con las mismas líneas
//      en orden distinto no pueden quedarse esperando mutuamente.
//
//   4. Sin duplicados — la clave de idempotencia se inserta en la misma
//      transacción. Su PRIMARY KEY es lo que convierte un reintento en una
//      repetición de la respuesta original en lugar de una segunda reserva.
//
//   5. Eventos sin pérdida — los eventos de dominio se escriben en la tabla
//      outbox dentro de la transacción y un publicador los envía a RabbitMQ
//      después. Si el broker está caído, el evento no se pierde.
//
// Decisiones: docs/adr/ADR-005-comunicacion.md, SPEC.md § HU-04.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { ErrorDeDominio } from '../problema.js';
import { planificarReserva } from '../domain/reserva.js';

/** Monto mínimo de una orden mayorista, en la moneda de la cotización. */
const MONTO_MINIMO_POR_DEFECTO = 5000;

/**
 * @typedef {object} Puertos
 * @property {import('./puertos.js').RepositorioDeStock} repositorio
 * @property {import('./puertos.js').ServicioDePrecios} precios
 * @property {import('./puertos.js').PublicadorDeEventos} eventos
 * @property {() => Date} reloj
 */

/**
 * @param {Puertos} puertos
 * @returns {(solicitud: object) => Promise<{estado: number, cuerpo: object, repetida: boolean}>}
 */
export function crearReservarPedido({ repositorio, precios, eventos, reloj = () => new Date() }) {
  return async function reservarPedido({ consumidor, claveIdempotencia, cuerpo, correlationId }) {
    const huella = huellaDelCuerpo(cuerpo);

    // --- Paso 1: ¿esta operación ya se ejecutó? ----------------------------
    const previa = await repositorio.buscarClaveIdempotencia(claveIdempotencia);
    if (previa) {
      if (previa.huella_cuerpo !== huella) {
        // Misma clave, cuerpo distinto: el consumidor tiene un bug. Avisarlo es
        // más útil que devolverle la respuesta de otra operación.
        throw new ErrorDeDominio(
          'CLAVE_IDEMPOTENCIA_REUSADA',
          'La clave de idempotencia ya se usó con un cuerpo diferente.',
        );
      }
      return { estado: previa.estado_http, cuerpo: previa.respuesta, repetida: true };
    }

    // --- Paso 2: recuperar la cotización -----------------------------------
    // Llamada síncrona a pricing-search-service con timeout y circuit breaker
    // (el adaptador los implementa). Si el circuito está abierto no se degrada:
    // sin precio firme no se puede reservar, así que se devuelve 503.
    const cotizacion = await precios.obtenerCotizacion(cuerpo.cotizacion_id, { consumidor, correlationId });
    if (!cotizacion) {
      throw new ErrorDeDominio('NO_ENCONTRADO', 'La cotización no existe para este consumidor.');
    }

    // --- Paso 3: la transacción --------------------------------------------
    const resultado = await repositorio.enTransaccion(async (tx) => {
      // Orden estable de bloqueo: evita deadlocks entre pedidos concurrentes.
      const skus = [...new Set(cuerpo.lineas.map((l) => l.sku))].sort();
      const existencias = await tx.bloquearExistenciasPorSku(skus);
      const existenciasPorSku = new Map(existencias.map((e) => [e.sku, e]));

      const cupo = await tx.obtenerCupoVigente(consumidor);

      // Toda la decisión de negocio ocurre acá, sobre datos ya bloqueados.
      const decision = planificarReserva({
        cotizacion,
        lineasPedidas: cuerpo.lineas,
        existenciasPorSku,
        cupo,
        montoMinimo: Number(process.env.MONTO_MINIMO_ORDEN ?? MONTO_MINIMO_POR_DEFECTO),
        ahora: reloj(),
      });

      if (!decision.aprobada) {
        // Lanzar aborta la transacción: no queda nada a medias.
        throw errorDesdeDecision(decision);
      }

      const reserva = await tx.crearReserva({
        consumidor,
        cotizacion_id: cuerpo.cotizacion_id,
        referencia_externa: cuerpo.referencia_externa ?? null,
        moneda: decision.plan.moneda,
        total: decision.plan.total,
        expira_en: new Date(
          reloj().getTime() + Number(process.env.MINUTOS_VIGENCIA_RESERVA ?? 15) * 60_000,
        ),
        lineas: decision.plan.lineas,
      });

      // Compromiso del stock + asiento en el libro mayor, por línea.
      for (const linea of decision.plan.lineas) {
        await tx.comprometerStock({
          existencia_id: linea.existencia_id,
          cantidad: linea.cantidad,
          reserva_id: reserva.id,
        });
      }

      // Consecuencia de negocio: órdenes de reposición al fabricante más barato.
      for (const reposicion of decision.plan.reposiciones) {
        const mejor = await precios
          .mejorFabricantePorCostoPorWatt(reposicion.sku, { correlationId })
          .catch(() => null);
        await tx.registrarOrdenDeReposicion({
          ...reposicion,
          fabricante_elegido: mejor?.fabricante ?? null,
          costo_unitario: mejor?.costo_unitario ?? null,
          costo_por_watt: mejor?.costo_por_watt ?? null,
          // Se deja constancia de que el ranking no estaba disponible, en lugar
          // de abortar la reserva por una falla de una dependencia secundaria.
          origen_del_precio: mejor ? mejor.origen : 'sin_ranking',
        });

        await tx.encolarEvento({
          tipo: 'stock.bajo_minimo',
          clave_agregado: reposicion.sku,
          cuerpo: reposicion,
        });
      }

      await tx.encolarEvento({
        tipo: 'pedido.reservado',
        clave_agregado: reserva.id,
        cuerpo: { pedido_id: reserva.id, consumidor, total: decision.plan.total },
      });

      const respuesta = aRepresentacionPublica(reserva, decision.plan);

      // El registro de la clave va en la MISMA transacción que la reserva.
      await tx.registrarClaveIdempotencia({
        clave: claveIdempotencia,
        consumidor,
        operacion: 'POST /v1/pedidos/reservar',
        huella_cuerpo: huella,
        estado_http: 201,
        respuesta,
      });

      return respuesta;
    });

    // --- Paso 4: publicar lo que quedó en el outbox ------------------------
    // Fuera de la transacción y sin afectar la respuesta: si falla, el
    // publicador periódico reintenta. La reserva ya está confirmada.
    eventos.vaciarOutboxEnSegundoPlano();

    return { estado: 201, cuerpo: resultado, repetida: false };
  };
}

function errorDesdeDecision(decision) {
  // El primer error define el código HTTP; el resto viaja como detalle para que
  // el consumidor pueda corregir todo de una vez.
  const principal = decision.errores[0];
  const porStock = decision.errores.filter((e) => e.codigo === 'STOCK_INSUFICIENTE');

  return new ErrorDeDominio(principal.codigo, principal.detalle, {
    ...(porStock.length > 0
      ? {
          lineas_en_conflicto: porStock.map((e) => ({
            sku: e.campo,
            cantidad_solicitada: e.cantidad_solicitada,
            unidades_libres: e.unidades_libres,
          })),
        }
      : {}),
    errores_de_validacion: decision.errores
      .filter((e) => e.codigo !== 'STOCK_INSUFICIENTE')
      .map((e) => ({ campo: e.campo ?? 'pedido', mensaje: e.detalle })),
  });
}

function aRepresentacionPublica(reserva, plan) {
  return {
    pedido_id: reserva.id,
    estado: 'reservado',
    cotizacion_id: reserva.cotizacion_id,
    referencia_externa: reserva.referencia_externa,
    lineas: plan.lineas.map((l) => ({
      sku: l.sku,
      cantidad: l.cantidad,
      precio_unitario_congelado: { monto: l.precio_unitario_congelado.toFixed(2), moneda: plan.moneda },
      subtotal: { monto: l.subtotal.toFixed(2), moneda: plan.moneda },
    })),
    total: { monto: plan.total.toFixed(2), moneda: plan.moneda },
    creado_en: reserva.creado_en,
    expira_en: reserva.expira_en,
  };
}

function huellaDelCuerpo(cuerpo) {
  // Hash del cuerpo canonicalizado: detecta reuso de la clave con otro contenido.
  return createHash('sha256').update(JSON.stringify(cuerpo ?? {})).digest('hex');
}
