// ---------------------------------------------------------------------------
// Adaptador de salida: ServicioDePrecios sobre HTTP.
//
// Cliente de pricing-search-service. Implementa los flujos 1 y 4 de
// docs/adr/ADR-005-comunicacion.md, que van al mismo servicio con criterios de
// degradación OPUESTOS:
//
//   1. obtenerCotizacion — ESENCIAL. Sin precio firme no hay reserva: si
//      pricing no responde, la reserva falla con 503 y Retry-After.
//   4. mejorFabricantePorCostoPorWatt — CONVENIENCIA. Si no hay ranking, se
//      devuelve el último conocido o null, y la orden de reposición se registra
//      igual. Nunca lanza: una falla secundaria no tira abajo la reserva.
//
// Reglas de toda llamada (ADR-005):
//   - Timeout explícito por intento (AbortSignal.timeout, 2 s).
//   - Un único reintento, sólo para fallas transitorias: red, timeout, 5xx.
//     Nunca para 4xx. Tampoco para 501: "no implementado" no se arregla
//     reintentando.
//   - Circuit breaker por dependencia (ver circuito.js). Lo comparten los dos
//     flujos: si pricing está caído, lo está para ambos.
//   - Se propaga X-Correlation-Id.
//   - Tráfico este-oeste: se llama directo al alias `precios-interno`, no por
//     el gateway.
// ---------------------------------------------------------------------------

import { ErrorDeDominio } from '../problema.js';
import { CircuitoAbierto, crearCircuito } from './circuito.js';

/** La misma cabecera con la que el gateway identifica al consumidor autenticado. */
const CABECERA_CONSUMIDOR = 'X-Consumer-Username';

/** Falla de la dependencia que vale la pena reintentar y que cuenta para el circuito. */
class FallaTransitoria extends Error {
  constructor(detalle, causa) {
    super(detalle, { cause: causa });
    this.name = 'FallaTransitoria';
  }
}

/** La dependencia respondió, pero con un estado que este cliente no espera. */
class RespuestaInesperada extends Error {
  constructor(estado, ruta) {
    super(`pricing-search-service respondió ${estado} en ${ruta}.`);
    this.name = 'RespuestaInesperada';
    this.estado = estado;
  }
}

/**
 * @param {object} [opciones]
 * @param {string} [opciones.urlBase]      Por defecto PRICING_SEARCH_URL.
 * @param {number} [opciones.timeoutMs]    Por intento.
 * @param {object} [opciones.circuito]     Para inyectar uno con reloj controlado (tests).
 * @param {{warn: Function}} [opciones.log]
 * @returns {import('../application/puertos.js').ServicioDePrecios}
 */
export function crearServicioDePreciosHttp({
  urlBase = process.env.PRICING_SEARCH_URL ?? 'http://precios-interno:3003',
  timeoutMs = Number(process.env.TIMEOUT_PRECIOS_MS ?? 2000),
  log = { warn() {} },
  circuito = crearCircuito({
    nombre: 'pricing-search-service',
    alCambiar: (estado) => log.warn({ dependencia: 'pricing-search-service', estado }, 'circuito cambió de estado'),
  }),
} = {}) {
  // Último ranking conocido por SKU: es lo que permite registrar la reposición
  // con `origen_del_precio = ultimo_ranking_en_cache` cuando pricing no responde.
  const ultimoRanking = new Map();

  /** GET con timeout, un reintento para fallas transitorias y circuit breaker. */
  async function obtener(ruta, cabeceras) {
    return circuito.ejecutar(
      async () => {
        try {
          return await intentar(ruta, cabeceras);
        } catch (err) {
          if (!(err instanceof FallaTransitoria)) throw err;
          return intentar(ruta, cabeceras);
        }
      },
      (err) => err instanceof FallaTransitoria,
    );
  }

  async function intentar(ruta, cabeceras) {
    let res;
    try {
      res = await fetch(`${urlBase}${ruta}`, {
        headers: { Accept: 'application/json', ...cabeceras },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Red caída, DNS, conexión rechazada o timeout.
      throw new FallaTransitoria(`Sin respuesta de pricing-search-service en ${ruta}.`, err);
    }

    if (res.status >= 500 && res.status !== 501) {
      await res.body?.cancel();
      throw new FallaTransitoria(`pricing-search-service respondió ${res.status} en ${ruta}.`);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new RespuestaInesperada(res.status, ruta);
    }
    return res.json();
  }

  function cabecerasDe({ consumidor, correlationId } = {}) {
    return {
      ...(consumidor ? { [CABECERA_CONSUMIDOR]: consumidor } : {}),
      ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
    };
  }

  return {
    async obtenerCotizacion(cotizacionId, ctx = {}) {
      try {
        return await obtener(
          `/v1/proveedor/cotizaciones/${encodeURIComponent(cotizacionId)}`,
          cabecerasDe(ctx),
        );
      } catch (err) {
        // Flujo esencial: si no se puede obtener el precio firme, el consumidor
        // recibe un 503 reintentable. Un 501 también cae acá: mientras pricing
        // no implemente cotizaciones, la reserva no está disponible.
        const noDisponible =
          err instanceof FallaTransitoria ||
          err instanceof CircuitoAbierto ||
          (err instanceof RespuestaInesperada && err.estado === 501);
        if (noDisponible) {
          throw new ErrorDeDominio(
            'SERVICIO_NO_DISPONIBLE',
            'No se pudo obtener la cotización: el servicio de precios no está disponible.',
          );
        }
        throw err;
      }
    },

    async mejorFabricantePorCostoPorWatt(sku, ctx = {}) {
      try {
        const ranking = await obtener(`/interno/ranking/${encodeURIComponent(sku)}`, cabecerasDe(ctx));
        if (!ranking) return null; // Nadie lo vende con stock: no hay a quién comprarle.

        const mejor = {
          fabricante: ranking.fabricante,
          costo_unitario: ranking.costo_unitario_final,
          costo_por_watt: ranking.costo_por_watt,
        };
        ultimoRanking.set(sku, mejor);
        return { ...mejor, origen: 'ranking_vigente' };
      } catch (err) {
        // Flujo de conveniencia: cualquier falla degrada, ninguna se propaga.
        log.warn({ err, sku }, 'ranking no disponible; se usa el último conocido si existe');
        const conocido = ultimoRanking.get(sku);
        return conocido ? { ...conocido, origen: 'ultimo_ranking_en_cache' } : null;
      }
    },
  };
}
