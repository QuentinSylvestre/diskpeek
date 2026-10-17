import { execFile } from 'child_process';
import { win32 } from 'path';
import trash from 'trash';
import { rm } from 'fs/promises';

const PROTECTED_PREFIXES = [
  win32.resolve('C:\\Windows'),
  win32.resolve('C:\\Program Files'),
  win32.resolve('C:\\Program Files (x86)'),
  win32.resolve('C:\\ProgramData'),
  process.env.APPDATA      ? win32.resolve(process.env.APPDATA)      : null,
  process.env.LOCALAPPDATA ? win32.resolve(process.env.LOCALAPPDATA) : null,
].filter(Boolean);

function safePath(raw) { return win32.resolve(raw); }

function isProtected(raw) {
  const n = safePath(raw).toLowerCase();
  return PROTECTED_PREFIXES.some(p =>
    n.startsWith(p.toLowerCase() + '\\') || n === p.toLowerCase());
}

export async function trashPaths(rawPaths) {
  const results = [];
  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || !raw) {
      results.push({ path: String(raw), ok: false, error: 'Invalid path type' });
      continue;
    }
    if (isProtected(raw)) {
      results.push({ path: raw, ok: false, error: 'Protected system path' });
      continue;
    }
    try {
      await trash(safePath(raw));
      results.push({ path: raw, ok: true });
    } catch (e) {
      results.push({ path: raw, ok: false, error: e.message });
    }
  }
  return results;
}

export async function deletePaths(rawPaths) {
  const results = [];
  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || !raw) {
      results.push({ path: String(raw), ok: false, error: 'Invalid path type' });
      continue;
    }
    if (isProtected(raw)) {
      results.push({ path: raw, ok: false, error: 'Protected system path' });
      continue;
    }
    try {
      await rm(safePath(raw), { recursive: true, force: true });
      results.push({ path: raw, ok: true });
    } catch (e) {
      results.push({ path: raw, ok: false, error: e.message });
    }
  }
  return results;
}

export function revealInExplorer(rawPath) {
  const resolved = safePath(rawPath);
  const proc = execFile(
    win32.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe'),
    ['/select,' + resolved]
  );
  proc.on('error', (err) => console.error('reveal execFile error:', err.message));
  proc.unref();
}
