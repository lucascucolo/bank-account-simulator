const express = require('express');
const readline = require('readline');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000';
const INTERVAL_MS = Number(process.env.INTERVAL_MS) || 1500;

let isRunning = process.env.AUTO_START !== 'false';

// Sorteia e executa uma operação bancária contra a account-api
async function sendRandomRequest() {
  if (!isRunning) return;

  const roll = Math.random();
  let endpoint = '/statement';
  let options = { method: 'GET' };

  if (roll < 0.4) {
    // 40% de chance: Depósito entre R$ 10 e R$ 100
    const amount = Math.floor(Math.random() * 91) + 10;
    endpoint = '/deposit';
    options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 1, amount }),
    };
  } else if (roll < 0.75) {
    // 35% de chance: Saque entre R$ 10 e R$ 120
    const amount = Math.floor(Math.random() * 111) + 10;
    endpoint = '/withdraw';
    options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 1, amount }),
    };
  }

  try {
    const res = await fetch(`${TARGET_URL}${endpoint}`, options);
    const body = await res.json();
    console.log(`[load-gen] ${options.method} ${endpoint} -> HTTP ${res.status}`, JSON.stringify(body));
  } catch (err) {
    console.error(`[load-gen] Falha ao chamar ${endpoint}:`, err.message);
  }
}

setInterval(sendRandomRequest, INTERVAL_MS);

// --- CONTROLE 1: Endpoints HTTP (/start, /stop, /status) ---
app.post('/start', (_req, res) => {
  isRunning = true;
  console.log('▶️  [load-gen] Geração de carga ATIVADA via HTTP');
  res.json({ running: isRunning, message: 'Gerador de carga iniciado.' });
});

app.post('/stop', (_req, res) => {
  isRunning = false;
  console.log('⏸️  [load-gen] Geração de carga PAUSADA via HTTP');
  res.json({ running: isRunning, message: 'Gerador de carga pausado.' });
});

app.get('/status', (_req, res) => {
  res.json({ running: isRunning, target: TARGET_URL, intervalMs: INTERVAL_MS });
});

// --- CONTROLE 2: Atalho de Teclado no Terminal (Barra de Espaço ou 's') ---
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_str, key) => {
    if (key.ctrl && key.name === 'c') {
      process.exit(0);
    }
    if (key.name === 'space' || key.name === 's') {
      isRunning = !isRunning;
      console.log(isRunning ? '▶️  [load-gen] Retomado via teclado!' : '⏸️  [load-gen] Pausado via teclado!');
    }
  });
}

app.listen(PORT, () => {
  console.log(`[load-gen] Controle HTTP na porta ${PORT} (POST /start | POST /stop | GET /status)`);
  console.log(`[load-gen] Alvo: ${TARGET_URL} a cada ${INTERVAL_MS}ms | Estado inicial: ${isRunning ? 'ATIVO' : 'PAUSADO'}`);
  if (process.stdin.isTTY) {
    console.log(`[load-gen] Dica: Pressione [ESPAÇO] ou [S] no terminal para pausar/retomar.`);
  }
});

