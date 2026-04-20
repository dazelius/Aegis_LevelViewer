import yaml from 'js-yaml';

/**
 * Unity YAML files use a custom `!u!<classId>` tag on each document.
 * Examples of class ids:
 *   1   GameObject
 *   4   Transform
 *   20  Camera
 *   23  MeshRenderer
 *   33  MeshFilter
 *   108 Light
 *   114 MonoBehaviour
 *   224 RectTransform
 *
 * js-yaml doesn't understand `!u!...` out of the box, so we register a
 * pass-through type that preserves the underlying mapping/scalar/sequence.
 *
 * Additionally, each doc header looks like:
 *   --- !u!1 &1234567890
 * or sometimes:
 *   --- !u!114 &5678 stripped
 * The `&anchor` and `stripped` marker are handled by js-yaml's own YAML 1.1
 * mechanics except that the tag syntax is non-standard.
 *
 * Our strategy is to preprocess the document headers with {@link preprocessUnityYaml},
 * removing the `!u!<id>` tag from the header line and returning a separate list
 * of `(classId, fileID)` descriptors in document order.
 */

export interface UnityDocHeader {
  classId: number;
  fileID: string;
  stripped: boolean;
}

export interface PreprocessedUnityYaml {
  /** YAML text safe to feed to js-yaml loadAll */
  text: string;
  /** Per-document metadata in the same order as yaml.loadAll yields docs */
  headers: UnityDocHeader[];
}

// Unity fileIDs are 64-bit integers and CAN be negative — ShaderGraph's
// built-in AssetVersion MonoBehaviours in .mat files, for instance, ship
// with ids like `&-2050052298779600032`. Accept an optional leading `-`.
const DOC_HEADER_RE = /^---\s+!u!(\d+)\s+&(-?\d+)(\s+stripped)?\s*$/;

/**
 * Coerce reference-literal values to strings BEFORE js-yaml parses the doc.
 *
 *   guid: 0000000000000000e000000000000000
 *
 * This would otherwise be parsed as a float (`0e0 = 0`) by CORE_SCHEMA because
 * 'e' is scientific-notation. Same for very large fileIDs that overflow
 * Number.MAX_SAFE_INTEGER. We quote both to force js-yaml to keep them as
 * strings; downstream `fileIdOf` / `guidOf` / `num()` helpers already cope
 * with string inputs.
 */
function quoteUnityRefLiterals(text: string): string {
  return text
    .replace(/(\bguid:\s*)([0-9a-fA-F]{32})\b/g, '$1"$2"')
    .replace(/(\bfileID:\s*)(-?\d+)\b/g, '$1"$2"');
}

export function preprocessUnityYaml(source: string): PreprocessedUnityYaml {
  const headers: UnityDocHeader[] = [];
  // Normalize line endings first to simplify line-based parsing.
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  const out: string[] = [];
  for (const line of lines) {
    const m = DOC_HEADER_RE.exec(line);
    if (m) {
      headers.push({
        classId: Number(m[1]),
        fileID: m[2],
        stripped: Boolean(m[3]),
      });
      // Replace with a plain document separator js-yaml can handle.
      out.push('---');
    } else {
      out.push(line);
    }
  }

  return { text: quoteUnityRefLiterals(out.join('\n')), headers };
}

/**
 * Load a preprocessed Unity YAML source into an array of generic JS objects,
 * one per document. We use CORE_SCHEMA to avoid YAML 1.1 boolean/date surprises
 * (e.g. `yes` becoming `true`).
 */
export function loadUnityDocs(preprocessed: PreprocessedUnityYaml): unknown[] {
  const docs: unknown[] = [];
  try {
    yaml.loadAll(
      preprocessed.text,
      (doc) => {
        docs.push(doc);
      },
      { schema: yaml.CORE_SCHEMA },
    );
  } catch (err) {
    // Re-throw with clearer context
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Unity YAML parse failed: ${msg}`);
  }
  return docs;
}
