'use strict';

const assert = require('assert');
const { withNormalizedMeasureTypes } = require('../../lib/normalizedMeasureTypes');

describe('normalizedMeasureTypes', function () {
    it('lets a normalized Number override a provisioned StructuredValue', function () {
        const device = {
            id: 'machine-1',
            active: [
                { object_id: 'service_time', name: 'service_time', type: 'StructuredValue' },
                { object_id: 'diagnostics', name: 'diagnostics', type: 'StructuredValue' }
            ]
        };

        const result = withNormalizedMeasureTypes(device, [
            { name: 'service_time', type: 'Number', value: 42 },
            { name: 'service_time_maximum', type: 'Number', value: 90 }
        ]);

        assert.notStrictEqual(result, device);
        assert.strictEqual(result.active[0].type, 'Number');
        assert.strictEqual(result.active[1].type, 'StructuredValue');
        assert.strictEqual(device.active[0].type, 'StructuredValue');
    });

    it('matches the MQTT measure name against object_id when NGSI name differs', function () {
        const device = {
            active: [{ object_id: 'raw/service_time', name: 'serviceTime', type: 'StructuredValue' }]
        };

        const result = withNormalizedMeasureTypes(device, [
            { name: 'raw/service_time', type: 'Number', value: 42 }
        ]);

        assert.strictEqual(result.active[0].type, 'Number');
    });

    it('returns the original device when no type needs to change', function () {
        const device = {
            active: [{ object_id: 'temperature', name: 'temperature', type: 'Number' }]
        };

        const result = withNormalizedMeasureTypes(device, [
            { name: 'temperature', type: 'Number', value: 21 }
        ]);

        assert.strictEqual(result, device);
    });
});
