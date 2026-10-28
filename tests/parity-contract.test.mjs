import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const contract = JSON.parse(
  fs.readFileSync(
    new URL('../contracts/openapi.json', import.meta.url),
    'utf8',
  ),
);
const schemas = contract.components.schemas;

test('OpenAPI 3.1 parity observations explicitly admit null without weakening known values', () => {
  assert.equal(contract.openapi, '3.1.0');
  const nullable = {
    ParityStatus: {
      correcting: 'boolean',
      positionBytes: 'string',
      totalBytes: 'string',
      speedBytesPerSecond: 'string',
      elapsedSeconds: 'string',
      errorCount: 'string',
    },
    ParityLastResult: {
      startedAt: 'string',
      finishedAt: 'string',
      elapsedSeconds: 'string',
      errorCount: 'string',
    },
    HostPlan: { correct: 'boolean' },
  };
  for (const [name, fields] of Object.entries(nullable)) {
    for (const [field, type] of Object.entries(fields)) {
      const schema = schemas[name].properties[field];
      assert.deepEqual(schema.type, [type, 'null'], `${name}.${field}`);
      assert.equal(
        schema.nullable,
        undefined,
        `${name}.${field} must not rely on the OpenAPI 3.0 keyword`,
      );
      assert.ok(
        schemas[name].required.includes(field),
        `${name}.${field} must remain explicit when unknown`,
      );
    }
  }
  assert.equal(schemas.ParityStatus.type, 'object');
  assert.equal(schemas.ParityStatus.additionalProperties, false);
  assert.deepEqual(schemas.ParityStatus.properties.lastResult, {
    anyOf: [
      { $ref: '#/components/schemas/ParityLastResult' },
      { type: 'null' },
    ],
  });
  assert.equal(schemas.ParityLastResult.type, 'object');
  assert.deepEqual(schemas.ParityLastResult.properties.state.enum, [
    'COMPLETED',
    'CANCELLED',
    'FAILED',
  ]);
  for (const field of [
    'positionBytes',
    'totalBytes',
    'speedBytesPerSecond',
    'elapsedSeconds',
    'errorCount',
  ]) {
    assert.equal(schemas.ParityStatus.properties[field].pattern, '^[0-9]+$');
  }
  for (const field of ['startedAt', 'finishedAt'])
    assert.equal(
      schemas.ParityLastResult.properties[field].format,
      'date-time',
    );
});
