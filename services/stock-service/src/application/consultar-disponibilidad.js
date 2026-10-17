// ---------------------------------------------------------------------------
// Caso de uso: consultar la disponibilidad de un producto.
//
// Es una lectura INFORMATIVA (SPEC.md R3.8 y docs/contracts/openapi.yaml):
// no bloquea filas ni reserva nada, y el resultado puede cambiar entre esta
// consulta y la reserva. La reserva vuelve a leer el stock bajo FOR UPDATE.
// ---------------------------------------------------------------------------

import { ErrorDeDominio } from '../problema.js';
import { unidadesLibres } from '../domain/reserva.js';

/**
 * @param {object} puertos
 * @param {import('./puertos.js').RepositorioDeStock} puertos.repositorio
 * @param {() => Date} [puertos.reloj]
 */
export function crearConsultarDisponibilidad({ repositorio, reloj = () => new Date() }) {
  return async function consultarDisponibilidad({ sku, cantidad }) {
    const existencia = await repositorio.existenciaPorSku(sku);
    if (!existencia) {
      throw new ErrorDeDominio('NO_ENCONTRADO', `No hay existencias registradas para el SKU ${sku}.`);
    }

    const libres = unidadesLibres(existencia);
    return {
      sku: existencia.sku,
      cantidad_solicitada: cantidad,
      hay_disponible: libres >= cantidad,
      unidades_libres: libres,
      multiplo_de_embalaje: existencia.multiplo_de_embalaje,
      consultado_en: reloj().toISOString(),
    };
  };
}
