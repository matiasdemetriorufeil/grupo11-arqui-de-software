// ---------------------------------------------------------------------------
// API interna de stock-service, para el frontend propio de Helios.
//
// No forma parte del contrato publicado: puede cambiar sin versionado porque el
// único consumidor es nuestra propia interfaz. El gateway la expone bajo
// /interno/stock/** y exige JWT.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { noImplementadoTodavia } from '../problema.js';
import {
  calcularCantidadDeReposicion,
  requiereReposicion,
  unidadesLibres,
} from '../domain/reserva.js';

const PENDIENTE = noImplementadoTodavia('Entrega 2');

export function routerInterno() {
  const router = Router();

  // Panel de existencias por depósito, con el semáforo de reposición.
  router.get('/stock/existencias', PENDIENTE);

  // Órdenes de reposición sugeridas y emitidas.
  router.get('/stock/ordenes-reposicion', PENDIENTE);
  router.post('/stock/ordenes-reposicion/:id/emitir', PENDIENTE);

  // Ajuste manual de inventario (recuento físico). Deja asiento en el libro mayor.
  router.post('/stock/existencias/:id/ajustar', PENDIENTE);

  /**
   * Simulador de reposición: aplica las reglas del dominio sobre una existencia
   * hipotética y explica la decisión. No toca la base.
   *
   * Está implementado porque permite demostrar y defender las reglas de negocio
   * ya en la Entrega 1, sin esperar la capa de persistencia.
   *
   *   POST /interno/stock/simular-reposicion
   *   { "cantidad_fisica": 792, "cantidad_reservada": 0,
   *     "punto_de_reposicion": 720, "lote_de_reposicion": 1080,
   *     "multiplo_de_embalaje": 36 }
   */
  router.post('/stock/simular-reposicion', (req, res) => {
    const existencia = {
      cantidad_fisica: Number(req.body?.cantidad_fisica ?? 0),
      cantidad_reservada: Number(req.body?.cantidad_reservada ?? 0),
      punto_de_reposicion: Number(req.body?.punto_de_reposicion ?? 0),
      lote_de_reposicion: Number(req.body?.lote_de_reposicion ?? 1),
      multiplo_de_embalaje: Number(req.body?.multiplo_de_embalaje ?? 1),
    };

    res.json({
      unidades_libres: unidadesLibres(existencia),
      requiere_reposicion: requiereReposicion(existencia),
      cantidad_a_reponer: calcularCantidadDeReposicion(existencia),
      explicacion:
        'Se repone cuando las unidades libres (físicas menos reservadas) quedan en o por debajo ' +
        'del punto de reposición. La cantidad se redondea hacia arriba al lote de compra y al ' +
        'múltiplo de embalaje del fabricante.',
    });
  });

  return router;
}
