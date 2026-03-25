const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAnthropic(payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const result = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            console.log(`Anthropic status: ${res.statusCode} (attempt ${attempt}/${retries})`);
            console.log('Error body:', result.substring(0, 200));
          }
          resolve({ status: res.statusCode, body: result });
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // Success
    if (result.status === 200) return result;

    // Overloaded (529) or server error (500) — retry with backoff
    if ((result.status === 529 || result.status === 500) && attempt < retries) {
      const wait = attempt * 2000; // 2s, 4s
      console.log(`Retrying in ${wait}ms...`);
      await sleep(wait);
      continue;
    }

    // Other error or retries exhausted
    return result;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const file = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(file);
    } catch(e) {
      res.writeHead(500); res.end('index.html not found: ' + e.message);
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    console.log('POST /api/chat received');
    try {
      const rawBody = await readBody(req);
      console.log('Body length:', rawBody.length);

      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
        return;
      }

      const { system, messages } = parsed;
      if (!system || !messages) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing system or messages' }));
        return;
      }

      if (!API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured' }));
        return;
      }

      const result = await callAnthropic({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system,
        messages
      });

      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);

    } catch(e) {
      console.error('Unhandled error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`ReflectX running on port ${PORT}`));
