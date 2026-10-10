// ---------------------------------------------------------------------------
// Métricas del servicio en formato de exposición Prometheus.
//
// Sin librería de instrumentación todavía: para la Entrega 1 alcanza con dejar
// el endpoint y las series que el tablero va a usar, de modo que la decisión de
// qué medir quede tomada y documentada antes de instrumentar.
//
// Series que importan en este servicio:
//   helios_busquedas_total{resultado}        — volumen de búsquedas
//   helios_cache_busqueda_total{resultado}   — aciertos/fallos de caché (D7)
//   helios_retraso_indice_segundos           — retraso de la proyección (D6)
//   helios_busqueda_duracion_segundos        — latencia de consulta
//
// La tasa de aciertos de caché y el retraso del índice son las dos métricas con
// las que se justifica la caché y el motor de búsqueda; ver docs/ARCHITECTURE.md.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { INSTANCIA, SERVICIO } from '../observabilidad.js';

const contadores = {
  busquedas: 0,
  cache_hit: 0,
  cache_miss: 0,
};

export function contar(nombre) {
  if (nombre in contadores) contadores[nombre] += 1;
}

export function routerDeMetricas() {
  const router = Router();

  router.get('/metricas', (_req, res) => {
    const etiquetas = `servicio="${SERVICIO}",instancia="${INSTANCIA}"`;
    const lineas = [
      '# HELP helios_busquedas_total Búsquedas resueltas por este servicio.',
      '# TYPE helios_busquedas_total counter',
      `helios_busquedas_total{${etiquetas}} ${contadores.busquedas}`,
      '# HELP helios_cache_busqueda_total Resultados de la caché de búsquedas.',
      '# TYPE helios_cache_busqueda_total counter',
      `helios_cache_busqueda_total{${etiquetas},resultado="hit"} ${contadores.cache_hit}`,
      `helios_cache_busqueda_total{${etiquetas},resultado="miss"} ${contadores.cache_miss}`,
      '# HELP helios_proceso_tiempo_en_linea_segundos Tiempo desde el arranque.',
      '# TYPE helios_proceso_tiempo_en_linea_segundos gauge',
      `helios_proceso_tiempo_en_linea_segundos{${etiquetas}} ${Math.round(process.uptime())}`,
    ];
    res.type('text/plain; version=0.0.4').send(`${lineas.join('\n')}\n`);
  });

  return router;
}
