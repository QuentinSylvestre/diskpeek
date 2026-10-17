//! MFT (Master File Table) fast scanner for NTFS volumes.
//!
//! Requires Administrator privileges (to open `\\.\X:`) and an NTFS volume.
//! The live `$MFT` is read through `volume::MftStream`.  Uses two passes:
//!
//!   **Pass 1** — iterate every MFT entry, build an FRN → `FrnEntry` map.
//!                SSE keep-alive comments are emitted every 2 s so browsers
//!                don't drop the connection during this silent phase.
//!
//!   **Pass 2** — walk the tree depth-first from the root directory, building
//!                each path from its parent's, and emit an NDJSON `entry` line
//!                per record (parents before children).
//!
//! The external `mft` crate is referenced as `::mft::` to avoid a name
//! collision with this module (`mod mft` in `main.rs`).

use std::collections::{HashMap, HashSet};
use std::io::{self, BufWriter, Read, Seek, Write};
use std::panic::{self, AssertUnwindSafe};
use std::time::Instant;

use crate::model::{NdjsonLine, ScanStats};
use crate::volume::MftStream;

// '::mft::' targets the external dependency, not this module.
use ::mft::attribute::header::ResidentialHeader;
use ::mft::attribute::x30::FileNamespace;
use ::mft::attribute::MftAttributeType;
use ::mft::{MftEntry, MftParser};

// ─── NTFS constants ───────────────────────────────────────────────────────────

/// FRN of the NTFS root directory ($Dot, `.`).  Always 5 on all NTFS volumes.
const ROOT_FRN: u64 = 5;

/// Placeholder parent for a base record whose `$FILE_NAME` has not been seen yet.
const UNKNOWN_FRN: u64 = u64::MAX;

/// Smallest valid attribute record (a resident attribute header).
const MIN_ATTRIBUTE_LEN: usize = 0x18;

// ─── Internal data structures ─────────────────────────────────────────────────

/// Compact per-entry record kept in the pass-1 map.
struct FrnEntry {
    /// File or directory name component (Win32-preferred, no path separators).
    name: String,
    /// FRN of the parent directory.
    parent_frn: u64,
    /// Logical (apparent) file size in bytes; 0 for directories.
    size: u64,
    /// Physical (cluster-allocated) size in bytes; `None` for directories.
    alloc_size: Option<u64>,
    /// Unix timestamp (seconds) of last modification.
    mtime_unix: i64,
    /// Whether this entry represents a directory.
    is_dir: bool,
}

/// Facts that extension records contribute to their base record.
#[derive(Default)]
struct Extensions {
    /// $DATA sizes, keyed by base FRN.  A heavily fragmented file keeps its
    /// $DATA outside the base record, which then has none.
    sizes: HashMap<u64, (u64, Option<u64>)>,
    /// ($FILE_NAME name, parent FRN, is-DOS-only), keyed by base FRN.  A record
    /// with many attributes (e.g. a file with many hard links) can have some or
    /// all of its $FILE_NAMEs moved out via $ATTRIBUTE_LIST, leaving the base
    /// record with no name or only the 8.3 short name.
    names: HashMap<u64, (String, u64, bool)>,
    /// Base records whose only local name is an 8.3 short name ("PROGRA~1").
    dos_named: HashSet<u64>,
}

/// Counts from pass 2.
struct EmitStats {
    entry_count: u64,
    total_size: u64,
    /// Records not reachable from the root (one Error line each).
    orphan_count: u64,
    /// Output failed (broken pipe); the scan should stop.
    closed: bool,
}

/// Silences the default panic message while installed; restores it on drop.
/// The `mft` crate panics on some corrupt records (unchecked fixup slicing);
/// those panics are caught and counted, and must not spam stderr.
struct QuietPanics;

impl QuietPanics {
    fn install() -> Self {
        panic::set_hook(Box::new(|_| {}));
        QuietPanics
    }
}

impl Drop for QuietPanics {
    fn drop(&mut self) {
        let _ = panic::take_hook(); // back to the default hook
    }
}

// ─── Record helpers ───────────────────────────────────────────────────────────

/// Logical and allocated size of an entry's unnamed `$DATA` attribute.
///
/// Returns `None` when the record holds no unnamed `$DATA` starting at VCN 0
/// (directories, or files whose `$DATA` lives in an extension record).
/// Allocated size is `None` for resident data, which occupies no clusters.
fn data_sizes(entry: &MftEntry) -> Option<(u64, Option<u64>)> {
    entry
        .iter_attributes_matching(Some(vec![MftAttributeType::DATA]))
        .filter_map(|r| r.ok())
        .filter(|a| a.header.name.is_empty())
        .find_map(|a| match a.header.residential_header {
            ResidentialHeader::Resident(ref r) => Some((u64::from(r.data_size), None)),
            ResidentialHeader::NonResident(ref nr) if nr.vnc_first == 0 => Some((
                nr.file_size,
                Some(nr.total_allocated.unwrap_or(nr.allocated_length)),
            )),
            ResidentialHeader::NonResident(_) => None,
        })
}

/// Whether the record's attribute chain is walkable: every attribute length is
/// at least a header and stays inside the record, ending in the 0xFFFFFFFF
/// marker.  The `mft` crate advances by each attribute's length without
/// checking it, so a zero length would make it loop forever.
fn attributes_well_formed(entry: &MftEntry) -> bool {
    let data = &entry.data;
    let mut off = usize::from(entry.header.first_attribute_record_offset);
    loop {
        if off + 4 > data.len() {
            return false;
        }
        if data[off..off + 4] == [0xFF; 4] {
            return true;
        }
        if off + 8 > data.len() {
            return false;
        }
        let len = u32::from_le_bytes([data[off + 4], data[off + 5], data[off + 6], data[off + 7]]) as usize;
        if len < MIN_ATTRIBUTE_LEN || off + len > data.len() {
            return false;
        }
        off += len;
    }
}

// ─── Tree assembly ────────────────────────────────────────────────────────────

/// Apply extension-record facts to base records.
///
/// Fills in names for base records that had none, replaces 8.3 short names with
/// long names, applies extension $DATA sizes, and drops base records with no
/// $FILE_NAME anywhere.  Returns the number of records dropped.
fn merge_extensions(frn_map: &mut HashMap<u64, FrnEntry>, ext: Extensions) -> u64 {
    for (base_frn, (name, parent_frn, is_dos)) in ext.names {
        if let Some(fe) = frn_map.get_mut(&base_frn) {
            let upgrade = !is_dos && ext.dos_named.contains(&base_frn);
            if fe.parent_frn == UNKNOWN_FRN || upgrade {
                fe.name = name;
                fe.parent_frn = parent_frn;
            }
        }
    }
    // A base record with no $FILE_NAME anywhere cannot be placed in the tree.
    let before = frn_map.len();
    frn_map.retain(|_, fe| fe.parent_frn != UNKNOWN_FRN);
    let dropped = (before - frn_map.len()) as u64;

    // Only the record holding VCN 0 reports sizes, so at most one of base and
    // extension records contributed; the extension value replaces the fallback.
    for (base_frn, (size, alloc_size)) in ext.sizes {
        if let Some(fe) = frn_map.get_mut(&base_frn) {
            if !fe.is_dir {
                fe.size = size;
                fe.alloc_size = alloc_size;
            }
        }
    }
    dropped
}

/// Emit every record reachable from the root as an NDJSON entry, parents first,
/// then one Error line per unreachable record.
///
/// Depth-first from ROOT_FRN so every directory is emitted before its
/// children, as in parallel mode.  The browser treats any entry whose parent
/// has not arrived yet as a top-level row, so emitting in FRN-map order makes
/// its periodic live render build one row per pending orphan.  Only directories
/// are descended into: a parent FRN that was freed and reused for a file must
/// not gain children.  Paths are built from the parent's path.
fn emit_tree<W: Write>(mut frn_map: HashMap<u64, FrnEntry>, drive_root: &str, writer: &mut W) -> EmitStats {
    let mut children: HashMap<u64, Vec<u64>> = HashMap::with_capacity(frn_map.len() / 4);
    for (&frn, fe) in &frn_map {
        if frn != ROOT_FRN {
            children.entry(fe.parent_frn).or_default().push(frn);
        }
    }

    let mut stats = EmitStats { entry_count: 0, total_size: 0, orphan_count: 0, closed: false };

    // (FRN, full path).  Records are removed from frn_map as they are emitted;
    // whatever is left afterwards was not reachable from the root.
    let mut stack: Vec<(u64, String)> = vec![(ROOT_FRN, drive_root.to_string())];

    while let Some((frn, path)) = stack.pop() {
        // A missing root record still lets its children be walked.
        let is_dir = frn_map.get(&frn).map_or(frn == ROOT_FRN, |fe| fe.is_dir);
        if is_dir {
            if let Some(kids) = children.remove(&frn) {
                for kid in kids {
                    if let Some(ke) = frn_map.get(&kid) {
                        // drive_root already ends with '\' (e.g. "C:\").
                        let sep = if path.ends_with('\\') { "" } else { "\\" };
                        stack.push((kid, format!("{}{}{}", path, sep, ke.name)));
                    }
                }
            }
        }

        let fe = match frn_map.remove(&frn) {
            Some(fe) => fe,
            None => continue,
        };

        // FIX-1: NTFS names the root directory "."; override with the actual drive
        // root string (e.g. "C:\\") so the browser tree displays it correctly.
        let name = if frn == ROOT_FRN { drive_root.to_string() } else { fe.name };

        let line = NdjsonLine::Entry {
            path,
            name,
            size: fe.size,
            is_dir: fe.is_dir,
            alloc_size: fe.alloc_size,
            mtime_unix: fe.mtime_unix,
        };

        // Stop on broken pipe / stdout closed; still return stats for what we did emit.
        if serde_json::to_writer(&mut *writer, &line).is_err() || writer.write_all(b"\n").is_err() {
            stats.closed = true;
            return stats;
        }

        stats.entry_count += 1;
        stats.total_size = stats.total_size.saturating_add(fe.size);
    }

    // Orphans: parent chain broken, a parent cycle that never reaches the root,
    // or a parent that is now a file.  One Error line each.
    let mut orphans: Vec<u64> = frn_map.into_keys().collect();
    orphans.sort_unstable();
    for frn in orphans {
        stats.orphan_count += 1;
        let error_line = NdjsonLine::Error {
            path: format!("{}", frn),
            message: format!("MFT: could not resolve path for FRN {}", frn),
        };
        if serde_json::to_writer(&mut *writer, &error_line).is_err() || writer.write_all(b"\n").is_err() {
            stats.closed = true;
            break;
        }
    }
    stats
}

// ─── Public scan entry point ─────────────────────────────────────────────────

/// Scan an NTFS volume via its Master File Table.
///
/// # Arguments
/// - `source`     — the volume's live `$MFT`, opened by `MftStream::open`.
/// - `drive_root` — drive root such as `"C:\\"` used for constructing output paths.
/// - `writer`     — takes ownership of the `BufWriter`; returned with statistics.
///
/// # Errors
/// Returns an error string if the `$MFT` stream cannot be parsed or stdout closes.
pub fn mft_scan<V: Read + Seek>(
    source: MftStream<V>,
    drive_root: &str,
    writer: BufWriter<io::Stdout>,
) -> Result<(BufWriter<io::Stdout>, ScanStats), String> {
    let start = Instant::now();
    let mut writer = writer;

    // ── Pass 1: build FRN → FrnEntry map ─────────────────────────────────────
    //
    // Typical C: drive: 300 K – 3 M MFT entries; pre-size to reduce reallocs.
    let len = source.len();
    let mut parser = MftParser::from_read_seek(source, Some(len))
        .map_err(|e| format!("cannot parse $MFT: {}", e))?;

    let mut frn_map: HashMap<u64, FrnEntry> = HashMap::with_capacity(500_000);
    let mut ext = Extensions::default();
    // Records that could not be read (I/O error), parsed (crate error or panic),
    // or trusted (torn update sequence, malformed attribute chain).
    let mut unreadable: u64 = 0;
    let mut last_heartbeat = Instant::now();

    let quiet = QuietPanics::install();
    for i in 0..parser.get_entry_count() {
        // SSE keep-alive: emit a bare comment every 2 s so the browser won't
        // time out while this silent build phase runs.
        if last_heartbeat.elapsed() > std::time::Duration::from_secs(2) {
            writer
                .write_all(b":\n")
                .and_then(|_| writer.flush())
                .map_err(|e| format!("cannot write to stdout: {}", e))?;
            last_heartbeat = Instant::now();
        }

        let entry = match panic::catch_unwind(AssertUnwindSafe(|| parser.get_entry(i))) {
            Ok(Ok(e)) => e,
            Ok(Err(_)) | Err(_) => {
                unreadable += 1;
                continue;
            }
        };

        // Skip freed (deallocated) MFT records.
        if !entry.is_allocated() {
            continue;
        }

        // A record being rewritten while it was read fails its fixups; its
        // attributes would mix two versions.
        if entry.valid_fixup != Some(true) || !attributes_well_formed(&entry) {
            unreadable += 1;
            continue;
        }

        let frn = entry.header.record_number;
        let is_dir = entry.is_dir();

        // Extension record: contributes its $DATA size and $FILE_NAME to the base
        // record, and is not an entry of its own.
        let base_frn = entry.header.base_reference.entry;
        if base_frn != 0 {
            if let Some(sizes) = data_sizes(&entry) {
                ext.sizes.insert(base_frn, sizes);
            }
            if let Some(f) = entry.find_best_name_attribute() {
                let is_dos = f.namespace == FileNamespace::DOS;
                let keep_existing = matches!(ext.names.get(&base_frn), Some((_, _, false)));
                if !keep_existing {
                    ext.names.insert(base_frn, (f.name, f.parent.entry, is_dos));
                }
            }
            continue;
        }

        // $FILE_NAME attribute: Win32 namespace preferred; falls back to any.
        // When absent here it lives in an extension record; the name and parent
        // are filled in by merge_extensions after this pass.
        let fname = entry.find_best_name_attribute();
        if fname.as_ref().is_some_and(|f| f.namespace == FileNamespace::DOS) {
            ext.dos_named.insert(frn);
        }

        let (name, parent_frn) = match &fname {
            Some(f) => (f.name.clone(), f.parent.entry),
            None => (String::new(), UNKNOWN_FRN),
        };
        // Directories report 0 apparent size.  Files take sizes from the unnamed
        // $DATA attribute: the $FILE_NAME copies are only refreshed when the name
        // changes, so they are stale for any file that grew after creation.
        // Resident data (< ~900 B) has no allocation; it stays None so the browser
        // receives null rather than 0, matching parallel mode behaviour.
        let (size, alloc_size) = if is_dir {
            (0, None)
        } else {
            data_sizes(&entry)
                .unwrap_or((fname.as_ref().map_or(0, |f| f.logical_size), None))
        };

        // Prefer $STANDARD_INFORMATION modified time (the user-visible last-write
        // timestamp that Explorer shows); fall back to $FILE_NAME.modified.
        let mtime_unix = entry
            .iter_attributes_matching(Some(vec![MftAttributeType::StandardInformation]))
            .filter_map(|r| r.ok())
            .find_map(|a| a.data.into_standard_info())
            .map(|si| si.modified.timestamp())
            .or_else(|| fname.as_ref().map(|f| f.modified.timestamp()))
            .unwrap_or(0);

        frn_map.insert(
            frn,
            FrnEntry {
                name,
                parent_frn,
                size,
                alloc_size,
                mtime_unix,
                is_dir,
            },
        );
    }
    drop(quiet);

    let nameless = merge_extensions(&mut frn_map, ext);

    // ── Pass 2: walk the tree from the root and emit NDJSON entries ───────────
    let emitted = emit_tree(frn_map, drive_root, &mut writer);
    if emitted.closed {
        return Err("cannot write to stdout".to_string());
    }

    // One summary Error line for records skipped before the tree was built, so
    // the loss is visible instead of silently shrinking the totals.
    let lost = unreadable + nameless;
    if lost > 0 {
        let error_line = NdjsonLine::Error {
            path: String::new(),
            message: format!(
                "MFT: {} records skipped ({} unreadable or corrupt, {} without a name)",
                lost, unreadable, nameless
            ),
        };
        serde_json::to_writer(&mut writer, &error_line)
            .map_err(|e| e.to_string())
            .and_then(|_| writer.write_all(b"\n").map_err(|e| e.to_string()))
            .map_err(|e| format!("cannot write to stdout: {}", e))?;
    }

    let duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);

    Ok((
        writer,
        ScanStats {
            total_size: emitted.total_size,
            entry_count: emitted.entry_count,
            skipped_count: emitted.orphan_count + lost,
            duration_ms,
        },
    ))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fe(name: &str, parent_frn: u64, size: u64, is_dir: bool) -> FrnEntry {
        FrnEntry { name: name.to_string(), parent_frn, size, alloc_size: None, mtime_unix: 0, is_dir }
    }

    /// Run emit_tree and return (entry paths in output order, error count, stats).
    fn emit(map: HashMap<u64, FrnEntry>) -> (Vec<String>, usize, EmitStats) {
        let mut out = Vec::new();
        let stats = emit_tree(map, "C:\\", &mut out);
        let mut paths = Vec::new();
        let mut errors = 0;
        for line in String::from_utf8(out).unwrap().lines() {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            match v["type"].as_str().unwrap() {
                "entry" => paths.push(v["path"].as_str().unwrap().to_string()),
                "error" => errors += 1,
                other => panic!("unexpected line type {}", other),
            }
        }
        (paths, errors, stats)
    }

    #[test]
    fn emit_tree_is_parent_first_with_full_paths() {
        let mut map = HashMap::new();
        map.insert(ROOT_FRN, fe(".", ROOT_FRN, 0, true));
        map.insert(40, fe("a.txt", 30, 7, false));
        map.insert(30, fe("Users", ROOT_FRN, 0, true));
        map.insert(50, fe("b", 30, 0, true));
        map.insert(60, fe("c.bin", 50, 5, false));

        let (paths, errors, stats) = emit(map);
        assert_eq!(errors, 0);
        assert_eq!((stats.entry_count, stats.total_size, stats.orphan_count), (5, 12, 0));
        assert_eq!(paths[0], "C:\\");
        for p in ["C:\\Users", "C:\\Users\\a.txt", "C:\\Users\\b", "C:\\Users\\b\\c.bin"] {
            assert!(paths.contains(&p.to_string()), "missing {}", p);
        }
        // Every entry's parent was emitted before it.
        for (i, p) in paths.iter().enumerate().skip(1) {
            let parent = &p[..p.rfind('\\').unwrap().max(3)];
            let parent = if parent.len() == 2 { "C:\\" } else { parent };
            assert!(paths[..i].iter().any(|q| q == parent), "{} before its parent", p);
        }
    }

    #[test]
    fn emit_tree_reports_orphans_and_children_of_files() {
        let mut map = HashMap::new();
        map.insert(ROOT_FRN, fe(".", ROOT_FRN, 0, true));
        map.insert(30, fe("file.txt", ROOT_FRN, 1, false));
        map.insert(31, fe("child-of-file", 30, 1, false)); // parent FRN reused by a file
        map.insert(32, fe("lost", 999, 1, false)); // parent missing
        map.insert(33, fe("loop-a", 34, 0, true)); // cycle not reaching the root
        map.insert(34, fe("loop-b", 33, 0, true));

        let (paths, errors, stats) = emit(map);
        assert_eq!(paths, vec!["C:\\".to_string(), "C:\\file.txt".to_string()]);
        assert_eq!(errors, 4);
        assert_eq!(stats.orphan_count, 4);
    }

    #[test]
    fn merge_extensions_fills_and_upgrades_names_and_sizes() {
        let mut map = HashMap::new();
        map.insert(10, fe("", UNKNOWN_FRN, 0, false)); // name only in extension
        map.insert(11, fe("PROGRA~1", ROOT_FRN, 0, true)); // 8.3 name in base
        map.insert(12, fe("", UNKNOWN_FRN, 0, false)); // no name anywhere
        map.insert(13, fe("big.vhdx", ROOT_FRN, 1, false)); // $DATA in extension

        let mut ext = Extensions::default();
        ext.names.insert(10, ("real.txt".into(), ROOT_FRN, false));
        ext.names.insert(11, ("Program Files".into(), ROOT_FRN, false));
        ext.dos_named.insert(11);
        ext.sizes.insert(13, (1 << 40, Some(1 << 30)));

        assert_eq!(merge_extensions(&mut map, ext), 1);
        assert!(!map.contains_key(&12));
        assert_eq!((map[&10].name.as_str(), map[&10].parent_frn), ("real.txt", ROOT_FRN));
        assert_eq!(map[&11].name, "Program Files");
        assert_eq!((map[&13].size, map[&13].alloc_size), (1 << 40, Some(1 << 30)));
    }
}
