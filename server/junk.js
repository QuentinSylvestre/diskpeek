/**
 * Junk detection rule engine.
 *
 * Applies a rules.json rule array against a scanned entry to determine its
 * junk category. Server-side only — keeps rule changes decoupled from the
 * Rust binary.
 */

/**
 * Expand %VAR% tokens in a template string using envVars.
 *
 * Example: expandTemplate('%LOCALAPPDATA%\\Temp', process.env)
 *          → 'C:\\Users\\user\\AppData\\Local\\Temp'
 *
 * Returns an empty string (not null) if the referenced variable is absent, so
 * pathStartsWithAny's `if (!prefix)` guard skips the expanded value cleanly.
 *
 * @param {string} template   - Template string with %VAR% tokens
 * @param {object} envVars    - Env-var dictionary (e.g. process.env)
 * @returns {string}
 */
function expandTemplate(template, envVars) {
  return template.replace(/%([^%]+)%/g, (_, varName) => {
    const val = envVars[varName];
    return val != null ? val : '';
  });
}

// Module-level cache for expanded path_prefix templates.
// Keyed by JSON.stringify(rule.path_templates) so templates are expanded only
// once per unique set of template strings for the process lifetime.
const _expandedPrefixCache = new Map();

/**
 * Return (and cache) expanded, lowercased prefixes for a path_prefix rule.
 * Effective for a server process where envVars is effectively constant.
 *
 * @param {object} rule     - A rule object with a path_templates array
 * @param {object} envVars  - Env-var dictionary used to expand templates
 * @returns {string[]}      - Lowercased expanded prefix strings
 */
function getExpandedPrefixes(rule, envVars) {
  const key = JSON.stringify(rule.path_templates);
  if (_expandedPrefixCache.has(key)) return _expandedPrefixCache.get(key);
  const expanded = (rule.path_templates || []).map(t => expandTemplate(t, envVars).toLowerCase());
  _expandedPrefixCache.set(key, expanded);
  return expanded;
}

/**
 * Check whether an entry's path starts with any of the given prefix strings
 * (case-insensitive, Windows backslash separator).
 *
 * Matches both the exact prefix (entry IS the temp directory) and anything
 * inside it (prefix + backslash).
 *
 * @param {string}   entryPath - Absolute Windows path from the scanner
 * @param {string[]} prefixes  - Expanded prefix paths to check against
 * @returns {boolean}
 */
function pathStartsWithAny(entryPath, prefixes) {
  const pathLower = entryPath.toLowerCase();
  return prefixes.some(prefix => {
    if (!prefix) return false;
    const p = prefix.toLowerCase();
    return pathLower === p || pathLower.startsWith(p + '\\');
  });
}

/**
 * Apply a single rule to an entry.
 *
 * @param {object} entry     - {path, name, size, is_dir, mtime_unix}
 * @param {object} rule      - One element from rules.json
 * @param {object} envVars   - process.env
 * @param {string} nameLower - Pre-computed entry.name.toLowerCase()
 * @param {string} pathLower - Pre-computed entry.path.toLowerCase()
 * @returns {boolean}
 */
function matchesRule(entry, rule, envVars, nameLower, pathLower) {
  switch (rule.match) {
    case 'dir_name':
      // Matches directories whose name is exactly in the names list (case-insensitive).
      // is_dir guard prevents false positives from same-named files.
      return entry.is_dir && Array.isArray(rule.names) && rule.names.includes(nameLower);

    case 'path_prefix': {
      // Matches entries whose path starts with any expanded template prefix.
      // Handles both the directory itself and any file inside it.
      const expanded = getExpandedPrefixes(rule, envVars);
      return pathStartsWithAny(entry.path, expanded);
    }

    case 'file_ext_age': {
      // Matches non-directory files with a given extension older than max_age_days.
      if (entry.is_dir) return false;
      // Guard: null/undefined mtime_unix, zero (MFT fallback value), or negative
      // (pre-epoch) — no silent NaN comparison.
      if (entry.mtime_unix == null || entry.mtime_unix <= 0) return false;
      const hasExt = (rule.extensions || []).some(ext => nameLower.endsWith(ext.toLowerCase()));
      if (!hasExt) return false;
      const ageSecs = Date.now() / 1000 - entry.mtime_unix;
      return ageSecs > rule.max_age_days * 86400;
    }

    case 'file_ext_in_downloads_age': {
      // Matches files with a given extension that sit inside a Downloads directory
      // and are older than max_age_days.
      if (entry.is_dir) return false;
      if (entry.mtime_unix == null || entry.mtime_unix <= 0) return false;
      const hasExt = (rule.extensions || []).some(ext => nameLower.endsWith(ext.toLowerCase()));
      if (!hasExt) return false;
      // Check path contains a \Downloads\ segment (case-insensitive)
      if (!pathLower.includes('\\downloads\\')) return false;
      const ageSecs = Date.now() / 1000 - entry.mtime_unix;
      return ageSecs > rule.max_age_days * 86400;
    }

    default:
      return false;
  }
}

/**
 * Detect the junk category of a scanned entry.
 *
 * Iterates rules in order; returns the id of the first matching rule, or null.
 * Returns null (not false) when mtime_unix is absent so callers never
 * misinterpret NaN comparisons as a match.
 *
 * @param {object} entry    - {path, name, size, is_dir, mtime_unix}
 * @param {Array}  rules    - Parsed rules array from rules.json
 * @param {object} envVars  - process.env or equivalent
 * @returns {string|null}   - Category id (e.g. 'node_modules') or null
 */
export function detectCategory(entry, rules, envVars) {
  // Cache toLowerCase() results once; reused across all rule evaluations.
  const nameLower = entry.name ? entry.name.toLowerCase() : '';
  const pathLower = entry.path ? entry.path.toLowerCase() : '';

  /**
   * Rules are evaluated in order and the first match wins.
   * For files matching multiple rules (e.g. a .log file in %TEMP%),
   * the rule with the lower index in rules.json takes precedence.
   * Current order: node_modules > python_cache > rust_build > build_output > venv > temp > log > installer
   */
  for (const rule of rules) {
    if (matchesRule(entry, rule, envVars, nameLower, pathLower)) {
      return rule.id;
    }
  }
  return null;
}
