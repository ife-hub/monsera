/**
 * Local stand-in for the external scoring engine (SCORING_ENGINE_URL/decision),
 * used only by run-local.sh. Approves ~95% of requests up to ₦7,000 with
 * 50–300ms of latency so the debit path behaves like it does in production.
 * The real engine's latency is NOT modelled beyond that.
 *
 * Usage: node mock-scoring-engine.js [port]
 */
const http = require('http');

const port = Number(process.argv[2] || 4001);
const secret = process.env.SCORING_ENGINE_SECRET;

http
  .createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/decision') {
      res.writeHead(404).end();
      return;
    }
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const delay = 50 + Math.floor(Math.random() * 250);
      setTimeout(() => {
        const eligible = Math.random() >= 0.05;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            eligible
              ? { eligible: true, approved_amount: 7000, score: 700, band: 'B', model_version: 'mock-v1' }
              : { eligible: false, reason: 'mock decline', score: 400, band: 'B', model_version: 'mock-v1' }
          )
        );
      }, delay);
    });
  })
  .listen(port, () => console.log(`mock scoring engine on :${port}`));
