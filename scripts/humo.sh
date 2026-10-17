#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Prueba de humo del sistema levantado.
#
#   docker compose up -d
#   ./scripts/humo.sh
#
# Verifica, en este orden:
#   1. Todos los contenedores arriba y sanos.
#   2. El mock del contrato sirve los ejemplos y permite forzar errores.
#   3. El gateway exige JWT y lo valida.
#   4. La validación de parámetros respeta el contrato.
#   5. El balanceo reparte entre las dos instancias.
#   6. Las tres bases quedaron inicializadas.
#
# Sale con código distinto de cero si alguna verificación falla.
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(dirname "$0")/.."

GATEWAY="http://localhost:${PUERTO_GATEWAY:-8000}"
MOCK="http://localhost:${PUERTO_MOCK:-4010}"

ok=0
fallos=0

verificar() {
  local descripcion="$1"
  local esperado="$2"
  local obtenido="$3"
  if [[ "${obtenido}" == "${esperado}" ]]; then
    printf '  \033[32mOK\033[0m   %s\n' "${descripcion}"
    ok=$((ok + 1))
  else
    printf '  \033[31mFALLA\033[0m %s\n       esperado: %s\n       obtenido: %s\n' \
      "${descripcion}" "${esperado}" "${obtenido}"
    fallos=$((fallos + 1))
  fi
}

estado() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo
echo '=== 1. Contenedores ==='
# Un contenedor está bien si su estado empieza con "Up" y no dice "unhealthy"
# ni "starting". El formato del texto de Docker varía ("Up 2 minutes",
# "Up About a minute"), así que se verifica el prefijo, no la duración.
no_sanos=$(docker compose ps --format '{{.Service}}|{{.Status}}' \
  | awk -F'|' '$2 !~ /^Up / || $2 ~ /unhealthy|starting/ { print }' \
  | wc -l | tr -d ' ')
verificar 'todos los contenedores arriba y sanos' '0' "${no_sanos}"
docker compose ps --format '  {{.Service}}: {{.Status}}'

echo
echo '=== 2. Mock del contrato ==='
AUTH='Authorization: Bearer token-de-prueba'
verificar 'catálogo responde 200' '200' "$(estado "${MOCK}/v1/proveedor/catalogo" -H "${AUTH}")"
verificar 'sin autenticación responde 401' '401' "$(estado "${MOCK}/v1/proveedor/catalogo")"

skus=$(curl -s "${MOCK}/v1/proveedor/catalogo" -H "${AUTH}" \
  | grep -o '"sku":"[^"]*"' | head -1 | cut -d'"' -f4)
verificar 'el catálogo trae los SKUs del contrato' 'HEL-PAN-550-JKM' "${skus}"

cuerpo='{"cotizacion_id":"7f1c9d3e-5b42-4a1f-9d0e-2c7b8a6f4e11","lineas":[{"sku":"HEL-PAN-550-JKM","cantidad":108}]}'
IDEM='Idempotency-Key: 3d1a0d7c-8f52-4c64-9b6e-1f0a2e5c7d93'
verificar 'reservar responde 201' '201' \
  "$(estado -X POST "${MOCK}/v1/pedidos/reservar" -H "${AUTH}" -H "${IDEM}" \
      -H 'Content-Type: application/json' -d "${cuerpo}")"
verificar 'se puede forzar el error 409 del contrato' '409' \
  "$(estado -X POST "${MOCK}/v1/pedidos/reservar" -H "${AUTH}" -H "${IDEM}" \
      -H 'Prefer: code=409' -H 'Content-Type: application/json' -d "${cuerpo}")"

codigo=$(curl -s -X POST "${MOCK}/v1/pedidos/reservar" -H "${AUTH}" -H "${IDEM}" \
  -H 'Prefer: code=409' -H 'Content-Type: application/json' -d "${cuerpo}" \
  | grep -o '"codigo":"[^"]*"' | cut -d'"' -f4)
verificar 'el error trae el código estable' 'STOCK_INSUFICIENTE' "${codigo}"

echo
echo '=== 3. Gateway: autenticación ==='
verificar 'mock a través del gateway' '200' "$(estado "${GATEWAY}/mock/v1/proveedor/catalogo" -H "${AUTH}")"
verificar '/v1 sin JWT rechaza' '401' "$(estado "${GATEWAY}/v1/proveedor/catalogo")"
verificar 'salud sin autenticación' '200' "$(estado "${GATEWAY}/salud/stock/salud/viva")"

TOKEN=$(./scripts/token.sh 2>/dev/null)
if [[ -z "${TOKEN}" ]]; then
  printf '  \033[31mFALLA\033[0m no se pudo emitir el token de desarrollo\n'
  fallos=$((fallos + 1))
else
  JWT="Authorization: Bearer ${TOKEN}"
  # 501 es la respuesta esperada en la Entrega 1: el endpoint existe, está
  # autenticado y llega al servicio, pero la implementación llega en la Entrega 2.
  verificar 'JWT válido llega al servicio (501 en Entrega 1)' '501' \
    "$(estado "${GATEWAY}/v1/proveedor/catalogo" -H "${JWT}")"

  echo
  echo '=== 4. Validación según el contrato ==='
  verificar 'parámetros inválidos rechazan con 400' '400' \
    "$(estado "${GATEWAY}/v1/proveedor/catalogo?pagina=0&orden=precio" -H "${JWT}")"
  verificar 'reservar sin Idempotency-Key rechaza con 400' '400' \
    "$(estado -X POST "${GATEWAY}/v1/pedidos/reservar" -H "${JWT}" \
        -H 'Content-Type: application/json' -d '{}')"

  echo
  echo '=== 4b. Primer endpoint real: disponibilidad contra PostgreSQL ==='
  libres=$(curl -s "${GATEWAY}/v1/proveedor/disponibilidad?sku=HEL-PAN-550-JKM&cantidad=36" -H "${JWT}"     | grep -o '"unidades_libres":[0-9]*' | cut -d: -f2)
  verificar 'disponibilidad responde con las unidades libres reales' 'true'     "$([[ "${libres}" =~ ^[0-9]+$ ]] && echo true || echo "${libres:-sin respuesta}")"

  echo
  echo '=== 5. Balanceo de carga ==='
  instancias=$(for _ in $(seq 1 10); do
    curl -s -o /dev/null -D- "${GATEWAY}/v1/proveedor/catalogo" -H "${JWT}" \
      | grep -i '^x-instancia' | tr -d '\r' | awk '{print $2}'
  done | sort -u | wc -l | tr -d ' ')
  verificar 'las dos instancias atienden tráfico' '2' "${instancias}"
fi

echo
echo '=== 6. Bases de datos inicializadas ==='
productos=$(docker compose exec -T postgres-catalog \
  psql -U "${PG_USUARIO:-helios}" -d helios_catalogo -tAc \
  'select count(*) from catalogo.producto' 2>/dev/null | tr -d ' \r')
verificar 'catálogo con productos de demo' '5' "${productos}"

existencias=$(docker compose exec -T postgres-stock \
  psql -U "${PG_USUARIO:-helios}" -d helios_stock -tAc \
  'select count(*) from stock.existencia' 2>/dev/null | tr -d ' \r')
verificar 'stock con existencias de demo' '6' "${existencias}"

reponer=$(docker compose exec -T postgres-stock \
  psql -U "${PG_USUARIO:-helios}" -d helios_stock -tAc \
  'select count(*) from stock.existencia_disponible where requiere_reposicion' 2>/dev/null | tr -d ' \r')
verificar 'la vista detecta lo que hay que reponer' '1' "${reponer}"

perfiles=$(docker compose exec -T mongo-import mongosh \
  "mongodb://${MONGO_USUARIO:-helios}:${MONGO_CLAVE:-helios_dev}@localhost:27017/helios_importaciones?authSource=admin" \
  --quiet --eval 'db.perfil_mapeo.countDocuments()' 2>/dev/null | tr -d ' \r')
verificar 'mongo con perfiles de mapeo' '2' "${perfiles}"

echo
printf '=== Resultado: \033[32m%d correctas\033[0m, \033[31m%d fallas\033[0m ===\n' "${ok}" "${fallos}"
echo
[[ ${fallos} -eq 0 ]]
