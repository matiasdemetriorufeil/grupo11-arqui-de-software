// ---------------------------------------------------------------------------
// Repositorio de cotizaciones sobre Redis.
//
// Decisión (punto abierto de ADR-003): Redis, no una tabla propia. Si Redis se
// reinicia y pierde una cotización vigente, el consumidor vuelve a cotizar; lo
// que no se puede perder es el precio de una reserva, y ese lo congela
// stock-service en su propia base al reservar.
//
// La clave dura más que la vigencia (24 h contra 15 min) para que un GET
// después del vencimiento responda `estado: expirada` y no un 404, como pide
// el contrato.
// ---------------------------------------------------------------------------

import { ErrorDeDominio } from '../problema.js';

const PREFIJO = 'cotizacion:';
const SEGUNDOS_DE_RETENCION = 24 * 60 * 60;

/**
 * @param {object} args
 * @param {import('redis').RedisClientType} args.redis
 */
export function crearRepositorioDeCotizaciones({ redis, segundosDeRetencion = SEGUNDOS_DE_RETENCION }) {
  return {
    /** Guarda la cotización junto con su dueño: sólo él la puede consultar. */
    async guardar(cotizacion, consumidor) {
      await conRedis(() =>
        redis.set(PREFIJO + cotizacion.cotizacion_id, JSON.stringify({ consumidor, cotizacion }), {
          EX: segundosDeRetencion,
        }),
      );
    },

    /** @returns {Promise<{consumidor: string, cotizacion: object}|null>} */
    async obtener(cotizacionId) {
      const guardada = await conRedis(() => redis.get(PREFIJO + cotizacionId));
      return guardada ? JSON.parse(guardada) : null;
    },
  };
}

/**
 * Cualquier falla de Redis acá es de disponibilidad: las operaciones son un
 * SET y un GET, no hay consulta que pueda estar mal armada.
 */
async function conRedis(operacion) {
  try {
    return await operacion();
  } catch {
    throw new ErrorDeDominio('SERVICIO_NO_DISPONIBLE', 'El almacén de cotizaciones no está disponible.');
  }
}
