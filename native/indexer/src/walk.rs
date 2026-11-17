// Port of walk() in src/server/scan.ts.
// Phase 1 lists directories on a bounded pool of threads; phase 2 rebuilds the entries in the same shape and
// order (parent before children, siblings sorted like Node's readdir) and folds the folder statistics.
// Symlinks are never followed; excluded names and paths are skipped exactly like the TypeScript walker.

use crate::classify::{classify_dir, classify_file, is_data_class, is_media_class, DirStats, Glob, PROJECT_MARKERS};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};

pub struct Options {
    pub roots: Vec<String>,
    pub configured_roots: Vec<String>,
    pub exclude_paths: HashSet<String>,
    pub exclude_names: HashSet<String>,
    pub vendor_names: HashSet<String>,
    pub secrets: Vec<Glob>,
    pub dump_min_files: f64,
    pub dump_data_share: f64,
    pub threads: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub parent: Option<String>,
    pub name: String,
    pub kind: &'static str,
    pub ext: String,
    pub cls: &'static str,
    pub lang: Option<&'static str>,
    pub size: u64,
    pub mtime: f64,
    pub inode: u64,
    pub depth: usize,
    pub aggregate: u8,
    pub link_target: Option<String>,
    pub stats: Option<DirStats>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Clone, Copy)]
struct Meta {
    size: u64,
    mtime: f64,
    ino: u64,
}

struct Child {
    name: String,
    kind: Kind,
    /// lstat for files and symlinks; None when it failed or the name is not valid UTF-8 (Node could not open it).
    meta: Option<Meta>,
    link: Option<String>,
}

#[derive(Default)]
struct Listing {
    /// lstat of the directory itself and readdir both succeeded
    ok: bool,
    readdir_ok: bool,
    meta: Option<Meta>,
    /// raw number of names, excluded ones included (childCount of vendor folders)
    raw_count: usize,
    /// every raw name, sorted bytewise; in aggregate mode only the kept subdirectories
    children: Vec<Child>,
    /// aggregate mode: kept regular files of this folder, counted instead of stored
    agg_files: u64,
    agg_bytes: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// regular directory: nodes for every child
    Walk,
    /// vendor or virtualenv subtree: only file counts and bytes
    Aggregate,
}

/// Same arithmetic as Node's `mtimeMs` (sec * 1000 + nsec / 1e6, in doubles) so incremental scans compare equal.
fn meta_of(m: &fs::Metadata) -> Meta {
    Meta { size: m.size(), mtime: (m.mtime() as f64) * 1000.0 + (m.mtime_nsec() as f64) / 1e6, ino: m.ino() }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

pub fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(i) => &t[i + 1..],
        None => t,
    }
}

pub fn dirname(p: &str) -> String {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return if p.starts_with('/') { "/".into() } else { ".".into() };
    }
    match t.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => match t[..i].trim_end_matches('/') {
            "" => "/".into(),
            d => d.to_string(),
        },
        None => ".".into(),
    }
}

/// POSIX `path.resolve(base, rel)` for an absolute `base`.
pub fn resolve(base: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in base.split('/').chain(rel.split('/')) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

impl Options {
    fn keep(&self, dir: &str, name: &str) -> bool {
        !self.exclude_names.contains(name) && !self.exclude_paths.contains(&join(dir, name))
    }

    fn excluded_root(&self, p: &str) -> bool {
        self.exclude_paths.contains(p) || self.exclude_names.contains(basename(p))
    }
}

fn list(dir: &str, mode: Mode, opts: &Options) -> Listing {
    let mut out = Listing::default();
    let lst = fs::symlink_metadata(dir);
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    out.readdir_ok = true;
    let mut raw: Vec<(String, bool, Kind)> = Vec::new();
    for d in rd.flatten() {
        let os = d.file_name();
        let (name, valid) = match os.to_str() {
            Some(s) => (s.to_string(), true),
            None => (os.to_string_lossy().into_owned(), false),
        };
        let kind = match d.file_type() {
            Ok(t) if t.is_symlink() => Kind::Symlink,
            Ok(t) if t.is_dir() => Kind::Dir,
            Ok(t) if t.is_file() => Kind::File,
            _ => Kind::Other,
        };
        raw.push((name, valid, kind));
    }
    out.raw_count = raw.len();
    raw.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let venv = raw.iter().any(|r| r.0 == "pyvenv.cfg");
    for (name, valid, kind) in raw {
        if mode == Mode::Aggregate {
            if !valid || !opts.keep(dir, &name) {
                continue;
            }
            match kind {
                Kind::File => {
                    if let Ok(m) = fs::symlink_metadata(join(dir, &name)) {
                        out.agg_files += 1;
                        out.agg_bytes += m.size();
                    }
                }
                Kind::Dir => out.children.push(Child { name, kind, meta: None, link: None }),
                _ => {}
            }
            continue;
        }
        let mut child = Child { name, kind, meta: None, link: None };
        if valid && opts.keep(dir, &child.name) {
            let p = join(dir, &child.name);
            match kind {
                // aggregate() uses stat(), handleFile() lstat(): identical for regular files
                Kind::File => child.meta = fs::symlink_metadata(&p).ok().map(|m| meta_of(&m)),
                Kind::Symlink if !venv => {
                    if let (Ok(m), Ok(t)) = (fs::symlink_metadata(&p), fs::read_link(&p)) {
                        child.meta = Some(meta_of(&m));
                        let t = t.to_string_lossy().into_owned();
                        child.link = Some(if t.starts_with('/') { t } else { resolve(dir, &t) });
                    }
                }
                _ => {}
            }
        }
        out.children.push(child);
    }
    if let Ok(m) = lst {
        out.ok = true;
        out.meta = Some(meta_of(&m));
    }
    out
}

/// Which subdirectories a listing leads to, and in which mode. Phase 2 follows the same decisions.
fn subdirs(dir: &str, l: &Listing, mode: Mode, opts: &Options) -> Vec<(String, Mode)> {
    if !l.readdir_ok {
        return Vec::new();
    }
    let venv = mode == Mode::Walk && l.children.iter().any(|c| c.name == "pyvenv.cfg");
    let mut out = Vec::new();
    for c in &l.children {
        if c.kind != Kind::Dir || !opts.keep(dir, &c.name) {
            continue;
        }
        let m = if mode == Mode::Aggregate || venv || opts.vendor_names.contains(&c.name) { Mode::Aggregate } else { Mode::Walk };
        out.push((join(dir, &c.name), m));
    }
    out
}

struct Queue {
    todo: VecDeque<(String, Mode)>,
    pending: usize,
}

fn list_all(opts: &Options, roots: &[String], progress: &(dyn Fn(usize) + Sync)) -> HashMap<String, Listing> {
    let queue = Mutex::new(Queue { todo: roots.iter().map(|r| (r.clone(), Mode::Walk)).collect(), pending: roots.len() });
    let cv = Condvar::new();
    let results: Mutex<HashMap<String, Listing>> = Mutex::new(HashMap::new());
    let seen = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..opts.threads.max(1) {
            s.spawn(|| loop {
                let job = {
                    let mut q = queue.lock().unwrap();
                    loop {
                        if let Some(j) = q.todo.pop_front() {
                            break Some(j);
                        }
                        if q.pending == 0 {
                            break None;
                        }
                        q = cv.wait(q).unwrap();
                    }
                };
                let Some((dir, mode)) = job else {
                    cv.notify_all();
                    return;
                };
                let l = list(&dir, mode, opts);
                let next = subdirs(&dir, &l, mode, opts);
                if mode == Mode::Walk {
                    let n = l.children.len() + 1;
                    let before = seen.fetch_add(n, Ordering::Relaxed);
                    if (before + n) / 2000 > before / 2000 {
                        progress(before + n);
                    }
                }
                results.lock().unwrap().insert(dir, l);
                let mut q = queue.lock().unwrap();
                q.pending += next.len();
                q.todo.extend(next);
                q.pending -= 1;
                drop(q);
                cv.notify_all();
            });
        }
    });
    results.into_inner().unwrap()
}

struct Builder<'a> {
    opts: &'a Options,
    listings: HashMap<String, Listing>,
    /// overlapping roots walk the same folder twice (like the TypeScript walker); otherwise free each listing once used
    keep_listings: bool,
    entries: Vec<Entry>,
}

impl Builder<'_> {
    fn aggregate(&self, dir: &str) -> (u64, u64) {
        let Some(l) = self.listings.get(dir) else { return (0, 0) };
        let (mut files, mut bytes) = (l.agg_files, l.agg_bytes);
        for c in &l.children {
            if !self.opts.keep(dir, &c.name) {
                continue;
            }
            match c.kind {
                Kind::File => {
                    if let Some(m) = c.meta {
                        files += 1;
                        bytes += m.size;
                    }
                }
                Kind::Dir => {
                    let (f, b) = self.aggregate(&join(dir, &c.name));
                    files += f;
                    bytes += b;
                }
                _ => {}
            }
        }
        (files, bytes)
    }

    fn dir_entry(&mut self, path: &str, parent: Option<String>, depth: usize, cls: &'static str, aggregate: u8) -> usize {
        let name = match basename(path) {
            "" => path.to_string(),
            n => n.to_string(),
        };
        self.entries.push(Entry {
            path: path.to_string(), parent, name, kind: "dir", ext: String::new(), cls, lang: None, size: 0, mtime: 0.0,
            inode: 0, depth, aggregate, link_target: None, stats: Some(DirStats::default()),
        });
        self.entries.len() - 1
    }

    fn vendor(&mut self, path: &str, parent: &str, depth: usize) -> (u64, u64) {
        let idx = self.dir_entry(path, Some(parent.to_string()), depth, "vendor", 1);
        let Some(l) = self.listings.get(path) else { return (0, 0) };
        if !l.ok {
            return (0, 0);
        }
        let (meta, count) = (l.meta.unwrap(), l.raw_count as u64);
        let (files, bytes) = self.aggregate(path);
        let e = &mut self.entries[idx];
        e.mtime = meta.mtime;
        e.inode = meta.ino;
        let s = e.stats.as_mut().unwrap();
        s.files = files;
        s.bytes = bytes;
        s.child_count = count;
        (files, bytes)
    }

    fn walk_dir(&mut self, dir: &str, depth: usize, parent: Option<String>) -> DirStats {
        let idx = self.dir_entry(dir, parent, depth, "folder", 0);
        let mut stats = DirStats::default();
        let Some(l) = self.listings.get(dir) else { return stats };
        if !l.ok {
            return stats;
        }
        let meta = l.meta.unwrap();
        self.entries[idx].mtime = meta.mtime;
        self.entries[idx].inode = meta.ino;
        if l.children.iter().any(|c| c.name == "pyvenv.cfg") {
            let count = l.raw_count as u64;
            let (files, bytes) = self.aggregate(dir);
            stats.files = files;
            stats.bytes = bytes;
            stats.child_count = count;
            let e = &mut self.entries[idx];
            e.aggregate = 1;
            e.cls = "vendor";
            e.stats = Some(stats.clone());
            return stats;
        }
        // take the listing out so that children can borrow self mutably; put back afterwards
        let l = self.listings.remove(dir).unwrap();
        let opts = self.opts;
        for c in &l.children {
            if !opts.keep(dir, &c.name) {
                continue;
            }
            if PROJECT_MARKERS.contains(&c.name.as_str()) {
                stats.markers.push(c.name.clone());
            }
            stats.child_count += 1;
            let p = join(dir, &c.name);
            match c.kind {
                Kind::Symlink => {
                    if let (Some(m), Some(t)) = (c.meta, &c.link) {
                        self.entries.push(Entry {
                            path: p, parent: Some(dir.to_string()), name: c.name.clone(), kind: "symlink", ext: String::new(),
                            cls: "other", lang: None, size: 0, mtime: m.mtime, inode: m.ino, depth: depth + 1, aggregate: 0,
                            link_target: Some(t.clone()), stats: None,
                        });
                    }
                }
                Kind::Dir => {
                    if opts.vendor_names.contains(&c.name) {
                        let (f, b) = self.vendor(&p, dir, depth + 1);
                        stats.files += f;
                        stats.bytes += b;
                    } else {
                        let s = self.walk_dir(&p, depth + 1, Some(dir.to_string()));
                        stats.files += s.files;
                        stats.bytes += s.bytes;
                        stats.data_files += s.data_files;
                        stats.media_files += s.media_files;
                        stats.code_files += s.code_files;
                        stats.doc_files += s.doc_files;
                    }
                }
                Kind::File => {
                    if let Some(m) = c.meta {
                        let fc = classify_file(&c.name, &opts.secrets);
                        stats.files += 1;
                        stats.bytes += m.size;
                        if is_data_class(fc.cls) || fc.ext == "txt" {
                            stats.data_files += 1;
                        }
                        if is_media_class(fc.cls) {
                            stats.media_files += 1;
                        }
                        if fc.cls == "code" {
                            stats.code_files += 1;
                        }
                        if fc.cls == "doc" {
                            stats.doc_files += 1;
                        }
                        self.entries.push(Entry {
                            path: p, parent: Some(dir.to_string()), name: c.name.clone(), kind: "file", ext: fc.ext, cls: fc.cls,
                            lang: fc.lang, size: m.size, mtime: m.mtime, inode: m.ino, depth: depth + 1, aggregate: 0,
                            link_target: None, stats: None,
                        });
                    }
                }
                Kind::Other => {}
            }
        }
        // a `.git` directory is excluded from the listing above, so look at the raw names
        if stats.markers.is_empty() && l.children.iter().any(|c| c.name == ".git") {
            stats.markers.push(".git".into());
        }
        if self.keep_listings {
            self.listings.insert(dir.to_string(), l);
        }
        let e = &mut self.entries[idx];
        e.cls = classify_dir(&stats, opts.dump_min_files, opts.dump_data_share);
        e.stats = Some(stats.clone());
        stats
    }
}

pub fn walk(opts: &Options, progress: &(dyn Fn(usize) + Sync)) -> Vec<Entry> {
    let roots: Vec<String> = opts.roots.iter().filter(|r| !opts.excluded_root(r)).cloned().collect();
    let listings = list_all(opts, &roots, progress);
    let overlap = roots.iter().enumerate().any(|(i, a)| {
        roots.iter().enumerate().any(|(j, b)| i != j && (a == b || b.starts_with(&join(a, ""))))
    });
    let mut b = Builder { opts, listings, keep_listings: overlap, entries: Vec::new() };
    for root in &roots {
        let depth = root.split('/').count() - 1;
        let parent = if opts.configured_roots.contains(root) { None } else { Some(dirname(root)) };
        b.walk_dir(root, depth, parent);
    }
    b.entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("/"), "/");
        assert_eq!(basename("/a/b"), "b");
        assert_eq!(basename("/"), "");
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(resolve("/a/b", "../c/./d"), "/a/c/d");
        assert_eq!(resolve("/a", "../../x"), "/x");
    }
}
