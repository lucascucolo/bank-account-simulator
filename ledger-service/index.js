const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const logger = require('./logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const tracer = trace.getTracer('ledger-service-tracer', '1.0.0');

// --- ESTADO DOS INCIDENTES (ETAPA 5: Chaos Engineering) ---
const chaosState = {
  withdrawLatencyMs: Number(process.env.CHAOS_WITHDRAW_LATENCY_MS) || 0, // Ex: 2000ms no /withdraw
  depositDbFailure: process.env.CHAOS_DEPOSIT_DB_FAILURE === 'true',     // Ex: Erro 500 de conexao com Postgres no /deposit
  ledgerIsolatedFailure: false,                                          // Erro 500 exclusivo no ledger-service com fallback resiliente no account-api
};

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'bank',
});

// Garante que as tabelas e a conta padrão existam ao iniciar
async function initDatabase() {
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
  await pool.query(sql);
  logger.info('Tabelas verificadas e conta padrao pronta no PostgreSQL');
}

// Helper para simular atraso sintético
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- ENDPOINTS DE CONTROLE DE INCIDENTES (CHAOS) ---
app.get('/chaos/status', (_req, res) => {
  res.json(chaosState);
});

app.post('/chaos/config', (req, res) => {
  if (req.body.withdrawLatencyMs !== undefined) {
    chaosState.withdrawLatencyMs = Number(req.body.withdrawLatencyMs) || 0;
  }
  if (req.body.depositDbFailure !== undefined) {
    chaosState.depositDbFailure = Boolean(req.body.depositDbFailure);
  }
  if (req.body.ledgerIsolatedFailure !== undefined) {
    chaosState.ledgerIsolatedFailure = Boolean(req.body.ledgerIsolatedFailure);
  }
  logger.warn({ chaosState }, 'Configuracao de Chaos Engineering (Incidentes) alterada no ledger-service');
  res.json({ message: 'Estado de incidentes atualizado', chaosState });
});

// POST /ledger/deposit - Registra depósito e atualiza saldo
app.post('/ledger/deposit', async (req, res) => {
  const { accountId = 1, amount } = req.body;
  const numericAmount = Number(amount);

  return tracer.startActiveSpan('ledger.process_deposit', async (span) => {
    span.setAttributes({
      'operation.type': 'deposit',
      'account.id': Number(accountId),
      'transaction.amount': numericAmount,
      'chaos.db_failure_injected': chaosState.depositDbFailure,
    });

    if (!numericAmount || numericAmount <= 0) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Valor de deposito invalido' });
      logger.warn({ operation: 'deposit', accountId, amount }, 'Tentativa de deposito com valor invalido');
      span.end();
      return res.status(400).json({ error: 'O valor do depósito deve ser maior que zero.' });
    }

    // INCIDENTE 2 (Erro 5xx): Falha forçada de conexão com o banco no /deposit
    if (chaosState.depositDbFailure) {
      const dbErr = new Error('FATAL: remaining connection slots are reserved for non-replication superuser connections (ECONNREFUSED postgres:5432)');
      span.recordException(dbErr);
      span.setStatus({ code: SpanStatusCode.ERROR, message: dbErr.message });
      logger.error(
        {
          operation: 'deposit',
          accountId,
          amount: numericAmount,
          db_host: process.env.DB_HOST || 'postgres',
          error_code: '53300_TOO_MANY_CONNECTIONS',
          err: dbErr.message,
        },
        'INCIDENTE: Falha critica de conexao com o PostgreSQL ao processar /deposit'
      );
      span.end();
      return res.status(500).json({
        error: 'Erro interno: Falha de conexão com o banco de dados PostgreSQL',
        details: dbErr.message,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updateRes = await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING id, owner, balance',
        [numericAmount, accountId]
      );

      if (updateRes.rowCount === 0) {
        await client.query('ROLLBACK');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Conta nao encontrada' });
        logger.warn({ operation: 'deposit', accountId }, 'Conta nao encontrada para deposito');
        return res.status(404).json({ error: 'Conta não encontrada.' });
      }

      await client.query(
        'INSERT INTO transactions (account_id, type, amount) VALUES ($1, $2, $3)',
        [accountId, 'deposit', numericAmount]
      );

      await client.query('COMMIT');

      const newBalance = Number(updateRes.rows[0].balance);
      span.setAttribute('account.new_balance', newBalance);
      span.setStatus({ code: SpanStatusCode.OK });
      logger.info({ operation: 'deposit', accountId, amount: numericAmount, newBalance }, 'Deposito persistido no ledger');

      res.json({
        operation: 'deposit',
        amount: numericAmount,
        account: updateRes.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK');
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error({ operation: 'deposit', accountId, err: err.message }, 'Erro de banco de dados ao processar deposito');
      res.status(500).json({ error: 'Erro interno ao processar depósito', details: err.message });
    } finally {
      client.release();
      span.end();
    }
  });
});

// POST /ledger/withdraw - Valida saldo e registra saque
app.post('/ledger/withdraw', async (req, res) => {
  const { accountId = 1, amount } = req.body;
  const numericAmount = Number(amount);

  return tracer.startActiveSpan('ledger.process_withdraw', async (span) => {
    span.setAttributes({
      'operation.type': 'withdraw',
      'account.id': Number(accountId),
      'transaction.amount': numericAmount,
      'chaos.latency_injected_ms': chaosState.withdrawLatencyMs,
    });

    if (!numericAmount || numericAmount <= 0) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Valor de saque invalido' });
      logger.warn({ operation: 'withdraw', accountId, amount }, 'Tentativa de saque com valor invalido');
      span.end();
      return res.status(400).json({ error: 'O valor do saque deve ser maior que zero.' });
    }

    // INCIDENTE 1 (Latência): Delay sintético no endpoint de /withdraw
    if (chaosState.withdrawLatencyMs > 0) {
      await tracer.startActiveSpan('ledger.anti_fraud_sync_lock_delay', async (delaySpan) => {
        delaySpan.setAttributes({
          'operation.type': 'withdraw',
          'chaos.injected_delay_ms': chaosState.withdrawLatencyMs,
          'bottleneck.component': 'legacy-fraud-lock-check',
        });
        logger.warn(
          {
            operation: 'withdraw',
            accountId,
            amount: numericAmount,
            injectedDelayMs: chaosState.withdrawLatencyMs,
          },
          `INCIDENTE DE LATENCIA: Travamento sintetico de ${chaosState.withdrawLatencyMs}ms durante validacao de saque (/withdraw)`
        );
        await sleep(chaosState.withdrawLatencyMs);
        delaySpan.end();
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const accRes = await client.query(
        'SELECT id, owner, balance FROM accounts WHERE id = $1 FOR UPDATE',
        [accountId]
      );

      if (accRes.rowCount === 0) {
        await client.query('ROLLBACK');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Conta nao encontrada' });
        logger.warn({ operation: 'withdraw', accountId }, 'Conta nao encontrada para saque');
        return res.status(404).json({ error: 'Conta não encontrada.' });
      }

      const currentBalance = Number(accRes.rows[0].balance);
      span.setAttribute('account.current_balance', currentBalance);

      if (currentBalance < numericAmount) {
        await client.query('ROLLBACK');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Saldo insuficiente' });
        logger.warn(
          { operation: 'withdraw', accountId, requested: numericAmount, currentBalance },
          'Regra financeira: Saldo insuficiente para saque'
        );
        return res.status(400).json({
          error: 'Saldo insuficiente.',
          balance: currentBalance,
          requested: numericAmount,
        });
      }

      const updateRes = await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING id, owner, balance',
        [numericAmount, accountId]
      );

      await client.query(
        'INSERT INTO transactions (account_id, type, amount) VALUES ($1, $2, $3)',
        [accountId, 'withdraw', numericAmount]
      );

      await client.query('COMMIT');

      const newBalance = Number(updateRes.rows[0].balance);
      span.setAttribute('account.new_balance', newBalance);
      span.setStatus({ code: SpanStatusCode.OK });
      logger.info({ operation: 'withdraw', accountId, amount: numericAmount, newBalance }, 'Saque persistido no ledger');

      res.json({
        operation: 'withdraw',
        amount: numericAmount,
        account: updateRes.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK');
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error({ operation: 'withdraw', accountId, err: err.message }, 'Erro de banco de dados ao processar saque');
      res.status(500).json({ error: 'Erro interno ao processar saque', details: err.message });
    } finally {
      client.release();
      span.end();
    }
  });
});

// GET /ledger/statement/:accountId - Retorna saldo e últimas 10 transações
app.get('/ledger/statement/:accountId', async (req, res) => {
  const { accountId } = req.params;

  return tracer.startActiveSpan('ledger.fetch_statement', async (span) => {
    span.setAttributes({
      'operation.type': 'statement',
      'account.id': Number(accountId),
    });

    // INCIDENTE EXCLUSIVO NO LEDGER (com Graceful Degradation / Fallback no account-api)
    if (chaosState.ledgerIsolatedFailure) {
      const internalErr = new Error('FATAL: Falha interna de sincronização na réplica contábil do ledger (SQL Timeout 500)');
      span.recordException(internalErr);
      span.setStatus({ code: SpanStatusCode.ERROR, message: internalErr.message });
      logger.error(
        {
          operation: 'statement',
          accountId,
          error_code: '50001_LEDGER_REPLICA_SYNC_ERROR',
          err: internalErr.message,
        },
        'INCIDENTE ISOLADO: Falha interna 500 exclusiva no ledger-service ao gerar extrato'
      );
      span.end();
      return res.status(500).json({
        error: 'Erro interno no ledger-service: Falha na réplica contábil',
        details: internalErr.message,
      });
    }

    try {
      const accRes = await pool.query('SELECT id, owner, balance FROM accounts WHERE id = $1', [accountId]);
      if (accRes.rowCount === 0) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Conta nao encontrada' });
        logger.warn({ operation: 'statement', accountId }, 'Conta nao encontrada ao buscar extrato');
        return res.status(404).json({ error: 'Conta não encontrada.' });
      }

      const txRes = await pool.query(
        'SELECT id, type, amount, created_at FROM transactions WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10',
        [accountId]
      );

      span.setAttribute('statement.transactions_count', txRes.rowCount);
      span.setStatus({ code: SpanStatusCode.OK });
      logger.info({ operation: 'statement', accountId, txCount: txRes.rowCount }, 'Extrato consultado no banco');

      res.json({
        account: accRes.rows[0],
        transactions: txRes.rows,
      });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error({ operation: 'statement', accountId, err: err.message }, 'Erro ao consultar extrato no banco');
      res.status(500).json({ error: 'Erro interno ao consultar extrato', details: err.message });
    } finally {
      span.end();
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({ service: 'ledger-service', status: 'ok', chaosState });
});

app.listen(PORT, async () => {
  logger.info({ port: PORT }, 'ledger-service iniciado');
  try {
    await initDatabase();
  } catch (err) {
    logger.warn({ err: err.message }, 'Banco ainda nao disponivel no startup');
  }
});
