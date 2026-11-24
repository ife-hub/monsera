// Pretends to be the scoring engine so a debit stress test never touches the real one.
// Usage: node stress\mock-scoring.js
//   PORT           listen port (default 4000)
//   DELAY_MS       simulated engine latency (default 50)
//   APPROVED_KOBO  approved_amount returned for every request (default 1000000 = N10,000)
//   DECISION_PATH  path the mock answers (default /decision)
const http = require('http');

const PORT = Number(process.env.PORT || 4000);
const DELAY_MS = Number(process.env.DELAY_MS || 50);
const APPROVED_KOBO = Number(process.env.APPROVED_KOBO || 1000000);
const DECISION_PATH = process.env.DECISION_PATH || '/decision';

let served = 0;

http
  .createServer((req, res) => {
    const path = (req.url || '').split('?')[0];

    // Quick check from a browser or PowerShell: http://localhost:4000/health
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mock: true, served }));
      return;
    }

    if (req.method === 'POST' && path === DECISION_PATH) {
      req.resume(); // drain the request body; the mock ignores it
      req.on('end', () =>
        setTimeout(() => {
          served++;
          if (served % 25 === 0) console.log(`[mock] served ${served} decisions`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              eligible: true,
              approved_amount: APPROVED_KOBO,
              score: 700,
              band: 'B',
              model_version: 'mock',
            }),
          );
        }, DELAY_MS),
      );
      return;
    }

    // Anything else: say so in this terminal, so a wrong path in payments is easy to spot.
    console.warn(`[mock] 404 ${req.method} ${req.url} (expected POST ${DECISION_PATH})`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  })
  .listen(PORT, () =>
    console.log(
      `Mock scoring engine on :${PORT} (delay ${DELAY_MS}ms, approves ${APPROVED_KOBO}, path ${DECISION_PATH})`,
    ),
  );