const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { TraceIdRatioBasedSampler, AlwaysOnSampler, ParentBasedSampler } = require('@opentelemetry/sdk-trace-node');
const { metrics } = require('@opentelemetry/api');
const { monitorEventLoopDelay } = require('perf_hooks');

const serviceName = process.env.OTEL_SERVICE_NAME || 'ledger-service';
const serviceVersion = process.env.OTEL_SERVICE_VERSION || '1.0.0';
const environment = process.env.DEPLOYMENT_ENVIRONMENT || 'local-lab';
const collectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

// SAMPLING (Amostragem Head-Based):
// O ParentBasedSampler respeita a decisão de amostragem vinda do serviço pai (account-api) via W3C traceparent.
// Se for o início do trace, usa samplingRatio (1.0 = 100% no laboratório).
const samplingRatio = Number(process.env.OTEL_TRACES_SAMPLER_ARG) || 1.0;
const sampler = new ParentBasedSampler({
  root: samplingRatio >= 1.0 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(samplingRatio),
});

// 1. Define a identidade do serviço (Resource Attributes padronizados)
const resource = new Resource({
  'service.name': serviceName,
  'service.version': serviceVersion,
  'deployment.environment': environment,
});

// 2. Configura o SDK oficial do OpenTelemetry (Traces + Métricas + Auto-instrumentação HTTP/Express/PG)
const sdk = new NodeSDK({
  resource,
  sampler, // <-- Amostragem Head-Based configurada aqui
  traceExporter: new OTLPTraceExporter({
    url: `${collectorUrl}/v1/traces`,
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${collectorUrl}/v1/metrics`,
    }),
    exportIntervalMillis: 5000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: true },
    }),
  ],
});

sdk.start();

// 3. Métricas de Infraestrutura / Runtime do Container Node.js (Memória RAM, Heap V8, CPU e Event Loop Lag)
const runtimeMeter = metrics.getMeter('nodejs-runtime-metrics', '1.0.0');
const loopHistogram = monitorEventLoopDelay({ resolution: 10 });
loopHistogram.enable();

runtimeMeter.createObservableGauge('nodejs_memory_rss_bytes', {
  description: 'Memoria RAM fisica (RSS) alocada pelo container Node.js em bytes',
}).addCallback((res) => res.observe(process.memoryUsage().rss));

runtimeMeter.createObservableGauge('nodejs_memory_heap_used_bytes', {
  description: 'Memoria Heap V8 em uso pelo servico Node.js em bytes',
}).addCallback((res) => res.observe(process.memoryUsage().heapUsed));

runtimeMeter.createObservableGauge('nodejs_eventloop_lag_ms', {
  description: 'Atraso medio do Event Loop do Node.js em milissegundos',
}).addCallback((res) => res.observe(loopHistogram.mean / 1e6));

runtimeMeter.createObservableGauge('nodejs_uptime_seconds', {
  description: 'Tempo de atividade (uptime) do container Node.js em segundos',
}).addCallback((res) => res.observe(process.uptime()));

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
