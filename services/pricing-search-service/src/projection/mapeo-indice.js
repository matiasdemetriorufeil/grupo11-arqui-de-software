// ---------------------------------------------------------------------------
// Mapping del índice de productos en Elasticsearch.
//
// Un documento por producto canónico, con las ofertas de todos los fabricantes
// ya resueltas a costo. Es el read model del CQRS: se puede borrar y
// reconstruir desde las fuentes. Ver src/projection/README.md.
//
// Las búsquedas apuntan siempre al ALIAS, nunca al índice físico. Así una
// reconstrucción puede poblar `helios-productos-v2` en paralelo y mover el
// alias cuando termina, sin cortar el servicio.
// ---------------------------------------------------------------------------

export const ALIAS_PRODUCTOS = process.env.ALIAS_INDICE_PRODUCTOS ?? 'helios-productos';

export const MAPEO_PRODUCTOS = {
  // strict: un campo no declarado es un bug de la proyección, no un dato nuevo.
  dynamic: 'strict',
  properties: {
    sku: { type: 'keyword' },
    tipo: { type: 'keyword' },
    modelo: { type: 'text', fields: { exacto: { type: 'keyword' } } },
    potencia_w: { type: 'integer' },
    tecnologia_celda: { type: 'keyword' },
    certificaciones: { type: 'keyword' },
    multiplo_de_embalaje: { type: 'integer' },

    // nested: cada oferta se filtra como unidad. Con `object`, "fabricante X"
    // y "costo por Watt < Y" podrían cumplirse en ofertas distintas.
    ofertas: {
      type: 'nested',
      properties: {
        fabricante: { type: 'keyword' },
        moneda: { type: 'keyword' },
        precio_lista: { type: 'double' },
        bonificacion_base_pct: { type: 'double' },
        costo_unitario_final: { type: 'double' },
        costo_por_watt: { type: 'double' },
        unidades_libres: { type: 'integer' },
        dias_de_entrega: { type: 'integer' },
      },
    },

    // Precalculados: son el criterio de orden y el filtro más usados, y
    // calcularlos en la consulta obligaría a ordenar sobre un campo nested.
    mejor_costo_por_watt: { type: 'double' },
    unidades_libres_total: { type: 'integer' },

    proyectado_en: { type: 'date' },
    // Descarta eventos viejos que lleguen después de uno nuevo (external versioning).
    version: { type: 'long' },
  },
};

/**
 * Crea el índice con su alias si todavía no existe. Idempotente: las dos
 * instancias del servicio lo llaman al arrancar y sólo una lo crea.
 *
 * @param {import('@elastic/elasticsearch').Client} es
 * @returns {Promise<boolean>} true si lo creó esta llamada.
 */
export async function asegurarIndice(es, { alias = ALIAS_PRODUCTOS, indice = `${alias}-v1` } = {}) {
  if (await es.indices.existsAlias({ name: alias })) return false;
  try {
    await es.indices.create({
      index: indice,
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: MAPEO_PRODUCTOS,
      aliases: { [alias]: {} },
    });
    return true;
  } catch (err) {
    // La otra instancia lo creó entre el chequeo y la creación.
    if (err?.meta?.body?.error?.type === 'resource_already_exists_exception') return false;
    throw err;
  }
}
