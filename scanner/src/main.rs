use std::io::{self, BufWriter, Write};
use std::process;

mod model;
mod parallel;

// MFT scanner — Windows only.  Referenced as `mft::mft_scan(...)` in main.
// Inside mft.rs, the external 'mft' crate is accessed via '::mft::' to
// disambiguate from this module.
#[cfg(windows)]
mod mft;
#[cfg(windows)]
mod volume;

use model::{NdjsonLine, ScanStats};
use parallel::parallel_scan;

// ─── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum ScanMode {
    Auto,
    Mft,
    Parallel,
}

fn parse_args() -> Result<(String, ScanMode), String> {
    let args: Vec<String> = std::env::args().collect();
    let mut path: Option<String> = None;
    let mut mode = ScanMode::Auto;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--path" => {
                i += 1;
                if i >= args.len() {
                    return Err("--path requires a value".to_string());
                }
                // CALLER RESPONSIBILITY: The Node.js server (Phase 2) must validate and
                // canonicalize this path before invoking the scanner.  The scanner accepts
                // any accessible path without canonicalization — path traversal prevention
                // is the caller's responsibility.
                path = Some(args[i].clone());
            }
            "--mode" => {
                i += 1;
                if i >= args.len() {
                    return Err("--mode requires a value".to_string());
                }
                mode = match args[i].as_str() {
                    "auto" => ScanMode::Auto,
                    "mft" => ScanMode::Mft,
                    "parallel" => ScanMode::Parallel,
                    other => {
                        return Err(format!(
                            "unknown mode '{}'; valid values: auto, mft, parallel",
                            other
                        ))
                    }
                };
            }
            other => return Err(format!("unknown argument: {}", other)),
        }
        i += 1;
    }

    let path = path.ok_or_else(|| "--path <PATH> is required".to_string())?;
    Ok((path, mode))
}

// ─── Scan dispatch ────────────────────────────────────────────────────────────

/// Open the volume's `$MFT` when MFT scanning applies to `path` under `mode`.
///
/// The MFT enumerates the whole volume, so it is used only for a drive root
/// written exactly as `C:\` (the form entry paths use); subfolders, `C:` (the
/// drive's current directory) and UNC paths use parallel.  Opening the raw
/// volume needs Administrator rights and the boot sector must be NTFS, so this
/// call doubles as the admin and filesystem check.
///
/// Returns the open stream and the drive root (e.g. `"C:\\"`), or `None` plus
/// the reason for the header's `fallback` field when the volume opened but
/// cannot be MFT-scanned.  Lack of Administrator rights is not reported there:
/// the browser already explains it.  With `--mode mft` every reason also goes
/// to stderr.
#[cfg(windows)]
fn open_mft(path: &str, mode: &ScanMode) -> (Option<(volume::MftStream, String)>, Option<String>) {
    if *mode == ScanMode::Parallel {
        return (None, None);
    }

    let b = path.as_bytes();
    let is_drive_root = b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\';
    if !is_drive_root {
        if *mode == ScanMode::Mft {
            eprintln!("warning: --mode mft: MFT scans whole drives (X:\\) only; using parallel scan for {}", path);
        }
        return (None, None);
    }

    let drive = &path[..2]; // e.g. "C:"
    match volume::MftStream::open(&format!("\\\\.\\{}", drive)) { // "\\.\C:"
        Ok(source) => (Some((source, format!("{}\\", drive))), None),
        Err(e) => {
            if *mode == ScanMode::Mft {
                eprintln!("warning: --mode mft: {}; falling back to parallel scan", e);
            }
            match e {
                volume::OpenError::AccessDenied => (None, None),
                volume::OpenError::Unsupported(reason) => (None, Some(reason)),
            }
        }
    }
}

fn run_parallel(
    path: &str,
    writer: BufWriter<io::Stdout>,
) -> Result<(BufWriter<io::Stdout>, ScanStats), String> {
    parallel_scan(path, writer).map_err(|e| format!("parallel scan: {}", e))
}

// ─── Entry point ─────────────────────────────────────────────────────────────

fn main() {
    let (path, mode) = match parse_args() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {}", e);
            eprintln!("usage: scanner --path <PATH> [--mode auto|mft|parallel]");
            process::exit(1);
        }
    };

    // Open the $MFT *before* emitting the header so the header reflects what
    // the scan will actually do: a volume that cannot be opened (no admin
    // rights, not NTFS) is reported as parallel from the first line.
    #[cfg(windows)]
    let (mft_source, fallback) = open_mft(&path, &mode);
    #[cfg(windows)]
    let effective_mode: &str = if mft_source.is_some() { "mft" } else { "parallel" };
    #[cfg(not(windows))]
    let (effective_mode, fallback): (&str, Option<String>) = {
        let _ = &mode; // only consulted on Windows
        ("parallel", None)
    };

    // 128 KB BufWriter: batches writes into large syscalls instead of per-line locks.
    // CRITICAL: this buffer must be explicitly flushed before process exit, or the last
    // ~128 KB of output (and the summary line) will be silently lost.
    let mut writer = BufWriter::with_capacity(128 * 1024, io::stdout());

    // ── Header (first output line) ────────────────────────────────────────────
    let header = NdjsonLine::Header {
        mode: effective_mode.to_string(),
        path: path.clone(),
        fallback,
    };
    let header_json = match serde_json::to_string(&header) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("fatal: cannot serialize header: {}", e);
            process::exit(1);
        }
    };
    if let Err(e) = writeln!(writer, "{}", header_json) {
        eprintln!("fatal: cannot write header: {}", e);
        process::exit(1);
    }
    // Flush the header immediately so streaming consumers (Node.js server) see
    // it without waiting for the buffer to fill.
    if let Err(e) = writer.flush() {
        eprintln!("fatal: cannot flush after header: {}", e);
        process::exit(1);
    }

    // ── Scan ─────────────────────────────────────────────────────────────────
    //
    // The scan takes ownership of `writer`, executes (MFT or parallel), and
    // returns the writer along with scan statistics.
    #[cfg(windows)]
    let scan_result = match mft_source {
        Some((source, drive_root)) => mft::mft_scan(source, &drive_root, writer),
        None => run_parallel(&path, writer),
    };
    #[cfg(not(windows))]
    let scan_result = run_parallel(&path, writer);
    let (mut writer, stats) = match scan_result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("fatal: scan error: {}", e);
            process::exit(1);
        }
    };

    // ── Summary (last output line) ────────────────────────────────────────────
    let summary = NdjsonLine::Summary {
        total_size: stats.total_size,
        entry_count: stats.entry_count,
        duration_ms: stats.duration_ms,
        mode: effective_mode.to_string(),
        skipped_count: stats.skipped_count,
    };
    let summary_json = match serde_json::to_string(&summary) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("fatal: cannot serialize summary: {}", e);
            process::exit(1);
        }
    };
    if let Err(e) = writeln!(writer, "{}", summary_json) {
        eprintln!("fatal: cannot write summary: {}", e);
        process::exit(1);
    }

    // CRITICAL: explicit flush before exit.
    // Without this, any data still in the BufWriter's 128 KB buffer (including
    // the summary line just written) is silently discarded when the process exits.
    if let Err(e) = writer.flush() {
        eprintln!("fatal: cannot flush stdout: {}", e);
        process::exit(1);
    }

    process::exit(0);
}
