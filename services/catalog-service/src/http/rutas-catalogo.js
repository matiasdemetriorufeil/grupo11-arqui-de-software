// ---------------------------------------------------------------------------
// Capa HTTP de catalog-service — API interna del catálogo maestro.
//
// Expuesta por el gateway bajo /interno/catalogo/**. No es parte del contrato
// público: puede evolucionar sin versionado porque sus únicos consumidores son
// el frontend de Helios y los otros servicios del sistema.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { ErrorDeDominio, noImplementadoTodavia } from '../problema.js';
import { esSkuCanonico, normalizarCodigoDeFabricante } from '../application/skus.js';

const PENDIENTE = noImplementadoTodavia('Entrega 2');

export function routerDeCatalogo() {
  const router = Router();

  // --- Productos canónicos ------------------------------------------------
  router.get('/productos', PENDIENTE);
  router.get('/productos/:sku', validarSku, PENDIENTE);
  router.post('/productos', PENDIENTE);
  router.patch('/productos/:sku', validarSku, PENDIENTE);

  // --- Fabricantes ---------------------------------------------------------
  router.get('/fabricantes', PENDIENTE);
  router.post('/fabricantes', PENDIENTE);

  // --- Mapeo de SKUs: el servicio que consume import-service --------------
  // Dado el código propio de un fabricante, devuelve el producto canónico.
  // Es la operación que permite unificar listas de precios heterogéneas.
  router.get('/mapeos/resolver', exigirQuery(['fabricante', 'codigo']), PENDIENTE);
  router.post('/mapeos', PENDIENTE);

  /**
   * Normalización de un código de fabricante.
   *
   * Implementado en la Entrega 1 porque es la regla que import-service necesita
   * para no crear mapeos duplicados por diferencias de formato, y se puede
   * defender sin tener la base conectada.
   *
   *   GET /interno/catalogo/mapeos/normalizar?codigo=  jkm550n-72hl4-bdv
   */
  router.get('/mapeos/normalizar', exigirQuery(['codigo']), (req, res) => {
    const original = String(req.query.codigo);
    res.json({
      original,
      normalizado: normalizarCodigoDeFabricante(original),
      explicacion:
        'Se recortan espacios, se colapsan separadores repetidos, se pasa a mayúsculas y se ' +
        'quitan los caracteres que los fabricantes agregan sin significado (espacios internos, ' +
        'puntos finales). Dos códigos que normalizan igual son el mismo producto.',
    });
  });

  return router;
}

function validarSku(req, _res, next) {
  if (!esSkuCanonico(req.params.sku)) {
    return next(
      new ErrorDeDominio('SOLICITUD_INVALIDA', 'El SKU no tiene el formato canónico de Helios.', {
        errores_de_validacion: [
          { campo: 'sku', mensaje: 'Formato esperado: HEL-XXX-NNNNN (ej. HEL-PAN-550-JKM).' },
        ],
      }),
    );
  }
  next();
}

function exigirQuery(nombres) {
  return (req, _res, next) => {
    const faltantes = nombres.filter((n) => req.query[n] === undefined || req.query[n] === '');
    if (faltantes.length > 0) {
      return next(
        new ErrorDeDominio('SOLICITUD_INVALIDA', 'Faltan parámetros obligatorios.', {
          errores_de_validacion: faltantes.map((n) => ({ campo: n, mensaje: 'Obligatorio.' })),
        }),
      );
    }
    next();
  };
}
