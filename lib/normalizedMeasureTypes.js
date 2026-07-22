'use strict';

/**
 * Return a device snapshot whose active attribute types agree with the
 * normalized measures that will be sent to Orion.
 *
 * iotagent-node-lib rebuilds outgoing measures from device.active and, when a
 * measure matches a provisioned object_id, otherwise replaces the type chosen
 * by the telemetry normalizer. Cloning keeps that library behaviour isolated
 * from the persisted device registration while allowing bounded values to be
 * emitted as Number attributes.
 *
 * @param {Object} device Provisioned IoT Agent device.
 * @param {Array} values Normalized NGSI measures.
 * @return {Object} The original device when no override is required, otherwise
 *                  a shallow clone with a cloned active array.
 */
function withNormalizedMeasureTypes(device, values) {
    if (!device || !Array.isArray(device.active) || !Array.isArray(values)) {
        return device;
    }

    const normalizedTypeByName = new Map();
    for (const value of values) {
        const name = typeof value?.name === 'string' ? value.name.trim() : '';
        const type = typeof value?.type === 'string' ? value.type.trim() : '';
        if (name && type) normalizedTypeByName.set(name, type);
    }

    let changed = false;
    const active = device.active.map((attribute) => {
        if (!attribute || typeof attribute !== 'object') return attribute;

        const objectId = typeof attribute.object_id === 'string' ? attribute.object_id.trim() : '';
        const name = typeof attribute.name === 'string' ? attribute.name.trim() : '';
        const normalizedType = normalizedTypeByName.get(objectId) || normalizedTypeByName.get(name);
        if (!normalizedType || normalizedType === attribute.type) return attribute;

        changed = true;
        return { ...attribute, type: normalizedType };
    });

    return changed ? { ...device, active } : device;
}

module.exports = {
    withNormalizedMeasureTypes
};
