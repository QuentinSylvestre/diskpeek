import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { scanPath, SCANNER_BIN } from './scanner.js';
import { listDrives } from './drives.js';
import { trashPaths, deletePaths, revealInExplorer } from './cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Phase 8: domain allowlist replaced with SRI hash directives.
      // sha384 values match cdn.jsdelivr.net/npm/d3@7.9.0 and unpkg.com/lucide@0.263.0.
      scriptSrc: [
        "'self'",
        "'sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i'",
        "'sha384-JNhb/AfQ8tCvhjfm2WXKx9qovmn7LcndXYllHYDf2CcTBaBMAiPsjRJeC3f9U8V6'",
      ],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      // 'unsafe-inline' retained intentionally: index.html carries an inline <style>
      // block for drive-panel layout overrides added in Phase 4. Removing it requires
      // extracting that block to a static CSS file first (see Follow-up Work #19).
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));

// express.json() scoped to POST routes only — FIX-17 from Phase 2
const jsonBody = express.json({ limit: '10kb' });
// Larger limit for bulk cleanup endpoints (FIX-11)
const jsonBodyBulk = express.json({ limit: '256kb' });

app.use('/static', express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// GET /drives — enumerate available Windows drives (wmic primary, PowerShell fallback)
app.get('/drives', async (req, res) => {
  try {
    const drives = await listDrives();
    res.json(drives);
  } catch (err) {
    res.status(500).json({ error: 'Failed to enumerate drives: ' + err.message });
  }
});

// Allowed scan modes; reject anything else to prevent injection into argv
const VALID_MODES = new Set(['auto', 'mft', 'parallel']);

/**
 * Validate and canonicalize a Windows scan path.
 * Rejects: non-strings, null bytes, relative paths, non-Windows-absolute paths.
 * Returns normalized path on success, null on failure.
 * Caller responsibility per scanner/src/main.rs comment.
 */
function validateScanPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return null;
  if (p.includes('\x00')) return null;
  // Must be Windows absolute: drive letter (C:\) or UNC (\\server\share)
  if (!/^[a-zA-Z]:\\/.test(p) && !p.startsWith('\\\\')) return null;
  return path.normalize(p);
}

// POST /scan — streams NDJSON as SSE for one or more drive paths
// Body: { paths: [{path: "C:\\", drive: "C"}, ...], mode?: "auto" }
// Scans each path sequentially; all entries stream to the same SSE response.
app.post('/scan', jsonBody, async (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'JSON body required' });

  const { paths, mode = 'auto' } = req.body;

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array of {path, drive} objects' });
  }

  // Check binary BEFORE setting SSE headers so the client sees a proper JSON error
  if (!existsSync(SCANNER_BIN)) {
    return res.status(500).json({
      error: 'Scanner binary not found. Run: cd scanner && cargo build --release'
    });
  }

  // Validate all paths up-front; skip invalid entries rather than 400-ing the whole request
  const validPaths = [];
  for (const item of paths) {
    if (!item || typeof item !== 'object') continue;
    const safe = validateScanPath(item.path);
    if (!safe) continue;
    // Derive drive letter from the item's drive field, or fall back to the path's first char
    const drive =
      typeof item.drive === 'string' && item.drive.length >= 1
        ? item.drive.substring(0, 1).toUpperCase()
        : safe.charAt(0).toUpperCase();
    validPaths.push({ path: safe, drive });
  }

  if (validPaths.length === 0) {
    return res.status(400).json({ error: 'No valid absolute Windows paths in request' });
  }

  const effectiveMode = VALID_MODES.has(mode) ? mode : 'auto';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Track client disconnect so we can stop the sequential loop early
  let closed = false;
  res.on('close', () => { closed = true; });

  // Scan each path sequentially — all entries stream to the same SSE response.
  // scanPath() returns a Promise that resolves when the scan process closes.
  for (const item of validPaths) {
    if (closed) break;
    await scanPath(item.path, effectiveMode, item.drive, res);
  }

  if (!closed && !res.writableEnded) res.end();
});

app.post('/trash', jsonBodyBulk, async (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'JSON body required' });
  const { paths } = req.body;
  if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be array' });
  const normalizedPaths = [];
  for (const p of paths) {
    const safe = (typeof p === 'string') && validateScanPath(p);
    if (!safe) return res.status(400).json({ error: `Invalid path: ${p}` });
    normalizedPaths.push(safe);
  }
  res.json(await trashPaths(normalizedPaths));
});

app.post('/delete', jsonBodyBulk, async (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'JSON body required' });
  const { paths } = req.body;
  if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be array' });
  const normalizedPaths = [];
  for (const p of paths) {
    const safe = (typeof p === 'string') && validateScanPath(p);
    if (!safe) return res.status(400).json({ error: `Invalid path: ${p}` });
    normalizedPaths.push(safe);
  }
  res.json(await deletePaths(normalizedPaths));
});

app.get('/reveal', (req, res) => {
  const { path: rawPath } = req.query;
  if (!rawPath) return res.status(400).json({ error: 'path required' });
  if (!validateScanPath(rawPath)) return res.status(400).json({ error: 'Invalid path' });
  try { revealInExplorer(rawPath); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Malformed or oversized JSON bodies: answer with a JSON 400/413 instead of Express's
// default handler, which logs a full stack trace to the console for each one.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
});

// Bind to loopback only — prevents LAN access to file-deletion endpoints
app.listen(3000, '127.0.0.1', () => console.log('DiskPeek running on http://localhost:3000'));
