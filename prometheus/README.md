# Prometheus Monitoring

Prometheus scrapes metrics from the backend (`/metrics`), worker (`/metrics`),
and redis-exporter (sidecar that translates Redis RESP to Prometheus format).
Alertmanager, Grafana, and Loki are also wired into the compose stack for a
minimal observability plane.

## Configuration

The `prometheus.yml` file defines scrape targets for:
- Prometheus itself (`localhost:9090`)
- Backend API (`backend:34567/metrics`)
- Worker (`worker:3002/metrics`)
- Redis exporter (`redis-exporter:9121`)

`alerts.yml` contains example alert rules evaluated by Prometheus. Firing alerts
are forwarded to Alertmanager.

## Alerting

Alertmanager is deployed by `docker-compose.yml`. Its config is GENERATED at
container start by `deploy/alertmanager/entrypoint.sh` (the `alertmanager.yml`
in this directory is a template only). The default receiver posts to the
backend receiver at `http://backend:34567/api/alerts/alerts` (bearer token
from the `alert_receiver_token` Docker secret); set `ALERT_WEBHOOK_URL` for an
additional external receiver (Slack, PagerDuty, etc.).

## Logs & Dashboards

- **Loki** aggregates Docker container logs.
- **Promtail** ships container logs to Loki.
- **Grafana** is provisioned with Prometheus and Loki datasources; access it at
  `http://localhost:3003` (login password is read from
  `secrets/grafana_admin_password.txt`).
