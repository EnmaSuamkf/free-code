#!/usr/bin/env node

/**
 * Calcula el consumo total de tokens de todas las sesiones de pi
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.free-code', 'agent', 'sessions');

function parseJsonl(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

function aggregateUsage(sessions) {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    calls: 0,
    sessions: sessions.length
  };

  sessions.forEach(entries => {
    entries.forEach(entry => {
      if (entry.type === 'message' && entry.message?.role === 'assistant' && entry.message?.usage) {
        const usage = entry.message.usage;
        totals.input += usage.input || 0;
        totals.output += usage.output || 0;
        totals.cacheRead += usage.cacheRead || 0;
        totals.cacheWrite += usage.cacheWrite || 0;
        totals.totalTokens += usage.totalTokens || 0;
        totals.totalCost += usage.cost?.total || 0;
        totals.calls += 1;
      }
    });
  });

  return totals;
}

function getAllSessions(dir) {
  const sessions = [];
  
  function walkDir(currentPath) {
    const items = fs.readdirSync(currentPath);
    
    items.forEach(item => {
      const fullPath = path.join(currentPath, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory() && !item.startsWith('.')) {
        walkDir(fullPath);
      } else if (stat.isFile() && item.endsWith('.jsonl')) {
        try {
          const entries = parseJsonl(fullPath);
          sessions.push(entries);
        } catch (e) {
          console.error(`Error reading ${fullPath}:`, e.message);
        }
      }
    });
  }
  
  walkDir(dir);
  return sessions;
}

function formatCurrency(amount) {
  return `$${amount.toFixed(4)}`;
}

function formatNumber(num) {
  return num.toLocaleString('en-US');
}

// Main
console.log('\n🔍 Calculando consumo total de todas las sesiones...\n');

if (!fs.existsSync(SESSIONS_DIR)) {
  console.error(`❌ No se encontró el directorio de sesiones: ${SESSIONS_DIR}`);
  process.exit(1);
}

const sessions = getAllSessions(SESSIONS_DIR);
const totals = aggregateUsage(sessions);

console.log('📊 Resumen Total de Consumo\n');
console.log('═'.repeat(50));
console.log(`Sesiones totales:     ${formatNumber(totals.sessions)}`);
console.log(`Llamadas totales:     ${formatNumber(totals.calls)}`);
console.log('─'.repeat(50));
console.log(`Tokens de entrada:    ${formatNumber(totals.input)}`);
console.log(`Tokens de salida:     ${formatNumber(totals.output)}`);
console.log(`Cache read:           ${formatNumber(totals.cacheRead)}`);
console.log(`Cache write:          ${formatNumber(totals.cacheWrite)}`);
console.log('─'.repeat(50));
console.log(`Total tokens:         ${formatNumber(totals.totalTokens)}`);
console.log(`Costo total:          ${formatCurrency(totals.totalCost)}`);
console.log('═'.repeat(50));

// Promedios
if (totals.calls > 0) {
  console.log('\n📈 Promedios por llamada:\n');
  console.log(`Tokens promedio:      ${formatNumber(Math.round(totals.totalTokens / totals.calls))}`);
  console.log(`Costo promedio:       ${formatCurrency(totals.totalCost / totals.calls)}`);
}

console.log('\n');
