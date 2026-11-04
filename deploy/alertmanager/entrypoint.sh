#!/bin/sh
# Substitute environment variables into alertmanager.yml at runtime.
# Alertmanager does not natively expand ${VAR} placeholders, and it rejects
# empty webhook URLs, so we generate the final config here.
set -e

mkdir -p /etc/alertmanager

# LOW #70: Read the alert receiver token from the Docker secret file instead
# of an environment variable so it never appears in `docker inspect`.
if [ -f /run/secrets/alert_receiver_token ]; then
  TOKEN="$(cat /run/secrets/alert_receiver_token)"
else
  TOKEN="${ALERT_RECEIVER_TOKEN:-}"
fi
EXTERNAL="${ALERT_WEBHOOK_URL:-}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: alert_receiver_token secret or ALERT_RECEIVER_TOKEN env var is required" >&2
  exit 1
fi

CONFIG_FILE=/etc/alertmanager/alertmanager.generated.yml

if [ -n "$EXTERNAL" ]; then
  cat > "$CONFIG_FILE" <<EOF
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'cinematicai-webhook'
  routes:
    - match:
        severity: critical
      receiver: 'cinematicai-webhook'
      continue: true
    - match:
        severity: warning
      receiver: 'cinematicai-webhook'
      continue: false

receivers:
  - name: 'cinematicai-webhook'
    webhook_configs:
      - url: 'http://backend:34567/api/alerts/alerts'
        send_resolved: true
        http_config:
          bearer_token: '${TOKEN}'
      - url: '${EXTERNAL}'
        send_resolved: true

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname']
EOF
else
  cat > "$CONFIG_FILE" <<EOF
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'cinematicai-webhook'
  routes:
    - match:
        severity: critical
      receiver: 'cinematicai-webhook'
      continue: true
    - match:
        severity: warning
      receiver: 'cinematicai-webhook'
      continue: false

receivers:
  - name: 'cinematicai-webhook'
    webhook_configs:
      - url: 'http://backend:34567/api/alerts/alerts'
        send_resolved: true
        http_config:
          bearer_token: '${TOKEN}'

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname']
EOF
fi

exec /bin/alertmanager --config.file="$CONFIG_FILE" "$@"
