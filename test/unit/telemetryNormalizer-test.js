'use strict';

const assert = require('assert');
const { createTelemetryNormalizer } = require('../../lib/telemetryNormalizer');

describe('telemetryNormalizer', function () {
    it('keeps ordinary structured telemetry as one StructuredValue', function () {
        const normalizer = createTelemetryNormalizer();
        const payload = { phase: 'ready', counters: [1, 2] };

        const result = normalizer.normalize({
            deviceId: 'machine-1',
            attribute: 'diagnostics',
            value: payload,
            provisionedType: 'StructuredValue'
        });

        assert.deepStrictEqual(result.values, [
            { name: 'diagnostics', type: 'StructuredValue', value: payload }
        ]);
        assert.strictEqual(result.bounded, false);
    });

    it('converts value and limits to Number attributes', function () {
        const normalizer = createTelemetryNormalizer();
        const result = normalizer.normalize({
            deviceId: 'machine-1',
            attribute: 'service_time',
            value: { value: '42', minimum: '0', maximum: '90' },
            provisionedType: 'StructuredValue'
        });

        assert.deepStrictEqual(result.values, [
            { name: 'service_time', type: 'Number', value: 42 },
            { name: 'service_time_minimum', type: 'Number', value: 0 },
            { name: 'service_time_maximum', type: 'Number', value: 90 }
        ]);
        assert.strictEqual(result.bounded, true);
    });

    it('only emits a known limit again when it changes', function () {
        const normalizer = createTelemetryNormalizer();
        const input = {
            deviceId: 'machine-1',
            attribute: 'service_time',
            provisionedType: 'StructuredValue'
        };

        normalizer.normalize({ ...input, value: { value: 42, maximum: 90 } });
        const unchanged = normalizer.normalize({ ...input, value: { value: 43, maximum: 90 } });
        const changed = normalizer.normalize({ ...input, value: { value: 44, maximum: 100 } });

        assert.deepStrictEqual(unchanged.values, [
            { name: 'service_time', type: 'Number', value: 43 }
        ]);
        assert.deepStrictEqual(changed.values, [
            { name: 'service_time', type: 'Number', value: 44 },
            { name: 'service_time_maximum', type: 'Number', value: 100 }
        ]);
    });

    it('preserves a known limit when a later payload omits it', function () {
        const normalizer = createTelemetryNormalizer();
        const input = {
            deviceId: 'machine-1',
            attribute: 'service_time',
            provisionedType: 'StructuredValue'
        };

        normalizer.normalize({ ...input, value: { value: 42, maximum: 90 } });
        const result = normalizer.normalize({ ...input, value: { value: 43 } });

        assert.deepStrictEqual(result.values, [
            { name: 'service_time', type: 'Number', value: 43 }
        ]);
        assert(result.warnings.some((warning) => warning.code === 'missing-maximum'));
    });

    it('rejects an invalid bounded value without emitting limits', function () {
        const normalizer = createTelemetryNormalizer();
        const result = normalizer.normalize({
            deviceId: 'machine-1',
            attribute: 'service_time',
            value: { value: 'not-a-number', maximum: 90 },
            provisionedType: 'StructuredValue'
        });

        assert.deepStrictEqual(result.values, []);
        assert(result.warnings.some((warning) => warning.code === 'invalid-value'));
    });

    it('ignores unsupported bounded fields and records a warning', function () {
        const normalizer = createTelemetryNormalizer();
        const result = normalizer.normalize({
            deviceId: 'machine-1',
            attribute: 'service_time',
            value: { value: 42, maximum: 90, unit: 'hours' },
            provisionedType: 'StructuredValue'
        });

        assert(result.warnings.some((warning) => warning.code === 'ignored-fields'));
        assert.strictEqual(result.values.some((value) => value.name === 'service_time_unit'), false);
    });
});
