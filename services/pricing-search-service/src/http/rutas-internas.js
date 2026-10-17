// ---------------------------------------------------------------------------
// API interna de pricing-search-service, para otros servicios de Helios.
//
// No forma parte del contrato publicado ni pasa por el gateway: es tráfico
// este-oeste, que llega por el alias de red `precios-interno` (ADR-005).
//
//   GET /interno/ranking/:sku   mejor fabricante por costo por Watt
//     200 { sku, fabricante, costo_unitario_final, costo_por_watt, motivo }
//     404 si el producto no está indexado o nadie lo vende con stock
//     503 si el índice no está disponible
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { ErrorDeDominio } from '../problema.js';

/** Mismo patrón que el schema `Sku` del contrato. */
const PATRON_SKU = /^HEL-[A-Z]{3}-[A-Z0-9-]{3,20}$/;

/**
 * @param {object} consultas
 * @param {(sku: string) => Promise<object|null>} consultas.mejorFabricante
 */
export function routerInterno({ mejorFabricante }) {
  const router = Router();

  router.get('/interno/ranking/:sku', async (req, res, next) => {
    try {
      const { sku } = req.params;
      if (!PATRON_SKU.test(sku)) {
        throw new ErrorDeDominio('SOLICITUD_INVALIDA', 'SKU inválido.', {
          errores_de_validacion: [{ campo: 'sku', mensaje: 'Debe ser un SKU canónico de Helios.' }],
        });
      }

      const ranking = await mejorFabricante(sku);
      if (!ranking) {
        throw new ErrorDeDominio('NO_ENCONTRADO', `Ningún fabricante ofrece ${sku} con stock.`);
      }
      res.json(ranking);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
