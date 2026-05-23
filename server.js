import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileP = promisify(execFile);
const PORT      = process.env.PORT ?? 4242;
const OZ        = 'oz';

const TERMINAL = new Set(['succeeded','failed','cancelled','errored','error',
                          'SUCCEEDED','FAILED','CANCELLED','ERRORED']);

// ── oz CLI helpers ─────────────────────────────────────────────────────────────────
const OZ_ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}` };

async function ozJson(args) {
  const { stdout } = await execFileP(OZ, [...args, '--output-format', 'json'], { env: OZ_ENV });
  return JSON.parse(stdout.trim() || 'null');
}

// Normalize uppercase state (INPROGRESS, SUCCEEDED, ...) to lowercase with underscores
function normalizeState(s) {
  if (!s) return s;
  const map = { INPROGRESS: 'in_progress', SUCCEEDED: 'succeeded', FAILED: 'failed',
                CANCELLED: 'cancelled', ERRORED: 'errored', PENDING: 'pending',
                QUEUED: 'queued', RUNNING: 'running', ERROR: 'error' };
  return map[s] ?? s.toLowerCase();
}

// Extract readable text from a --conversation response
function extractConversationOutput(conv) {
  if (!conv?.steps) return '';
  const parts = [];
  for (const step of conv.steps) {
    for (const msg of step.messages ?? []) {
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (typeof content === 'string') { parts.push(content); continue; }
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text) parts.push(c.text);
        }
      }
    }
  }
  return parts.join('\n\n').trim();
}

// Fetch run + latest conversation output, normalized
async function getRunWithOutput(runId) {
  const [run, conv] = await Promise.allSettled([
    ozJson(['run', 'get', runId]),
    ozJson(['run', 'get', runId, '--conversation']),
  ]);
  const r = run.status === 'fulfilled' ? run.value : {};
  const output = conv.status === 'fulfilled' ? extractConversationOutput(conv.value) : '';
  return { ...r, state: normalizeState(r.state), output };
}

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, 'public')));

// POST /api/run — dispatch a new cloud agent run
app.post('/api/run', async (req, res) => {
  const { prompt, environment_id } = req.body ?? {};
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required' });

  try {
    const args = ['agent', 'run-cloud', '--prompt', prompt];
    if (environment_id) args.push('--environment', environment_id);
    else                args.push('--no-environment');

    // oz agent run-cloud outputs plain text: "Spawned agent with run ID: <uuid>"
    // --output-format json may not produce structured output for this command
    const { stdout } = await execFileP(OZ, args, {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}` },
    });

    // Try JSON first, fall back to regex extraction
    let run_id;
    try {
      const parsed = JSON.parse(stdout.trim());
      run_id = parsed.run_id ?? parsed.id ?? parsed.runId;
    } catch {
      const match = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      run_id = match?.[0];
    }

    if (!run_id) {
      console.error('run-cloud output:', stdout);
      return res.status(500).json({ error: `Could not extract run ID from: ${stdout.trim()}` });
    }

    res.json({ run_id, state: 'pending', prompt });
  } catch (err) {
    console.error('run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/runs — list recent runs (normalize states)
app.get('/api/runs', async (req, res) => {
  try {
    const data = await ozJson(['run', 'list']);
    const runs = (data?.runs ?? data ?? []).map(r => ({ ...r, state: normalizeState(r.state) }));
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/run/:id — get run details with output
app.get('/api/run/:id', async (req, res) => {
  try {
    res.json(await getRunWithOutput(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/run/:id/events — SSE stream polling run state + output until terminal
app.get('/api/run/:id/events', async (req, res) => {
  const runId = req.params.id;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let timer;

  const poll = async () => {
    try {
      const run = await getRunWithOutput(runId);
      send(run);
      if (TERMINAL.has(run?.state)) {
        clearInterval(timer);
        res.end();
      }
    } catch (err) {
      send({ error: err.message });
      clearInterval(timer);
      res.end();
    }
  };

  await poll();
  timer = setInterval(poll, 3000);
  req.on('close', () => clearInterval(timer));
});

// GET /api/environments — list available environments
app.get('/api/environments', async (req, res) => {
  try {
    res.json(await ozJson(['environment', 'list']));
  } catch {
    res.json([]);
  }
});

app.listen(PORT, () => {
  console.log(`oz-relay  →  http://localhost:${PORT}`);
  console.log(`auth      →  oz CLI session (no API key required)`);
});
