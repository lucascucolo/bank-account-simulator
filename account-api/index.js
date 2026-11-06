const express = require('express');
const path = require('path');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const logger = require('./logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LEDGER_URL = process.env.LEDGER_URL || 'http://localhost:3001';
const LOAD_GEN_URL = process.env.LOAD_GEN_URL || 'http://localhost:3002';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const LOKI_URL = process.env.LOKI_URL || 'http://localhost:3100';
const TEMPO_URL = process.env.TEMPO_URL || 'http://localhost:3200';

// Obtém um Tracer e um Meter para instrumentação manual
const tracer = trace.getTracer('account-api-tracer', '1.0.0');
const meter = metrics.getMeter('account-api-meter', '1.0.0');

// Métrica de Domínio (Etapa 4): Contador de transações bancárias por tipo, status e família HTTP (2xx, 4xx, 5xx)
const bankTransactionsCounter = meter.createCounter('bank_transactions_total', {
  description: 'Total de operacoes bancarias solicitadas na API por tipo, resultado e familia de status HTTP',
});

function getStatusClass(statusCode) {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  return '2xx';
}

// GET / - Serve o painel visual minimalista
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Proxy para controlar o Simulador de Incidentes
let localChaos = {
  serviceCommunicationFailure: false, // Simula particao/falha de comunicacao com o ledger-service (502 Bad Gateway)
};

// Cache em memória para contingência e resiliência (Graceful Degradation)
let lastKnownAccountSnapshot = { id: 1, owner: 'Cliente Demo', balance: 100.0 };
let lastKnownTransactionsSnapshot = [];

// Helper para encaminhar chamadas ao ledger-service (o fetch nativo propaga o traceparent automaticamente)
async function forwardToLedger(urlPath, options = {}) {
  // INCIDENTE 3 (Edital Seção 4.1): Falha de comunicação entre serviços
  if (localChaos.serviceCommunicationFailure) {
    throw new Error('connect ECONNREFUSED http://ledger-service:3001 (Simulação de Interrupção de Rede / Queda a Montante)');
  }

  const response = await fetch(`${LEDGER_URL}${urlPath}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json();
  return { status: response.status, data };
}

// POST /deposit - Realiza depósito em uma conta
app.post('/deposit', async (req, res) => {
  const { accountId = 1, amount } = req.body;

  return tracer.startActiveSpan('bank.operation.deposit', async (span) => {
    span.setAttributes({
      'operation.type': 'deposit',
      'account.id': Number(accountId),
      'transaction.amount': Number(amount),
    });

    try {
      logger.info({ operation: 'deposit', accountId, amount }, 'Iniciando solicitacao de deposito');

      const { status, data } = await forwardToLedger('/ledger/deposit', {
        method: 'POST',
        body: JSON.stringify({ accountId, amount }),
      });

      const outcome = status >= 200 && status < 300 ? 'success' : 'error';
      const statusClass = getStatusClass(status);
      bankTransactionsCounter.add(1, { 'operation.type': 'deposit', status: outcome, status_class: statusClass });

      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: data.error || 'Erro 5xx no deposito' });
        logger.error({ operation: 'deposit', accountId, amount, status, status_class: statusClass, error: data.error, details: data.details }, 'INCIDENTE 5xx: Falha critica no ledger-service durante /deposit');
      } else if (status >= 400) {
        logger.warn({ operation: 'deposit', accountId, amount, status, status_class: statusClass, error: data.error }, 'Deposito recusado por regra de negocio (4xx)');
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
        logger.info({ operation: 'deposit', accountId, amount, newBalance: data.account?.balance }, 'Deposito concluido com sucesso');
      }

      res.status(status).json(data);
    } catch (err) {
      bankTransactionsCounter.add(1, { 'operation.type': 'deposit', status: 'error', status_class: '5xx' });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error({ operation: 'deposit', accountId, status_class: '5xx', err: err.message }, 'Falha ao comunicar com o ledger-service no /deposit');
      res.status(502).json({ error: 'Falha ao comunicar com o ledger-service', details: err.message });
    } finally {
      span.end();
    }
  });
});

// POST /withdraw - Realiza saque em uma conta
app.post('/withdraw', async (req, res) => {
  const { accountId = 1, amount } = req.body;

  return tracer.startActiveSpan('bank.operation.withdraw', async (span) => {
    span.setAttributes({
      'operation.type': 'withdraw',
      'account.id': Number(accountId),
      'transaction.amount': Number(amount),
    });

    try {
      logger.info({ operation: 'withdraw', accountId, amount }, 'Iniciando solicitacao de saque');

      const { status, data } = await forwardToLedger('/ledger/withdraw', {
        method: 'POST',
        body: JSON.stringify({ accountId, amount }),
      });

      const outcome = status >= 200 && status < 300 ? 'success' : 'error';
      const statusClass = getStatusClass(status);
      bankTransactionsCounter.add(1, { 'operation.type': 'withdraw', status: outcome, status_class: statusClass });

      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: data.error || 'Erro 5xx no saque' });
        logger.error({ operation: 'withdraw', accountId, amount, status, status_class: statusClass, error: data.error }, 'Erro critico no ledger-service durante /withdraw');
      } else if (status >= 400) {
        logger.warn({ operation: 'withdraw', accountId, amount, status, status_class: statusClass, error: data.error }, 'Saque recusado por regra de negocio (4xx - Saldo insuficiente)');
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
        logger.info({ operation: 'withdraw', accountId, amount, newBalance: data.account?.balance }, 'Saque concluido com sucesso');
      }

      res.status(status).json(data);
    } catch (err) {
      bankTransactionsCounter.add(1, { 'operation.type': 'withdraw', status: 'error', status_class: '5xx' });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error({ operation: 'withdraw', accountId, status_class: '5xx', err: err.message }, 'Falha ao comunicar com o ledger-service no /withdraw');
      res.status(502).json({ error: 'Falha ao comunicar com o ledger-service', details: err.message });
    } finally {
      span.end();
    }
  });
});

// GET /statement - Consulta saldo e extrato da conta
app.get('/statement', async (req, res) => {
  const accountId = req.query.accountId || 1;

  return tracer.startActiveSpan('bank.operation.statement', async (span) => {
    span.setAttributes({
      'operation.type': 'statement',
      'account.id': Number(accountId),
    });

    try {
      logger.info({ operation: 'statement', accountId }, 'Consultando extrato da conta');

      const { status, data } = await forwardToLedger(`/ledger/statement/${accountId}`);

      // RESILIÊNCIA / GRACEFUL DEGRADATION:
      // Se o ledger-service falhar internamente (5xx), a account-api isola o erro e atende via cache
      if (status >= 500) {
        logger.warn(
          { operation: 'statement', accountId, downstreamStatus: status, downstreamError: data.error },
          'RESILIÊNCIA: ledger-service falhou com 5xx, ativando Fallback Gracioso com snapshot em cache (Graceful Degradation)'
        );
        span.setAttributes({
          'resilience.fallback_applied': true,
          'resilience.downstream_status': status,
        });
        span.setStatus({ code: SpanStatusCode.OK, message: 'Degraded: Fallback aplicado com sucesso' });
        bankTransactionsCounter.add(1, { 'operation.type': 'statement', status: 'success', status_class: '2xx' });

        return res.status(200).json({
          account: lastKnownAccountSnapshot,
          transactions: lastKnownTransactionsSnapshot,
          degraded: true,
          fallbackReason: 'ledger-service com falha interna 500 (resiliência com cache ativo)',
        });
      }

      if (data.account) {
        lastKnownAccountSnapshot = data.account;
        lastKnownTransactionsSnapshot = data.transactions || [];
      }

      const outcome = status >= 200 && status < 300 ? 'success' : 'error';
      const statusClass = getStatusClass(status);
      bankTransactionsCounter.add(1, { 'operation.type': 'statement', status: outcome, status_class: statusClass });

      span.setStatus({ code: status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      res.status(status).json(data);
    } catch (err) {
      bankTransactionsCounter.add(1, { 'operation.type': 'statement', status: 'error', status_class: '5xx' });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error({ operation: 'statement', accountId, status_class: '5xx', err: err.message }, 'Falha ao comunicar com o ledger-service no /statement');
      res.status(502).json({ error: 'Falha ao comunicar com o ledger-service', details: err.message });
    } finally {
      span.end();
    }
  });
});

// Proxy para controlar o load-gen direto pelos botões da página
app.get('/load-gen/status', async (_req, res) => {
  try {
    const r = await fetch(`${LOAD_GEN_URL}/status`);
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ running: false, error: err.message });
  }
});

app.post('/load-gen/:action(start|stop)', async (req, res) => {
  try {
    const r = await fetch(`${LOAD_GEN_URL}/${req.params.action}`, { method: 'POST' });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Proxy para controlar o Simulador de Incidentes
app.get('/chaos/status', async (_req, res) => {
  let ledgerChaos = {};
  try {
    const response = await fetch(`${LEDGER_URL}/chaos/status`);
    ledgerChaos = await response.json();
  } catch (_) {}

  res.json({
    serviceCommunicationFailure: localChaos.serviceCommunicationFailure,
    withdrawLatencyMs: ledgerChaos.withdrawLatencyMs || 0,
    depositDbFailure: Boolean(ledgerChaos.depositDbFailure),
    ledgerIsolatedFailure: Boolean(ledgerChaos.ledgerIsolatedFailure),
  });
});

app.post('/chaos/config', async (req, res) => {
  if (req.body.serviceCommunicationFailure !== undefined) {
    localChaos.serviceCommunicationFailure = Boolean(req.body.serviceCommunicationFailure);
    logger.warn({ localChaos }, 'Chaos: Falha de comunicação entre serviços alterada na account-api');
  }

  let ledgerChaos = {};
  try {
    const response = await fetch(`${LEDGER_URL}/chaos/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    ledgerChaos = await response.json();
  } catch (_) {}

  res.json({
    message: 'Estado de incidentes atualizado',
    chaosState: {
      serviceCommunicationFailure: localChaos.serviceCommunicationFailure,
      withdrawLatencyMs: ledgerChaos.chaosState?.withdrawLatencyMs || 0,
      depositDbFailure: Boolean(ledgerChaos.chaosState?.depositDbFailure),
      ledgerIsolatedFailure: Boolean(ledgerChaos.chaosState?.ledgerIsolatedFailure),
    },
  });
});

// --- ASSISTENTE DE IA (SRE COM GOOGLE GEMINI) ---
// Coleta em tempo real Métricas (Prometheus), Logs de Erro/Alerta (Loki) e Traces (Tempo) e envia ao Gemini
async function queryProm(promql) {
  try {
    const r = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`);
    const j = await r.json();
    return j.data?.result || [];
  } catch {
    return [];
  }
}

async function queryLokiRecentErrors() {
  try {
    const query = '{service_name=~".+"} |~ "\\"level\\":(40|50)"';
    const r = await fetch(`${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&limit=10`);
    const j = await r.json();
    const lines = [];
    for (const stream of j.data?.result || []) {
      for (const [, line] of stream.values || []) {
        lines.push(line);
      }
    }
    return lines.slice(0, 10);
  } catch {
    return [];
  }
}

async function queryTempoRecentTraces() {
  try {
    const r = await fetch(`${TEMPO_URL}/api/search?limit=10`);
    const j = await r.json();
    return j.traces || [];
  } catch {
    return [];
  }
}

app.post('/ai/analyze', async (req, res) => {
  const question = req.body.question || 'Analise a saúde atual da aplicação bancária, possíveis incidentes ativos e causa raiz.';
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  try {
    // 1. Coleta dados reais de APLICAÇÃO (RED, Logs, Traces) + INFRAESTRUTURA (Containers, RAM, CPU, Event Loop, Pipeline OTel, TSDB)
    const [
      p95Res,
      err5xxRes,
      err4xxRes,
      rpsRes,
      targetsUpRes,
      nodeRssRes,
      nodeHeapRes,
      nodeLagRes,
      nodeUptimeRes,
      stackRamRes,
      stackCpuRes,
      otelSpansSentRes,
      otelSpansFailedRes,
      tsdbSeriesRes,
      recentErrorLogs,
      recentTraces,
    ] = await Promise.all([
      queryProm('histogram_quantile(0.95, sum by (le, service_name) (rate(traces_spanmetrics_duration_milliseconds_bucket{span_kind="SPAN_KIND_SERVER"}[2m])))'),
      queryProm('sum by (operation_type) (rate(bank_transactions_total{status_class="5xx"}[2m]))'),
      queryProm('sum by (operation_type) (rate(bank_transactions_total{status_class="4xx"}[2m]))'),
      queryProm('sum by (service_name) (rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER"}[2m]))'),
      queryProm('up'),
      queryProm('max by (service_name) (nodejs_memory_rss_bytes) / 1024 / 1024'),
      queryProm('max by (service_name) (nodejs_memory_heap_used_bytes) / 1024 / 1024'),
      queryProm('max by (service_name) (nodejs_eventloop_lag_ms)'),
      queryProm('max by (service_name) (nodejs_uptime_seconds)'),
      queryProm('process_resident_memory_bytes / 1024 / 1024'),
      queryProm('rate(process_cpu_seconds_total[1m]) * 100'),
      queryProm('sum(rate(otelcol_exporter_sent_spans[1m]))'),
      queryProm('sum(rate(otelcol_exporter_send_failed_spans[1m]))'),
      queryProm('prometheus_tsdb_head_series'),
      queryLokiRecentErrors(),
      queryTempoRecentTraces(),
    ]);

    const telemetrySnapshot = {
      timestamp: new Date().toISOString(),
      application_metrics_red: {
        request_rate_rps: rpsRes.map((m) => ({ service: m.metric.service_name, rps: Number(m.value?.[1] || 0).toFixed(2) })),
        latency_p95_ms: p95Res.map((m) => ({ service: m.metric.service_name, p95_ms: Number(m.value?.[1] || 0).toFixed(1) })),
        errors_5xx_per_sec: err5xxRes.map((m) => ({ operation: m.metric.operation_type, rate: Number(m.value?.[1] || 0).toFixed(2) })),
        errors_4xx_business_per_sec: err4xxRes.map((m) => ({ operation: m.metric.operation_type, rate: Number(m.value?.[1] || 0).toFixed(2) })),
      },
      infrastructure_and_runtime_metrics: {
        targets_availability: targetsUpRes.map((m) => ({ job: m.metric.job, instance: m.metric.instance, status: m.value?.[1] === '1' ? 'UP' : 'DOWN' })),
        nodejs_containers: {
          memory_rss_mb: nodeRssRes.map((m) => ({ service: m.metric.service_name, rss_mb: Number(m.value?.[1] || 0).toFixed(1) })),
          memory_v8_heap_mb: nodeHeapRes.map((m) => ({ service: m.metric.service_name, heap_mb: Number(m.value?.[1] || 0).toFixed(1) })),
          eventloop_lag_ms: nodeLagRes.map((m) => ({ service: m.metric.service_name, lag_ms: Number(m.value?.[1] || 0).toFixed(2) })),
          uptime_seconds: nodeUptimeRes.map((m) => ({ service: m.metric.service_name, uptime_s: Math.round(Number(m.value?.[1] || 0)) })),
        },
        observability_stack_containers: {
          ram_usage_mb: stackRamRes.map((m) => ({ container: m.metric.job, ram_mb: Number(m.value?.[1] || 0).toFixed(1) })),
          cpu_usage_percent: stackCpuRes.map((m) => ({ container: m.metric.job, cpu_pct: Number(m.value?.[1] || 0).toFixed(2) + '%' })),
        },
        telemetry_pipeline_health: {
          otel_collector_spans_sent_per_sec: Number(otelSpansSentRes[0]?.value?.[1] || 0).toFixed(1),
          otel_collector_spans_failed_per_sec: Number(otelSpansFailedRes[0]?.value?.[1] || 0).toFixed(2),
          prometheus_tsdb_active_series_cardinality: Number(tsdbSeriesRes[0]?.value?.[1] || 0),
        },
      },
      loki_recent_warn_error_logs: recentErrorLogs,
      tempo_recent_traces: recentTraces.map((t) => ({
        traceID: t.traceID,
        rootServiceName: t.rootServiceName,
        rootTraceName: t.rootTraceName,
        durationMs: t.durationMs,
      })),
    };

    if (!apiKey) {
      return res.status(400).json({
        error: 'Chave GEMINI_API_KEY não configurada no arquivo .env!',
        hint: 'Adicione sua chave no arquivo .env na raiz do projeto e rode: docker compose up -d account-api',
        telemetrySnapshot,
      });
    }

    const prompt = `Você é um Engenheiro SRE Especialista em Observabilidade e Infraestrutura (OpenTelemetry, Prometheus, Grafana Tempo, Loki e Containers Node.js/Docker) analisando ao vivo uma arquitetura bancária composta por:
- Microserviços Node.js: account-api (Gateway HTTP) e ledger-service (Regras financeiras + PostgreSQL)
- Stack de Infraestrutura/Telemetria: OpenTelemetry Collector, Prometheus, Grafana Tempo, Grafana Loki e PostgreSQL.

Aqui está o SNAPSHOT REAL DE TELEMETRIA (Camada de Aplicação RED + Camada de Infraestrutura/Containers/Runtime + Logs + Traces) coletado agora mesmo:
${JSON.stringify(telemetrySnapshot, null, 2)}

PERGUNTA DO ENGENHEIRO: "${question}"

Responda em Português de forma direta, técnica e estruturada em Markdown com a seguinte ordem de seções:
1. **Causa Raiz, Correlação Trace -> Log & Recomendações**: Comece direto pelo diagnóstico cirúrgico! Cite \`trace_id\` relevantes, aponte a causa raiz e forneça as recomendações corretivas imediatas.
2. **Saúde da Aplicação (RED & Apdex)**: Analise RPS, Latência P95 e diferencie erros 4xx (regra de negócio: saldo insuficiente) de erros 5xx (falha real).
3. **Saúde da Infraestrutura, Containers & Runtime**: Cite os números reais de Memória RAM (RSS e V8 Heap em MB), Event Loop Lag (ms) e Uptime dos containers Node.js, além do uso de CPU/RAM dos containers da stack (Prometheus, Loki, Tempo, Collector), throughput do pipeline OTel e cardinalidade ativa do TSDB (\`prometheus_tsdb_active_series_cardinality\`).
Finalize com conclusão executiva objetiva, concluindo todas as frases e blocos sem truncamento.`;

    // Prioriza os modelos mais rápidos e com menor fila, usando thinkingLevel: "low" para resposta em ~2-3s
    const candidateModels = Array.from(new Set([
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3.6-flash',
      model,
    ]));

    let answer = null;
    let usedModel = null;
    let lastError = null;

    for (const candidate of candidateModels) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${candidate}:generateContent?key=${apiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 2500,
              thinkingConfig: { thinkingLevel: 'low' },
            },
          }),
        });

        const geminiData = await geminiRes.json();
        const candidateChoice = geminiData.candidates?.[0];
        if (geminiRes.ok && candidateChoice?.content?.parts) {
          const text = candidateChoice.content.parts
            .filter((p) => p.text && !p.thought)
            .map((p) => p.text)
            .join('\n')
            .trim();
          if (text) {
            answer = text;
            usedModel = candidate;
            break;
          }
        }
        lastError = `[${candidate}] ${geminiData.error?.message || geminiRes.statusText}`;
      } catch (e) {
        lastError = `[${candidate}] ${e.message}`;
      }
    }

    // Fallback Resiliente: Se a nuvem da Google estiver com High Demand (503) no momento da demo,
    // gera a análise técnica estruturada diretamente a partir das métricas, logs e traces reais coletados!
    if (!answer) {
      const p95List = telemetrySnapshot.application_metrics_red.latency_p95_ms;
      const err5xxList = telemetrySnapshot.application_metrics_red.errors_5xx_per_sec;
      const infra = telemetrySnapshot.infrastructure_and_runtime_metrics;
      const maxP95 = Math.max(0, ...p95List.map((x) => Number(x.p95_ms) || 0));
      const total5xx = err5xxList.reduce((acc, x) => acc + (Number(x.rate) || 0), 0);
      const parsedLogs = telemetrySnapshot.loki_recent_warn_error_logs
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const err50Logs = parsedLogs.filter((l) => l.level >= 50);
      const warn40Logs = parsedLogs.filter((l) => l.level === 40);

      const isHealthy = total5xx === 0 && maxP95 < 250;
      usedModel = 'sre-telemetry-engine (Fallback local — API Gemini em alta demanda)';
      answer = [
        `### 1. Saúde da Aplicação (RED & Apdex)`,
        isHealthy
          ? `- **Status Operacional:** Saudável (Apdex ~0.99 / Verde). Nenhum erro 5xx ativo nos últimos 2 minutos (\`0.00 req/s\`) e latência P95 controlada (\`account-api: ${p95List.find((x) => x.service === 'account-api')?.p95_ms || '--'}ms\`, \`ledger-service: ${p95List.find((x) => x.service === 'ledger-service')?.p95_ms || '--'}ms\`).`
          : `- **Status Degradado:** Incidente ativo nas métricas RED! Taxa de erro 5xx: \`${total5xx.toFixed(2)} req/s\` | Pico de Latência P95: \`${maxP95}ms\`.`,
        `- **Separação 4xx vs 5xx:** \`${warn40Logs.length}\` alertas 4xx de regra de negócio (*Saldo insuficiente*) e \`${err50Logs.length}\` logs críticos de falha 5xx.\n`,
        `### 2. Saúde da Infraestrutura, Containers & Runtime`,
        `- **Containers Node.js (RAM & Event Loop):** ${infra.nodejs_containers.memory_rss_mb.map((m) => `\`${m.service}\`: RSS \`${m.rss_mb} MB\``).join(' | ')} | Event Loop Lag: ${infra.nodejs_containers.eventloop_lag_ms.map((l) => `\`${l.service}: ${l.lag_ms} ms\``).join(' | ')}.`,
        `- **Containers da Stack (CPU & RAM):** ${infra.observability_stack_containers.ram_usage_mb.map((c) => `\`${c.container}: ${c.ram_mb} MB\``).join(', ')}.`,
        `- **Pipeline OTel & Prometheus TSDB:** Collector enviando \`${infra.telemetry_pipeline_health.otel_collector_spans_sent_per_sec} spans/s\` (\`${infra.telemetry_pipeline_health.otel_collector_spans_failed_per_sec}\` falhas) | Cardinalidade ativa no TSDB: \`${infra.telemetry_pipeline_health.prometheus_tsdb_active_series_cardinality} séries\`.\n`,
        `### 3. Correlação Trace -> Log & Recomendação`,
        err50Logs.length > 0
          ? `- **Último Erro 5xx no Loki:** \`${err50Logs[0].msg}\` | TraceID: \`${err50Logs[0].trace_id}\`.`
          : `- **Último Alerta no Loki:** \`${warn40Logs[0]?.msg || 'Nenhum'}\` | TraceID: \`${warn40Logs[0]?.trace_id || 'N/A'}\`.`,
      ].join('\n');
    }

    res.json({ answer, model: usedModel, telemetrySnapshot });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao executar análise de IA: ' + err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ service: 'account-api', status: 'ok' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT, ledgerUrl: LEDGER_URL }, 'account-api iniciada');
});
