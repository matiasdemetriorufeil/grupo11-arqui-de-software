// ---------------------------------------------------------------------------
// Casos de uso de cotizaciones: emitir y consultar.
//
// Lado lectura del CQRS: el precio sale del índice (read model), nunca de una
// llamada a otro servicio. Lo único que se escribe es la cotización emitida,
// que es un dato propio de este servicio.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { errors } from '@elastic/elasticsearch';

import { ErrorDeDominio } from '../problema.js';
import { ALIAS_PRODUCTOS } from '../projection/mapeo-indice.js';
import { traducirErrorDeElasticsearch } from '../elasticsearch.js';
import { armarCotizacion, conEstadoActual } from './cotizacion.js';

/**
 * @param {object} args
 * @param {import('@elastic/elasticsearch').Client} args.es
 * @param {ReturnType<import('./repositorio-cotizaciones.js').crearRepositorioDeCotizaciones>} args.repositorio
 * @param {string} [args.alias]
 * @param {() => Date} [args.reloj]
 * @param {() => string} [args.generarId]
 */
export function crearCotizaciones({
  es,
  repositorio,
  alias = ALIAS_PRODUCTOS,
  reloj = () => new Date(),
  generarId = randomUUID,
}) {
  async function documentosDe(skus) {
    try {
      const { docs } = await es.mget({ index: alias, ids: [...new Set(skus)] });
      return new Map(docs.filter((d) => d.found).map((d) => [d._id, d._source]));
    } catch (err) {
      // Sin índice todavía (el servicio recién arranca): no se puede cotizar,
      // pero es transitorio.
      if (err instanceof errors.ResponseError && err.statusCode === 404) {
        throw new ErrorDeDominio('SERVICIO_NO_DISPONIBLE', 'El índice de productos todavía no está listo.');
      }
      return traducirErrorDeElasticsearch(err);
    }
  }

  return {
    async cotizar(solicitud, consumidor) {
      const documentosPorSku = await documentosDe(solicitud.lineas.map((l) => l.sku));
      const cotizacion = armarCotizacion({ solicitud, documentosPorSku, id: generarId(), ahora: reloj() });
      await repositorio.guardar(cotizacion, consumidor);
      return cotizacion;
    },

    async obtener(cotizacionId, consumidor) {
      const guardada = await repositorio.obtener(cotizacionId);
      // La cotización de otro consumidor no existe para éste: un 403 le
      // confirmaría que ese id es válido.
      if (!guardada || guardada.consumidor !== consumidor) {
        throw new ErrorDeDominio('NO_ENCONTRADO', 'No existe una cotización con ese identificador para este consumidor.');
      }
      return conEstadoActual(guardada.cotizacion, reloj());
    },
  };
}
