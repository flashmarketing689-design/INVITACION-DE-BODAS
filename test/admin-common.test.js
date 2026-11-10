const test = require('node:test');
const assert = require('node:assert/strict');
const common = require('../admin-common');

test('CSV neutraliza fórmulas y conserva las columnas', () => {
  for (const evil of ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
    const cell = common.csvCell(evil);
    assert.ok(cell.startsWith('"\''), `sin neutralizar: ${evil}`);
  }
  assert.equal(common.csvCell('Ana "la" Pérez'), '"Ana ""la"" Pérez"');
  assert.equal(common.csvCell(null), '""');
  assert.equal(common.csvCell(12), '"12"');
  // Una fecha con coma ya no corre las columnas siguientes.
  const row = common.csvRow(['8/11/2026, 10:30:00 a. m.', 'Sí', 'x']);
  assert.equal(row, '"8/11/2026, 10:30:00 a. m.","Sí","x"');
});

test('escapeHtml cubre los cinco caracteres', () => {
  assert.equal(common.escapeHtml(`<a href="x" title='y'>&</a>`),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(common.escapeHtml(null), '');
});

test('withBusy bloquea el segundo clic mientras corre la acción', async () => {
  const control = { disabled: false, dataset: {} };
  let runs = 0;
  let release;
  const first = common.withBusy(control, () => { runs += 1; return new Promise((r) => { release = r; }); });
  assert.equal(control.disabled, true);
  assert.equal(await common.withBusy(control, async () => { runs += 1; }), undefined);
  release('ok');
  assert.equal(await first, 'ok');
  assert.equal(control.disabled, false);
  assert.equal(runs, 1);
  await common.withBusy(control, async () => { runs += 1; });
  assert.equal(runs, 2);
});

test('uuid genera identificadores v4 válidos incluso sin randomUUID', () => {
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(common.uuid(), pattern);
  const original = globalThis.crypto.randomUUID;
  try {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    assert.match(common.uuid(), pattern);
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
  }
});
