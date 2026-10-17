# DiskPeek

Windows disk space explorer — browser UI, Rust MFT/parallel scanner, D3 treemap, cleanup workflow.

---

## Prerequisites

- **Windows** only (NTFS + exFAT/FAT32 via parallel fallback)
- **Node.js v18+** — [nodejs.org](https://nodejs.org/)
- **Rust/Cargo** — [rustup.rs](https://rustup.rs/) (for building the scanner binary)

---

## Setup (first run)

```
cd scanner && cargo build --release
cd ../server && npm install
```

This produces `scanner\target\release\scanner.exe` and installs the server's npm dependencies.

---

## Launch

### Standard mode

Double-click `launch.bat`, or from a terminal:

```
cd server && node server.js
```

`launch.bat` starts the Node.js server in the background and opens `http://localhost:3000` in
your default browser automatically — it polls for port 3000 before opening, so the browser
will not open until the server is ready.

### MFT fast scan mode (requires Administrator)

Run `launch-admin.bat` as Administrator (a UAC prompt will appear). The elevated server
enables `scanner.exe` to read the NTFS Master File Table directly, which is significantly
faster than the parallel filesystem traversal used in standard mode.

> **Security note**: `launch-admin.bat` elevates the entire Node.js server process to
> Administrator. All HTTP endpoints (including `/delete`) run with admin rights. The server
> binds to `127.0.0.1` only, so it is not reachable from other machines on the network.

After the UAC prompt is accepted, the browser opens to `http://localhost:3000`. The scan
mode indicator in the UI shows **"Fast (MFT)"** when MFT access is available.

---

## Scanner CLI

The scanner binary can be used standalone:

```
scanner.exe --path C:\ --mode auto      # auto-detect MFT or parallel
scanner.exe --path C:\ --mode mft       # MFT, warn on stderr if unavailable (requires admin)
scanner.exe --path C:\ --mode parallel  # always parallel (no admin needed)
```

MFT mode reads the whole volume, so it applies to drive roots written as `C:\` on NTFS only. It
falls back to parallel for any other path, a process without admin rights, a non-NTFS volume, an
`$MFT` too fragmented to map from its first record, or a corrupt `$MFT` first record. The header's
`mode` field always reports the mode actually used; when the volume opened but could not be
MFT-scanned, the header also carries a `fallback` field with the reason. Records that cannot be
read or fail their integrity checks are skipped and reported in one `error` line. In MFT mode a
hard-linked file is listed once, under one of its names, so totals do not double-count it.

Output is NDJSON to stdout — one JSON object per line:
- First line: `{"type":"header","mode":"parallel|mft","path":"..."}` (plus `"fallback":"..."` when MFT was not possible)
- Entry lines: `{"type":"entry","path":"...","name":"...","size":12345,"is_dir":true,...}`
- Error lines: `{"type":"error","path":"...","message":"Access denied"}`
- Last line: `{"type":"summary","total_size":...,"entry_count":...,"duration_ms":...}`

---

## Browser

Open `http://localhost:3000` after launching. The UI shows:

- **Drive selection panel** — check one or more drives and click "Scan selected drives".
- **Tree-list** — sortable by size (default) or name, with inline proportional size bars and
  junk category badges.
- **Treemap panel** — D3 squarified treemap synchronized with the tree-list selection.
- **Cleanup workflow** — select rows with checkboxes, review the modal, then move to Trash or
  permanently delete.
- **Reveal in Explorer** — row action to open Windows Explorer at any path.

---

## License

MIT — see [LICENSE](LICENSE).
