# LOW #66: Pin image by digest for reproducible, tamper-resistant builds.
FROM prom/alertmanager:v0.27.0@sha256:e13b6ed5cb929eeaee733479dce55e10eb3bc2e9c4586c705a4e8da41e5eacf5

USER root

COPY deploy/alertmanager/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && \
    mkdir -p /etc/alertmanager && \
    chown nobody:nobody /etc/alertmanager

USER nobody

ENTRYPOINT ["/entrypoint.sh"]
CMD ["--storage.path=/alertmanager"]
