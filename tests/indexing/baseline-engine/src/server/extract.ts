// Deterministic content extraction: references, identifiers and terms found in ONE file.
// Pure module: no filesystem, no database. Resolution of the references to nodes happens in graph.ts.
//
// Contract (do not change the exported names or shapes without updating graph.ts):
//   extract(input) -> ExtractResult
//
// Every reference carries the line and a short snippet: they become the evidence of the edge.

export interface ExtractInput {
  path: string;                 // absolute path of the file
  content: string;              // text content (already decoded as UTF-8)
  ext: string;                  // lower-case extension without the dot ('' when none)
  cls: string;                  // file class from classify.ts: code | doc | config | notebook | data | log | other
  lang?: string | null;         // language from classify.ts when known (python, javascript, typescript, rust, shell, html, css, markdown, json, yaml, ...)
  projectRoot?: string | null;  // nearest project root, when known
}

export type RawRefKind = 'imports' | 'links' | 'refpath' | 'mention';

export interface RawRef {
  kind: RawRefKind;
  /** The target exactly as written in the file (module specifier, link target, path, file name). */
  target: string;
  line: number;                 // 1-based
  snippet: string;              // the line, trimmed, max ~160 chars
  /** How `target` must be resolved: relative to the file's directory, to the project root, absolute, or by file name. */
  relativeTo: 'file' | 'root' | 'absolute' | 'name';
}

export interface ExtractResult {
  lines: number;
  /** Rough complexity: functions + branches for code, headings + links for docs, keys for config. */
  complexity: number;
  refs: RawRef[];
  /** Rare identifiers worth matching across files: hex hashes, PR numbers, ticket keys, Slack ids, ... */
  identifiers: { token: string; line: number }[];
  /** Term frequencies for text similarity (lower-case, stop-words removed). */
  terms: Record<string, number>;
  /** Paths outside the indexed roots (e.g. ~/.hermes/..., /opt/...), for `external` edges. */
  externalRefs: { target: string; line: number; snippet: string }[];
  /** Bare package / module names imported (npm packages, pip modules, crates): technologies, not edges. */
  packages: string[];
}

// ---------------------------------------------------------------------------------------------
// Implementation of docs/EXTRACT_SPEC.md. One linear pass over the lines; every regex is compiled
// once at module level and is free of nested ambiguous quantifiers (no catastrophic backtracking).
// On each line the detectors run from the strongest to the weakest (imports > links > paths >
// mentions) and every match "consumes" its character span, so the same text never yields two refs.
// ---------------------------------------------------------------------------------------------

type RelTo = RawRef['relativeTo'];
type Resolved = { target: string; rel: RelTo } | { external: string };

const MAX_REFS = 500;
const MAX_EXTERNAL = 500;
const MAX_IDS = 200;
const MAX_TERMS = 2000;
const MAX_PACKAGES = 200;
const SNIPPET_MAX = 160;
const MAX_LINE_SCAN = 20000;   // characters of one line that are looked at (minified / base64 lines)

// --- extensions ------------------------------------------------------------------------------

const KNOWN_EXT = (
  'py pyw pyi ipynb js mjs cjs jsx ts mts cts tsx gs rs go java kt swift c h cpp cc hpp m mm rb php ' +
  'sh bash zsh fish ps1 sql r scala lua pl vue svelte dart cs ex exs hs clj cmake mk applescript scpt ' +
  'css scss less proto graphql md mdx rst txt tex html htm pdf doc docx odt pages rtf epub ppt pptx key ' +
  'json jsonc yaml yml toml ini cfg conf plist lock csv tsv jsonl ndjson xml parquet sqlite sqlite3 db ' +
  'pkl pickle npy npz xls xlsx xlsm ods numbers gz zip tar tgz 7z rar bz2 xz dmg pkg whl png jpg jpeg ' +
  'gif svg webp heic bmp tiff tif ico psd icns mp4 mov avi mkv webm m4v mp3 wav m4a aac flac ogg ttf ' +
  'otf woff woff2 log'
).split(' ');

// The regexes capture a generic extension and the sets decide: much faster than a 150-way alternation.
const KNOWN_EXT_SET = new Set(KNOWN_EXT);
// One-letter extensions (.c .h .m .r) are too noisy for bare file names in prose.
const MENTION_EXT_SET = new Set(KNOWN_EXT.filter((e) => e.length >= 2));

const LANG_BY_EXT: Record<string, string> = {
  py: 'python', pyw: 'python', pyi: 'python', ipynb: 'notebook',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', gs: 'appsscript',
  rs: 'rust', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', mk: 'make',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', txt: 'text', rst: 'rst',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
  plist: 'plist', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp',
  rb: 'ruby', php: 'php', sql: 'sql', lua: 'lua', r: 'r', pl: 'perl',
};

const SHEBANG_RE = /^#!.*?\b(python[\d.]*|node|deno|bun|bash|zsh|sh)\b/;

// --- language families -----------------------------------------------------------------------

const JS_LANGS = new Set(['javascript', 'typescript', 'appsscript', 'vue', 'svelte', 'html']);
const HTML_LANGS = new Set(['html', 'vue', 'svelte']);
const CSS_LANGS = new Set(['css', 'scss', 'less', 'html', 'vue', 'svelte']);
const SHELL_LANGS = new Set(['shell', 'make']);
const PROSE_LANGS = new Set(['markdown', 'text', 'rst', 'notebook']);
const HASH_COMMENT_LANGS = new Set(['python', 'shell', 'make', 'yaml', 'toml', 'ruby', 'r', 'perl', 'ini']);
const SLASH_COMMENT_LANGS = new Set([
  'javascript', 'typescript', 'appsscript', 'rust', 'go', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp',
  'dart', 'scala', 'php', 'objc', 'css', 'scss', 'less', 'vue', 'svelte',
]);
const DASH_COMMENT_LANGS = new Set(['sql', 'lua', 'haskell']);

// --- paths -----------------------------------------------------------------------------------

// Characters of an unquoted path: everything but whitespace, quotes, brackets and shell/format syntax.
const PCH = '[^\\s"\'`<>(){}\\[\\],;|*?\\\\:$%#=&]';

/** Home paths, absolute paths about this Mac, and `Desktop/...` (relative to the home). */
const ABS_RE = new RegExp(
  `(?<![\\w.~/$-])(?:~|\\$HOME|\\$\\{HOME\\})/${PCH}*` +
  `|(?<![\\w.-])/(?:Users|home)/${PCH}+` +
  `|(?<![\\w.~/-])/(?:opt|usr/local|Applications|Library|Volumes|System|private|etc|tmp|var)/${PCH}*` +
  `|(?<![\\w./~$@-])Desktop/${PCH}+`,
  'g',
);
const EXTERNAL_ABS = ['/opt/', '/usr/local/', '/Applications/', '/Library/', '/Volumes/', '/System/', '/private/', '/etc/', '/tmp/', '/var/'];
const HOME_PREFIX_RE = /^(?:~|\$HOME|\$\{HOME\})(?=\/)/;
const USER_HOME_RE = /^(?:\/(?:Users|home)\/[^/]+|~)((?:\/.*)?)$/;
const HOME_OF_RE = /^(\/(?:Users|home)\/[^/]+)\//;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const URL_RE = /\b(?:https?|ftp|ssh|git|s3|gs|wss?):\/\/[^\s"'<>)\]]+|\bwww\.[^\s"'<>)\]]+/gi;

/** Python pathlib chain: `X / "Desktop" / "a" / "b.py"`. */
const PATHLIB_RE = /\/\s*[rRuU]?(["'])Desktop((?:\/[^"'\n]*)?)\1((?:\s*\/\s*[rRuU]?(["'])[^"'\n]*\4)*)/g;
/** Join calls: `os.path.join(home, "Desktop", "a")`, `path.join(os.homedir(), 'Desktop', 'a')`, `.join("Desktop").join("a")`. */
const JOIN_RE = /[(,]\s*(["'])Desktop((?:\/[^"'\n]*)?)\1((?:\s*(?:,|\)\s*\.join(?:path)?\()\s*(["'])[^"'\n]*\4)*)/g;
const JOIN_CTX_RE = /join|Path\s*\(|resolve\s*\(/;
const QUOTED_SEG_RE = /(["'])([^"'\n]*)\1/g;

const SEG = '\\.?[\\p{L}\\p{N}_@+-][\\p{L}\\p{N}_.@+-]*';
const FILE_TAIL = `\\.([\\p{L}\\p{N}]{1,11})(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}])`;
/** Plausible relative paths `a/b/c.ext` (at least one slash; group 1 = extension, checked against KNOWN_EXT_SET). */
const REL_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.\\/~$@%\\\\-])(?:(?:\\.{1,2}\\/)+(?:${SEG}\\/)*|(?:${SEG}\\/)+)${SEG}${FILE_TAIL}`,
  'gu',
);
const DOMAIN_SEG_RE = /^(?:[\p{L}\p{N}-]+\.)+(?:com|org|net|io|it|dev|app|ai|co|eu|gov|edu|me|info|biz|us|uk|de|fr|es|ch)\//iu;

/** File names cited without a path (group 1 = extension, checked against MENTION_EXT_SET). */
const MENTION_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.\\/~$@%\\\\-])[\\p{L}\\p{N}_][\\p{L}\\p{N}_.+@-]*\\.([\\p{L}\\p{N}]{2,11})(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}])`,
  'gu',
);
const MENTION_DENY = new Set([
  'node.js', 'next.js', 'nuxt.js', 'vue.js', 'react.js', 'angular.js', 'ember.js', 'backbone.js', 'd3.js',
  'three.js', 'chart.js', 'express.js', 'alpine.js', 'solid.js', 'p5.js', 'console.log', 'logger.log',
  'logging.log', 'self.db', 'this.db', 'res.json', 'response.json', 'req.json', 'request.json', 'r.json',
]);
const HAS_LETTER_RE = /\p{L}/u;

const BT_RE = /`([^`\n]{2,300})`/g;
const BT_PATH_RE = /^[\p{L}\p{N}_.@+~$/-][\p{L}\p{N}_.@+~${}/-]*$/u;
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;

// --- imports ---------------------------------------------------------------------------------

const JS_STMT_RE = /^\s*(?:import|export)\b|\}\s*from\s*["']/;
const JS_FROM_RE = /\bfrom\s*(["'])([^"'\n]+)\1/g;
const JS_SIDE_RE = /^\s*import\s*(["'])([^"'\n]+)\1/;
const JS_CALL_RE = /\b(?:import|require)\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g;

const PY_FROM_RE = /^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+(.*)$/;
const PY_IMPORT_RE = /^\s*import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)/;
const PY_NAME_RE = /^[A-Za-z_]\w*$/;
const NB_LINE_RE = /^\s*"((?:[^"\\]|\\.)*)",?\s*$/;
const NB_RUN_RE = /^\s*%run\s+(?:-\w+\s+)*("[^"\n]+"|'[^'\n]+'|\S+)/;

const RS_MOD_RE = /^\s*(?:pub(?:\([^)\n]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/;
const RS_USE_RE = /^\s*(?:pub(?:\([^)\n]*\))?\s+)?use\s+([^;]+)/;
const RS_EXTERN_RE = /^\s*extern\s+crate\s+([A-Za-z_]\w*)/;
const RS_IDENT_RE = /^[A-Za-z_]\w*$/;
const RS_SKIP = new Set(['std', 'core', 'alloc', 'self', 'super', 'crate']);

const SH_ARG = `("[^"\\n]+"|'[^'\\n]+'|[^\\s;&|<>()"'\`]+)`;
const SH_SOURCE_RE = new RegExp(`(?:^\\s*|[;&|]\\s*|\\b(?:then|do|else)\\s+)(?:source|\\.)\\s+${SH_ARG}`, 'g');
const SH_RUN_RE = new RegExp(
  `(?:^|[\\s;&|(\`/!"'])(?:python[\\d.]*|node|bash|zsh|sh|deno\\s+run|bun(?:\\s+run)?|tsx|ts-node|uv\\s+run)\\s+(?:-{1,2}[\\w-]+(?:=\\S*)?\\s+)*${SH_ARG}`,
  'g',
);
const SCRIPT_EXT_RE = /\.(?:py|js|mjs|cjs|ts|mts|sh|bash|zsh)$/;
const SH_VAR_PREFIX_RE = /^\$\{?(?!HOME\b)[A-Za-z_]\w*\}?\//;

const HTML_ATTR_RE = /\b(src|href)\s*=\s*(["'])([^"'\n]*)\2/gi;
const CSS_IMPORT_RE = /@(?:import|use|forward)\s+(?:url\(\s*)?(["']?)([^"'()\s;]+)\1/g;
const CSS_URL_RE = /\burl\(\s*(["']?)([^"'()\s]+)\1\s*\)/g;

// --- links -----------------------------------------------------------------------------------

// bounded quantifiers: a line full of `[` must not cost quadratic time
const MD_LINK_RE = /!?\[[^\]\n]{0,300}\]\(\s*(<[^>\n]{0,500}>|[^)\s]{1,500})(?:\s+(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'))?\s*\)/g;
const MD_DEF_RE = /^\s{0,3}\[([^\]\n]{1,300})\]:\s*(<[^>\n]{0,500}>|\S+)/;
const WIKI_RE = /!?\[\[([^\]\n|#]{1,200})(?:[#|][^\]\n]{0,200})?\]\]/g;

// --- identifiers -----------------------------------------------------------------------------

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE = /(?<![#\w])[0-9a-f]{8,40}(?!\w)/g;
const SLACK_ID_RE = /(?<![\w-])[CDGUWTBF][A-Z0-9]{8,10}(?![\w-])/g;
const SLACK_TS_RE = /(?<![\w.])\d{10}\.\d{6}(?![\w.])/g;
const SLACK_PERMALINK_RE = /\/p(\d{10})(\d{6})\b/g;
const PR_RE = /\b(?:PR|[Pp]ull [Rr]equest)\s*#\s*(\d{1,6})\b|\/pulls?\/(\d{1,6})\b/g;
const ISSUE_RE = /\b[Ii]ssues?\s*#\s*(\d{1,6})\b|\/issues\/(\d{1,6})\b/g;
const HASHNUM_RE = /(?<![\w&#])#(\d{1,6})\b/g;
const PR_CTX_RE = /\bPR\b|[Pp]ull [Rr]equest/;
const ISSUE_CTX_RE = /\b[Ii]ssues?\b/;
const KEY_RE = /(?<![\w-])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![\w-])/g;
const KEY_DENY = new Set((
  'UTF ISO SHA MD RFC GPT COVID CVE ES ECMA TLS SSL HTTP HTTPS AES RSA CP WIN LATIN ASCII PEP IEC EN DIN ' +
  'UNI IEEE ANSI IPV SARS MP KB MB GB TB PDF CSV JSON XML HTML CSS JS TS PY API SDK CLI URL URI ID NO NR ' +
  'ART DL DPR DM DLGS CCNL INPS INAIL IVA IRPEF IRAP TFR DURC'
).split(' '));
const HAS_DIGIT_RE = /\d/;
const BLOB_RE = /[A-Za-z0-9+/=]{200,}/;

// --- terms -----------------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}]{4,}/gu;   // shorter words never become terms
const INNER_UPPER_RE = /.\p{Lu}/u;
const PIECE_RE = /\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})|\p{Lo}+/gu;
const STOP = new Set((
  // Italian
  'abbia abbiamo adesso affinché agli alla alle allo allora altra altre altri altro anche ancora avere aveva ' +
  'avevano bene buona buono cioè circa come comunque contro cosa cose così dalla dalle dallo dagli degli della ' +
  'delle dello dentro deve devono dopo dove dovrebbe dunque ecco essa esse essere essi esso fare farlo fatto ' +
  'fino fuori già hanno infatti inoltre insieme invece loro mentre meno molta molte molti molto negli nella ' +
  'nelle nello nemmeno neanche nessun nessuna nessuno niente nostra nostre nostri nostro nulla oggi ogni oltre ' +
  'oppure ossia ovvero perché però piuttosto poco poiché potrebbe prima proprio può quale quali qualche ' +
  'qualcosa quando quanta quante quanti quanto quasi quella quelle quelli quello questa queste questi questo ' +
  'quindi sarà sarebbe sempre senza siamo siano solo sono sopra sotto stata state stati stato stessa stesse ' +
  'stessi stesso sugli sulla sulle sullo tale tali tanto tante tanti tranne tutta tutte tutti tutto verso ' +
  'vengono viene volta vostra vostre vostri vostro ' +
  // English
  'about above after again against also although among another anyone anything around because been before ' +
  'being below between both cannot could does doing done down during each either else even ever every from ' +
  'further have having here hers herself himself however into itself just like made make many might more most ' +
  'much must myself neither never once only other ours ourselves over same shall should some such than that ' +
  'their theirs them themselves then there therefore these they this those through thus together under until ' +
  'upon very want what when where whether which while whom whose will with within without would your yours ' +
  'yourself yourselves ' +
  // language keywords and ubiquitous builtins (python, js/ts, rust, shell, html/css, sql)
  'none true false elif pass break continue lambda yield async await global nonlocal assert raise except ' +
  'finally import class return print range isinstance enumerate dict list tuple super self init ' +
  'const function export default extends constructor null undefined typeof instanceof switch case throw ' +
  'catch delete void static interface type enum implements private public protected readonly declare ' +
  'namespace module require string number boolean object symbol bigint unknown never keyof infer satisfies ' +
  'console length prototype arguments impl struct trait match loop move unsafe extern crate where some okay ' +
  'option result unwrap clone into iter collect usize isize bool char done esac local echo exit source shift ' +
  'read test html head body span style script href width height color margin padding display border font ' +
  'size auto solid flex center left right bottom important rgba background position relative absolute block ' +
  'inline grid align items justify select insert update create table values join inner order group having ' +
  'limit primary foreign references index integer real exists http https'
).split(/\s+/));

// --- complexity ------------------------------------------------------------------------------

const CODE_CX_RE = /\b(?:def|function|fn|class|impl|if|for|while|match|case|try|catch|except)\b|=>/g;
const MD_HEADING_RE = /^#{1,6}\s+\S/;
const MD_FENCE_RE = /^\s*(?:```|~~~)/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const HTML_CX_RE = /<h[1-6][\s>]|<a\s|<table[\s>]/gi;
const YAML_TOP_RE = /^(?:"[^"\n]*"|'[^'\n]*'|[^\s#\-?:{}[\]][^:\n]*?)\s*:(?:\s|$)/;
const INI_SECTION_RE = /^\s*\[[^\]\n]+\]/;
const INI_KEY_RE = /^[A-Za-z0-9_."-]+\s*[=:]/;
const PLIST_KEY_RE = /^(\s*)<key>/;

// --- python modules that are packages (stdlib + common third-party), not files --------------

const PY_PACKAGES = new Set((
  'abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar cgi cmath codecs collections ' +
  'colorsys concurrent configparser contextlib contextvars copy csv ctypes curses dataclasses datetime decimal ' +
  'difflib dis doctest email encodings enum errno faulthandler filecmp fileinput fnmatch fractions ftplib ' +
  'functools gc getopt getpass gettext glob graphlib gzip hashlib heapq hmac html http imaplib importlib ' +
  'inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox math mimetypes mmap ' +
  'multiprocessing numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib pprint ' +
  'profile pstats pty queue quopri random re readline reprlib resource sched secrets select selectors shelve ' +
  'shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct ' +
  'subprocess sys sysconfig tarfile tempfile termios textwrap threading time timeit tkinter token tokenize ' +
  'tomllib trace traceback tty types typing unicodedata unittest urllib uuid venv warnings wave weakref ' +
  'webbrowser winreg wsgiref xml xmlrpc zipfile zipimport zlib zoneinfo cProfile distutils setuptools ' +
  'pkg_resources pip wheel typing_extensions ' +
  'numpy pandas polars pyarrow scipy sklearn statsmodels matplotlib seaborn plotly bokeh altair openpyxl ' +
  'xlrd xlwt xlsxwriter pyxlsb odf docx pptx PyPDF2 pypdf pdfplumber fitz pymupdf reportlab fpdf weasyprint ' +
  'pdfkit camelot tabula pytesseract PIL cv2 imageio requests httpx aiohttp urllib3 certifi websockets ' +
  'websocket bs4 lxml html5lib selenium playwright scrapy flask django fastapi starlette uvicorn gunicorn ' +
  'werkzeug jinja2 markupsafe pydantic attr attrs marshmallow sqlalchemy alembic psycopg psycopg2 pymysql ' +
  'pymongo redis duckdb celery yaml ruamel toml tomli tomlkit dotenv click typer rich tqdm colorama tabulate ' +
  'pytest hypothesis mock dateutil pytz tzdata holidays babel arrow pendulum regex chardet charset_normalizer ' +
  'unidecode jsonschema orjson ujson simplejson msgpack boto3 botocore google googleapiclient gspread ' +
  'oauth2client oauthlib requests_oauthlib msal jwt cryptography Crypto nacl bcrypt paramiko fabric invoke ' +
  'docker kubernetes anthropic openai tiktoken langchain llama_index chromadb faiss transformers torch ' +
  'tensorflow keras jax nltk spacy gensim networkx sympy numba joblib dask pyspark IPython ipywidgets ' +
  'notebook streamlit gradio slack_sdk slack_bolt notion_client hubspot simple_salesforce feedparser ' +
  'schedule apscheduler watchdog psutil pyautogui pynput objc Foundation AppKit Quartz applescript mcp ' +
  'fastmcp markdown mistune frontmatter html2text markdownify mammoth docx2txt qrcode tenacity backoff ' +
  'sentry_sdk loguru structlog pexpect sh plumbum xmltodict defusedxml'
).split(/\s+/));

// --- privacy: tax-code-shaped and secret-shaped substrings -----------------------------------
// They never reach `terms` or `identifiers` (the line is blanked first) and are masked in snippets.

const MASK = '«***»';
const CF_RE = /[A-Za-z]{6}[0-9]{2}[A-Za-z][0-9]{2}[A-Za-z][0-9]{3}[A-Za-z]/g;
const SECRET_RE = new RegExp([
  '\\beyJ[A-Za-z0-9_-]{6,}(?:\\.[A-Za-z0-9_-]+){0,2}',      // JWT
  '\\bxox[a-z]-[A-Za-z0-9-]+',                              // Slack tokens
  '\\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{4,}',          // GitHub tokens
  '\\bsk-[A-Za-z0-9_-]{8,}',                                // API keys sk-...
  '\\b(?:AKIA|ASIA)[A-Z0-9]{12,}',                          // AWS access keys
  '(?<![A-Za-z0-9])[0-9a-fA-F]{41,}(?![A-Za-z0-9])',        // hex runs longer than a commit id
].join('|'), 'g');
const B64_RUN_RE = /[A-Za-z0-9+/=_-]{33,}/g;
const B64_STRETCH_RE = /[A-Za-z0-9+]{16,}/g;
const PURE_HEX_RE = /^[0-9a-fA-F]+$/;
const UPPER_RE = /[A-Z]/;
const LOWER_RE = /[a-z]/;
const ASCII_LETTER_RE = /[A-Za-z]/;

/** A base64-ish run: a separator-free stretch of 16+ chars that mixes digits and letters like random data. */
function randomLooking(run: string): boolean {
  B64_STRETCH_RE.lastIndex = 0;
  for (let m = B64_STRETCH_RE.exec(run); m; m = B64_STRETCH_RE.exec(run)) {
    const s = m[0];
    if (!HAS_DIGIT_RE.test(s)) continue;
    if (s.length <= 40 && PURE_HEX_RE.test(s)) continue;   // commit ids and fingerprints are identifiers (spec §5)
    if (UPPER_RE.test(s) && LOWER_RE.test(s)) return true;
    if (s.length >= 24 && ASCII_LETTER_RE.test(s)) return true;
  }
  return false;
}

/** Sorted, merged [start, end) pairs of the tax-code-shaped and secret-shaped substrings of `text`. */
function sensitiveSpans(text: string): number[] {
  const raw: number[] = [];
  if (!HAS_DIGIT_RE.test(text)) return raw;   // tax codes, tokens and keys all carry digits
  let m: RegExpExecArray | null;
  CF_RE.lastIndex = 0;
  while ((m = CF_RE.exec(text))) raw.push(m.index, m.index + m[0].length);
  SECRET_RE.lastIndex = 0;
  while ((m = SECRET_RE.exec(text))) raw.push(m.index, m.index + m[0].length);
  if (text.length >= 33) {
    B64_RUN_RE.lastIndex = 0;
    while ((m = B64_RUN_RE.exec(text))) if (randomLooking(m[0])) raw.push(m.index, m.index + m[0].length);
  }
  if (raw.length <= 2) return raw;
  const order: number[] = [];
  for (let i = 0; i < raw.length; i += 2) order.push(i);
  order.sort((a, b) => raw[a] - raw[b]);
  const out: number[] = [];
  for (const i of order) {
    const n = out.length;
    if (n > 0 && raw[i] <= out[n - 1]) out[n - 1] = Math.max(out[n - 1], raw[i + 1]);
    else out.push(raw[i], raw[i + 1]);
  }
  return out;
}

/** Same length as `line`, with the given spans replaced by spaces. */
function blankSpans(line: string, spans: number[]): string {
  let out = '';
  let prev = 0;
  for (let i = 0; i < spans.length; i += 2) {
    out += line.slice(prev, spans[i]) + ' '.repeat(spans[i + 1] - spans[i]);
    prev = spans[i + 1];
  }
  return out + line.slice(prev);
}

/** The line, trimmed and masked, cut to SNIPPET_MAX characters around position `at` when longer. */
function snippetOf(line: string, at: number, sens: number[]): string {
  let text = line;
  let pos = at;
  if (sens.length > 0) {
    let out = '';
    let prev = 0;
    let shift = 0;
    for (let i = 0; i < sens.length; i += 2) {
      const s = sens[i];
      const e = sens[i + 1];
      out += line.slice(prev, s) + MASK;
      if (e <= at) shift += e - s - MASK.length;
      else if (s < at) shift += at - s;
      prev = e;
    }
    text = out + line.slice(prev);
    pos = Math.max(0, at - shift);
  }
  const t = text.trim();
  if (t.length <= SNIPPET_MAX) return t;
  const start = Math.max(0, Math.min(pos - 40, text.length - (SNIPPET_MAX - 2)));
  const end = start + SNIPPET_MAX - 2;
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// --- per-file state --------------------------------------------------------------------------

interface Mode {
  lang: string;
  js: boolean;
  py: boolean;
  rust: boolean;
  shell: boolean;
  html: boolean;
  css: boolean;
  md: boolean;            // markdown links, wiki-links
  notebook: boolean;
  backtick: boolean;      // backtick paths (not where backticks are code syntax)
  codeMention: boolean;   // in code, bare file names count only in comments or at the start of a string
  comment: string[];      // line-comment prefixes
  trailing: RegExp | null;
}

interface Ctx {
  home: string | null;
  mode: Mode;
  refs: RawRef[];
  refKeys: Set<string>;
  externalRefs: ExtractResult['externalRefs'];
  extKeys: Set<string>;
  packages: Set<string>;
  mentioned: Set<string>;
  identifiers: ExtractResult['identifiers'];
  idTokens: Set<string>;
  docLinks: number;
  fence: boolean;         // inside a fenced code block (markdown)
  line: string;           // current line (the decoded source line for notebooks)
  lineNo: number;
  spans: number[];        // consumed [start, end) pairs of the current line
  sens: number[];         // sensitive spans of the current line
}

const CONFIG_LANGS = new Set(['json', 'yaml', 'toml', 'ini', 'plist']);
const HASH_TRAIL_RE = /(?:^|\s)#/;
const SLASH_TRAIL_RE = /(?:^|[\s;{}(),])\/\//;

function modeFor(input: ExtractInput, firstLine: string): Mode {
  let lang = (input.lang ?? '').toLowerCase() || LANG_BY_EXT[input.ext] || '';
  if (!lang) {
    const sb = SHEBANG_RE.exec(firstLine);
    if (sb) {
      const b = sb[1];
      lang = b.startsWith('python') ? 'python' : b === 'node' || b === 'deno' || b === 'bun' ? 'javascript' : 'shell';
    }
  }
  if (input.ext === 'ipynb' || input.cls === 'notebook') lang = 'notebook';
  const notebook = lang === 'notebook';
  const js = JS_LANGS.has(lang);
  const shell = SHELL_LANGS.has(lang);
  const hash = HASH_COMMENT_LANGS.has(lang);
  const slash = SLASH_COMMENT_LANGS.has(lang);
  return {
    lang,
    js,
    py: lang === 'python' || notebook,
    rust: lang === 'rust',
    shell,
    html: HTML_LANGS.has(lang),
    css: CSS_LANGS.has(lang),
    md: PROSE_LANGS.has(lang) || (input.cls === 'doc' && !HTML_LANGS.has(lang)),
    notebook,
    backtick: !(js || shell || lang === 'go'),
    codeMention: input.cls === 'code' && !notebook,
    comment: hash ? ['#'] : slash ? ['//', '/*', '*'] : DASH_COMMENT_LANGS.has(lang) ? ['--']
      : lang === 'html' || lang === 'xml' || lang === 'markdown' ? ['<!--'] : [],
    trailing: hash ? HASH_TRAIL_RE : slash ? SLASH_TRAIL_RE : null,
  };
}

function homeOf(path: string): string | null {
  const m = HOME_OF_RE.exec(path);
  if (m) return m[1];
  const i = path.indexOf('/Desktop/');
  return i > 0 ? path.slice(0, i) : null;
}

function overlaps(c: Ctx, s: number, e: number): boolean {
  const sp = c.spans;
  for (let i = 0; i < sp.length; i += 2) if (s < sp[i + 1] && e > sp[i]) return true;
  return false;
}

function inSpans(spans: number[], at: number): boolean {
  for (let i = 0; i < spans.length; i += 2) if (at >= spans[i] && at < spans[i + 1]) return true;
  return false;
}

function addRef(c: Ctx, kind: RawRefKind, target: string, rel: RelTo, s: number, e: number): void {
  c.spans.push(s, e);
  if (!target || c.refs.length >= MAX_REFS) return;
  const key = `${kind}\u0000${target}\u0000${c.lineNo}`;
  if (c.refKeys.has(key)) return;
  c.refKeys.add(key);
  c.refs.push({ kind, target, line: c.lineNo, snippet: snippetOf(c.line, s, c.sens), relativeTo: rel });
}

function addExternal(c: Ctx, target: string, s: number, e: number): void {
  c.spans.push(s, e);
  if (c.externalRefs.length >= MAX_EXTERNAL) return;
  const key = `${target}\u0000${c.lineNo}`;
  if (c.extKeys.has(key)) return;
  c.extKeys.add(key);
  c.externalRefs.push({ target, line: c.lineNo, snippet: snippetOf(c.line, s, c.sens) });
}

function addResolved(c: Ctx, kind: RawRefKind, r: Resolved | null, s: number, e: number): void {
  if (r === null) c.spans.push(s, e);
  else if ('external' in r) addExternal(c, r.external, s, e);
  else addRef(c, kind, r.target, r.rel, s, e);
}

function addPackage(c: Ctx, name: string): void {
  if (name && c.packages.size < MAX_PACKAGES) c.packages.add(name);
}

// --- path normalisation ----------------------------------------------------------------------

const TRAIL_PUNCT = ',;:!?)]}>\'"`/';
const QUERY_RE = /[?#]/;
const PCT_RE = /%[0-9A-Fa-f]{2}/;
const MULTI_SLASH_RE = /\/{2,}/g;
const LEADING_SLASHES_RE = /^\/+/;

/** Strips the punctuation that prose and code leave after a path (and a trailing slash). */
function cleanPath(raw: string): string {
  const s = raw.trim();
  let e = s.length;
  while (e > 1) {
    const ch = s[e - 1];
    if (TRAIL_PUNCT.includes(ch)) { e--; continue; }
    if (ch === '.' && s[e - 2] !== '.' && s[e - 2] !== '/') { e--; continue; }
    break;
  }
  return s.slice(0, e);
}

/**
 * Classifies a path as written: Desktop paths (home forms normalised to the user's home) are absolute
 * refs; other paths in the home or about this Mac are external; `./` and `../` are relative to the
 * file; a leading `/` means `slash`; anything else is relative to `relDefault`.
 */
function resolvePath(raw: string, home: string | null, relDefault: RelTo, slash: RelTo): Resolved | null {
  let p = cleanPath(raw);
  if (p.startsWith('file://')) p = p.slice(7);
  p = p.replace(MULTI_SLASH_RE, '/');
  if (!p || p === '/' || p === '.' || p === '..' || p === '~') return null;
  const hp = HOME_PREFIX_RE.exec(p);
  if (hp) p = (home ?? '~') + p.slice(hp[0].length);
  else if (p.startsWith('Desktop/')) p = `${home ?? '~'}/${p}`;
  const um = USER_HOME_RE.exec(p);
  if (um) {
    const rest = um[1];
    if (rest.startsWith('/Desktop/')) return rest.length > 9 ? { target: p, rel: 'absolute' } : null;
    if (rest === '' || rest === '/' || rest === '/Desktop') return null;   // the home or the Desktop itself
    return { external: p };
  }
  if (p.startsWith('/')) {
    if (EXTERNAL_ABS.some((x) => p.startsWith(x))) return { external: p };
    if (slash === 'absolute') return { target: p, rel: 'absolute' };
    const t = p.replace(LEADING_SLASHES_RE, '');
    return t ? { target: t, rel: slash } : null;
  }
  if (p.startsWith('./') || p.startsWith('../')) return { target: p, rel: 'file' };
  return { target: p, rel: relDefault };
}

/** A link / src / url() target: null for URLs, anchors and templates; query and anchor removed. */
function localTarget(raw: string): string | null {
  let t = raw.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim();
  if (!t || t.startsWith('#') || t.startsWith('//') || t.includes('{{') || t.includes('{%') || t.includes('${') || t.includes('<%')) return null;
  if (t.startsWith('file://')) t = t.slice(7);
  else if (SCHEME_RE.test(t)) return null;
  const q = t.search(QUERY_RE);
  if (q >= 0) t = t.slice(0, q);
  if (PCT_RE.test(t)) {
    try { t = decodeURI(t); } catch { /* keep as written */ }
  }
  return t || null;
}

// --- small helpers -----------------------------------------------------------------------------

const NEWLINE_RE = /\r\n|\n|\r/;
const NON_SPACE_RE = /\S/;
const DOT_RE = /\./g;
const WS_RE = /\s+/;
const WS_GLOBAL_RE = /\s+/g;
const PKG_SCHEME_RE = /^(?:node|npm|jsr):/;
const ALIAS_RE = /^(?:[~#]|@\/)/;
const PY_NAMES_JUNK_RE = /[()\\]/g;
const RS_EDGE_COLONS_RE = /^::|::$/g;
const JSON_KEY_RE = /^(\s*)"[^"\n]+"\s*:/;
const LEADING_WS_RE = /^\s/;
const HEX_LETTER_RE = /[a-f]/;

function stripQuotes(s: string): string {
  const t = s.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}

/** True when position `at` of the current line is inside a line comment. */
function inComment(c: Ctx, at: number): boolean {
  const t = c.line.trimStart();
  for (const p of c.mode.comment) if (t.startsWith(p)) return true;
  const tr = c.mode.trailing;
  if (tr === null) return false;
  const m = tr.exec(c.line);
  return m !== null && m.index + m[0].length - (m[0].endsWith('//') ? 2 : 1) < at;
}

function quotedBefore(line: string, s: number): boolean {
  const ch = line[s - 1];
  return ch === '"' || ch === "'" || ch === '`';
}

/** Python / Rust module names are lower-case; CapWords are classes or types, ALL_CAPS are constants. */
function moduleLike(name: string): boolean {
  return name[0] === name[0].toLowerCase() && name !== name.toUpperCase();
}

/** npm package of a bare specifier: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function pkgName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function count(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s)) n++;
  return n;
}

// --- 1. imports --------------------------------------------------------------------------------

function jsSpec(c: Ctx, spec: string, s: number): void {
  const e = s + spec.length;
  if (overlaps(c, s, e)) return;
  const t = spec.trim();
  if (t && !t.includes('${')) {
    if (t.startsWith('.') || t.startsWith('/') || t.startsWith('file:')) {
      addResolved(c, 'imports', resolvePath(t, c.home, 'file', 'root'), s, e);
      return;
    }
    if (PKG_SCHEME_RE.test(t)) addPackage(c, pkgName(t.slice(t.indexOf(':') + 1)));
    else if (!SCHEME_RE.test(t) && !ALIAS_RE.test(t)) addPackage(c, pkgName(t));   // aliases (@/, ~/, #x) are not resolvable here
  }
  c.spans.push(s, e);
}

function jsImports(c: Ctx): void {
  const line = c.line;
  let m: RegExpExecArray | null;
  if (JS_STMT_RE.test(line)) {
    JS_FROM_RE.lastIndex = 0;
    while ((m = JS_FROM_RE.exec(line))) jsSpec(c, m[2], m.index + m[0].lastIndexOf(m[2]));
    const side = JS_SIDE_RE.exec(line);
    if (side) jsSpec(c, side[2], side.index + side[0].lastIndexOf(side[2]));
  }
  JS_CALL_RE.lastIndex = 0;
  while ((m = JS_CALL_RE.exec(line))) jsSpec(c, m[2], m.index + m[0].lastIndexOf(m[2]));
}

function pyNames(list: string): string[] {
  const out: string[] = [];
  for (const part of list.split('#')[0].replace(PY_NAMES_JUNK_RE, ' ').split(',')) {
    const name = part.trim().split(WS_RE)[0];
    if (PY_NAME_RE.test(name)) out.push(name);
  }
  return out;
}

/** `pkg.mod` → package (stdlib / third party) or a ref `pkg/mod` from the root; lower-case imported names may be submodules. */
function pyModule(c: Ctx, dotted: string, names: string[], s: number, e: number): void {
  const top = dotted.split('.')[0];
  if (!top || top.startsWith('__')) return;
  if (PY_PACKAGES.has(top)) {
    addPackage(c, top);
    return;
  }
  const path = dotted.replace(DOT_RE, '/');
  addRef(c, 'imports', path, 'root', s, e);
  for (const n of names) if (moduleLike(n)) addRef(c, 'imports', `${path}/${n}`, 'root', s, e);
}

function pyImports(c: Ctx): void {
  const line = c.line;
  const f = PY_FROM_RE.exec(line);
  if (f) {
    const s = f.index;
    const e = s + f[0].length;
    const dots = f[1] ?? '';
    const mod = f[2] ?? '';
    const names = pyNames(f[3] ?? '');
    if (dots === '') {
      if (mod) pyModule(c, mod, names, s, e);
    } else {
      const base = dots.length === 1 ? './' : '../'.repeat(dots.length - 1);
      const path = mod ? base + mod.replace(DOT_RE, '/') : '';
      if (path) addRef(c, 'imports', path, 'file', s, e);
      for (const n of names) if (moduleLike(n)) addRef(c, 'imports', path ? `${path}/${n}` : base + n, 'file', s, e);
    }
    c.spans.push(s, e);
    return;
  }
  const im = PY_IMPORT_RE.exec(line);
  if (im) {
    const s = im.index;
    const e = s + im[0].length;
    for (const part of im[1].split(',')) {
      const dotted = part.trim().split(WS_RE)[0];
      if (dotted) pyModule(c, dotted, [], s, e);
    }
    c.spans.push(s, e);
    return;
  }
  if (c.mode.notebook) {
    const r = NB_RUN_RE.exec(line);
    if (r) {
      const s = r.index + r[0].lastIndexOf(r[1]);
      addResolved(c, 'imports', resolvePath(stripQuotes(r[1]), c.home, 'file', 'absolute'), s, s + r[1].length);
    }
  }
}

/** `use crate::a::b::{c, D}` → `src/a/b`, `src/a`, `src/a/b/c` (root); `use serde::X` → package. */
function rustUse(c: Ctx, path: string, s: number, e: number): void {
  const clean = path.replace(WS_GLOBAL_RE, '');
  const brace = clean.indexOf('{');
  const segs = (brace >= 0 ? clean.slice(0, brace) : clean).replace(RS_EDGE_COLONS_RE, '').split('::').filter((x) => x !== '');
  const first = segs[0] ?? '';
  if (first !== 'crate') {
    if (first && !RS_SKIP.has(first) && RS_IDENT_RE.test(first)) addPackage(c, first);
    return;
  }
  const mods: string[] = [];
  for (const seg of segs.slice(1)) {
    if (!RS_IDENT_RE.test(seg) || !moduleLike(seg)) break;
    mods.push(seg);
  }
  const groups: string[] = [];
  if (brace >= 0 && mods.length === segs.length - 1) {
    const close = clean.lastIndexOf('}');
    for (const item of clean.slice(brace + 1, close > brace ? close : clean.length).split(',')) {
      const name = item.split('::')[0];
      if (name !== 'self' && RS_IDENT_RE.test(name) && moduleLike(name)) groups.push(name);
    }
  }
  if (mods.length > 0) addRef(c, 'imports', `src/${mods.join('/')}`, 'root', s, e);
  if (mods.length > 1) addRef(c, 'imports', `src/${mods.slice(0, -1).join('/')}`, 'root', s, e);
  for (const g of groups) addRef(c, 'imports', `src/${[...mods, g].join('/')}`, 'root', s, e);
}

function rustImports(c: Ctx): void {
  const line = c.line;
  const mod = RS_MOD_RE.exec(line);
  if (mod) {
    addRef(c, 'imports', mod[1], 'file', mod.index, mod.index + mod[0].length);
    return;
  }
  const ext = RS_EXTERN_RE.exec(line);
  if (ext) {
    addPackage(c, ext[1]);
    c.spans.push(ext.index, ext.index + ext[0].length);
    return;
  }
  const use = RS_USE_RE.exec(line);
  if (use) {
    rustUse(c, use[1], use.index, use.index + use[0].length);
    c.spans.push(use.index, use.index + use[0].length);
  }
}

/** One argument of `source` / `python3` / `node` ...: `$DIR/x.sh` is taken as relative to the script. */
function shellArg(c: Ctx, raw: string, s: number, kind: RawRefKind, relDefault: RelTo): void {
  const e = s + raw.length;
  if (overlaps(c, s, e)) return;
  let t = stripQuotes(raw);
  const v = SH_VAR_PREFIX_RE.exec(t);
  if (v) t = `./${t.slice(v[0].length)}`;
  if (!t || t.replace(HOME_PREFIX_RE, '').includes('$')) {
    c.spans.push(s, e);
    return;
  }
  addResolved(c, kind, resolvePath(t, c.home, relDefault, 'absolute'), s, e);
}

/** `source` / `.` in shell scripts; `python3 x.py`, `node x.js`, ... in any file (imports in shell, refpath elsewhere). */
function shellRefs(c: Ctx): void {
  const line = c.line;
  let m: RegExpExecArray | null;
  if (c.mode.shell) {
    SH_SOURCE_RE.lastIndex = 0;
    while ((m = SH_SOURCE_RE.exec(line))) shellArg(c, m[1], m.index + m[0].length - m[1].length, 'imports', 'file');
  }
  const kind: RawRefKind = c.mode.shell ? 'imports' : 'refpath';
  SH_RUN_RE.lastIndex = 0;
  while ((m = SH_RUN_RE.exec(line))) {
    if (SCRIPT_EXT_RE.test(stripQuotes(m[1]))) shellArg(c, m[1], m.index + m[0].length - m[1].length, kind, 'root');
  }
}

/** A local src / href / url() / @import target, relative to the file. */
function linkTarget(c: Ctx, kind: RawRefKind, raw: string, s: number): void {
  const e = s + raw.length;
  if (overlaps(c, s, e)) return;
  const t = localTarget(raw);
  if (t === null) c.spans.push(s, e);
  else addResolved(c, kind, resolvePath(t, c.home, 'file', 'root'), s, e);
}

function htmlRefs(c: Ctx): void {
  const line = c.line;
  HTML_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_ATTR_RE.exec(line))) linkTarget(c, 'imports', m[3], m.index + m[0].length - 1 - m[3].length);
}

function cssRefs(c: Ctx): void {
  const line = c.line;
  let m: RegExpExecArray | null;
  CSS_IMPORT_RE.lastIndex = 0;
  while ((m = CSS_IMPORT_RE.exec(line))) linkTarget(c, 'imports', m[2], m.index + m[0].lastIndexOf(m[2]));
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(line))) linkTarget(c, 'imports', m[2], m.index + m[0].lastIndexOf(m[2]));
}

// --- 2. links ----------------------------------------------------------------------------------

function mdLink(c: Ctx, raw: string, s: number, e: number): void {
  if (overlaps(c, s, e)) return;
  c.docLinks++;
  const t = localTarget(raw);
  if (t === null) c.spans.push(s, e);
  else addResolved(c, 'links', resolvePath(t, c.home, 'file', 'root'), s, e);
}

function mdLinks(c: Ctx): void {
  const line = c.line;
  let m: RegExpExecArray | null;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(line))) {
    const s = m.index;
    const e = s + m[0].length;
    if (overlaps(c, s, e)) continue;
    c.docLinks++;
    const name = m[1].trim();
    if (name) addRef(c, 'links', name, 'name', s, e);
    else c.spans.push(s, e);
  }
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(line))) mdLink(c, m[1], m.index, m.index + m[0].length);
  const d = MD_DEF_RE.exec(line);
  if (d) mdLink(c, d[2], d.index, d.index + d[0].length);
}

/** `operativo/scripts/x.py` between backticks; a bare file name is left to the mention detector. */
function backtickPaths(c: Ctx): void {
  const line = c.line;
  BT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BT_RE.exec(line))) {
    const s = m.index + 1;
    const e = s + m[1].length;
    if (overlaps(c, s, e)) continue;
    const t = m[1].trim().replace(LINE_SUFFIX_RE, '');
    if (!t.includes('/') || !BT_PATH_RE.test(t) || !HAS_LETTER_RE.test(t) || t.startsWith('//')) continue;
    if (SCHEME_RE.test(t) || DOMAIN_SEG_RE.test(t) || t.replace(HOME_PREFIX_RE, '').includes('$')) continue;
    addResolved(c, 'refpath', resolvePath(t, c.home, 'root', 'root'), s, e);
  }
}

// --- 3. paths written in files ---------------------------------------------------------------

function desktopChain(c: Ctx, first: string, rest: string, s: number, e: number): void {
  if (overlaps(c, s, e)) return;
  const segs = first.split('/').filter((x) => x !== '');
  QUOTED_SEG_RE.lastIndex = 0;
  let q: RegExpExecArray | null;
  while ((q = QUOTED_SEG_RE.exec(rest))) for (const x of q[2].split('/')) if (x !== '') segs.push(x);
  if (segs.length === 0) c.spans.push(s, e);   // the Desktop itself
  else addRef(c, 'refpath', `${c.home ?? '~'}/Desktop/${segs.join('/')}`, 'absolute', s, e);
}

/** `HOME / "Desktop" / "a"` (pathlib) and `join(home, "Desktop", "a")` / `.join("Desktop").join("a")`. */
function joinedPaths(c: Ctx): void {
  const line = c.line;
  let m: RegExpExecArray | null;
  if (c.mode.py) {
    PATHLIB_RE.lastIndex = 0;
    while ((m = PATHLIB_RE.exec(line))) desktopChain(c, m[2] ?? '', m[3] ?? '', m.index, m.index + m[0].length);
  }
  if (JOIN_CTX_RE.test(line)) {
    JOIN_RE.lastIndex = 0;
    while ((m = JOIN_RE.exec(line))) desktopChain(c, m[2] ?? '', m[3] ?? '', m.index + 1, m.index + m[0].length);
  }
}

/** Home, Desktop and this-Mac paths; a quoted path may contain spaces, so it runs to the closing quote. */
function absolutePaths(c: Ctx): void {
  const line = c.line;
  ABS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ABS_RE.exec(line))) {
    const s = m.index;
    let raw = m[0];
    const q = line[s - 1];
    if (q === '"' || q === "'" || q === '`') {
      const close = line.indexOf(q, s);
      if (close > s + raw.length) raw = line.slice(s, close);
    }
    const e = s + raw.length;
    if (e > ABS_RE.lastIndex) ABS_RE.lastIndex = e;
    if (overlaps(c, s, e)) continue;
    addResolved(c, 'refpath', resolvePath(raw.replace(LINE_SUFFIX_RE, ''), c.home, 'root', 'absolute'), s, e);
  }
}

function relativePaths(c: Ctx): void {
  const line = c.line;
  REL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REL_RE.exec(line))) {
    const s = m.index;
    const e = s + m[0].length;
    if (!KNOWN_EXT_SET.has(m[1].toLowerCase()) || overlaps(c, s, e) || DOMAIN_SEG_RE.test(m[0])) continue;
    addResolved(c, 'refpath', resolvePath(m[0], c.home, 'root', 'root'), s, e);
  }
}

// --- 4. file names cited -------------------------------------------------------------------------

function mentions(c: Ctx): void {
  const line = c.line;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(line))) {
    const name = m[0];
    const s = m.index;
    const e = s + name.length;
    if (!MENTION_EXT_SET.has(m[1].toLowerCase()) || c.mentioned.has(name) || overlaps(c, s, e)) continue;
    if (MENTION_DENY.has(name.toLowerCase()) || !HAS_LETTER_RE.test(name.slice(0, name.lastIndexOf('.')))) continue;
    if (c.mode.codeMention && !inComment(c, s) && !quotedBefore(line, s)) continue;   // in code: comments and strings only
    c.mentioned.add(name);
    addRef(c, 'mention', name, 'name', s, e);
  }
}

function consumeUrls(c: Ctx): void {
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(c.line))) c.spans.push(m.index, m.index + m[0].length);
}

/**
 * All reference detectors on the current line, strongest first: each match consumes its span.
 * Cheap substring tests skip the detectors that cannot match (most lines have no `/`, `[`, backtick...).
 */
function scanLine(c: Ctx): void {
  const m = c.mode;
  const line = c.line;
  const slash = line.includes('/');
  if (m.js) jsImports(c);
  if (m.py) pyImports(c);
  if (m.rust) rustImports(c);
  if (m.md && !c.fence && line.includes('[')) mdLinks(c);
  if (slash || line.includes('www.')) consumeUrls(c);
  if ((m.html || m.md) && line.includes('=')) htmlRefs(c);
  if (m.css && (line.includes('url(') || line.includes('@'))) cssRefs(c);
  shellRefs(c);
  if (m.backtick && line.includes('`')) backtickPaths(c);
  if (line.includes('Desktop')) joinedPaths(c);
  if (slash) {
    absolutePaths(c);
    relativePaths(c);
  }
  if (line.includes('.') && (!m.codeMention || mentionable(c))) mentions(c);
}

/** In code, mentions count only in comments and strings: lines with neither are skipped up front. */
function mentionable(c: Ctx): boolean {
  const l = c.line;
  if (l.includes('"') || l.includes("'") || l.includes('`')) return true;
  const t = l.trimStart();
  for (const p of c.mode.comment) if (t.startsWith(p)) return true;
  return c.mode.trailing !== null && c.mode.trailing.test(l);
}

// --- 5. identifiers ------------------------------------------------------------------------------

function addId(c: Ctx, token: string): void {
  if (c.identifiers.length >= MAX_IDS || c.idTokens.has(token)) return;
  c.idTokens.add(token);
  c.identifiers.push({ token, line: c.lineNo });
}

/** Runs on the line with tax-code- and secret-shaped spans blanked. */
function scanIdentifiers(c: Ctx, text: string): void {
  if (c.identifiers.length >= MAX_IDS || !HAS_DIGIT_RE.test(text)) return;   // every identifier kind carries digits
  let m: RegExpExecArray | null;
  const uuids: number[] = [];
  UUID_RE.lastIndex = 0;
  while ((m = UUID_RE.exec(text))) {
    addId(c, m[0].toLowerCase());
    uuids.push(m.index, m.index + m[0].length);
  }
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(text))) {
    if (!inSpans(uuids, m.index) && HAS_DIGIT_RE.test(m[0]) && HEX_LETTER_RE.test(m[0])) addId(c, m[0]);
  }
  SLACK_ID_RE.lastIndex = 0;
  while ((m = SLACK_ID_RE.exec(text))) if (HAS_DIGIT_RE.test(m[0])) addId(c, m[0]);
  SLACK_TS_RE.lastIndex = 0;
  while ((m = SLACK_TS_RE.exec(text))) addId(c, m[0]);
  SLACK_PERMALINK_RE.lastIndex = 0;
  while ((m = SLACK_PERMALINK_RE.exec(text))) addId(c, `${m[1]}.${m[2]}`);
  PR_RE.lastIndex = 0;
  while ((m = PR_RE.exec(text))) addId(c, `PR#${m[1] ?? m[2]}`);
  ISSUE_RE.lastIndex = 0;
  while ((m = ISSUE_RE.exec(text))) addId(c, `ISSUE#${m[1] ?? m[2]}`);
  const pr = PR_CTX_RE.test(text);
  if (pr || ISSUE_CTX_RE.test(text)) {
    HASHNUM_RE.lastIndex = 0;
    while ((m = HASHNUM_RE.exec(text))) addId(c, `${pr ? 'PR' : 'ISSUE'}#${m[1]}`);
  }
  KEY_RE.lastIndex = 0;
  while ((m = KEY_RE.exec(text))) if (!KEY_DENY.has(m[1])) addId(c, `${m[1]}-${m[2]}`);
}

// --- 6. terms ------------------------------------------------------------------------------------

function addTerm(t: string, terms: Map<string, number>): void {
  if (t.length < 4 || STOP.has(t)) return;
  const n = terms.get(t);
  if (n !== undefined) terms.set(t, n + 1);
  else if (terms.size < MAX_TERMS) terms.set(t, 1);
}

function addTerms(text: string, terms: Map<string, number>): void {
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) {
    const w = m[0];
    if (HAS_DIGIT_RE.test(w)) continue;
    if (!INNER_UPPER_RE.test(w)) {
      addTerm(w.toLowerCase(), terms);
      continue;
    }
    PIECE_RE.lastIndex = 0;   // camelCase / PascalCase: one term per piece
    let p: RegExpExecArray | null;
    while ((p = PIECE_RE.exec(w))) addTerm(p[0].toLowerCase(), terms);
  }
}

// --- 7. complexity -------------------------------------------------------------------------------

type CxKind = 'code' | 'doc' | 'html' | 'config' | 'none';

function cxKind(input: ExtractInput, mode: Mode): CxKind {
  if (mode.notebook) return 'code';
  if (mode.html) return 'html';
  if (CONFIG_LANGS.has(mode.lang) || input.cls === 'config') return 'config';
  if (input.cls === 'code') return 'code';
  if (input.cls === 'doc' || mode.md) return 'doc';
  return 'none';
}

/** Least-indented keys matched by `re` (group 1 = indentation). */
function topKeys(lines: string[], re: RegExp): number {
  let min = Infinity;
  let n = 0;
  for (const l of lines) {
    const m = re.exec(l);
    if (m === null) continue;
    if (m[1].length < min) {
      min = m[1].length;
      n = 1;
    } else if (m[1].length === min) n++;
  }
  return n;
}

/** Number of first-level keys of a config file. */
function configKeys(lines: string[], lang: string, content: string): number {
  if (lang === 'json') {
    try {
      const v: unknown = JSON.parse(content);
      if (Array.isArray(v)) return v.length;
      return v !== null && typeof v === 'object' ? Object.keys(v).length : 0;
    } catch {
      return topKeys(lines, JSON_KEY_RE);   // JSON with comments, or cut
    }
  }
  if (lang === 'plist') return topKeys(lines, PLIST_KEY_RE);
  let n = 0;
  if (lang === 'yaml') {
    for (const l of lines) if (l.length < 2000 && l.includes(':') && !LEADING_WS_RE.test(l) && YAML_TOP_RE.test(l)) n++;
    return n;
  }
  let section = false;   // toml / ini: sections + the keys before the first section
  for (const l of lines) {
    if (INI_SECTION_RE.test(l)) {
      section = true;
      n++;
    } else if (!section && INI_KEY_RE.test(l)) n++;
  }
  return n;
}

// --- entry point -----------------------------------------------------------------------------

export function extract(input: ExtractInput): ExtractResult {
  const content = input.content ?? '';
  const all = content === '' ? [] : content.split(NEWLINE_RE);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const mode = modeFor(input, all[0] ?? '');
  const c: Ctx = {
    home: homeOf(input.path),
    mode,
    refs: [],
    refKeys: new Set(),
    externalRefs: [],
    extKeys: new Set(),
    packages: new Set(),
    mentioned: new Set(),
    identifiers: [],
    idTokens: new Set(),
    docLinks: 0,
    fence: false,
    line: '',
    lineNo: 0,
    spans: [],
    sens: [],
  };
  const terms = new Map<string, number>();
  const cx = cxKind(input, mode);
  let complexity = 0;

  for (let i = 0; i < all.length; i++) {
    let line = all[i];
    if (line.length > MAX_LINE_SCAN) line = line.slice(0, MAX_LINE_SCAN);
    if (mode.notebook) {
      // only the JSON string lines of a notebook carry source (and output) text
      const nb = NB_LINE_RE.exec(line);
      if (nb === null) continue;
      try {
        line = String(JSON.parse(`"${nb[1]}"`));
      } catch {
        continue;
      }
      if (line.endsWith('\n')) line = line.slice(0, -1);
    }
    if (!NON_SPACE_RE.test(line)) continue;
    c.line = line;
    c.lineNo = i + 1;
    c.spans = [];
    c.sens = sensitiveSpans(line);

    if (mode.md && MD_FENCE_RE.test(line)) c.fence = !c.fence;
    else if (cx === 'doc' && !c.fence) complexity += (MD_HEADING_RE.test(line) ? 1 : 0) + (TABLE_SEP_RE.test(line) ? 1 : 0);
    if (cx === 'code') complexity += count(CODE_CX_RE, line);
    else if (cx === 'html') complexity += count(HTML_CX_RE, line);

    scanLine(c);

    const text = c.sens.length > 0 ? blankSpans(line, c.sens) : line;
    if (!BLOB_RE.test(text)) {
      scanIdentifiers(c, text);
      addTerms(text, terms);
    }
  }
  if (cx === 'doc') complexity += c.docLinks;
  else if (cx === 'config') complexity = configKeys(all, mode.lang, content);

  return {
    lines: all.length,
    complexity,
    refs: c.refs,
    identifiers: c.identifiers,
    terms: Object.fromEntries(terms),
    externalRefs: c.externalRefs,
    packages: [...c.packages],
  };
}
