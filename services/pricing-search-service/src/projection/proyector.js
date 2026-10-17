// ---------------------------------------------------------------------------
// Proyector: arma el documento del índice a partir de los datos fuente.
//
// Función pura. Recibe la ficha técnica (de catalog-service) y las ofertas de
// los fabricantes (precios de import-service, stock de stock-service) y devuelve
// el documento desnormalizado que se indexa. La usan la carga de datos de demo
// y, más adelante, el consumidor de eventos: los dos producen el MISMO
// documento, así que cambiar la fuente no cambia lo que ve la búsqueda.
// ---------------------------------------------------------------------------

import { calcularCostoPorWatt, calcularCostoUnitarioFinal } from '../query/precios.js';

/**
 * @param {object} args
 * @param {{sku: string, tipo: string, modelo: string, potencia_w?: number|null, tecnologia_celda?: string|null, certificaciones?: string[], multiplo_de_embalaje: number}} args.ficha
 * @param {Array<{fabricante: string, moneda: string, precio_lista: number, bonificacion_base_pct?: number, unidades_libres: number, dias_de_entrega: number}>} args.ofertas
 * @param {Date} [args.ahora]
 * @param {number} [args.version]  Versión del dato fuente, para descartar eventos viejos.
 */
export function documentoDeProducto({ ficha, ofertas, ahora = new Date(), version = 1 }) {
  const ofertasCalculadas = ofertas.map((o) => {
    // Costo de REFERENCIA: lista menos la bonificación base del fabricante, más
    // impuestos, sin flete ni bonificación por volumen. Sirve para ordenar el
    // catálogo y rankear; la cotización recalcula con la cantidad y el destino
    // reales, que son los que definen esos dos términos.
    const costo = calcularCostoUnitarioFinal({
      precioLista: o.precio_lista,
      bonificacionPct: o.bonificacion_base_pct ?? 0,
    });
    return {
      fabricante: o.fabricante,
      moneda: o.moneda,
      precio_lista: o.precio_lista,
      bonificacion_base_pct: o.bonificacion_base_pct ?? 0,
      costo_unitario_final: costo,
      costo_por_watt: calcularCostoPorWatt(costo, ficha.potencia_w),
      unidades_libres: o.unidades_libres,
      dias_de_entrega: o.dias_de_entrega,
    };
  });

  // El mejor costo por Watt sólo considera ofertas con stock: es el que se
  // muestra y por el que se ordena, y no puede ser el de alguien que no entrega.
  const comparables = ofertasCalculadas
    .filter((o) => o.unidades_libres > 0 && o.costo_por_watt !== null)
    .map((o) => o.costo_por_watt);

  return {
    sku: ficha.sku,
    tipo: ficha.tipo,
    modelo: ficha.modelo,
    potencia_w: ficha.potencia_w ?? null,
    tecnologia_celda: ficha.tecnologia_celda ?? null,
    certificaciones: ficha.certificaciones ?? [],
    multiplo_de_embalaje: ficha.multiplo_de_embalaje,
    ofertas: ofertasCalculadas,
    mejor_costo_por_watt: comparables.length > 0 ? Math.min(...comparables) : null,
    unidades_libres_total: ofertasCalculadas.reduce((acc, o) => acc + o.unidades_libres, 0),
    proyectado_en: ahora.toISOString(),
    version,
  };
}
