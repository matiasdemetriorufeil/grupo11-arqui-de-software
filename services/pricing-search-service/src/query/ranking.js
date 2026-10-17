// ---------------------------------------------------------------------------
// Consulta: mejor fabricante de un producto por costo por Watt.
//
// Lado lectura del CQRS. Lee el documento proyectado del producto y aplica el
// mismo ranking que usa la cotización (elegirFabricante), así que "a quién le
// conviene comprar" responde igual en los dos lugares.
//
// Consumidor: stock-service, para elegir el fabricante de una orden de
// reposición (SPEC R6.3). Ver services/stock-service/src/adapters/precios-http.js.
// ---------------------------------------------------------------------------

import { errors } from '@elastic/elasticsearch';

import { ALIAS_PRODUCTOS } from '../projection/mapeo-indice.js';
import { traducirErrorDeElasticsearch } from '../elasticsearch.js';
import { elegirFabricante } from './precios.js';

/**
 * @param {object} args
 * @param {import('@elastic/elasticsearch').Client} args.es
 * @param {string} [args.alias]
 * @returns {(sku: string) => Promise<{sku: string, fabricante: string, costo_unitario_final: number, costo_por_watt: number|null, motivo: string}|null>}
 *   null si el producto no está indexado o nadie lo vende con stock.
 */
export function crearConsultaDeRanking({ es, alias = ALIAS_PRODUCTOS }) {
  return async function mejorFabricante(sku) {
    let documento;
    try {
      documento = (await es.get({ index: alias, id: sku }))._source;
    } catch (err) {
      if (err instanceof errors.ResponseError && err.statusCode === 404) return null;
      return traducirErrorDeElasticsearch(err);
    }

    // rankearOfertas compara por `costo_unitario`; en el índice se llama
    // `costo_unitario_final` porque es lo que el documento expone.
    const elegido = elegirFabricante(
      documento.ofertas.map((o) => ({ ...o, costo_unitario: o.costo_unitario_final })),
    );
    if (!elegido) return null;

    return {
      sku: documento.sku,
      fabricante: elegido.oferta.fabricante,
      costo_unitario_final: elegido.oferta.costo_unitario_final,
      costo_por_watt: elegido.oferta.costo_por_watt,
      motivo: elegido.motivo,
    };
  };
}
