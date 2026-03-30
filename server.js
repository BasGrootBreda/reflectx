const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// ─── LOAD & VALIDATE CONFIG ───
const CONFIG = loadAndValidateConfig();

function loadAndValidateConfig() {
  const configPath = path.join(__dirname, 'reflectx-config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw);

  const errors = [];
  const plos = ['ontwikkelen','analyseren','adviseren','managen','ontwerpen','onderzoeken','implementeren'];
  const years = ['1','2','stage','afstuderen'];
  const langs = ['nl','en'];

  // Top-level keys
  ['plo','years','jargon','ploProbes','fieldCriteria','concretenessChecks','hints','toneRules','qualityGates','logisticsLenses'].forEach(k => {
    if (!cfg[k]) errors.push('Missing top-level key: ' + k);
  });

  // PLO definitions: 7 × 2
  langs.forEach(lang => {
    plos.forEach(plo => {
      const p = cfg.plo?.[lang]?.[plo];
      if (!p) { errors.push(`Missing plo.${lang}.${plo}`); return; }
      if (!p.name) errors.push(`Missing plo.${lang}.${plo}.name`);
      if (!p.desc) errors.push(`Missing plo.${lang}.${plo}.desc`);
    });
  });

  // Years: 4 × 2
  langs.forEach(lang => {
    const yrs = cfg.years?.[lang];
    if (!yrs || !Array.isArray(yrs)) { errors.push(`Missing/invalid years.${lang}`); return; }
    years.forEach(k => {
      if (!yrs.some(y => y.k === k)) errors.push(`Missing years.${lang} entry: ${k}`);
    });
  });

  // Jargon: 4 levels with cumulative markers
  years.forEach(yr => {
    if (!cfg.jargon?.[yr]) errors.push(`Missing jargon.${yr}`);
  });
  if (cfg.jargon?.['2'] && !cfg.jargon['2'].includes('+YEAR1+')) errors.push('jargon.2 missing +YEAR1+ marker');
  if (cfg.jargon?.stage && !cfg.jargon.stage.includes('+YEAR2+')) errors.push('jargon.stage missing +YEAR2+ marker');
  if (cfg.jargon?.afstuderen && !cfg.jargon.afstuderen.includes('+STAGE+')) errors.push('jargon.afstuderen missing +STAGE+ marker');

  // PLO probes: 7 × 2
  langs.forEach(lang => {
    plos.forEach(plo => {
      if (!cfg.ploProbes?.[lang]?.[plo]) errors.push(`Missing ploProbes.${lang}.${plo}`);
    });
  });

  // Field criteria: S,T,A,R1 + adv + R2×4 + T2×4
  ['S','T','A','R1'].forEach(f => {
    if (!cfg.fieldCriteria?.[f]) errors.push(`Missing fieldCriteria.${f}`);
    if (!cfg.fieldCriteria?.[f + '_adv']) errors.push(`Missing fieldCriteria.${f}_adv`);
  });
  years.forEach(yr => {
    if (!cfg.fieldCriteria?.R2?.[yr]) errors.push(`Missing fieldCriteria.R2.${yr}`);
    if (!cfg.fieldCriteria?.T2?.[yr]) errors.push(`Missing fieldCriteria.T2.${yr}`);
  });

  // Concreteness checks: S,T,A,R1 + R2×4 + T2×4
  ['S','T','A','R1'].forEach(f => {
    if (!cfg.concretenessChecks?.[f]) errors.push(`Missing concretenessChecks.${f}`);
  });
  years.forEach(yr => {
    if (!cfg.concretenessChecks?.R2?.[yr]) errors.push(`Missing concretenessChecks.R2.${yr}`);
    if (!cfg.concretenessChecks?.T2?.[yr]) errors.push(`Missing concretenessChecks.T2.${yr}`);
  });

  // Hints: per lang, S/T/A/R1 (default+example), R2/T2 (per year+example), evidence
  langs.forEach(lang => {
    const h = cfg.hints?.[lang];
    if (!h) { errors.push(`Missing hints.${lang}`); return; }
    ['S','T','A','R1'].forEach(f => {
      if (!h[f]?.default) errors.push(`Missing hints.${lang}.${f}.default`);
      if (!h[f]?.example) errors.push(`Missing hints.${lang}.${f}.example`);
    });
    if (!h.S?.adv) errors.push(`Missing hints.${lang}.S.adv`);
    ['R2','T2'].forEach(f => {
      years.forEach(yr => {
        if (!h[f]?.[yr]) errors.push(`Missing hints.${lang}.${f}.${yr}`);
        if (!h[f]?.[yr + '_example']) errors.push(`Missing hints.${lang}.${f}.${yr}_example`);
      });
    });
    if (!h.evidence?.hint) errors.push(`Missing hints.${lang}.evidence.hint`);
    if (!h.evidence?.placeholder) errors.push(`Missing hints.${lang}.evidence.placeholder`);
  });

  // Quality gates
  ['antiGeneric','repetitionCheck','patternProbe'].forEach(k => {
    if (!cfg.qualityGates?.[k]) errors.push(`Missing qualityGates.${k}`);
  });

  // Tone rules & logistics lenses
  if (typeof cfg.toneRules !== 'string' || cfg.toneRules.length < 50) errors.push('Missing/short toneRules');
  if (typeof cfg.logisticsLenses !== 'string' || cfg.logisticsLenses.length < 20) errors.push('Missing/short logisticsLenses');

  if (errors.length > 0) {
    console.error('CONFIG VALIDATION FAILED:');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }

  console.log('Config validated: OK (' +
    plos.length + ' PLOs × ' + langs.length + ' langs, ' +
    years.length + ' year levels, ' +
    Object.keys(cfg.qualityGates).length + ' quality gates)');
  return cfg;
}

// ─── JARGON RESOLVER ───
function resolveJargon(year) {
  const j = CONFIG.jargon;
  const j1 = j['1'];
  const j2 = j['2'].replace('+YEAR1+', j1);
  const js = j['stage'].replace('+YEAR2+', j2);
  const ja = j['afstuderen'].replace('+STAGE+', js);
  return { '1': j1, '2': j2, 'stage': js, 'afstuderen': ja }[year] || j1;
}

// ─── RATE LIMITER (10 requests/min per IP) ───
const rateLimits = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 1000; // 1 minute

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    rateLimits.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT) return true;
  return false;
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_WINDOW * 2) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

// ─── PROMPT BUILDER ───
function buildSystemPrompt({ lang, plo, year, round, prevFeedback, lockedFields, changedFields, lockedOkFields }) {
  const nl = lang === 'nl';
  const yr1 = year === '1';
  const yr2 = year === '2';
  const yr3 = year === 'stage';
  const yr4 = year === 'afstuderen';
  const adv = yr3 || yr4;

  const ploData = CONFIG.plo[lang][plo];
  if (!ploData) throw new Error('Unknown PLO: ' + plo);

  const yearLabel = nl
    ? { '1': 'Jaar 1', '2': 'Jaar 2', 'stage': 'Stage', 'afstuderen': 'Afstuderen' }[year]
    : { '1': 'Year 1', '2': 'Year 2', 'stage': 'Placement', 'afstuderen': 'Graduation' }[year];

  const jargon = resolveJargon(year);
  const probes = (CONFIG.ploProbes[lang] || {})[plo] || '';
  const fc = CONFIG.fieldCriteria;
  const cc = CONFIG.concretenessChecks;
  const qg = CONFIG.qualityGates;

  const letters = ['S', 'T', 'A', 'R', 'R', 'T'];
  const fieldLabels = nl
    ? ['Situatie', 'Taak', 'Actie', 'Resultaat', 'Reflectie', 'Transfer']
    : ['Situation', 'Task', 'Action', 'Result', 'Reflection', 'Transfer'];

  // ─── Consistency note ───
  let consistencyNote = '';
  if (round > 0 && prevFeedback) {
    const lockedList = (lockedOkFields || []).map(i => letters[i] + ' (' + fieldLabels[i] + ')').join(', ');
    const changedList = (changedFields || []).map(i => letters[i] + ' (' + fieldLabels[i] + ')').join(', ');
    consistencyNote = `
CONSISTENCY RULE (critical):
Previous round feedback: ${JSON.stringify(prevFeedback.fields)}
- Fields LOCKED as ok (student did NOT change text): ${lockedList || 'none'}
  → Do NOT re-assess these. Keep status "ok" and repeat the previous feedback verbatim.
- Fields to assess: ${changedList || 'none'}
  → Only assess these fields. A field previously "ok" whose text was changed by the student must be re-assessed — it may still be ok or may now need work.
  → A field previously "needs_work" that the student improved: assess against criteria. If it now meets criteria, mark "ok".
  → NEVER downgrade a field from "ok" to "needs_work" if the text has not changed.`;
  }

  // ─── Pattern probe ───
  let patternProbe = '';
  if (round >= 1 && (yr3 || yr4)) {
    patternProbe = `\n${qg.patternProbe.replace('(stage/graduation)', `(stage/graduation, round ${round + 1})`)}`;
  }

  // ─── Assemble prompt ───
  return `You are a STARRT reflection feedback tool for HBO Logistics students (BUas). Language: ${nl ? 'Dutch' : 'English'} ONLY.
Student: ${yearLabel} | PLO: ${ploData.name} — ${ploData.desc}
Relevant jargon: ${jargon}
Feedback round: ${round + 1}

TASK: Assess all 6 STARRT fields against the criteria below. Return structured JSON.

${CONFIG.toneRules}

CRITERIA per field (each field has ONE clear focus — do not assess content that belongs in another field):
S (Situatie/Situation): ${fc.S}${adv ? fc.S_adv : ''}
T (Taak/Task): ${fc.T}${adv ? fc.T_adv : ''}
A (Actie/Action): ${fc.A}${adv ? fc.A_adv : ''}
R1 (Resultaat/Result): ${fc.R1}${adv ? fc.R1_adv : ''}
R2 (Reflectie/Reflection): WHAT YOU LEARNED ABOUT YOURSELF. ${fc.R2[year]} Do NOT repeat the result — focus on the insight about the self.
T2 (Transfer): WHAT YOU WILL DO NEXT. ${fc.T2[year]} Do NOT repeat the reflection — focus on the plan.

QUALITY GATES (apply to every field):
${patternProbe}
${qg.antiGeneric}

2. CONCRETENESS CHECK: Look for concrete anchors in each field.
   Situatie: ${cc.S}
   Taak: ${cc.T}
   Actie: ${cc.A}
   Resultaat: ${cc.R1}
   Reflectie: ${cc.R2[year]}
   Transfer: ${cc.T2[year]}
   If concrete anchors are missing: flag in feedback what type of anchor is needed.

${qg.repetitionCheck}

PLO-SPECIFIC PROBES (use max 1 as a priority question if it fits):
${probes}

LOGISTICS LENSES (use max 1 per round as deepening):
${CONFIG.logisticsLenses}

FEEDBACK STRUCTURE:
1. Per field: status + ONE sentence observation grounded in student's text.
2. Max 3 PRIORITIES total — the points that make biggest difference. Each: field + one open question. Focus on weakest fields. NEVER more than 3.
3. EVIDENCE: if the student has not described any evidence (the evidence field is empty or very vague), include ONE priority suggesting what kind of evidence would strengthen this reflection. Examples: feedback from a supervisor, a screenshot, a KPI measurement, a grade, an email. Evidence is recommended, not required — do not block the student.
4. PLO ALIGNMENT: does content fit PLO "${ploData.name}"? If mismatch: flag which PLO fits better.
5. SUMMARY: only if round >= 3 OR all fields "ok". Count complete fields, list remaining gaps.

OUTPUT — ONLY this JSON, no text before/after, no backticks:
{
  "fields": [
    {"letter": "S", "status": "ok|needs_work", "feedback": "one sentence"},
    {"letter": "T", "status": "ok|needs_work", "feedback": "..."},
    {"letter": "A", "status": "ok|needs_work", "feedback": "..."},
    {"letter": "R1", "status": "ok|needs_work", "feedback": "..."},
    {"letter": "R2", "status": "ok|needs_work", "feedback": "..."},
    {"letter": "T2", "status": "ok|needs_work", "feedback": "..."}
  ],
  "priorities": [
    {"field": "A", "question": "one open question"}
  ],
  "plo_alignment": "ok|mismatch",
  "plo_note": "only if mismatch",
  "summary": ${round >= 2 ? `"one sentence in ${nl ? 'Dutch' : 'English'}"` : '"null"'}
}
${consistencyNote}`;
}

// ─── HTTP HELPERS ───
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

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
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

    if (result.status === 200) return result;

    if ((result.status === 529 || result.status === 500) && attempt < retries) {
      const wait = attempt * 2000;
      console.log(`Retrying in ${wait}ms...`);
      await sleep(wait);
      continue;
    }

    return result;
  }
}

// ─── SERVER ───
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve index.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const file = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(file);
    } catch (e) {
      res.writeHead(500); res.end('index.html not found: ' + e.message);
    }
    return;
  }

  // Serve config (PLO, years, hints — needed by frontend for UI)
  if (req.method === 'GET' && req.url === '/api/config') {
    const clientConfig = {
      plo: CONFIG.plo,
      years: CONFIG.years,
      hints: CONFIG.hints
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clientConfig));
    return;
  }

  // Chat endpoint — builds prompt server-side
  if (req.method === 'POST' && req.url === '/api/chat') {
    // Rate limiting
    const ip = getClientIP(req);
    if (isRateLimited(ip)) {
      console.log('Rate limited:', ip);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests. Wait a moment and try again.' }));
      return;
    }

    console.log('POST /api/chat from', ip);
    try {
      const rawBody = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
        return;
      }

      const { lang, plo, year, round, prevFeedback, lockedFields, changedFields, lockedOkFields, userMessage } = parsed;

      if (!lang || !plo || !year || userMessage === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: lang, plo, year, userMessage' }));
        return;
      }

      if (!API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured' }));
        return;
      }

      // Build prompt server-side
      const system = buildSystemPrompt({
        lang, plo, year,
        round: round || 0,
        prevFeedback: prevFeedback || null,
        lockedFields: lockedFields || {},
        changedFields: changedFields || [],
        lockedOkFields: lockedOkFields || []
      });

      console.log('Prompt tokens (est):', Math.round(system.length / 4));

      const result = await callAnthropic({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system,
        messages: [{ role: 'user', content: userMessage }]
      });

      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);

    } catch (e) {
      console.error('Unhandled error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`ReflectX running on port ${PORT}`));
