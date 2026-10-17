use serde::Serialize;

/// All NDJSON lines the scanner emits, tagged with `"type"` as the first JSON field.
///
/// Serialization contract (matches Node.js parser in Phase 2):
///   - Header : {"type":"header","mode":"...","path":"...","fallback":"..."?}
///   - Entry  : {"type":"entry","path":"...","name":"...","size":N,"is_dir":bool,"alloc_size":null,"mtime_unix":N}
///   - Error  : {"type":"error","path":"...","message":"..."}
///   - Summary: {"type":"summary","total_size":N,"entry_count":N,"duration_ms":N,"mode":"...","skipped_count":N}
///
/// `alloc_size` is always null in parallel mode; Phase 3 (MFT) will populate it.
/// `mtime_unix` is always a non-null integer: the Unix timestamp (seconds) of last modification.
/// For times before the Unix epoch the value is negative.  When `metadata().modified()` is
/// unavailable (unusual UNC paths, FAT32 corrupted entries), the value is `0`.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NdjsonLine {
    Header {
        mode: String,
        path: String,
        /// Why an MFT scan was not possible on a volume the process could open
        /// (not NTFS, fragmented $MFT, ...).  Absent when MFT ran, was not
        /// requested, or failed only for lack of Administrator rights.
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback: Option<String>,
    },
    Entry {
        path: String,
        name: String,
        size: u64,
        is_dir: bool,
        alloc_size: Option<u64>,
        mtime_unix: i64,
    },
    Error {
        path: String,
        message: String,
    },
    Summary {
        total_size: u64,
        entry_count: u64,
        duration_ms: u64,
        mode: String,
        skipped_count: u64,
    },
}

/// Statistics returned by a completed scan.
pub struct ScanStats {
    /// Sum of apparent file sizes (directories contribute 0).
    pub total_size: u64,
    /// Number of `Entry` lines emitted.
    pub entry_count: u64,
    /// Number of entries skipped: in parallel mode, directories that emitted an Error line;
    /// in MFT mode, entries whose FRN chain could not be resolved to a full path.
    pub skipped_count: u64,
    /// Wall-clock duration of the scan in milliseconds.
    pub duration_ms: u64,
}
