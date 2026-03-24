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

function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
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
        console.log('Anthropic status:', res.statusCode);
        if (res.statusCode !== 200) console.log('Anthropic error body:', result.substring(0, 300));
        resolve({ status: res.statusCode, body: result });
      });
    });
    req.on('error', (e) => {
      console.error('HTTPS request error:', e.message);
      reject(e);
    });
    req.write(body);
    req.end();
  });
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
        console.error('JSON parse error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
        return;
      }

      const { system, messages } = parsed;
      if (!system || !messages) {
        console.error('Missing fields. Keys:', Object.keys(parsed));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing system or messages' }));
        return;
      }

      if (!API_KEY) {
        console.error('ANTHROPIC_API_KEY not set!');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured' }));
        return;
      }

      const result = await callAnthropic({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
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

  console.log('404:', req.method, req.url);
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`ReflectX running on port ${PORT}`));
