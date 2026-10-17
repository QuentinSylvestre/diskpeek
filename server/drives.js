import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Parse wmic /format:list output into an array of key-value objects.
 * wmic outputs blocks separated by blank lines; each block has KEY=VALUE lines.
 * Normalizes CRLF before splitting so the regex is platform-safe.
 */
function parseWmicList(stdout) {
  const blocks = stdout.replace(/\r\n/g, '\n').split(/\n\n+/);
  return blocks.map(block => {
    const kv = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) kv[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
    }
    return kv;
  }).filter(kv => kv.Caption);
}

/**
 * Enumerate drives using wmic logicaldisk.
 * Works on Windows 10 and Windows 11 builds that still ship wmic.
 * Throws when wmic is absent or returns no drives.
 *
 * @returns {Promise<DriveInfo[]>}
 */
async function listDrivesWmic() {
  const { stdout } = await execFileAsync(
    'wmic',
    ['logicaldisk', 'get', 'Caption,DriveType,FreeSpace,Size,VolumeName', '/format:list'],
    { timeout: 10000 }
  );

  const drives = [];
  for (const kv of parseWmicList(stdout)) {
    const letter = kv.Caption.replace(':', '').trim();
    if (!letter || letter.length !== 1) continue;
    drives.push({
      letter,
      label:      kv.VolumeName || '',
      totalBytes: kv.Size      ? parseInt(kv.Size, 10)      : 0,
      freeBytes:  kv.FreeSpace ? parseInt(kv.FreeSpace, 10) : 0,
      type:       kv.DriveType ? parseInt(kv.DriveType, 10) : 0,
    });
  }

  if (drives.length === 0) throw new Error('wmic returned no drives');
  return drives;
}

/**
 * Enumerate drives using PowerShell System.IO.DriveInfo.
 * Fallback for Windows 11 22H2+ where wmic is absent.
 * Exported for direct testing per Phase 4 exit criteria.
 *
 * DriveType mapping from .NET DriveType enum:
 *   Unknown=0, NoRootDirectory=1, Removable=2, Fixed=3, Network=4, CDRom=5, Ram=6
 *
 * @returns {Promise<DriveInfo[]>}
 */
export async function listDrivesPowerShell() {
  // -Depth 5: defensive per PS 5.1 ConvertTo-Json truncation rule; objects are flat (depth 1 suffices).
  const psScript = [
    '[System.IO.DriveInfo]::GetDrives()',
    '| Where-Object { $_.IsReady }',
    '| ForEach-Object {',
    '  [PSCustomObject]@{',
    '    Letter = $_.Name.Substring(0,1);',
    '    Label  = $_.VolumeLabel;',
    '    TotalBytes = $_.TotalSize;',
    '    FreeBytes  = $_.AvailableFreeSpace;',
    '    Type       = [int]$_.DriveType',
    '  }',
    '} | ConvertTo-Json -Compress -Depth 5',
  ].join(' ');

  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { timeout: 10000 }
  );

  const raw = stdout.trim();
  if (!raw) throw new Error('PowerShell returned empty output for drive enumeration');

  const parsed = JSON.parse(raw);
  const arr = Array.isArray(parsed) ? parsed : [parsed];

  return arr
    .filter(d => typeof d.Letter === 'string' && d.Letter.length >= 1)
    .map(d => ({
      letter:     d.Letter.substring(0, 1),
      label:      d.Label      || '',
      totalBytes: d.TotalBytes || 0,
      freeBytes:  d.FreeBytes  || 0,
      type:       d.Type       || 0,
    }));
}

/**
 * Enumerate all available Windows drives.
 * Tries wmic first; falls back to PowerShell on Win11 22H2+ where wmic is absent.
 *
 * @typedef {{ letter: string, label: string, totalBytes: number, freeBytes: number, type: number }} DriveInfo
 * @returns {Promise<DriveInfo[]>} — type: 3=local, 2=removable, 4=network, 5=CD/DVD
 */
export async function listDrives() {
  try {
    return await listDrivesWmic();
  } catch {
    // wmic absent (Win11 22H2+) or returned no drives — fall through to PowerShell
    return await listDrivesPowerShell();
  }
}
