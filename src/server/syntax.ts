// Import statements read with tree-sitter (WebAssembly grammars in vendor/tree-sitter) for languages whose imports a
// line-by-line rule gets wrong or misses: Go import blocks, Java imports, multi-line Python imports, C/C++ includes.
// Loaded once per thread before extraction; until then (or if a grammar fails) syntaxImports returns null and the
// extractor keeps its own rules, so a missing grammar never fails an index.
import { join } from 'node:path';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { PROJECT_ROOT } from './config.ts';

export type SyntaxImport =
  | { kind: 'py-from'; line: number; col: number; end: number; dots: number; module: string; names: string[] }
  | { kind: 'py-import'; line: number; col: number; end: number; modules: string[] }
  | { kind: 'go'; line: number; col: number; end: number; path: string }
  | { kind: 'java'; line: number; col: number; end: number; name: string; wildcard: boolean; isStatic: boolean }
  | { kind: 'c'; line: number; col: number; end: number; path: string };

const GRAMMAR = { go: 'go', java: 'java', python: 'python', c: 'c', cpp: 'c', objc: 'c', cuda: 'c' } as const;
type Grammar = (typeof GRAMMAR)[keyof typeof GRAMMAR];
/** Larger sources (generated or minified) are left to the line rules. */
const MAX_SOURCE = 1_000_000;
/** Lines where an import can start; Go, Java and C/C++ sources are parsed up to the last of them plus a block's worth of lines. */
const KEYWORD: Record<Grammar, RegExp> = { python: /^[ \t]*(?:from|import)[ \t]/m, go: /^[ \t]*import\b/gm, java: /^[ \t]*import[ \t]/gm, c: /^[ \t]*#[ \t]*include\b/gm };
const TAIL_LINES = 200;
/** Python: only the module header, before the first top-level def or class, where multi-line imports live; later (often lazy) imports are single lines the extractor's rules read as well. */
const PY_BODY_RE = /^(?:async[ \t]+def|def|class)\b/m;

/** The part of the source that is parsed; '' when it cannot contain an import. */
function importRegion(grammar: Grammar, content: string): string {
  if (grammar === 'python') {
    const body = PY_BODY_RE.exec(content);
    const head = body ? content.slice(0, body.index) : content;
    return KEYWORD.python.test(head) ? head : '';
  }
  const re = KEYWORD[grammar];
  re.lastIndex = 0;
  let last = -1;
  for (let m = re.exec(content); m; m = re.exec(content)) { last = m.index; re.lastIndex = m.index + m[0].length; }
  if (last < 0) return '';
  let end = last;
  for (let n = 0; n <= TAIL_LINES && end >= 0; n++) end = content.indexOf('\n', end + 1);
  return end < 0 ? content : content.slice(0, end + 1);
}

const parsers = new Map<Grammar, Parser>();
let loading: Promise<boolean> | null = null;

export const grammarDir = () => join(PROJECT_ROOT, 'vendor', 'tree-sitter');

/** Loads the runtime and every grammar; resolves false (never rejects) when tree-sitter is unavailable. */
export function loadSyntax(dir = grammarDir()): Promise<boolean> {
  loading ??= (async () => {
    try {
      await Parser.init();
      for (const g of new Set(Object.values(GRAMMAR))) {
        const parser = new Parser();
        parser.setLanguage(await Language.load(join(dir, `tree-sitter-${g}.wasm`)));
        parsers.set(g, parser);
      }
      return true;
    } catch {
      parsers.clear();
      return false;
    }
  })();
  return loading;
}

export function syntaxLanguage(lang: string): boolean {
  return lang in GRAMMAR && parsers.has(GRAMMAR[lang as keyof typeof GRAMMAR]);
}

/**
 * The imports of one source file and how many of its lines were read (Python: the header only; the extractor's own rules
 * cover the rest), or null when its language is not covered or tree-sitter is not loaded.
 */
export function syntaxImports(lang: string, content: string): { imports: SyntaxImport[]; lines: number } | null {
  if (!syntaxLanguage(lang) || content.length > MAX_SOURCE) return null;
  const grammar = GRAMMAR[lang as keyof typeof GRAMMAR];
  const region = importRegion(grammar, content);
  // Without an import keyword nothing is parsed; Python still leaves its body to the line rules.
  if (!region) return { imports: [], lines: grammar === 'python' ? lineCount(content.slice(0, PY_BODY_RE.exec(content)?.index ?? content.length)) : Infinity };
  const tree = parsers.get(grammar)!.parse(region);
  if (!tree) return null;
  try {
    const root = tree.rootNode;
    const at = (n: Node) => ({ line: n.startPosition.row + 1, col: n.startPosition.column, end: n.startPosition.row === n.endPosition.row ? n.endPosition.column : n.startPosition.column + n.text.indexOf('\n') });
    const out: SyntaxImport[] = [];
    if (grammar === 'python') {
      for (const n of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
        if (!n || n.hasError) continue;
        if (n.type === 'import_statement') {
          const modules = n.childrenForFieldName('name').map(c => (c?.type === 'aliased_import' ? c.childForFieldName('name') : c)?.text ?? '').filter(Boolean);
          out.push({ kind: 'py-import', ...at(n), modules });
        } else {
          const mod = n.childForFieldName('module_name');
          if (!mod) continue;
          const relative = mod.type === 'relative_import';
          const dots = relative ? (mod.children.find(c => c?.type === 'import_prefix')?.text.length ?? 0) : 0;
          const module = relative ? (mod.children.find(c => c?.type === 'dotted_name')?.text ?? '') : mod.text;
          const names = n.childrenForFieldName('name').map(c => (c?.type === 'aliased_import' ? c.childForFieldName('name') : c)?.text ?? '').filter(Boolean);
          out.push({ kind: 'py-from', ...at(n), dots, module, names });
        }
      }
    } else if (grammar === 'go') {
      for (const n of root.descendantsOfType('import_spec')) {
        const path = n?.childForFieldName('path');
        const text = path?.namedChildren.find(c => c?.type === 'interpreted_string_literal_content' || c?.type === 'raw_string_literal_content')?.text;
        if (path && text) out.push({ kind: 'go', ...at(path), path: text });
      }
    } else if (grammar === 'java') {
      for (const n of root.descendantsOfType('import_declaration')) {
        if (!n || n.hasError) continue;
        const name = n.namedChildren.find(c => c?.type === 'scoped_identifier' || c?.type === 'identifier');
        if (!name) continue;
        out.push({ kind: 'java', ...at(n), name: name.text, wildcard: n.namedChildren.some(c => c?.type === 'asterisk'), isStatic: n.children.some(c => c?.type === 'static') });
      }
    } else {
      for (const n of root.descendantsOfType('preproc_include')) {
        const path = n?.childForFieldName('path');
        // <system.h> headers are not project files.
        const text = path?.type === 'string_literal' ? path.namedChildren.find(c => c?.type === 'string_content')?.text : undefined;
        if (path && text) out.push({ kind: 'c', ...at(path), path: text });
      }
    }
    return { imports: out, lines: grammar === 'python' ? lineCount(region) : Infinity };
  } finally {
    tree.delete();
  }
}

/** Lines that start inside `text` (a trailing newline does not open a new one). */
function lineCount(text: string): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.length && !text.endsWith('\n') ? n + 1 : n;
}
