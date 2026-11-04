#!/bin/sh
set -e

# Read the Loki tenant ID from the Docker secret, or fall back to a default.
# Loki runs with auth_enabled: true, so every client must send the
# X-Scope-OrgID header with this value.
TENANT_ID="${LOKI_TENANT_ID:-cinematicai}"
if [ -f /run/secrets/loki_tenant_id ]; then
  TENANT_ID="$(cat /run/secrets/loki_tenant_id)"
fi

# Copy the read-only provisioning templates into a writable location so we can
# substitute the tenant ID into the Loki datasource configuration.
mkdir -p /etc/grafana/provisioning/datasources
cp /etc/grafana/provisioning-templates/datasources/*.yml /etc/grafana/provisioning/datasources/ 2>/dev/null || true

cat > /etc/grafana/provisioning/datasources/datasources.yml <<EOF
# LOW #67: Grafana datasource provisioning for Prometheus and Loki.
# Generated at container start so the Loki X-Scope-OrgID tenant header can be
# injected from the loki_tenant_id Docker secret.
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false

  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: false
    jsonData:
      httpHeaderName1: X-Scope-OrgID
    secureJsonData:
      httpHeaderValue1: ${TENANT_ID}
EOF

exec /run.sh "$@"
