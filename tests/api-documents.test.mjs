import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate, visit, Kind } from 'graphql';
test('API example documents validate against the Bridge schema', () => {
  const schema = buildSchema(
    readFileSync(
      new URL('../contracts/schema.graphql', import.meta.url),
      'utf8',
    ),
  );
  const source = readFileSync(
    new URL('../docs/api.md', import.meta.url),
    'utf8',
  );
  const rows = [...source.matchAll(/```graphql\n([\s\S]*?)```/g)].map(
    (match) => ({
      file: 'docs/api.md',
      line: source.slice(0, match.index).split('\n').length,
      query: match[1],
    }),
  );
  for (const row of rows) {
    const document = parse(row.query);
    // The snapshot intentionally excludes official fields. Remove only official root
    // siblings and variables used solely by them, retaining every Bridge selection.
    const definitions = document.definitions
      .map((def) => {
        if (def.kind !== Kind.OPERATION_DEFINITION) return def;
        const selections = def.selectionSet.selections.filter(
          (s) => s.kind !== Kind.FIELD || s.name.value.startsWith('deckBridge'),
        );
        if (!selections.length) return null;
        const selectionSet = { ...def.selectionSet, selections };
        const used = new Set();
        visit(selectionSet, {
          Variable(n) {
            used.add(n.name.value);
          },
        });
        return {
          ...def,
          selectionSet,
          variableDefinitions: def.variableDefinitions?.filter((v) =>
            used.has(v.variable.name.value),
          ),
        };
      })
      .filter(Boolean);
    if (!definitions.length) continue;
    const errors = validate(schema, { ...document, definitions });
    assert.deepEqual(
      errors.map((e) => e.message),
      [],
      `${row.file}:${row.line}: ${row.query}`,
    );
  }
});
