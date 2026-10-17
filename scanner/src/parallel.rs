use std::io::{self, BufWriter, Write};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::bounded;
use ignore::{WalkBuilder, WalkState};

use crate::model::{NdjsonLine, ScanStats};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Extract a filesystem path from an `ignore::Error` Display string.
///
/// `ignore::Error::Io` variants format as `"path: error_description"` when produced by the
/// walkdir layer.  On Windows, drive letters use "C:" followed by `\`, never `" "`, so
/// `find(": ")` reliably finds the separator between path and message.
///
/// Returns an empty string if no path separator is found.
fn extract_path_from_message(message: &str) -> String {
    if let Some(colon_space) = message.find(": ") {
        let candidate = &message[..colon_space];
        // Require at least one path separator to avoid matching bare error words
        if candidate.contains('\\') || candidate.contains('/') {
            return candidate.to_string();
        }
    }
    String::new()
}

/// Convert a `SystemTime` to a Unix timestamp in seconds.
///
/// Returns a positive value for times after the epoch, a negative value for times before the
/// Unix epoch (rare on Windows but possible on mounted FAT volumes with old mtimes).  This is
/// extracted from `get_mtime_unix` to allow direct unit testing without reimplementing the
/// algorithm in the test body.
fn mtime_from_system_time(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
        Err(e) => {
            // SystemTime is before the Unix epoch (e.g. FAT volumes with old file times).
            // Negate the difference so the caller gets a meaningful negative timestamp
            // rather than 0 (which would be indistinguishable from "unavailable").
            let secs = e.duration().as_secs();
            i64::try_from(secs).map(|v| -v).unwrap_or(i64::MIN)
        }
    }
}

/// Convert `metadata().modified()` to a Unix timestamp in seconds.
///
/// Returns `0` if the OS does not support `modified()` on this platform (e.g. unusual UNC
/// paths, FAT32 corrupted entries).  `mtime_unix` is always a non-null integer in the output.
pub fn get_mtime_unix(meta: &std::fs::Metadata) -> i64 {
    meta.modified().map(mtime_from_system_time).unwrap_or(0)
}

// ─── Parallel scan ────────────────────────────────────────────────────────────

/// Traverse `root` recursively using `ignore::WalkBuilder::build_parallel()`.
///
/// This spawns multiple threads that issue `readdir` syscalls concurrently — true parallel I/O.
/// Compare with `walkdir + par_bridge()`, which serialises directory discovery and only
/// parallelises CPU-side processing (not the bottleneck on modern storage).
///
/// # Design
/// - A bounded channel (capacity 10 000) prevents unbounded accumulation when the drain thread
///   is slower than the walker threads.
/// - A single drain thread owns the `BufWriter` and serialises all NDJSON writes.  The BufWriter
///   is returned to the caller (main.rs) after all entries are flushed, so main.rs can append the
///   summary line and call `flush()` exactly once.
/// - Statistics (entry_count, total_size, skipped_count) are accumulated in the drain thread, not
///   via atomics in the walker threads.  This ensures the returned counts are always consistent
///   with the lines actually written — a walker-thread atomic could race if a `send()` were dropped
///   (channel full) after incrementing the counter.
///
/// # Ordering guarantee
/// `walker.run()` is synchronous: it blocks until all walker threads exit.  We then drop the
/// last sender, which closes the channel.  The drain thread consumes all remaining buffered items
/// before its `for` loop ends.  `drain_handle.join()` ensures the drain thread has finished
/// writing before this function returns.  The caller writes the summary line afterwards, so the
/// summary is guaranteed to be the last line in the output.
pub fn parallel_scan(
    root: &str,
    writer: BufWriter<io::Stdout>,
) -> Result<(BufWriter<io::Stdout>, ScanStats), String> {
    let start = Instant::now();

    // Bounded channel: walkers send NdjsonLine values; drain thread writes them to stdout.
    let (tx, rx) = bounded::<NdjsonLine>(10_000);

    // ── Drain thread ────────────────────────────────────────────────────────
    // Owns the BufWriter.  Reads from `rx` until the channel closes.
    // Counts stats here (not in walker threads) — see design note above.
    let drain_handle = std::thread::spawn(move || {
        let mut writer = writer;
        let mut entry_count: u64 = 0;
        let mut total_size: u64 = 0;
        let mut skipped_count: u64 = 0;

        for line in rx.iter() {
            // Write JSON directly into the BufWriter — avoids one heap allocation per line
            // compared to serde_json::to_string(&line) which allocates a String first.
            if serde_json::to_writer(&mut writer, &line).is_err() {
                // I/O error (broken pipe, process killed) — stop writing.
                break;
            }
            // NDJSON: each JSON object on its own line.
            if writer.write_all(b"\n").is_err() {
                break;
            }
            // Increment stats only after a successful write so counts are consistent
            // with the lines actually written (a broken-pipe break would otherwise
            // produce stats that exceed the output).
            match &line {
                NdjsonLine::Entry { size, .. } => {
                    entry_count += 1;
                    total_size = total_size.saturating_add(*size);
                }
                NdjsonLine::Error { .. } => {
                    skipped_count += 1;
                }
                _ => {}
            }
        }

        (writer, entry_count, total_size, skipped_count)
    });

    // ── Walker ──────────────────────────────────────────────────────────────
    // hidden(false)     — include hidden files and directories
    // ignore(false)     — do not consult .ignore files
    // git_ignore(false) — do not consult .gitignore files
    // git_global(false) — do not consult global gitignore (~/.config/git/ignore)
    // git_exclude(false)— do not consult .git/info/exclude
    // follow_links(false) is the default: symlinks appear as entries but are not recursed into.
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        // Default 8 threads balances SSD speed vs HDD seek contention; override with DISKPEEK_THREADS env var
        .threads(
            std::env::var("DISKPEEK_THREADS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8),
        )
        .build_parallel();

    // `walker.run(factory)` calls `factory()` once per worker thread (after cloning it).
    // Each call returns a `Box<dyn FnMut(Result<DirEntry, Error>) -> WalkState>` that
    // processes every filesystem entry on that thread.
    walker.run(|| {
        // Clone `tx` so each thread's closure has its own sender.
        // The outer closure captures `&tx` — it is cloned by the ignore crate for each thread
        // and called once.  `Sender<T>: Clone + Send + Sync` so this is safe.
        let tx = tx.clone();
        Box::new(move |result| {
            match result {
                Err(err) => {
                    // Access-denied, loop detection, etc. — emit an error line and continue.
                    //
                    // ignore::Error has no .path() method.  Try named enum variants first
                    // (their fields are pub in ignore 0.4), then fall back to parsing the
                    // path out of the Display string.  The Io variant formats as:
                    //   "C:\path\to\dir: Access is denied. (os error 5)"
                    let message = err.to_string();
                    let path = match &err {
                        ignore::Error::WithPath { path, .. } => {
                            path.to_string_lossy().into_owned()
                        }
                        ignore::Error::Loop { child, .. } => {
                            child.to_string_lossy().into_owned()
                        }
                        // Partial errors carry a Vec of sub-errors from concurrent readdir
                        // threads.  Emit each one individually so the front-end sees the full
                        // error list and skipped_count increments once per affected path.
                        ignore::Error::Partial(ref sub_errors) => {
                            for sub_err in sub_errors {
                                let sub_message = sub_err.to_string();
                                let sub_path = extract_path_from_message(&sub_message);
                                let _ = tx.send(NdjsonLine::Error {
                                    path: sub_path,
                                    message: sub_message,
                                });
                            }
                            return WalkState::Continue;
                        }
                        _ => extract_path_from_message(&message),
                    };
                    let _ = tx.send(NdjsonLine::Error { path, message });
                }
                Ok(entry) => {
                    let path = entry.path().to_string_lossy().into_owned();

                    // For a drive root like "C:\", file_name() returns None.
                    // Fall back to the full path string.
                    let name = entry
                        .path()
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| path.clone());

                    match entry.metadata() {
                        Err(e) => {
                            let _ = tx.send(NdjsonLine::Error {
                                path,
                                message: e.to_string(),
                            });
                        }
                        Ok(meta) => {
                            let is_dir = meta.is_dir();
                            // Directories report 0 apparent size; the UI computes cumulative
                            // totals from child entries.
                            let size = if is_dir { 0 } else { meta.len() };
                            let mtime_unix = get_mtime_unix(&meta);

                            let _ = tx.send(NdjsonLine::Entry {
                                path,
                                name,
                                size,
                                is_dir,
                                alloc_size: None, // MFT mode (Phase 3) will populate this
                                mtime_unix,
                            });
                        }
                    }
                }
            }
            WalkState::Continue
        })
    });

    // `walker.run()` is synchronous — all walker threads have finished at this point.
    // Drop the original sender.  All per-thread clones were dropped when their closures
    // were dropped (when threads exited).  Dropping `tx` here closes the channel, which
    // terminates the drain thread's `rx.iter()` loop.
    drop(tx);

    // Wait for the drain thread to process all buffered items.
    // This MUST happen before we return — the caller writes the summary line next, and
    // the summary must be the last line in the output.
    let (writer, entry_count, total_size, skipped_count) = drain_handle
        .join()
        .map_err(|_| "drain thread panicked".to_string())?;

    let duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);

    Ok((
        writer,
        ScanStats {
            total_size,
            entry_count,
            skipped_count,
            duration_ms,
        },
    ))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `get_mtime_unix` must return a positive non-zero timestamp for any real filesystem
    /// entry on modern Windows.  A wrong implementation that returns 0 for all files fails here.
    #[test]
    fn test_mtime_non_null_for_real_file() {
        let dir = std::env::temp_dir();
        let meta = std::fs::metadata(&dir).expect("temp dir metadata should be readable");
        let mtime = get_mtime_unix(&meta);

        assert!(
            mtime > 0,
            "mtime_unix should be a positive integer for a directory on modern Windows; got {}",
            mtime
        );
        // Sanity: temp dir mtime should be after 2020-01-01 (Unix ts 1 577 836 800)
        assert!(
            mtime > 1_577_836_800,
            "mtime should be a recent timestamp; got {}",
            mtime
        );
    }

    /// Pre-Unix-epoch times must produce a *negative* result.  Calls `mtime_from_system_time`
    /// directly so a regression in that function is caught without reimplementing the algorithm
    /// in the test body.
    #[test]
    fn test_mtime_before_epoch_returns_negative() {
        use std::time::{Duration, UNIX_EPOCH};

        let before_epoch = UNIX_EPOCH
            .checked_sub(Duration::from_secs(3600))
            .expect("test setup: should be able to subtract 3600 s from UNIX_EPOCH");

        let result = mtime_from_system_time(before_epoch);

        assert_eq!(result, -3600_i64, "pre-epoch time should yield -3600, got {}", result);
    }

    /// Scanning a small known directory tree must return non-zero entry_count consistent
    /// with what was created.  The drain-thread-counts design ensures entry_count always
    /// matches the number of Entry lines written; a walker-thread-atomic design could race.
    #[test]
    fn test_parallel_scan_returns_consistent_stats() {
        use std::fs;
        use std::io::BufWriter;

        let base = std::env::temp_dir().join("diskpeek_test_scan_stats_parallel");
        // Clean up any previous run
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("sub")).expect("create subdir");
        fs::write(base.join("file1.txt"), b"hello").expect("create file1");
        fs::write(base.join("sub").join("file2.txt"), b"world").expect("create file2");

        let root = base.to_string_lossy().into_owned();
        let writer = BufWriter::new(io::stdout());

        let result = parallel_scan(&root, writer);
        assert!(result.is_ok(), "parallel_scan should not return Err on a readable directory");

        let (_, stats) = result.unwrap();
        // 4 entries: base dir + sub dir + file1.txt + sub/file2.txt
        assert!(
            stats.entry_count >= 4,
            "expected >= 4 entries (dir, subdir, 2 files); got {}",
            stats.entry_count
        );
        // 10 bytes of file content: "hello" (5) + "world" (5)
        assert!(
            stats.total_size >= 10,
            "expected total_size >= 10 bytes; got {}",
            stats.total_size
        );
        assert_eq!(
            stats.skipped_count, 0,
            "expected no errors on a directory we created; got {}",
            stats.skipped_count
        );

        let _ = fs::remove_dir_all(&base);
    }
}
