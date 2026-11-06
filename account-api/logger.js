const pino = require('pino');
const { trace } = require('@opentelemetry/api');

const otelCollectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

// Envia o log estruturado também para o OTel Collector (/v1/logs) para cair no Loki sem precisar de agentes extras
function shipToOtelLogs(logObj) {
  fetch(`${otelCollectorUrl}/v1/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: logObj.service } },
              { key: 'deployment.environment', value: { stringValue: logObj.env } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(Date.now() * 1000000),
                  severityText: logObj.level >= 50 ? 'ERROR' : logObj.level >= 40 ? 'WARN' : 'INFO',
                  body: { stringValue: JSON.stringify(logObj) },
                  attributes: [
                    { key: 'trace_id', value: { stringValue: logObj.trace_id || '' } },
                    { key: 'span_id', value: { stringValue: logObj.span_id || '' } },
                    { key: 'operation', value: { stringValue: logObj.operation || '' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  }).catch(() => {});
}

const customStream = {
  write(msg) {
    process.stdout.write(msg);
    try {
      shipToOtelLogs(JSON.parse(msg));
    } catch (_) {}
  },
};

// Logger estruturado em JSON que injeta automaticamente trace_id e span_id em cada linha de log
const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: process.env.OTEL_SERVICE_NAME || 'account-api',
      env: process.env.DEPLOYMENT_ENVIRONMENT || 'local-lab',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const activeSpan = trace.getActiveSpan();
      if (!activeSpan) return {};
      const { traceId, spanId } = activeSpan.spanContext();
      return { trace_id: traceId, span_id: spanId };
    },
  },
  customStream
);

module.exports = logger;
