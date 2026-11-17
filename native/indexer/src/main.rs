// vb-indexer: native helper for Visual Brain indexing.
//
//   vb-indexer --version          → {"name":"vb-indexer","version":"…","protocol":1}
//   vb-indexer walk < request.json → NDJSON on stdout:
//       {"t":"progress","done":N}            every 2000 entries listed
//       {"t":"entry", …Entry of scan.ts…}    parent before children
//       {"t":"end","count":N,"ms":M}         last line; missing ⇒ the caller falls back to the TypeScript walker
//
// Errors go to stderr with a non-zero exit code. The binary never writes to the filesystem.

mod classify;
mod walk;

use classify::Glob;
use serde::{Deserialize, Serialize};
use std::io::{self, BufWriter, Read, Write};
use std::sync::Mutex;
use std::time::Instant;

const PROTOCOL: u32 = 1;
const DEFAULT_THREADS: usize = 4;
const MAX_THREADS: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalkRequest {
    protocol: u32,
    roots: Vec<String>,
    #[serde(default)]
    configured_roots: Vec<String>,
    #[serde(default)]
    exclude_paths: Vec<String>,
    #[serde(default)]
    exclude_names: Vec<String>,
    #[serde(default)]
    vendor_names: Vec<String>,
    #[serde(default)]
    secret_patterns: Vec<String>,
    dump_min_files: f64,
    dump_data_share: f64,
    #[serde(default)]
    threads: Option<usize>,
}

#[derive(Serialize)]
struct Tagged<'a, T: Serialize> {
    t: &'a str,
    #[serde(flatten)]
    body: T,
}

fn fail(msg: &str) -> ! {
    eprintln!("vb-indexer: {msg}");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("version") => {
            println!(
                "{}",
                serde_json::json!({ "name": "vb-indexer", "version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL })
            );
        }
        Some("walk") => {
            // phase 2 recurses once per directory level; macOS PATH_MAX (1024) caps the depth near 512, far below 32 MiB
            let h = std::thread::Builder::new().stack_size(32 << 20).spawn(run_walk).expect("thread");
            if h.join().is_err() {
                fail("walk panicked");
            }
        }
        _ => fail("usage: vb-indexer --version | vb-indexer walk < request.json"),
    }
}

fn run_walk() {
    let t0 = Instant::now();
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        fail("cannot read stdin");
    }
    let req: WalkRequest = serde_json::from_str(&input).unwrap_or_else(|e| fail(&format!("bad request: {e}")));
    if req.protocol != PROTOCOL {
        fail(&format!("protocol {} not supported (expected {PROTOCOL})", req.protocol));
    }
    let threads = std::env::var("VB_INDEXER_THREADS").ok().and_then(|v| v.parse().ok()).or(req.threads).unwrap_or(DEFAULT_THREADS);
    let opts = walk::Options {
        roots: req.roots,
        configured_roots: req.configured_roots,
        exclude_paths: req.exclude_paths.into_iter().collect(),
        exclude_names: req.exclude_names.into_iter().collect(),
        vendor_names: req.vendor_names.into_iter().collect(),
        secrets: req.secret_patterns.iter().map(|g| Glob::new(g)).collect(),
        dump_min_files: req.dump_min_files,
        dump_data_share: req.dump_data_share,
        threads: threads.clamp(1, MAX_THREADS),
    };
    let out = Mutex::new(BufWriter::with_capacity(1 << 16, io::stdout()));
    let progress = |done: usize| {
        let mut w = out.lock().unwrap();
        let _ = writeln!(w, "{{\"t\":\"progress\",\"done\":{done}}}");
        let _ = w.flush();
    };
    let entries = walk::walk(&opts, &progress);
    let mut w = out.into_inner().unwrap();
    for e in &entries {
        serde_json::to_writer(&mut w, &Tagged { t: "entry", body: e }).unwrap_or_else(|_| fail("write failed"));
        if w.write_all(b"\n").is_err() {
            fail("write failed");
        }
    }
    let end = serde_json::json!({ "t": "end", "count": entries.len(), "ms": t0.elapsed().as_millis() as u64 });
    if writeln!(w, "{end}").and_then(|_| w.flush()).is_err() {
        fail("write failed");
    }
}
