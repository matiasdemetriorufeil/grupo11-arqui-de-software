// ---------------------------------------------------------------------------
// Errores en formato RFC 9457 (application/problem+json).
//
// Es el mismo formato que publica el contrato en docs/contracts/openapi.yaml:
// los errores que ve el grupo consumidor se construyen aca.
// ---------------------------------------------------------------------------

const BASE_TIPOS = process.env.BASE_URI_PROBLEMAS ?? 'https://api.helios.example.com/problemas';

const TITULOS = {
  SOLICITUD_INVALIDA: ['Solicitud inválida', 400, 'solicitud-invalida'],
  NO_AUTENTICADO: ['No autenticado', 401, 'no-autenticado'],
  SCOPE_INSUFICIENTE: ['Sin permisos', 403, 'sin-permisos'],
  NO_ENCONTRADO: ['Recurso no encontrado', 404, 'no-encontrado'],
  STOCK_INSUFICIENTE: ['Stock insuficiente', 409, 'stock-insuficiente'],
  COTIZACION_EXPIRADA: ['Cotización expirada', 409, 'cotizacion-expirada'],
  RESERVA_EXPIRADA: ['Reserva expirada', 409, 'reserva-expirada'],
  ESTADO_NO_CANCELABLE: ['Estado no cancelable', 409, 'estado-no-cancelable'],
  ESTADO_NO_CONFIRMABLE: ['Estado no confirmable', 409, 'estado-no-confirmable'],
  CLAVE_IDEMPOTENCIA_REUSADA: ['Clave de idempotencia reusada', 409, 'clave-idempotencia-reusada'],
  CANTIDAD_NO_MULTIPLO_EMBALAJE: ['Regla de negocio incumplida', 422, 'regla-de-negocio'],
  MONTO_MINIMO_NO_ALCANZADO: ['Regla de negocio incumplida', 422, 'regla-de-negocio'],
  CUPO_CLIENTE_EXCEDIDO: ['Regla de negocio incumplida', 422, 'regla-de-negocio'],
  LINEAS_NO_COINCIDEN: ['Regla de negocio incumplida', 422, 'regla-de-negocio'],
  SKU_DESCONTINUADO: ['Regla de negocio incumplida', 422, 'regla-de-negocio'],
  LIMITE_DE_TASA_EXCEDIDO: ['Demasiadas solicitudes', 429, 'limite-de-tasa'],
  NO_IMPLEMENTADO: ['Operación no implementada todavía', 501, 'no-implementado'],
  SERVICIO_NO_DISPONIBLE: ['Servicio no disponible', 503, 'servicio-no-disponible'],
};

/** Sugerencia de espera que acompaña a un 503 (header Retry-After). */
const SEGUNDOS_PARA_REINTENTAR = 5;

/** Error de dominio que el middleware traduce a una respuesta problem+json. */
export class ErrorDeDominio extends Error {
  constructor(codigo, detail, extra = {}) {
    const [title, status] = TITULOS[codigo] ?? ['Error interno', 500, 'error-interno'];
    super(detail ?? title);
    this.name = 'ErrorDeDominio';
    this.codigo = codigo;
    this.status = status;
    this.title = title;
    this.extra = extra;
  }
}

export function problema(codigo, { detail, instance, traceId, extra } = {}) {
  const [title, status, slug] = TITULOS[codigo] ?? ['Error interno', 500, 'error-interno'];
  return {
    type: `${BASE_TIPOS}/${slug}`,
    title,
    status,
    codigo,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
    reintentable: status === 429 || status === 503,
    ...extra,
  };
}

/** Middleware final de errores. Debe registrarse despues de todas las rutas. */
export function middlewareDeErrores(log) {
  return (err, req, res, _next) => {
    const codigo = err instanceof ErrorDeDominio ? err.codigo : 'ERROR_INTERNO';
    const cuerpo = problema(codigo, {
      detail: err instanceof ErrorDeDominio ? err.message : 'Error interno del servicio.',
      instance: req.originalUrl,
      traceId: req.id,
      extra: err.extra,
    });
    if (cuerpo.status >= 500) log.error({ err, correlation_id: req.id }, 'error no manejado');
    // El contrato declara Retry-After en todo 503: el consumidor sabe cuándo reintentar.
    if (cuerpo.status === 503) res.set('Retry-After', String(SEGUNDOS_PARA_REINTENTAR));
    res.status(cuerpo.status).type('application/problem+json').json(cuerpo);
  };
}

/** Respuesta estandar para endpoints declarados en el contrato pero aun sin implementar. */
export function noImplementadoTodavia(entrega) {
  return (req, res) => {
    res
      .status(501)
      .type('application/problem+json')
      .json(
        problema('NO_IMPLEMENTADO', {
          detail: `Esta operación está definida en el contrato y se implementa en la ${entrega}. ` +
            'Mientras tanto, el mock del contrato responde en http://localhost:4010 con datos de ejemplo.',
          instance: req.originalUrl,
          traceId: req.id,
        }),
      );
  };
}
