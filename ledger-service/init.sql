-- Criação das tabelas minimalistas para o laboratório bancário
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  owner VARCHAR(100) NOT NULL,
  balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id),
  type VARCHAR(20) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Conta padrão (id = 1) com saldo inicial de R$ 1.000,00
INSERT INTO accounts (id, owner, balance)
VALUES (1, 'Cliente Demo', 1000.00)
ON CONFLICT (id) DO NOTHING;

