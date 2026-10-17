import { renderTreemap } from '/static/treemap.js';

// ── Junk category display labels ─────────────────────────────────────────────
// Maps category ids (from rules.json / junk.js) to human-readable badge labels.
// Must stay in sync with the id values in server/rules.json.
const CATEGORY_LABELS = {
  node_modules: 'node_modules',
  python_cache: '__pycache__',
  rust_build:   'Rust build',
  build_output: 'Build output',
  venv:         'Python venv',
  temp:         'Temp files',
  log:          'Log file',
  installer:    'Old installer',
};

// ── State ─────────────────────────────────────────────────────────────────────
// nodes: Map<path, {name,size,is_dir,alloc_size,mtime_unix,drive,parent_path,children:string[]}>
//   size is mutated in-place by computeSizes() to hold cumulative directory totals.
//   drive: letter string injected by scanner.js (Phase 4), e.g. 'C'
// orphans: Map<parentPath, ScanEntry[]>  — entries that arrived before their parent
const nodes   = new Map();
const orphans = new Map();
let errorCount  = 0;
let maxRootSize = 0;   // set during renderTree(); used by makeRow for bar widths
let abortCtrl   = null;
let liveTimer   = null; // periodic partial render during long scans (cleared on last summary)
let newDataSinceRender = false;  // dirty flag — only renderTree() when new data has arrived
let selectedPath = null;         // path last selected in tree or treemap
let showCandidatesOnly = false;  // when true, only rows with a junk category are shown
const selectedForCleanup = new Set();   // Phase 7: paths selected for cleanup actions
let operationInFlight = false;          // FIX-7: prevent double dispatch
let sortBy = 'size';                    // FIX-2: 'size' | 'name' — tree-list sort column

// Multi-drive scan tracking
// activeScanCount: initialized to paths.length before the scan, decremented on each 'summary'.
// When it reaches 0, all sequential scans have finished.
let activeScanCount  = 0;
let cumulativeItems  = 0;
let cumulativeBytes  = 0;
let cumulativeDurMs  = 0;
let activeScanPaths  = [];   // [{path, drive}] from most recent startScan call
let lastScanMode     = 'Standard'; // updated from 'header' SSE event

// Drive data loaded from GET /drives
let drivesData = [];  // [{letter, label, totalBytes, freeBytes, type}]

// ── Path helpers ──────────────────────────────────────────────────────────────
/**
 * Return the parent path of a Windows absolute path, or null for drive roots.
 * Drive roots (e.g. 'C:\\') have no parent.
 */
function parentOf(p) {
  if (/^[A-Za-z]:\\$/.test(p)) return null;  // drive root has no parent
  const idx = p.lastIndexOf('\\');
  if (idx <= 0) return null;
  // If the backslash is at index 2 (e.g. "C:\Users" -> idx=2), the parent is the drive root "C:\\"
  return idx === 2 ? p.substring(0, idx + 1) : p.substring(0, idx);
}

/**
 * Return the total size of the drive that contains `path`, from drivesData.
 * Used to compute inline bar widths proportional to drive capacity.
 * Returns 0 if the drive is not found in drivesData (caller falls back to ctxSize).
 */
function getScanRootSize(path) {
  const letter = path[0]?.toUpperCase();
  const drive = drivesData.find(d => d.letter?.toUpperCase() === letter);
  return drive ? drive.totalBytes : 0;
}

/**
 * Initialize Lucide icons in the document.
 * Called after each row batch insertion and after scan summary.
 * The container parameter is accepted for future scoping but currently unused
 * to match the plan's specified implementation exactly.
 */
function initLucideIcons(container) { // eslint-disable-line no-unused-vars
  if (typeof lucide !== 'undefined') {
    lucide.createIcons({ attrs: { width: 14, height: 14 }, nameAttr: 'data-lucide' });
  }
}

// ── Entry ingestion ───────────────────────────────────────────────────────────
/**
 * Insert a scanned entry into the tree, handling non-deterministic arrival order
 * via an orphan buffer.  Every entry is added to `nodes` immediately; attachment
 * to the parent's children array is deferred if the parent hasn't arrived yet.
 */
function onEntry(entry) {
  const pp = parentOf(entry.path);  // null for drive roots
  const node = { ...entry, parent_path: pp, children: [] };
  nodes.set(entry.path, node);

  // Flush any children that arrived before us
  if (orphans.has(entry.path)) {
    for (const child of orphans.get(entry.path)) node.children.push(child.path);
    orphans.delete(entry.path);
  }

  // Attach to parent — or buffer if parent hasn't arrived yet.
  // If pp === null, it's a drive root — no parent to attach to.
  if (pp !== null) {
    if (nodes.has(pp)) {
      nodes.get(pp).children.push(entry.path);
    } else {
      if (!orphans.has(pp)) orphans.set(pp, []);
      orphans.get(pp).push(entry);
    }
  }

  newDataSinceRender = true;
}

// ── Size computation ──────────────────────────────────────────────────────────
/**
 * Compute cumulative sizes bottom-up.
 * The scanner emits size=0 for directories; this derives the real total from children.
 * Mutates node.size in place so sort and bar-fill use the correct value.
 */
function computeSizes(path) {
  const node = nodes.get(path);
  if (!node) return 0;
  if (!node.is_dir) return node.size;
  let total = 0;
  for (const cp of node.children) total += computeSizes(cp);
  node.size = total;
  return total;
}

// ── Tree helpers ──────────────────────────────────────────────────────────────
/**
 * Find nodes whose parent was not scanned — these become the top-level roots.
 * Drive roots (parent_path === null) are always roots.
 * Other nodes whose parent is absent are also roots (e.g. scan started mid-tree).
 */
function findRoots() {
  const out = [];
  for (const [p, n] of nodes) {
    if (n.parent_path === null || !nodes.has(n.parent_path)) out.push(p);
  }
  return out;
}

/** Sort children of `path` by cumulative size descending, recursively. */
function sortBySize(path) {
  const n = nodes.get(path);
  if (!n) return;
  n.children.sort((a, b) => (nodes.get(b)?.size ?? 0) - (nodes.get(a)?.size ?? 0));
  n.children.forEach(sortBySize);
}

/** Sort a children array by sortBy state: 'size' (descending) or 'name'. Returns new array. */
function sortChildren(childPaths) {
  return childPaths.slice().sort((a, b) => {
    const na = nodes.get(a), nb = nodes.get(b);
    if (!na || !nb) return 0;
    if (sortBy === 'name') return na.name.localeCompare(nb.name);
    return (nb.size || 0) - (na.size || 0);  // default: size descending
  });
}

/** Return the path of the first root (by size descending after renderTree). */
function findFirstRoot() {
  const roots = findRoots();
  roots.sort((a, b) => (nodes.get(b)?.size ?? 0) - (nodes.get(a)?.size ?? 0));
  return roots.length > 0 ? roots[0] : null;
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n <= 0) return '0\u00a0B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / Math.pow(1024, i);
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + '\u00a0' + u[i];
}

/** Round bytes to nearest whole unit — used in drive panel (e.g. "512 GB"). */
function fmtBytesRound(n) {
  if (n <= 0) return '0\u00a0B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return Math.round(n / Math.pow(1024, i)) + '\u00a0' + u[i];
}

// ── Row factory ───────────────────────────────────────────────────────────────
/**
 * Create a table row for a tree node.
 * @param {string} nodePath - Node path key
 * @param {number} depth    - Nesting depth (0 = root)
 * @param {number} ctxSize  - Parent's cumulative size (used for bar fill width)
 */
function makeRow(nodePath, depth, ctxSize) {
  const n    = nodes.get(nodePath);
  const kids = n.is_dir && n.children.length > 0;

  const tr = document.createElement('tr');
  tr.dataset.path  = nodePath;
  tr.dataset.depth = String(depth);
  if (kids) tr.classList.add('has-children', 'collapsed');

  // Set data-junk attribute so the CSS candidates-only filter can target this row.
  // Present and non-empty when this entry has a junk category; absent otherwise.
  if (n.category) tr.dataset.junk = n.category;

  // ── Checkbox column ───────────────────────────────────────────────────────
  const tdCheck = document.createElement('td');
  tdCheck.className = 'checkbox-col';
  const cbEl = document.createElement('input');
  cbEl.type = 'checkbox';
  cbEl.dataset.path = nodePath;  // for FIX-6 lookup
  cbEl.setAttribute('aria-label', 'Select for cleanup');
  cbEl.checked = selectedForCleanup.has(nodePath);
  cbEl.addEventListener('click', (e) => e.stopPropagation());
  cbEl.addEventListener('change', () => {
    if (cbEl.checked) selectedForCleanup.add(nodePath);
    else selectedForCleanup.delete(nodePath);
    updateFloatingBar();
  });
  tdCheck.appendChild(cbEl);

  // ── Name cell ──────────────────────────────────────────────────────────────
  const tdName = document.createElement('td');
  tdName.className = 'col-name';

  const spc = document.createElement('span');
  spc.className = 'indent';
  spc.style.width = (depth * 20) + 'px';

  const ico = document.createElement('span');
  ico.className = 'icon';
  // Use Lucide icon if available; createIcons() processes data-lucide after insertion.
  const iconEl = document.createElement('span');
  iconEl.setAttribute('data-lucide', n.is_dir ? 'folder' : 'file');
  ico.appendChild(iconEl);

  const nm = document.createElement('span');
  nm.className = 'name';
  // Use path as display name for drive roots where name may be empty or just the path
  nm.textContent = (n.name && n.name.length > 0) ? n.name : nodePath;  // XSS-safe: textContent

  tdName.appendChild(spc);
  tdName.appendChild(ico);
  tdName.appendChild(nm);

  // Junk category badge — shown when this entry matched a rule in rules.json.
  // textContent is used (never innerHTML) to prevent XSS from crafted category ids.
  if (n.category) {
    const badge = document.createElement('span');
    badge.className = 'viz-badge';
    const categoryLabel = CATEGORY_LABELS[n.category] || n.category;
    badge.textContent = categoryLabel;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', 'Junk category: ' + categoryLabel);
    tdName.appendChild(badge);
  }

  // Reveal in Explorer button — path never written to innerHTML
  const revealBtn = document.createElement('button');
  revealBtn.type = 'button';
  revealBtn.className = 'reveal-btn';
  revealBtn.title = 'Reveal in Explorer';
  revealBtn.setAttribute('aria-label', 'Reveal in Explorer');
  revealBtn.textContent = '\u21d7';  // ⇗ — "open externally" idiom
  revealBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fetch(`/reveal?path=${encodeURIComponent(nodePath)}`)
      .then(r => r.json())
      .catch(() => null)
      .then(data => { if (data && !data.ok) console.warn('reveal failed:', data?.error); });
  });
  tdName.appendChild(revealBtn);

  // ── Size cell ──────────────────────────────────────────────────────────────
  const tdSize = document.createElement('td');
  tdSize.className = 'col-size tabular-nums';
  tdSize.textContent = fmtBytes(n.size);

  // ── Bar cell ───────────────────────────────────────────────────────────────
  const tdPct = document.createElement('td');
  tdPct.className = 'col-pct';
  const bar  = document.createElement('div');
  bar.className = 'size-bar';
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  // Bar width: proportional to drive total size (getScanRootSize), falling back
  // to parent's ctxSize when the drive is not found in drivesData.
  const rootSz   = getScanRootSize(nodePath);
  const barBase  = rootSz > 0 ? rootSz : ctxSize;
  fill.style.width = barBase > 0
    ? Math.min(100, (n.size / barBase) * 100).toFixed(2) + '%'
    : '0%';
  bar.appendChild(fill);
  tdPct.appendChild(bar);

  tr.appendChild(tdCheck);
  tr.appendChild(tdName);
  tr.appendChild(tdSize);
  tr.appendChild(tdPct);

  tr.addEventListener('click', () => selectNode(nodePath));
  if (kids) tr.addEventListener('click', onRowClick);

  return tr;
}

// ── Expand / collapse ─────────────────────────────────────────────────────────
const MAX_EXPAND_ROWS = 200;  // cap expandRow at 200 direct children

function onRowClick(e) {
  const tr = e.currentTarget;
  tr.classList.contains('collapsed') ? expandRow(tr) : collapseRow(tr);
}

function expandRow(tr) {
  const n     = nodes.get(tr.dataset.path);
  const depth = parseInt(tr.dataset.depth, 10);
  const ctxSize = n.size;

  const sorted      = sortChildren(n.children);
  const displayed   = sorted.slice(0, MAX_EXPAND_ROWS);
  const hiddenCount = sorted.length - displayed.length;

  const frag = document.createDocumentFragment();
  for (const cp of displayed) {
    frag.appendChild(makeRow(cp, depth + 1, ctxSize));
  }

  if (hiddenCount > 0) {
    const hiddenSize = sorted.slice(MAX_EXPAND_ROWS).reduce(
      (sum, cp) => sum + (nodes.get(cp)?.size ?? 0), 0
    );
    const placeholder = document.createElement('tr');
    placeholder.dataset.placeholder = 'true';
    placeholder.dataset.depth = String(depth + 1);
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = `(${hiddenCount} more items not shown — ${fmtBytes(hiddenSize)} total)`;
    td.style.fontStyle = 'italic';
    td.style.opacity = '0.6';
    placeholder.appendChild(td);
    frag.appendChild(placeholder);
  }

  tr.after(frag);
  tr.classList.replace('collapsed', 'expanded');
  // No icon text change needed — Lucide uses the same 'folder' icon for all states.
  // initLucideIcons() processes newly inserted data-lucide spans.
  initLucideIcons();
}

function collapseRow(tr) {
  const depth = parseInt(tr.dataset.depth, 10);
  const toRemove = [];
  let nxt = tr.nextElementSibling;
  while (nxt) {
    const d = nxt.dataset.depth;
    if (d === undefined || parseInt(d, 10) <= depth) break;
    toRemove.push(nxt);
    nxt = nxt.nextElementSibling;
  }
  const tbody   = tr.closest('tbody');
  const parent  = tbody.parentElement;
  const nextSib = tbody.nextSibling;
  parent.removeChild(tbody);
  toRemove.forEach(r => tbody.removeChild(r));
  parent.insertBefore(tbody, nextSib);

  tr.classList.replace('expanded', 'collapsed');
  // No icon text change needed — Lucide uses the same 'folder' icon for all states.
}

// ── Full render ───────────────────────────────────────────────────────────────
function renderTree() {
  const tbody = document.getElementById('tree-body');
  tbody.replaceChildren();

  // Re-apply the candidates-only filter class after a full re-render.
  tbody.classList.toggle('candidates-only', showCandidatesOnly);

  const roots = findRoots();
  if (roots.length === 0) return;

  roots.forEach(computeSizes);
  roots.sort((a, b) => (nodes.get(b)?.size ?? 0) - (nodes.get(a)?.size ?? 0));
  roots.forEach(sortBySize);

  // maxRootSize drives bar fill widths for root-level rows
  maxRootSize = roots.reduce((m, r) => Math.max(m, nodes.get(r)?.size ?? 0), 0);

  for (const rp of roots) tbody.appendChild(makeRow(rp, 0, maxRootSize));
  initLucideIcons();
}

// ── Selection ─────────────────────────────────────────────────────────────────
function selectNode(path) {
  selectedPath = path;
  document.querySelectorAll('#tree-body tr.selected-row').forEach(r => r.classList.remove('selected-row'));
  for (const tr of document.querySelectorAll('#tree-body tr')) {
    if (tr.dataset.path === path) { tr.classList.add('selected-row'); tr.scrollIntoView({ block: 'nearest' }); break; }
  }
  renderTreemap(path, nodes);
  updateRevealToolbar();
}
window.app = { selectNode };

function updateRevealToolbar() {
  const btn = document.getElementById('reveal-toolbar-btn');
  if (btn) btn.disabled = !selectedPath;
}

// ── Floating cleanup bar ──────────────────────────────────────────────────────
function updateFloatingBar() {
  const bar = document.getElementById('floating-cleanup-bar');
  if (!bar) return;
  if (selectedForCleanup.size === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  let totalSize = 0;
  for (const p of selectedForCleanup) totalSize += nodes.get(p)?.size ?? 0;
  bar.querySelector('.floating-bar-count').textContent =
    selectedForCleanup.size + '\u00a0item' + (selectedForCleanup.size !== 1 ? 's' : '') + '\u00a0selected';
  bar.querySelector('.floating-bar-size').textContent = fmtBytes(totalSize);
}

// ── Review & Clean modal ──────────────────────────────────────────────────────
function openCleanupModal() {
  const existing = document.getElementById('cleanup-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cleanup-modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'cleanup-modal-title');

  const box = document.createElement('div');
  box.className = 'modal-box';

  const h3 = document.createElement('h3');
  h3.id = 'cleanup-modal-title';
  h3.textContent = 'Review\u00a0& Clean';

  // Group selected paths by category
  const byCategory = new Map();
  let totalSize = 0;
  for (const p of selectedForCleanup) {
    const n = nodes.get(p);
    if (!n) continue;
    totalSize += n.size ?? 0;
    const cat = n.category || '_other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p);
  }

  const summary = document.createElement('p');
  summary.textContent =
    selectedForCleanup.size + '\u00a0item' + (selectedForCleanup.size !== 1 ? 's' : '') +
    '\u00a0\u2014\u00a0' + fmtBytes(totalSize) + '\u00a0total';

  const list = document.createElement('ul');
  list.className = 'cleanup-list';
  for (const [cat, paths] of byCategory) {
    const catLabel = cat === '_other' ? 'Other' : (CATEGORY_LABELS[cat] || cat);
    const li = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = catLabel + '\u00a0(' + paths.length + ')';
    li.appendChild(heading);
    const sub = document.createElement('ul');
    for (const p of paths) {
      const item = document.createElement('li');
      item.textContent = p;   // textContent — XSS safe: never innerHTML
      sub.appendChild(item);
    }
    li.appendChild(sub);
    list.appendChild(li);
  }

  // ── Permanent-delete section ────────────────────────────────────────────
  const deleteWrap = document.createElement('div');
  deleteWrap.className = 'delete-confirm';

  const confirmInput = document.createElement('input');
  confirmInput.type = 'text';
  confirmInput.placeholder = 'Type DELETE to confirm';
  confirmInput.setAttribute('aria-label', 'Type DELETE to enable permanent deletion');

  const permDeleteBtn = document.createElement('button');
  permDeleteBtn.type = 'button';
  permDeleteBtn.id = 'modal-delete-btn';
  permDeleteBtn.className = 'btn-danger';
  permDeleteBtn.textContent = 'Permanently\u00a0Delete';
  permDeleteBtn.disabled = true;

  confirmInput.addEventListener('input', () => {
    permDeleteBtn.disabled = (confirmInput.value !== 'DELETE');
  });

  // ── Action buttons ──────────────────────────────────────────────────────
  const trashBtn = document.createElement('button');
  trashBtn.type = 'button';
  trashBtn.id = 'modal-trash-btn';
  trashBtn.className = 'btn-primary';
  trashBtn.textContent = 'Move\u00a0to\u00a0Trash';
  trashBtn.addEventListener('click', async () => {
    if (operationInFlight) return;
    operationInFlight = true;
    trashBtn.disabled = true;
    permDeleteBtn.disabled = true;
    const paths = [...selectedForCleanup];
    let results;
    try {
      const resp = await fetch('/trash', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths })
      });
      results = await resp.json();
    } catch (e) {
      results = paths.map(p => ({ path: p, ok: false, error: e.message }));
    } finally {
      operationInFlight = false;
    }
    showCleanupResults(results, box);
  });

  permDeleteBtn.addEventListener('click', async () => {
    if (operationInFlight) return;
    operationInFlight = true;
    permDeleteBtn.disabled = true;
    trashBtn.disabled = true;
    const paths = [...selectedForCleanup];
    let results;
    try {
      const resp = await fetch('/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths })
      });
      results = await resp.json();
    } catch (e) {
      results = paths.map(p => ({ path: p, ok: false, error: e.message }));
    } finally {
      operationInFlight = false;
    }
    showCleanupResults(results, box);
  });

  deleteWrap.appendChild(confirmInput);
  deleteWrap.appendChild(permDeleteBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  actions.appendChild(trashBtn);
  actions.appendChild(deleteWrap);
  actions.appendChild(cancelBtn);

  // FIX-1: exFAT/non-NTFS warning
  const hasExFatPath = [...selectedForCleanup].some(p => {
    const letter = p[0]?.toUpperCase();
    const drive = drivesData.find(d => d.letter?.toUpperCase() === letter);
    return drive && drive.type !== 3;
  });

  box.appendChild(h3);
  box.appendChild(summary);
  if (hasExFatPath) {
    const warn = document.createElement('p');
    warn.style.cssText = 'color:#f59e0b;background:rgba(245,158,11,0.1);padding:8px;border-radius:4px;margin-bottom:8px;';
    warn.textContent = 'Note: Files on removable or non-NTFS drives may be permanently deleted \u2014 no Recycle Bin is available on FAT32/exFAT volumes.';
    box.appendChild(warn);
  }
  box.appendChild(list);
  box.appendChild(actions);
  overlay.appendChild(box);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ── Toast notification ────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Per-path cleanup results ──────────────────────────────────────────────────
function showCleanupResults(results, box) {
  if (!Array.isArray(results)) {
    document.getElementById('status-bar').textContent = 'Cleanup failed: ' + (results.error || 'Unknown error');
    return;
  }
  const existing = box.querySelector('.cleanup-results');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'cleanup-results';

  const ul = document.createElement('ul');
  for (const r of results) {
    const li = document.createElement('li');
    const statusEl = document.createElement('span');
    statusEl.textContent = (r.ok ? '\u2713' : '\u2717') + '\u00a0';  // ✓ / ✗
    const pathEl = document.createElement('code');
    pathEl.textContent = r.path;   // textContent — XSS safe: never innerHTML
    li.appendChild(statusEl);
    li.appendChild(pathEl);
    if (!r.ok && r.error) {
      const errEl = document.createElement('span');
      errEl.className = 'error-msg';
      errEl.textContent = '\u00a0\u2014\u00a0' + r.error;
      li.appendChild(errEl);
    }
    // FIX-10: only remove from selectedForCleanup on success
    if (r.ok) {
      selectedForCleanup.delete(r.path);
    }
    ul.appendChild(li);
  }
  div.appendChild(ul);
  box.appendChild(div);

  // FIX-4: Remove successful rows from the tree body
  const tbody = document.getElementById('tree-body');
  for (const r of results) {
    if (r.ok) {
      const row = tbody ? [...tbody.querySelectorAll('tr')].find(tr => tr.dataset.path === r.path) : null;
      if (row) row.remove();
    }
  }

  // FIX-6: Uncheck DOM checkboxes for successfully deleted items
  for (const r of results) {
    if (r.ok) {
      const cb = document.querySelector(`input[type="checkbox"][data-path="${CSS.escape(r.path)}"]`);
      if (cb) cb.checked = false;
    }
  }

  updateFloatingBar();

  // FIX-4: Toast notification for freed space
  const freedBytes = results.filter(r => r.ok).reduce((s, r) => {
    const node = nodes.get(r.path);
    return s + (node ? node.size : 0);
  }, 0);
  if (freedBytes > 0) showToast(`Freed ${fmtBytes(freedBytes)}`);

  // FIX-5: Re-enable buttons after partial failure
  const trashBtn = document.getElementById('modal-trash-btn');
  const delBtn = document.getElementById('modal-delete-btn');
  if (trashBtn) trashBtn.disabled = selectedForCleanup.size === 0;
  if (delBtn) delBtn.disabled = true;  // always re-requires DELETE re-type
}

// ── Drive panel ───────────────────────────────────────────────────────────────

/** Map DriveType number to a human-readable label. */
function driveTypeLabel(type) {
  if (type === 3) return 'Local disk';
  if (type === 2) return 'Removable';
  if (type === 4) return 'Network drive';
  if (type === 5) return 'CD / DVD';
  return 'Unknown';
}

/** Load drives from the server and render the drive selection panel. */
async function loadDrives() {
  const loadingEl = document.getElementById('drives-loading');
  const listEl    = document.getElementById('drives-list');
  const scanRow   = document.getElementById('scan-row');

  try {
    const resp = await fetch('/drives');
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(body.error ?? resp.statusText);
    }
    drivesData = await resp.json();

    loadingEl.hidden = true;
    listEl.hidden    = false;
    scanRow.hidden   = false;

    renderDrivesPanel();
  } catch (err) {
    loadingEl.textContent = 'Could not load drives: ' + err.message;
  }
}

/** Render one checkbox row per drive in #drives-list. */
function renderDrivesPanel() {
  const listEl = document.getElementById('drives-list');
  listEl.replaceChildren();

  for (const drive of drivesData) {
    const usedPct = drive.totalBytes > 0
      ? Math.round((1 - drive.freeBytes / drive.totalBytes) * 100)
      : 0;

    const label = document.createElement('label');
    label.className = 'drive-item';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.value   = drive.letter;
    cb.checked = (drive.type === 3);  // local drives checked by default; removable/network unchecked
    cb.addEventListener('change', updateScanButton);

    const span = document.createElement('span');
    span.className = 'drive-label';

    // Display format: "C: [Windows] — Local disk — 512 GB total, 100 GB free (80% used)"
    const displayName = drive.label
      ? `${drive.letter}: [${drive.label}]`
      : `${drive.letter}:`;
    const typeStr = driveTypeLabel(drive.type);
    const totalStr = fmtBytesRound(drive.totalBytes);
    const freeStr  = fmtBytesRound(drive.freeBytes);

    span.textContent = `${displayName} — `;

    const typeSpan = document.createElement('span');
    typeSpan.className = 'drive-type';
    typeSpan.textContent = `${typeStr} — `;

    const detailNode = document.createTextNode(
      `${totalStr} total, ${freeStr} free (${usedPct}% used)`
    );

    span.appendChild(typeSpan);
    span.appendChild(detailNode);

    label.appendChild(cb);
    label.appendChild(span);
    listEl.appendChild(label);
  }

  updateScanButton();
}

/** Enable/disable the Scan button based on whether any drive is checked. */
function updateScanButton() {
  const btn     = document.getElementById('scan-btn');
  const checked = document.querySelectorAll('#drives-list input[type="checkbox"]:checked');
  btn.disabled  = (checked.length === 0);
}

// ── Scan ──────────────────────────────────────────────────────────────────────
/**
 * Start a multi-drive scan.
 * @param {{ path: string, drive: string }[]} paths - Array of {path, drive} to scan sequentially
 */
async function startScan(paths) {
  // Abort any in-flight scan
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();

  nodes.clear();
  orphans.clear();
  errorCount = 0;
  newDataSinceRender = false;
  activeScanCount  = paths.length;   // matches expected 'summary' events
  activeScanPaths  = [...paths];     // saved for status bar free-space lookup
  cumulativeItems  = 0;
  cumulativeBytes  = 0;
  cumulativeDurMs  = 0;
  selectedPath     = null;
  selectedForCleanup.clear();
  updateFloatingBar();

  if (liveTimer !== null) { clearInterval(liveTimer); liveTimer = null; }

  document.getElementById('tree-body').replaceChildren();
  renderTreemap(null, nodes, true);
  document.getElementById('status-bar').textContent = 'Scanning\u2026';
  document.getElementById('mode-indicator').textContent = '';
  document.getElementById('admin-notice').hidden = true;

  // Periodic live render — only fires when new entries have arrived since last render.
  // A render re-sizes and re-sorts the whole tree, so on multi-million-entry scans it
  // can take seconds; the next one waits 4x the last one's duration, keeping live
  // renders to ~20% of the main thread so ingesting the stream is not starved.
  let nextLiveRenderAt = 0;
  liveTimer = setInterval(() => {
    if (newDataSinceRender && performance.now() >= nextLiveRenderAt) {
      newDataSinceRender = false;
      const t0 = performance.now();
      renderTree();
      if (selectedPath) renderTreemap(selectedPath, nodes, true);
      const t1 = performance.now();
      nextLiveRenderAt = t1 + 4 * (t1 - t0);
    }
  }, 1000);

  let resp;
  try {
    resp = await fetch('/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
      signal: abortCtrl.signal,
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      document.getElementById('status-bar').textContent = 'Error: ' + err.message;
    }
    if (liveTimer !== null) { clearInterval(liveTimer); liveTimer = null; }
    return;
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: resp.statusText }));
    document.getElementById('status-bar').textContent = 'Error: ' + (body.error ?? resp.statusText);
    if (liveTimer !== null) { clearInterval(liveTimer); liveTimer = null; }
    return;
  }

  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // FIX-4: stream closed — handle scanner crash without summary
        if (activeScanCount > 0) {
          activeScanCount = 0;
          if (liveTimer !== null) { clearInterval(liveTimer); liveTimer = null; }
          renderTree();
          renderTreemap(selectedPath || findFirstRoot(), nodes, false);
          document.getElementById('status-bar').textContent =
            'Scan incomplete \u2014 scanner exited unexpectedly.';
        }
        break;
      }
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by double newlines; the last part may be incomplete
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        if (part.startsWith('data: ')) {
          try {
            processLine(JSON.parse(part.slice(6)));
          } catch (e) {
            if (!(e instanceof SyntaxError)) console.error('processLine error:', e);
          }
        }
        // SSE comment lines (":\n\n") keep the connection alive — no processing needed
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      document.getElementById('status-bar').textContent = 'Stream error: ' + err.message;
    }
  }

  if (liveTimer !== null) { clearInterval(liveTimer); liveTimer = null; }
}

function processLine(line) {
  switch (line.type) {
    case 'header':
      {
        const modeName = (line.mode === 'mft') ? 'Fast\u00a0(MFT)' : 'Standard';
        lastScanMode = modeName;
        document.getElementById('mode-indicator').textContent = 'Mode:\u00a0' + modeName;
        // Show admin-notice when running in Standard mode.  `fallback` is set when
        // the scanner had admin rights but the volume cannot be MFT-scanned; then
        // relaunching as admin would not help, so say why instead.
        const notice = document.getElementById('admin-notice');
        notice.hidden = (line.mode === 'mft');
        notice.querySelector('span').textContent = line.fallback
          ? 'Standard mode \u2014 fast scan unavailable: ' + line.fallback + '.'
          : 'Standard mode \u2014 no admin rights.';
        document.getElementById('relaunch-admin-link').hidden = Boolean(line.fallback);
      }
      break;

    case 'entry':
      onEntry(line);
      break;

    case 'error':
      errorCount++;
      document.getElementById('status-bar').textContent =
        'Scanning\u2026 (' + errorCount + '\u00a0skipped)';
      break;

    case 'summary':
      // Accumulate totals; only finalize when all sequential scans have reported
      activeScanCount = Math.max(0, activeScanCount - 1);
      cumulativeItems += (line.entry_count  || 0);
      cumulativeBytes += (line.total_size   || 0);
      cumulativeDurMs += (line.duration_ms  || 0);

      if (activeScanCount === 0) {
        // All sequential scans done — clear timer and do final accurate render
        if (liveTimer !== null) { clearInterval(liveTimer); liveTimer = null; }
        renderTree();
        renderTreemap(selectedPath || findFirstRoot(), nodes, false);

        // Build formatted status bar: "Scanned: N items | Total: X GB | Free: Y GB (C:) | ..."
        const durSec = (cumulativeDurMs / 1000).toFixed(1);
        const primaryDrive = activeScanPaths[0]?.drive?.toUpperCase();
        const driveEntry   = drivesData.find(d => d.letter?.toUpperCase() === primaryDrive);
        const freeStr = (driveEntry && activeScanPaths.length === 1)
          ? ' | Free:\u00a0' + fmtBytes(driveEntry.freeBytes) + '\u00a0(' + primaryDrive + ':)'
          : '';
        document.getElementById('status-bar').textContent =
          'Scanned:\u00a0' + cumulativeItems.toLocaleString() + '\u00a0items' +
          ' | Total:\u00a0' + fmtBytes(cumulativeBytes) +
          freeStr +
          ' | Mode:\u00a0' + lastScanMode +
          ' | Duration:\u00a0' + durSec + '\u00a0s' +
          (errorCount > 0 ? ' | Skipped:\u00a0' + errorCount.toLocaleString() : '');
      }
      break;
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

// Scan button: read checked drives and launch a multi-path scan
document.getElementById('scan-btn').addEventListener('click', () => {
  const checked = [...document.querySelectorAll('#drives-list input[type="checkbox"]:checked')];
  if (checked.length === 0) return;
  const paths = checked.map(cb => ({
    path:  cb.value + ':\\',   // e.g. 'C' → 'C:\\'  (the string "C:\")
    drive: cb.value,
  }));
  startScan(paths).catch(err => {
    document.getElementById('status-bar').textContent = 'Scan error: ' + err.message;
  });
});

// Admin modal: show on "Relaunch as Admin" link click, close on button click or backdrop click
document.getElementById('relaunch-admin-link').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('admin-modal').hidden = false;
});

document.getElementById('admin-modal-close').addEventListener('click', () => {
  document.getElementById('admin-modal').hidden = true;
});

document.getElementById('admin-modal').addEventListener('click', (e) => {
  // Close when clicking the backdrop (outside the box)
  if (e.target === document.getElementById('admin-modal')) {
    document.getElementById('admin-modal').hidden = true;
  }
});

// "Show cleanup candidates" toggle — dynamically inserted into #scan-row.
// When active: CSS hides all rows without a junk category (data-junk absent).
// When inactive: all rows are visible.
(function setupCandidatesToggle() {
  const btn = document.createElement('button');
  btn.id   = 'candidates-btn';
  btn.type = 'button';
  btn.textContent = 'Show cleanup candidates';
  btn.setAttribute('aria-pressed', 'false');

  btn.addEventListener('click', () => {
    showCandidatesOnly = !showCandidatesOnly;
    btn.textContent = showCandidatesOnly ? 'Show all' : 'Show cleanup candidates';
    btn.classList.toggle('active', showCandidatesOnly);
    btn.setAttribute('aria-pressed', showCandidatesOnly ? 'true' : 'false');
    document.getElementById('tree-body').classList.toggle('candidates-only', showCandidatesOnly);

    if (showCandidatesOnly) {
      const visibleCount = document.querySelectorAll('#tree-body tr[data-junk]').length;
      if (visibleCount === 0) {
        const msg = document.getElementById('candidates-empty-msg') || document.createElement('p');
        msg.id = 'candidates-empty-msg';
        msg.textContent = 'No junk candidates found at the top level. Try expanding folders first, then toggle the filter.';
        msg.style.cssText = 'padding:8px;opacity:0.7;font-style:italic';
        document.getElementById('tree-container').appendChild(msg);
      } else {
        const old = document.getElementById('candidates-empty-msg');
        if (old) old.remove();
      }
    } else {
      const old = document.getElementById('candidates-empty-msg');
      if (old) old.remove();
    }
  });

  document.getElementById('scan-row').appendChild(btn);
})();

// Sort column headers — clicking 'Name' or 'Size' toggles sortBy and re-renders
function setupSortHeaders() {
  document.querySelectorAll('#tree-table th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      sortBy = th.dataset.sort;
      renderTree();
    });
  });
}
setupSortHeaders();

// Reveal toolbar button — enabled when a row is selected; fires /reveal for selectedPath
(function setupRevealToolbarBtn() {
  const btn = document.getElementById('reveal-toolbar-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (selectedPath) fetch(`/reveal?path=${encodeURIComponent(selectedPath)}`).catch(() => null);
  });
})();

// ── Floating cleanup bar setup ────────────────────────────────────────────────
(function setupFloatingBar() {
  const bar = document.createElement('div');
  bar.id = 'floating-cleanup-bar';
  bar.className = 'floating-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Cleanup selection');

  const countEl = document.createElement('span');
  countEl.className = 'floating-bar-count';

  const sizeEl = document.createElement('span');
  sizeEl.className = 'floating-bar-size';

  const reviewBtn = document.createElement('button');
  reviewBtn.type = 'button';
  reviewBtn.textContent = 'Review\u00a0& Clean';
  reviewBtn.addEventListener('click', openCleanupModal);

  const deselectBtn = document.createElement('button');
  deselectBtn.type = 'button';
  deselectBtn.textContent = 'Deselect\u00a0all';
  deselectBtn.addEventListener('click', () => {
    selectedForCleanup.clear();
    document.querySelectorAll('#tree-body input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateFloatingBar();
  });

  bar.appendChild(countEl);
  bar.appendChild(sizeEl);
  bar.appendChild(reviewBtn);
  bar.appendChild(deselectBtn);
  document.body.appendChild(bar);
})();

// Load drives on page load
loadDrives();

// Theme toggle — switches data-theme on <html> between dark (default) and light
(function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const html = document.documentElement;
    if (html.dataset.theme === 'light') {
      delete html.dataset.theme;
      btn.textContent = '\u2600';     // ☀
      btn.title = 'Switch to light mode';
    } else {
      html.dataset.theme = 'light';
      btn.textContent = '\u263E';     // ☾
      btn.title = 'Switch to dark mode';
    }
  });
})();

// Split divider drag to resize panels
const divider = document.getElementById('split-divider');
if (divider) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const panel = document.getElementById('main-panel');
    const onMove = (mv) => {
      const rect = panel.getBoundingClientRect();
      let pct = ((mv.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(20, Math.min(80, pct));
      document.getElementById('tree-container').style.flex = `0 0 ${pct}%`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const tt = document.getElementById('treemap-tooltip');
      if (tt) tt.style.display = 'none';
      renderTreemap(selectedPath || findFirstRoot(), nodes);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
