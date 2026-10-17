// ---------------------------------------------------------------------------
// Caso de uso: consultar un pedido.
//
// Devuelve la misma representación pública que la respuesta de la reserva
// (schema `Pedido` del contrato), leída de la base.
// ---------------------------------------------------------------------------

import { ErrorDeDominio } from '../problema.js';

/** Estados en los que el pedido todavía bloquea stock y por lo tanto vence. */
const ESTADOS_CON_VENCIMIENTO = new Set(['reservado', 'pendiente_de_pago']);

/**
 * @param {object} puertos
 * @param {import('./puertos.js').RepositorioDeStock} puertos.repositorio
 */
export function crearObtenerPedido({ repositorio }) {
  return async function obtenerPedido(pedidoId, consumidor) {
    const reserva = await repositorio.obtenerReserva(pedidoId);
    // El pedido de otro consumidor no existe para éste: un 403 le confirmaría
    // que ese id es válido.
    if (!reserva || reserva.consumidor !== consumidor) {
      throw new ErrorDeDominio('NO_ENCONTRADO', 'No existe un pedido con ese identificador para este consumidor.');
    }

    return {
      pedido_id: reserva.id,
      estado: reserva.estado,
      cotizacion_id: reserva.cotizacion_id,
      referencia_externa: reserva.referencia_externa,
      lineas: reserva.lineas.map((l) => ({
        sku: l.sku,
        cantidad: l.cantidad,
        deposito: l.deposito,
        precio_unitario_congelado: dinero(l.precio_unitario_congelado, reserva.moneda),
        subtotal: dinero(l.subtotal, reserva.moneda),
      })),
      total: dinero(reserva.total, reserva.moneda),
      creado_en: new Date(reserva.creado_en).toISOString(),
      expira_en: ESTADOS_CON_VENCIMIENTO.has(reserva.estado) ? new Date(reserva.expira_en).toISOString() : null,
    };
  };
}

/** Los numeric de PostgreSQL llegan como string; el contrato pide 2 decimales exactos. */
function dinero(monto, moneda) {
  return { monto: Number(monto).toFixed(2), moneda };
}
