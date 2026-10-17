import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { detectCategory } from './junk.js';

// Load junk detection rules once at module startup.
// readFileSync + JSON.parse avoids JSON import assertion compatibility concerns.
const _rulesPath = new URL('./rules.json', import.meta.url);
const rulesData = JSON.parse(readFileSync(_rulesPath, 'utf8'));
const rules = rulesData.rules;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCANNER_BIN = path.resolve(__dirname, '..', 'scanner', 'target', 'release', 'scanner.exe');

// Concurrent scan guard — track the active scanner process and the response it feeds
let currentProc = null;
let currentRes = null;

export function killActiveScanner() {
  if (currentProc && currentProc.exitCode === null) currentProc.kill();
}

/**
 * Spawn the scanner binary and pipe its NDJSON output as Server-Sent Events.
 *
 * Returns a Promise that resolves when the scan process closes (success or error).
 * Caller (server.js) MUST:
 *   - Call res.end() after all sequential scans complete
 *   - Verify the binary exists before calling (ENOENT guard)
 *   - Validate and normalize scanPathStr (path traversal prevention)
 *   - Set SSE response headers and call res.flushHeaders() before calling this function
 *
 * Drive field injection: each NDJSON entry line gets a "drive" field injected.
 * SSE keep-alive: ":" heartbeat lines emitted by the MFT scanner (Phase 3) are forwarded
 *   as ":\n\n" SSE comment events so browsers don't drop the connection during first-pass silence.
 * Drain-aware: pauses readline when the HTTP write buffer is full; resumes on drain.
 * Disconnect-aware: kills the scanner process when the browser tab closes mid-scan.
 *
 * @param {string} scanPathStr - Absolute Windows path to scan
 * @param {string} mode        - Scan mode: 'auto' | 'mft' | 'parallel'
 * @param {string} drive       - Drive letter (e.g. 'C') injected into every entry object
 * @param {object} res         - Express response (SSE headers already set and flushed)
 * @returns {Promise<void>}    - Resolves when scan closes; never rejects
 */
export function scanPath(scanPathStr, mode, drive, res) {
  // A newer request supersedes an older one.  End the older response as well as its
  // scanner: otherwise its drive loop in server.js moves on to its next drive and
  // kills this request's scanner in turn, and both streams look complete.  The
  // superseded browser tab sees the stream close and reports the scan as incomplete.
  if (currentRes && currentRes !== res && !currentRes.writableEnded && !currentRes.destroyed) {
    currentRes.destroy();
  }
  killActiveScanner();

  const proc = spawn(SCANNER_BIN, ['--path', scanPathStr, '--mode', mode]);
  currentProc = proc;
  currentRes = res;

  // Drain stderr to prevent pipe buffer overflow (scanner may emit diagnostics)
  if (proc.stderr) proc.stderr.resume();

  const rl = readline.createInterface({ input: proc.stdout });

  // Kill scanner when the SSE response closes (tab close, navigation, browser disconnect).
  // Listening on res, NOT req: req 'close' fires when the POST body is consumed by
  // express.json() middleware — immediately after the body is read — which would kill
  // the scanner before it produces any output.
  // stdout is torn down too: if it is paused waiting for a 'drain' that a closed
  // response will never emit, the process 'close' event (and this promise) would hang.
  // Removed again when this scanner closes, so a multi-drive scan does not accumulate
  // one stale listener per drive on the shared response.
  const onResClose = () => {
    if (proc.exitCode === null) proc.kill();
    rl.close();
    proc.stdout.destroy();
  };
  res.once('close', onResClose);

  // Drain-aware write: pause readline if the HTTP write buffer is full.
  // rl.pause() stops reading stdout, but lines already split from the current chunk
  // are still emitted synchronously; the flag keeps it to one 'drain' listener per
  // pause instead of one per such line (MaxListenersExceededWarning otherwise).
  // The listener is removed when the scanner closes: stdout can end while a drain is
  // still pending, and the shared response must not carry it into the next drive.
  let drainPending = false;
  const onDrain = () => {
    drainPending = false;
    rl.resume();
  };
  const write = (chunk) => {
    if (!res.write(chunk) && !drainPending) {
      drainPending = true;
      rl.pause();
      res.once('drain', onDrain);
    }
  };

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      // Guard: don't write to a closed or destroyed response
      if (res.writableEnded || res.destroyed) return;

      // SSE keep-alive: ":" heartbeat lines from the MFT scanner's first pass.
      // Forward as SSE comment (":\n\n") so browsers keep the connection alive
      // during the silent window between first-pass (FRN→path map) and second-pass entries.
      if (line.startsWith(':')) {
        write(':\n\n');
        return;
      }

      // Drive field injection and junk category detection: parse entry lines,
      // add the drive letter, apply junk detection rules.
      // Non-entry lines (header, summary, error) are forwarded unchanged.
      let output = line;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'entry') {
          obj.drive = drive;
          obj.category = detectCategory(obj, rules, process.env);
          output = JSON.stringify(obj);
        }
      } catch {
        // Not valid JSON — pass through as-is (should not occur in normal operation)
      }

      write(`data: ${output}\n\n`);
    });

    proc.on('close', (code) => {
      res.off('close', onResClose);
      res.off('drain', onDrain);
      if (code !== 0 && code !== null && !res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: 'error', path: '', message: `Scanner exited with code ${code}` })}\n\n`);
      }
      // Do NOT call res.end() here — server.js ends the response after all sequential scans
      resolve();
    });

    proc.on('error', (err) => {
      res.off('close', onResClose);
      res.off('drain', onDrain);
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: 'error', path: '', message: err.message })}\n\n`);
      }
      resolve();
    });
  });
}
