//! Live-volume access to the NTFS `$MFT`.
//!
//! The `mft` crate parses an `$MFT` *file image*: it expects record 0 at byte
//! offset 0 and a contiguous stream of records after it.  On a live volume
//! (`\\.\C:`) offset 0 is the boot sector and the `$MFT` is scattered across
//! the disk in one or more extents (data runs).  `MftStream` bridges the two:
//! it reads the boot sector, locates record 0 of `$MFT`, decodes its `$DATA`
//! runs, and presents the `$MFT` as a contiguous `Read + Seek` stream that
//! `MftParser::from_read_seek` can consume.
//!
//! Raw volume handles only accept reads whose offset and length are multiples
//! of the sector size, while the parser reads one record (typically 1 KiB) at
//! a time.  All volume reads therefore go through a cluster-aligned buffer.

use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

/// Minimum volume bytes read per buffer refill (one cluster if clusters are larger).
const CHUNK_SIZE: u64 = 1024 * 1024;

/// Boot-sector read size: a multiple of both 512-byte and 4 KiB sectors.
const BOOT_READ_SIZE: usize = 4096;

/// Why the `$MFT` could not be opened.
#[derive(Debug)]
pub enum OpenError {
    /// The volume handle was refused: the process lacks Administrator rights.
    AccessDenied,
    /// The volume opened but cannot be MFT-scanned (not NTFS, unsupported
    /// geometry, fragmented `$MFT`, unreadable or corrupt record 0, ...).
    Unsupported(String),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::AccessDenied => write!(f, "access denied (Administrator rights required)"),
            OpenError::Unsupported(reason) => write!(f, "{}", reason),
        }
    }
}

fn unsupported(reason: impl Into<String>) -> OpenError {
    OpenError::Unsupported(reason.into())
}

/// One `$MFT` extent: `clusters` clusters starting at virtual cluster `vcn`,
/// stored at logical cluster `lcn` (`None` for a sparse run, read as zeros).
#[derive(Clone, Copy)]
struct Run {
    vcn: u64,
    lcn: Option<u64>,
    clusters: u64,
}

/// The live `$MFT` presented as a contiguous `Read + Seek` stream.
pub struct MftStream<V: Read + Seek = File> {
    volume: V,
    runs: Vec<Run>,
    cluster_size: u64,
    /// Clusters per buffer refill.
    chunk_clusters: u64,
    /// Readable size of the `$MFT` stream, in bytes (its valid data length).
    len: u64,
    pos: u64,
    /// Buffered volume bytes; empty when nothing valid is buffered.
    buf: Vec<u8>,
    /// `$MFT` offset of `buf[0]`; meaningful only when `buf` is non-empty.
    buf_start: u64,
}

fn le_u64(bytes: &[u8]) -> u64 {
    bytes.iter().rev().fold(0, |acc, &b| (acc << 8) | u64::from(b))
}

fn le_i64(bytes: &[u8]) -> i64 {
    if bytes.is_empty() {
        return 0;
    }
    let unsigned = le_u64(bytes);
    let shift = 64 - 8 * bytes.len() as u32;
    // Sign-extend from the top bit of the last byte.
    ((unsigned << shift) as i64) >> shift
}

fn read_at<V: Read + Seek>(volume: &mut V, offset: u64, buf: &mut [u8]) -> io::Result<()> {
    volume.seek(SeekFrom::Start(offset))?;
    volume.read_exact(buf)
}

/// Decode an NTFS mapping-pairs array into runs.
///
/// Each pair starts with a header byte `offset_size << 4 | length_size`,
/// followed by the run length (unsigned) and the LCN delta (signed, relative
/// to the previous run's LCN).  A zero header byte terminates the array; a
/// zero `offset_size` marks a sparse run.
fn decode_runs(pairs: &[u8]) -> Result<Vec<Run>, String> {
    let mut runs = Vec::new();
    let mut p = 0usize;
    let mut vcn = 0u64;
    let mut lcn = 0i64;

    while p < pairs.len() && pairs[p] != 0 {
        let length_size = (pairs[p] & 0x0F) as usize;
        let offset_size = (pairs[p] >> 4) as usize;
        p += 1;
        if length_size == 0 || length_size > 8 || offset_size > 8 {
            return Err(format!("invalid data-run header 0x{:02x}", pairs[p - 1]));
        }
        if p + length_size + offset_size > pairs.len() {
            return Err("data run extends past the attribute".to_string());
        }
        let clusters = le_u64(&pairs[p..p + length_size]);
        p += length_size;
        let run_lcn = if offset_size == 0 {
            None
        } else {
            lcn = lcn
                .checked_add(le_i64(&pairs[p..p + offset_size]))
                .ok_or("data-run LCN overflow")?;
            p += offset_size;
            Some(u64::try_from(lcn).map_err(|_| "negative LCN in data run".to_string())?)
        };
        runs.push(Run { vcn, lcn: run_lcn, clusters });
        vcn = vcn.checked_add(clusters).ok_or("data-run VCN overflow")?;
    }
    Ok(runs)
}

impl MftStream<File> {
    /// Open `volume_path` (e.g. `"\\\\.\\C:"`) and locate its `$MFT`.
    ///
    /// Fails with `AccessDenied` without Administrator rights, and with
    /// `Unsupported` when the volume is not NTFS, has an unsupported geometry,
    /// or its `$MFT` extents do not all fit in record 0 (an `$MFT` fragmented
    /// enough to need an `$ATTRIBUTE_LIST`).  Callers fall back to parallel.
    pub fn open(volume_path: &str) -> Result<Self, OpenError> {
        let volume = File::open(volume_path).map_err(|e| match e.kind() {
            io::ErrorKind::PermissionDenied => OpenError::AccessDenied,
            _ => unsupported(format!("cannot open {}: {}", volume_path, e)),
        })?;
        Self::from_volume(volume)
    }
}

impl<V: Read + Seek> MftStream<V> {
    /// Locate the `$MFT` on an already-open volume (see `open`).
    pub fn from_volume(mut volume: V) -> Result<Self, OpenError> {
        // ── Boot sector ──────────────────────────────────────────────────────
        let mut boot = vec![0u8; BOOT_READ_SIZE];
        read_at(&mut volume, 0, &mut boot)
            .map_err(|e| unsupported(format!("cannot read boot sector: {}", e)))?;
        if &boot[3..11] != b"NTFS    " {
            return Err(unsupported("not an NTFS volume"));
        }

        let bytes_per_sector = u64::from(u16::from_le_bytes([boot[0x0B], boot[0x0C]]));
        if ![512, 1024, 2048, 4096].contains(&bytes_per_sector) {
            return Err(unsupported(format!("unsupported sector size {}", bytes_per_sector)));
        }
        // Values above 0x80 encode 2^(256 - v) sectors per cluster.
        let spc_raw = boot[0x0D];
        let sectors_per_cluster = match spc_raw {
            0 => 0,
            1..=0x80 => u64::from(spc_raw),
            _ if 256 - u32::from(spc_raw) <= 12 => 1u64 << (256 - u32::from(spc_raw)),
            _ => 0,
        };
        if !sectors_per_cluster.is_power_of_two() {
            return Err(unsupported(format!("invalid sectors-per-cluster byte 0x{:02x}", spc_raw)));
        }
        let cluster_size = bytes_per_sector * sectors_per_cluster;
        // Negative values encode 2^|v| bytes per record; positive ones, clusters.
        let cpr = boot[0x40] as i8;
        let record_size = match cpr {
            -16..=-8 => 1u64 << u32::from(cpr.unsigned_abs()),
            1..=127 => u64::from(cpr as u8) * cluster_size,
            _ => 0,
        };
        if !(256..=65536).contains(&record_size) || !record_size.is_power_of_two() {
            return Err(unsupported(format!("invalid file-record size byte 0x{:02x}", boot[0x40])));
        }
        let mft_offset = le_u64(&boot[0x30..0x38])
            .checked_mul(cluster_size)
            .ok_or_else(|| unsupported("$MFT location out of range"))?;

        // ── $MFT record 0 ────────────────────────────────────────────────────
        // Read whole clusters to stay sector-aligned; the record is the prefix.
        let read_len = record_size.div_ceil(cluster_size) * cluster_size;
        let mut raw = vec![0u8; read_len as usize];
        read_at(&mut volume, mft_offset, &mut raw)
            .map_err(|e| unsupported(format!("cannot read $MFT record 0: {}", e)))?;
        raw.truncate(record_size as usize);
        // from_buffer applies the update sequence fixups (which can overwrite
        // bytes inside the data runs) and reports whether every sector matched.
        let record0 = ::mft::MftEntry::from_buffer(raw, 0)
            .map_err(|e| unsupported(format!("cannot parse $MFT record 0: {}", e)))?;
        if !record0.header.is_valid() || record0.valid_fixup != Some(true) {
            return Err(unsupported("$MFT record 0 is corrupt (bad signature or fixups)"));
        }
        let data = &record0.data;

        // ── Unnamed non-resident $DATA attribute → runs ─────────────────────
        let mut off = usize::from(record0.header.first_attribute_record_offset);
        let (runs, len) = loop {
            if off + 8 > data.len() {
                return Err(unsupported("$MFT record 0 has no $DATA attribute"));
            }
            let attr_type = u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
            let attr_len =
                u32::from_le_bytes([data[off + 4], data[off + 5], data[off + 6], data[off + 7]]) as usize;
            if attr_type == 0xFFFF_FFFF || attr_len < 0x18 || off + attr_len > data.len() {
                return Err(unsupported("$MFT record 0 has no $DATA attribute"));
            }
            let non_resident = data[off + 8] == 1;
            let name_len = data[off + 9];
            if attr_type == 0x80 && non_resident && name_len == 0 && attr_len >= 0x40 {
                let attr = &data[off..off + attr_len];
                let runs_offset = usize::from(u16::from_le_bytes([attr[0x20], attr[0x21]]));
                // Valid data length bounds what NTFS has initialised; past it the
                // clusters may hold stale records that would read as phantom files.
                let len = le_u64(&attr[0x30..0x38]).min(le_u64(&attr[0x38..0x40]));
                if runs_offset >= attr.len() {
                    return Err(unsupported("$MFT data-run offset out of range"));
                }
                break (decode_runs(&attr[runs_offset..]).map_err(unsupported)?, len);
            }
            off += attr_len;
        };

        let mapped = runs
            .iter()
            .try_fold(0u64, |acc, r| acc.checked_add(r.clusters))
            .and_then(|c| c.checked_mul(cluster_size))
            .ok_or_else(|| unsupported("$MFT data runs out of range"))?;
        if mapped < len {
            return Err(unsupported(format!(
                "$MFT is fragmented beyond record 0 ({} of {} bytes mapped)",
                mapped, len
            )));
        }

        Ok(MftStream {
            volume,
            runs,
            cluster_size,
            chunk_clusters: (CHUNK_SIZE / cluster_size).max(1),
            len,
            pos: 0,
            buf: Vec::new(),
            buf_start: 0,
        })
    }

    /// Readable size of the `$MFT` stream in bytes.
    pub fn len(&self) -> u64 {
        self.len
    }

    /// Refill `buf` with the chunk-aligned extent containing `self.pos`.
    ///
    /// On error `buf` is left empty, so no partially read bytes are ever served.
    fn fill(&mut self) -> io::Result<()> {
        let mut buf = std::mem::take(&mut self.buf);
        let vcn = self.pos / self.cluster_size;
        let run = *self
            .runs
            .iter()
            .find(|r| vcn >= r.vcn && vcn < r.vcn + r.clusters)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "offset outside $MFT runs"))?;

        // Chunk-aligned start (in clusters), clipped to this run.
        let start_vcn = (vcn - vcn % self.chunk_clusters).max(run.vcn);
        let end_vcn = (start_vcn + self.chunk_clusters).min(run.vcn + run.clusters);
        let byte_len = ((end_vcn - start_vcn) * self.cluster_size) as usize;

        buf.resize(byte_len, 0);
        match run.lcn {
            Some(lcn) => {
                let disk_offset = (lcn + (start_vcn - run.vcn)) * self.cluster_size;
                read_at(&mut self.volume, disk_offset, &mut buf)?;
            }
            None => buf.fill(0),
        }
        self.buf = buf;
        self.buf_start = start_vcn * self.cluster_size;
        Ok(())
    }
}

impl<V: Read + Seek> Read for MftStream<V> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || out.is_empty() {
            return Ok(0);
        }
        let in_buf = !self.buf.is_empty()
            && self.pos >= self.buf_start
            && self.pos < self.buf_start + self.buf.len() as u64;
        if !in_buf {
            self.fill()?;
        }
        let start = (self.pos - self.buf_start) as usize;
        let available = (self.buf.len() - start).min((self.len - self.pos) as usize);
        let n = available.min(out.len());
        out[..n].copy_from_slice(&self.buf[start..start + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl<V: Read + Seek> Seek for MftStream<V> {
    fn seek(&mut self, target: SeekFrom) -> io::Result<u64> {
        let new_pos = match target {
            SeekFrom::Start(p) => Some(p),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        self.pos = new_pos
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek before start of $MFT"))?;
        Ok(self.pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const SECTOR: usize = 512; // test volume: 512-byte sectors, 1 sector per cluster
    const RECORD: usize = 1024;
    const MFT_LCN: usize = 16;
    const RUN3_LCN: usize = 40;

    /// Build an in-memory NTFS-like volume whose `$MFT` has three runs:
    /// 4 clusters at LCN 16, 2 sparse clusters, then 4 clusters at LCN 40.
    /// Every cluster outside record 0 is filled with its own LCN as a byte.
    fn test_volume() -> Vec<u8> {
        let mut vol = vec![0u8; 44 * SECTOR];
        for (lcn, cluster) in vol.chunks_mut(SECTOR).enumerate() {
            cluster.fill(lcn as u8);
        }

        // Boot sector.
        vol[..SECTOR].fill(0);
        vol[3..11].copy_from_slice(b"NTFS    ");
        vol[0x0B..0x0D].copy_from_slice(&(SECTOR as u16).to_le_bytes());
        vol[0x0D] = 1;
        vol[0x30..0x38].copy_from_slice(&(MFT_LCN as u64).to_le_bytes());
        vol[0x40] = (-10i8) as u8; // 2^10 = 1024-byte records

        // $MFT record 0.
        let mut rec = vec![0u8; RECORD];
        rec[0..4].copy_from_slice(b"FILE");
        rec[0x04..0x06].copy_from_slice(&0x30u16.to_le_bytes()); // usa offset
        rec[0x06..0x08].copy_from_slice(&3u16.to_le_bytes()); // usa size: USN + 2 sectors
        rec[0x14..0x16].copy_from_slice(&0x38u16.to_le_bytes()); // first attribute
        rec[0x16..0x18].copy_from_slice(&1u16.to_le_bytes()); // in use
        rec[0x18..0x1C].copy_from_slice(&0x88u32.to_le_bytes()); // used size
        rec[0x1C..0x20].copy_from_slice(&(RECORD as u32).to_le_bytes()); // allocated size

        let a = 0x38; // unnamed non-resident $DATA
        rec[a..a + 4].copy_from_slice(&0x80u32.to_le_bytes());
        rec[a + 4..a + 8].copy_from_slice(&0x48u32.to_le_bytes());
        rec[a + 8] = 1;
        rec[a + 0x18..a + 0x20].copy_from_slice(&9u64.to_le_bytes()); // last VCN
        rec[a + 0x20..a + 0x22].copy_from_slice(&0x40u16.to_le_bytes()); // runs offset
        let size = (10 * SECTOR) as u64;
        rec[a + 0x28..a + 0x30].copy_from_slice(&size.to_le_bytes()); // allocated
        rec[a + 0x30..a + 0x38].copy_from_slice(&size.to_le_bytes()); // data size
        rec[a + 0x38..a + 0x40].copy_from_slice(&size.to_le_bytes()); // valid data length
        let runs = [0x11, 4, MFT_LCN as u8, 0x01, 2, 0x11, 4, (RUN3_LCN - MFT_LCN) as u8];
        rec[a + 0x40..a + 0x48].copy_from_slice(&runs);
        rec[a + 0x48..a + 0x4C].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // end

        // Update sequence: USN 0x0001 replaces the last 2 bytes of each sector.
        rec[0x30..0x32].copy_from_slice(&1u16.to_le_bytes());
        for s in 0..2 {
            let end = (s + 1) * SECTOR;
            let original = [rec[end - 2], rec[end - 1]];
            rec[0x32 + 2 * s..0x34 + 2 * s].copy_from_slice(&original);
            rec[end - 2..end].copy_from_slice(&1u16.to_le_bytes());
        }
        vol[MFT_LCN * SECTOR..MFT_LCN * SECTOR + RECORD].copy_from_slice(&rec);
        vol
    }

    /// Expected byte at `$MFT` offset `off` beyond record 0.
    fn expected(off: usize) -> u8 {
        match off / SECTOR {
            vcn @ 2..=3 => (MFT_LCN + vcn) as u8,
            4..=5 => 0, // sparse run
            vcn => (RUN3_LCN + vcn - 6) as u8,
        }
    }

    #[test]
    fn stream_maps_runs_across_boundaries_and_sparse() {
        let vol = test_volume();
        let mut s = MftStream::from_volume(Cursor::new(vol.clone())).expect("opens");
        assert_eq!(s.len(), (10 * SECTOR) as u64);

        let mut all = vec![0u8; 10 * SECTOR];
        s.read_exact(&mut all).expect("reads whole $MFT");
        assert_eq!(&all[..RECORD], &vol[MFT_LCN * SECTOR..MFT_LCN * SECTOR + RECORD]);
        for (off, &b) in all.iter().enumerate().skip(RECORD) {
            assert_eq!(b, expected(off), "byte at $MFT offset {}", off);
        }

        // Random access straddling the sparse → run 3 boundary.
        let mut two = [0u8; 2];
        s.seek(SeekFrom::Start((6 * SECTOR - 1) as u64)).unwrap();
        s.read_exact(&mut two).unwrap();
        assert_eq!(two, [0, RUN3_LCN as u8]);

        // Reads stop at the end of the stream.
        s.seek(SeekFrom::End(0)).unwrap();
        assert_eq!(s.read(&mut two).unwrap(), 0);
    }

    /// Volume whose reads fail in a byte range, scribbling over the buffer first.
    struct FailingVolume {
        inner: Cursor<Vec<u8>>,
        fail: std::ops::Range<u64>,
    }

    impl Read for FailingVolume {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            let pos = self.inner.position();
            if pos < self.fail.end && pos + out.len() as u64 > self.fail.start {
                out.fill(0xEE);
                return Err(io::Error::new(io::ErrorKind::Other, "bad sector"));
            }
            self.inner.read(out)
        }
    }

    impl Seek for FailingVolume {
        fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
            self.inner.seek(to)
        }
    }

    #[test]
    fn failed_refill_never_serves_partial_bytes() {
        let fail_start = (RUN3_LCN * SECTOR) as u64;
        let vol = FailingVolume {
            inner: Cursor::new(test_volume()),
            fail: fail_start..fail_start + SECTOR as u64,
        };
        let mut s = MftStream::from_volume(vol).expect("opens");

        let mut b = [0u8; 1];
        s.seek(SeekFrom::Start((2 * SECTOR) as u64)).unwrap();
        s.read_exact(&mut b).unwrap(); // buffers run 1
        s.seek(SeekFrom::Start((6 * SECTOR) as u64)).unwrap();
        assert!(s.read_exact(&mut b).is_err(), "run 3 read must fail");

        // Back in run 1 the bytes must come from disk, not the scribbled buffer.
        s.seek(SeekFrom::Start((2 * SECTOR) as u64)).unwrap();
        s.read_exact(&mut b).unwrap();
        assert_eq!(b[0], expected(2 * SECTOR));
    }

    #[test]
    fn rejects_record0_with_torn_fixup() {
        let mut vol = test_volume();
        vol[MFT_LCN * SECTOR + SECTOR - 1] ^= 0xFF; // sector 1 trailer no longer the USN
        assert!(matches!(
            MftStream::from_volume(Cursor::new(vol)),
            Err(OpenError::Unsupported(_))
        ));
    }

    #[test]
    fn rejects_non_ntfs_and_bad_geometry() {
        let mut vol = test_volume();
        vol[3..11].copy_from_slice(b"EXFAT   ");
        assert!(MftStream::from_volume(Cursor::new(vol)).is_err());

        let mut vol = test_volume();
        vol[0x40] = (-40i8) as u8; // 2^40-byte records
        assert!(MftStream::from_volume(Cursor::new(vol)).is_err());

        let mut vol = test_volume();
        vol[0x0D] = 0x81; // 2^127 sectors per cluster
        assert!(MftStream::from_volume(Cursor::new(vol)).is_err());
    }

    #[test]
    fn decode_runs_handles_negative_delta_and_sparse() {
        // 0x21: 1-byte length, 2-byte offset → 0x10 clusters at LCN 0x1000.
        // 0x11: 1-byte length, 1-byte offset → 0x08 clusters at LCN 0x1000 - 0x10.
        // 0x01: sparse run of 0x04 clusters.
        let pairs = [0x21, 0x10, 0x00, 0x10, 0x11, 0x08, 0xF0, 0x01, 0x04, 0x00];
        let runs = decode_runs(&pairs).expect("valid runs");
        assert_eq!(runs.len(), 3);
        assert_eq!((runs[0].vcn, runs[0].lcn, runs[0].clusters), (0, Some(0x1000), 0x10));
        assert_eq!((runs[1].vcn, runs[1].lcn, runs[1].clusters), (0x10, Some(0x0FF0), 0x08));
        assert_eq!((runs[2].vcn, runs[2].lcn, runs[2].clusters), (0x18, None, 0x04));
    }

    #[test]
    fn decode_runs_rejects_truncated_pair() {
        assert!(decode_runs(&[0x21, 0x10, 0x00]).is_err());
    }
}
