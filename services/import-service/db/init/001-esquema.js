// ---------------------------------------------------------------------------
// import-service — Inicialización de MongoDB
//
// La razón de usar MongoDB acá es que las listas de precios llegan con esquemas
// distintos por fabricante y cambian sin aviso. Las filas crudas se guardan tal
// como vinieron (schema-on-read) y la validación se aplica sólo donde el dominio
// la necesita: los lotes y los perfiles de mapeo, que sí son nuestros.
//
// Decisión: docs/adr/ADR-003-persistencia.md
// ---------------------------------------------------------------------------

const importaciones = db.getSiblingDB('helios_importaciones');

// --- Lotes de importación --------------------------------------------------
// Un lote = un archivo recibido de un fabricante. Es el agregado que gobierna
// el avance del pipeline y el que se reporta en la interfaz.

importaciones.createCollection('lote_importacion', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['fabricante', 'archivo', 'estado', 'recibido_en'],
      properties: {
        fabricante: { bsonType: 'string', description: 'Nombre canónico del fabricante.' },
        archivo: {
          bsonType: 'object',
          required: ['nombre', 'formato'],
          properties: {
            nombre: { bsonType: 'string' },
            formato: { enum: ['csv', 'xlsx', 'xls', 'json', 'desconocido'] },
            bytes: { bsonType: ['long', 'int'] },
            huella_sha256: {
              bsonType: 'string',
              description: 'Hash del archivo: evita reprocesar el mismo lote dos veces.',
            },
          },
        },
        estado: {
          enum: ['recibido', 'parseando', 'normalizado', 'validado', 'aplicado', 'rechazado'],
        },
        perfil_mapeo_version: { bsonType: 'int' },
        filas_total: { bsonType: 'int' },
        filas_ok: { bsonType: 'int' },
        filas_con_error: { bsonType: 'int' },
        moneda: { enum: ['USD', 'ARS'] },
        vigente_desde: { bsonType: 'date' },
        recibido_en: { bsonType: 'date' },
        finalizado_en: { bsonType: ['date', 'null'] },
        motivo_rechazo: { bsonType: ['string', 'null'] },
      },
    },
  },
  validationLevel: 'moderate',
  validationAction: 'error',
});

importaciones.lote_importacion.createIndex({ fabricante: 1, recibido_en: -1 });
importaciones.lote_importacion.createIndex({ estado: 1, recibido_en: 1 });
// El mismo archivo no se importa dos veces: idempotencia de la ingesta.
importaciones.lote_importacion.createIndex(
  { 'archivo.huella_sha256': 1 },
  { unique: true, sparse: true, name: 'lote_huella_unica' },
);

// --- Filas crudas ----------------------------------------------------------
// Sin validador a propósito: acá entra lo que el fabricante haya mandado, con
// sus columnas raras y sus celdas vacías. Es la evidencia de qué recibimos.

importaciones.createCollection('fila_cruda');
importaciones.fila_cruda.createIndex({ lote_id: 1, numero_fila: 1 }, { unique: true });
importaciones.fila_cruda.createIndex({ lote_id: 1, tiene_error: 1 });

// --- Filas normalizadas ----------------------------------------------------
// Resultado del pipeline: estructura canónica lista para publicar al catálogo.

importaciones.createCollection('fila_normalizada', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['lote_id', 'numero_fila', 'codigo_fabricante', 'precio_lista'],
      properties: {
        lote_id: { bsonType: 'objectId' },
        numero_fila: { bsonType: 'int' },
        codigo_fabricante: { bsonType: 'string' },
        sku_canonico: { bsonType: ['string', 'null'] },
        descripcion: { bsonType: ['string', 'null'] },
        potencia_w: { bsonType: ['int', 'null'] },
        precio_lista: { bsonType: 'decimal' },
        moneda: { enum: ['USD', 'ARS'] },
        bonificacion_pct: { bsonType: ['decimal', 'null'] },
        unidades_por_pallet: { bsonType: ['int', 'null'] },
      },
    },
  },
  validationAction: 'error',
});

importaciones.fila_normalizada.createIndex({ lote_id: 1, numero_fila: 1 }, { unique: true });
importaciones.fila_normalizada.createIndex({ codigo_fabricante: 1 });
importaciones.fila_normalizada.createIndex({ sku_canonico: 1 }, { sparse: true });

// --- Perfiles de mapeo ------------------------------------------------------
// Las reglas que traducen las columnas de cada fabricante a campos canónicos.
// Versionadas: cuando un fabricante cambia su planilla se agrega una versión
// nueva y los lotes viejos siguen siendo reproducibles.

importaciones.createCollection('perfil_mapeo', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['fabricante', 'version', 'columnas'],
      properties: {
        fabricante: { bsonType: 'string' },
        version: { bsonType: 'int' },
        separador_decimal: { enum: ['.', ','] },
        moneda_por_defecto: { enum: ['USD', 'ARS'] },
        fila_de_encabezado: { bsonType: 'int' },
        columnas: {
          bsonType: 'object',
          description: 'campo canónico -> nombre o índice de columna en la planilla.',
        },
        transformaciones: {
          bsonType: 'array',
          items: { bsonType: 'object' },
        },
        vigente: { bsonType: 'bool' },
      },
    },
  },
  validationAction: 'error',
});

importaciones.perfil_mapeo.createIndex({ fabricante: 1, version: -1 }, { unique: true });

// --- Perfiles de los fabricantes de la demo --------------------------------
// Dos fabricantes, dos planillas con columnas y formatos distintos: eso es
// exactamente el problema que este servicio resuelve.

importaciones.perfil_mapeo.insertMany([
  {
    fabricante: 'Jinko Solar',
    version: 1,
    separador_decimal: '.',
    moneda_por_defecto: 'USD',
    fila_de_encabezado: 1,
    columnas: {
      codigo_fabricante: 'Model No.',
      descripcion: 'Description',
      potencia_w: 'Pmax (W)',
      precio_lista: 'FOB Price USD/pc',
      unidades_por_pallet: 'Pcs/Pallet',
    },
    transformaciones: [
      { campo: 'precio_lista', tipo: 'quitar_simbolo_moneda' },
      { campo: 'codigo_fabricante', tipo: 'trim_mayusculas' },
    ],
    vigente: true,
  },
  {
    fabricante: 'Trina Solar',
    version: 1,
    separador_decimal: ',',
    moneda_por_defecto: 'USD',
    fila_de_encabezado: 3,
    columnas: {
      codigo_fabricante: 'CODIGO',
      descripcion: 'DETALLE DEL PRODUCTO',
      potencia_w: 'POTENCIA',
      precio_lista: 'PRECIO UNIT.',
      bonificacion_pct: 'DTO %',
      unidades_por_pallet: 'BULTO',
    },
    // El formato decimal lo declara `separador_decimal`: las transformaciones
    // son sólo de limpieza de texto, nunca reinterpretan números ni unidades.
    transformaciones: [{ campo: 'descripcion', tipo: 'colapsar_espacios' }],
    vigente: true,
  },
]);

// --- Idempotencia del consumo de eventos -----------------------------------
// RabbitMQ entrega al-menos-una-vez; este registro evita reprocesar un mensaje.
// Los documentos se purgan solos a los 7 días (índice TTL).

importaciones.createCollection('evento_consumido');
importaciones.evento_consumido.createIndex({ id_mensaje: 1 }, { unique: true });
importaciones.evento_consumido.createIndex({ procesado_en: 1 }, { expireAfterSeconds: 604800 });

print('[helios] MongoDB de import-service inicializada.');
