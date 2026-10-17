// ---------------------------------------------------------------------------
// Armado de una cotización firme — lógica pura.
//
// Recibe la solicitud y los documentos del índice ya leídos, y devuelve la
// cotización con el precio unitario final de cada línea. No lee ni escribe
// nada: se puede testear sin Elasticsearch ni Redis.
//
// Cálculo por línea (SPEC R3.1 y R3.2, en este orden):
//   precio de lista del fabricante elegido
//   − bonificación base del fabricante + bonificación por volumen
//   + flete del envío prorrateado entre TODAS las unidades de la cotización
//   + IVA
//   = precio unitario final   ← lo que stock-service congela al reservar
//
// La bonificación por volumen se calcula sobre el total de unidades de la
// cotización: es lo que hace que reservar un pedido distinto del cotizado no
// sea válido (R4.2), porque el precio depende de la combinación completa.
// ---------------------------------------------------------------------------

import { ErrorDeDominio } from '../problema.js';
import { fletePorProvincia } from './flete.js';
import {
  bonificacionPorVolumen,
  calcularCostoPorWatt,
  calcularCostoUnitarioFinal,
  elegirFabricante,
} from './precios.js';

/** Vigencia de una cotización: pasado este plazo no sirve para reservar. */
export const MINUTOS_DE_VIGENCIA = 15;

/**
 * @param {object} args
 * @param {{destino: {provincia: string}, moneda?: string, lineas: Array<{sku: string, cantidad: number, fabricante_preferido?: string}>}} args.solicitud
 *   Ya validada sintácticamente por la ruta.
 * @param {Map<string, object>} args.documentosPorSku  sku → documento del índice.
 * @param {string} args.id
 * @param {Date} args.ahora
 * @returns {object} La cotización, con la forma del schema `Cotizacion` del contrato.
 * @throws {ErrorDeDominio} 422 si alguna línea no se puede cotizar; nombra todas.
 */
export function armarCotizacion({ solicitud, documentosPorSku, id, ahora }) {
  const moneda = solicitud.moneda ?? 'USD';
  const unidadesTotales = solicitud.lineas.reduce((acc, l) => acc + l.cantidad, 0);
  const flete = fletePorProvincia(solicitud.destino.provincia);
  const bonificacionVolumen = bonificacionPorVolumen(unidadesTotales);

  const errores = [];
  const lineas = [];
  let subtotalMercaderia = 0;

  solicitud.lineas.forEach((pedida, i) => {
    const documento = documentosPorSku.get(pedida.sku);
    if (!documento) {
      errores.push({
        codigo: 'SKU_DESCONTINUADO',
        campo: `lineas[${i}].sku`,
        mensaje: `${pedida.sku} no está en el catálogo.`,
      });
      return;
    }

    // Se rechaza al cotizar, no recién al reservar: cotizar una cantidad que
    // después no se puede reservar sólo le hace perder tiempo al consumidor.
    if (pedida.cantidad % documento.multiplo_de_embalaje !== 0) {
      errores.push({
        codigo: 'CANTIDAD_NO_MULTIPLO_EMBALAJE',
        campo: `lineas[${i}].cantidad`,
        mensaje: `Debe ser múltiplo de ${documento.multiplo_de_embalaje} (unidades por pallet).`,
      });
      return;
    }

    const elegido = elegirFabricante(
      documento.ofertas.map((o) => ({ ...o, costo_unitario: o.costo_unitario_final })),
      pedida.fabricante_preferido ?? null,
    );
    if (!elegido) {
      errores.push({
        codigo: 'SKU_DESCONTINUADO',
        campo: `lineas[${i}].sku`,
        mensaje: `Ningún fabricante ofrece ${pedida.sku} con stock.`,
      });
      return;
    }

    const { oferta, motivo } = elegido;
    const bonificacionPct = oferta.bonificacion_base_pct + bonificacionVolumen;
    const precioUnitario = calcularCostoUnitarioFinal({
      precioLista: oferta.precio_lista,
      bonificacionPct,
      fleteTotal: flete,
      unidadesDelEnvio: unidadesTotales,
    });
    const subtotal = redondear(precioUnitario * pedida.cantidad);

    subtotalMercaderia += oferta.precio_lista * (1 - bonificacionPct / 100) * pedida.cantidad;
    lineas.push({
      sku: documento.sku,
      modelo: documento.modelo,
      fabricante_elegido: oferta.fabricante,
      motivo_eleccion: motivo,
      cantidad: pedida.cantidad,
      precio_unitario: dinero(precioUnitario, moneda),
      costo_por_watt: calcularCostoPorWatt(precioUnitario, documento.potencia_w),
      bonificacion_por_volumen_pct: bonificacionVolumen,
      subtotal: dinero(subtotal, moneda),
    });
  });

  if (errores.length > 0) {
    // El primer error define el código; el resto viaja como detalle para que
    // el consumidor pueda corregir todo de una vez.
    throw new ErrorDeDominio(errores[0].codigo, 'Hay líneas que no se pueden cotizar.', {
      errores_de_validacion: errores.map(({ campo, mensaje }) => ({ campo, mensaje })),
    });
  }

  // El total es la suma de los subtotales por línea, que es exactamente lo que
  // stock-service va a congelar. Los impuestos se obtienen por diferencia para
  // que el desglose cierre al centavo con ese total.
  const total = redondear(lineas.reduce((acc, l) => acc + Number(l.subtotal.monto), 0));
  const mercaderia = redondear(subtotalMercaderia);
  const impuestos = redondear(total - mercaderia - flete);

  return {
    cotizacion_id: id,
    estado: 'vigente',
    lineas,
    subtotal_mercaderia: dinero(mercaderia, moneda),
    flete: dinero(flete, moneda),
    impuestos: dinero(impuestos, moneda),
    total: dinero(total, moneda),
    emitida_en: ahora.toISOString(),
    vigente_hasta: new Date(ahora.getTime() + MINUTOS_DE_VIGENCIA * 60_000).toISOString(),
  };
}

/**
 * Estado de una cotización guardada, visto en un momento dado. Se calcula al
 * leer porque la cotización se guarda más tiempo que su vigencia: el
 * consumidor tiene que poder ver que expiró, no recibir un 404.
 */
export function conEstadoActual(cotizacion, ahora) {
  if (cotizacion.estado !== 'vigente') return cotizacion;
  return new Date(cotizacion.vigente_hasta) <= ahora ? { ...cotizacion, estado: 'expirada' } : cotizacion;
}

function dinero(monto, moneda) {
  return { monto: monto.toFixed(2), moneda };
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}
