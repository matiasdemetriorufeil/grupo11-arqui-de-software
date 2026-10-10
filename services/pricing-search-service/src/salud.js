// ---------------------------------------------------------------------------
// Endpoints de salud del servicio.
//
//   GET /salud/viva   — liveness. El proceso responde. Lo usa el balanceador del
//                       gateway para sacar del anillo una instancia caida.
//   GET /salud/lista  — readiness. Ademas verifica las dependencias declaradas.
//                       Devuelve 503 si alguna esencial no esta disponible.
//
// Ninguno de los dos expone informacion sensible ni requiere autenticacion: son
// los unicos endpoints sin JWT en el gateway.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { SERVICIO, INSTANCIA, VERSION } from './observabilidad.js';

const arrancadoEn = Date.now();

/**
 * @param {Record<string, () => Promise<boolean>>} sondas
 *        Nombre de la dependencia -> funcion que resuelve true si esta sana.
 */
export function routerDeSalud(sondas = {}) {
  const router = Router();

  router.get('/salud/viva', (_req, res) => {
    res.json({
      estado: 'operativo',
      servicio: SERVICIO,
      instancia: INSTANCIA,
      version: VERSION,
      tiempo_en_linea_seg: Math.round((Date.now() - arrancadoEn) / 1000),
    });
  });

  router.get('/salud/lista', async (_req, res) => {
    const dependencias = {};
    await Promise.all(
      Object.entries(sondas).map(async ([nombre, sonda]) => {
        try {
          dependencias[nombre] = (await sonda()) ? 'disponible' : 'no_disponible';
        } catch {
          dependencias[nombre] = 'no_disponible';
        }
      }),
    );

    const todoSano = Object.values(dependencias).every((e) => e === 'disponible');
    res.status(todoSano ? 200 : 503).json({
      estado: todoSano ? 'operativo' : 'degradado',
      servicio: SERVICIO,
      instancia: INSTANCIA,
      version: VERSION,
      dependencias,
    });
  });

  return router;
}
