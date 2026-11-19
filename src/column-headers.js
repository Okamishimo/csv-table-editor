"use strict";

function replaceOnce(source, from, to, description) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`Cannot fix column headers: expected one ${description}, found ${count}.`);
  }
  return source.replace(from, to);
}

// Applied inside search-scope, preserving the shipped decorator order. CSV
// values alone cannot reliably distinguish titles from an all-text data row.
// Use the first row consistently, as the streaming preview already does.
function decorateWebviewHtml(html) {
  if (html.includes('class="csv-column-heading"')) return html;
  let result = replaceOnce(html, `  // ---------- header detection + sort model ----------
  /**
   * Guess the header row: the first "full" row whose row immediately below has a
   * comparable number of non-empty cells. Preamble is usually a few short rows
   * (1-2 cells) at the top. Returns a row index; defaults to 0 if nothing better.
   */
  function guessHeaderRow(g) {
    const cols = g[0] ? g[0].length : 0;
    if (g.length <= 1 || cols === 0) { return 0; }
    const filled = (row) => row.reduce((n, v) => n + (String(v).trim() !== '' ? 1 : 0), 0);
    let best = 0;
    let bestFill = -1;
    // Only inspect the first 20 rows to avoid scanning large files.
    const limit = Math.min(g.length - 1, 20);
    for (let r = 0; r <= limit; r++) {
      const f = filled(g[r]);
      const fNext = filled(g[r + 1] || []);
      // Ideal header: nearly full, and the row below also has many cells (data starts).
      if (f >= cols * 0.6 && fNext >= cols * 0.5) {
        return r;
      }
      if (f > bestFill) { bestFill = f; best = r; }
    }
    return best;
  }
`, `  // ---------- first-row titles + sort model ----------
`, "header guesser");
  result = replaceOnce(result,
    "  /** Load a new grid (init/setContent): guess header, reset sort, build view, draw. */",
    "  /** Load a new grid: use first-row titles, reset sort, build view, draw. */",
    "grid loading comment");
  result = replaceOnce(result, "    headerRow = guessHeaderRow(grid);",
    "    headerRow = 0;", "first-row titles");
  result = replaceOnce(result,
    "    headerInfoEl.textContent = 'Header: row ' + (headerRow + 1);",
    "    headerInfoEl.textContent = 'Column titles: first row';",
    "title source label");

  // Native flex sizing reserves the controls' space; only the title shrinks.
  // Keep th as a table cell, so sticky positioning and fixed columns still work.
  result = replaceOnce(result,
    `      head += '<th class="col-actions" data-colhead="' + c + '">' +`,
    `      head += '<th class="col-actions" data-colhead="' + c + '"><div class="csv-column-heading">' +`,
    "column heading container");
  result = replaceOnce(result,
    `        ' <button class="mini" data-delcol="' + c + '" title="Delete column">✕</button></th>';`,
    `        '<button class="mini" data-delcol="' + c + '" title="Delete column">✕</button></div></th>';`,
    "column delete button");
  result = replaceOnce(result, "</style>", `  .csv-column-heading { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .csv-column-heading .sort-header { flex: 1 1 0; min-width: 0; overflow: hidden; }
  .csv-column-heading .col-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .csv-column-heading .sort-glyph, .csv-column-heading [data-delcol] { flex: 0 0 auto; }
</style>`, "nonce-approved stylesheet");
  return result;
}

module.exports = { decorateWebviewHtml };
