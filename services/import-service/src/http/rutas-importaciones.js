// ---------------------------------------------------------------------------
// Adaptador de entrada del pipeline de importación.
//
// Expuesto por el gateway bajo /interno/importaciones/**. Lo usa el equipo de
// compras de Helios desde el frontend propio: no es una capacidad publicada.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { ErrorDeDominio, noImplementadoTodavia } from '../problema.js';
import { evaluarLote, normalizarFila } from '../pipeline/normalizador.js';

const PENDIENTE = noImplementadoTodavia('Entrega 2');

export function routerDeImportaciones() {
  const router = Router();

  // --- Etapa 1: ingesta ----------------------------------------------------
  // Subida de la planilla. Devuelve el lote con estado `recibido` y sigue en
  // segundo plano: una planilla de 5000 filas no se procesa dentro del request.
  router.post('/lotes', PENDIENTE);

  // --- Seguimiento del lote a través de las etapas ------------------------
  router.get('/lotes', PENDIENTE);
  router.get('/lotes/:lote_id', PENDIENTE);
  router.get('/lotes/:lote_id/filas-con-error', PENDIENTE);

  // --- Etapa final: aplicar al catálogo y publicar el evento --------------
  router.post('/lotes/:lote_id/aplicar', PENDIENTE);
  router.post('/lotes/:lote_id/rechazar', PENDIENTE);

  // --- Perfiles de mapeo ---------------------------------------------------
  router.get('/perfiles', PENDIENTE);
  router.post('/perfiles', PENDIENTE);

  /**
   * Prueba en seco del pipeline sobre filas pegadas a mano.
   *
   * Implementado en la Entrega 1 porque es la forma de ajustar el perfil de
   * mapeo de un fabricante nuevo sin subir el archivo entero, y permite
   * demostrar las reglas de normalización ya en esta etapa del proyecto.
   *
   *   POST /interno/importaciones/probar-normalizacion
   *   { "perfil": { ...perfil_mapeo... }, "filas": [ { "CODIGO": "...", ... } ] }
   */
  router.post('/probar-normalizacion', (req, res, next) => {
    const { perfil, filas } = req.body ?? {};
    if (!perfil?.columnas || !Array.isArray(filas)) {
      return next(
        new ErrorDeDominio('SOLICITUD_INVALIDA', 'Se requiere un perfil con columnas y un arreglo de filas.', {
          errores_de_validacion: [
            { campo: 'perfil.columnas', mensaje: 'Obligatorio.' },
            { campo: 'filas', mensaje: 'Arreglo de objetos columna → valor.' },
          ],
        }),
      );
    }

    const resultados = filas.map((fila, i) => {
      const r = normalizarFila(fila, perfil);
      return r.ok
        ? { numero_fila: i + 1, estado: 'ok', fila: r.fila }
        : { numero_fila: i + 1, estado: 'error', errores: r.errores };
    });

    const conError = resultados.filter((r) => r.estado === 'error').length;

    res.json({
      filas_total: resultados.length,
      filas_ok: resultados.length - conError,
      filas_con_error: conError,
      decision_del_lote: evaluarLote({
        filasTotal: resultados.length,
        filasConError: conError,
      }),
      resultados,
    });
  });

  return router;
}
