// ---------------------------------------------------------------------------
// Cálculo de costos y ranking de fabricantes — lógica pura.
//
// Es el "comparador" del sistema: convierte el precio de lista de cada
// fabricante en un costo unitario final comparable y decide quién es el más
// barato por Watt. Sin esto, comparar un panel de 550 W a USD 100 contra uno de
// 580 W a USD 110 no significa nada.
//
// Puro a propósito: se puede testear sin Elasticsearch ni Redis.
// Decisiones: docs/adr/ADR-003-persistencia.md (read model), SPEC.md § HU-03.
// ---------------------------------------------------------------------------

/** Alícuota de IVA aplicada a la venta mayorista local. */
export const IVA_PCT = 21;

/**
 * Costo unitario final de un producto de un fabricante, puesto en destino.
 *
 * Orden de aplicación (importa, y es la parte que hay que poder defender):
 *   1. Precio de lista del fabricante.
 *   2. Bonificación por volumen: se descuenta sobre el precio de lista.
 *   3. Flete: se reparte entre las unidades del pedido, no por línea de catálogo.
 *   4. Impuestos: se aplican sobre mercadería bonificada + flete.
 *
 * @param {object} args
 * @param {number} args.precioLista       Precio unitario de lista, en la moneda del fabricante.
 * @param {number} args.bonificacionPct   Bonificación total aplicable (base del fabricante + volumen).
 * @param {number} args.fleteTotal        Flete del envío completo.
 * @param {number} args.unidadesDelEnvio  Unidades que comparten ese flete.
 * @param {number} [args.impuestosPct]    Alícuota a aplicar. 0 para operaciones exentas.
 * @returns {number} Costo unitario final, redondeado a dos decimales.
 */
export function calcularCostoUnitarioFinal({
  precioLista,
  bonificacionPct = 0,
  fleteTotal = 0,
  unidadesDelEnvio = 1,
  impuestosPct = IVA_PCT,
}) {
  if (!(precioLista >= 0)) throw new TypeError('precioLista debe ser un número no negativo');
  if (!(unidadesDelEnvio >= 1)) throw new TypeError('unidadesDelEnvio debe ser al menos 1');

  const bonificado = precioLista * (1 - bonificacionPct / 100);
  const fletePorUnidad = fleteTotal / unidadesDelEnvio;
  const conImpuestos = (bonificado + fletePorUnidad) * (1 + impuestosPct / 100);
  return redondear(conImpuestos, 2);
}

/**
 * Bonificación por volumen según la escala mayorista de Helios.
 * Escalonada y acumulativa con la bonificación base del fabricante.
 */
export function bonificacionPorVolumen(unidades) {
  if (unidades >= 1000) return 6;
  if (unidades >= 500) return 4.5;
  if (unidades >= 200) return 3;
  if (unidades >= 100) return 1.5;
  return 0;
}

/**
 * Costo por Watt: la métrica que vuelve comparables productos de distinta
 * potencia. Es el criterio de ordenamiento por defecto del catálogo.
 *
 * @returns {number|null} null si el producto no tiene potencia nominal
 *                        (una estructura de montaje no se compara por Watt).
 */
export function calcularCostoPorWatt(costoUnitarioFinal, potenciaW) {
  if (!potenciaW || potenciaW <= 0) return null;
  return redondear(costoUnitarioFinal / potenciaW, 5);
}

/**
 * Rankea las ofertas de un mismo producto canónico y devuelve la mejor.
 *
 * Sólo compiten las ofertas con stock: recomendar al fabricante más barato que
 * no puede entregar no sirve de nada. Los empates se resuelven por plazo de
 * entrega y, si siguen empatados, por nombre de fabricante, para que el ranking
 * sea determinista y los resultados no bailen entre dos consultas iguales.
 *
 * @param {Array<{fabricante: string, costo_por_watt: number|null, costo_unitario: number, unidades_libres: number, dias_de_entrega: number}>} ofertas
 */
export function rankearOfertas(ofertas) {
  return [...ofertas]
    .filter((o) => o.unidades_libres > 0)
    .sort((a, b) => {
      const porWatt = (a.costo_por_watt ?? Infinity) - (b.costo_por_watt ?? Infinity);
      if (porWatt !== 0) return porWatt;
      const porCosto = a.costo_unitario - b.costo_unitario;
      if (porCosto !== 0) return porCosto;
      const porPlazo = (a.dias_de_entrega ?? 0) - (b.dias_de_entrega ?? 0);
      if (porPlazo !== 0) return porPlazo;
      return a.fabricante.localeCompare(b.fabricante);
    });
}

/**
 * Elige el fabricante para una línea de cotización.
 *
 * @param {Array} ofertas
 * @param {string|null} fabricantePreferido  Si el cliente lo fijó, manda sobre el ranking.
 * @returns {{oferta: object, motivo: 'mejor_costo_por_watt'|'fabricante_preferido'|'unico_con_stock'}|null}
 */
export function elegirFabricante(ofertas, fabricantePreferido = null) {
  const rankeadas = rankearOfertas(ofertas);
  if (rankeadas.length === 0) return null;

  if (fabricantePreferido) {
    const preferida = rankeadas.find((o) => o.fabricante === fabricantePreferido);
    // Si el preferido no tiene stock se cae al ranking: es mejor cotizar que
    // devolver un error por una preferencia que el cliente marcó como tal.
    if (preferida) return { oferta: preferida, motivo: 'fabricante_preferido' };
  }

  if (rankeadas.length === 1) return { oferta: rankeadas[0], motivo: 'unico_con_stock' };
  return { oferta: rankeadas[0], motivo: 'mejor_costo_por_watt' };
}

/**
 * Clave de caché de una búsqueda. Se normaliza para que dos consultas
 * equivalentes escritas distinto compartan entrada (y por lo tanto, para que la
 * tasa de aciertos que se mide sea real y no un artefacto del orden de los
 * parámetros en la URL).
 */
export function claveDeCache(parametros) {
  const normalizados = Object.entries(parametros)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v).trim().toLowerCase()])
    .sort(([a], [b]) => a.localeCompare(b));
  return `busqueda:v1:${new URLSearchParams(normalizados).toString()}`;
}

function redondear(n, decimales) {
  const factor = 10 ** decimales;
  return Math.round(n * factor) / factor;
}
