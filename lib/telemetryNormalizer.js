'use strict';

const NUMBER_TYPE = 'Number';
const KNOWN_BOUNDED_KEYS = new Set(['value', 'minimum', 'maximum']);

function asPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

function createTelemetryNormalizer(options = {}) {
    const maxEntries = asPositiveInteger(options.maxEntries, 10000);
    const stateByMetric = new Map();

    function metricKey(deviceId, attribute) {
        return `${deviceId}\u0000${attribute}`;
    }

    function peekState(key) {
        return stateByMetric.get(key) || null;
    }

    function getOrCreateState(key, warnings) {
        const current = stateByMetric.get(key);
        if (current) {
            stateByMetric.delete(key);
            stateByMetric.set(key, current);
            return current;
        }

        if (stateByMetric.size >= maxEntries) {
            const oldestKey = stateByMetric.keys().next().value;
            if (oldestKey !== undefined) {
                stateByMetric.delete(oldestKey);
                warnings.push({
                    code: 'limit-cache-evicted',
                    detail: 'The oldest bounded-telemetry cache entry was evicted.'
                });
            }
        }

        const created = {
            bounded: true,
            hasMinimum: false,
            minimum: undefined,
            hasMaximum: false,
            maximum: undefined
        };
        stateByMetric.set(key, created);
        return created;
    }

    function normalizeLimit({ payload, field, attribute, state, values, warnings }) {
        if (!Object.prototype.hasOwnProperty.call(payload, field)) {
            const stateFlag = field === 'minimum' ? 'hasMinimum' : 'hasMaximum';
            if (state[stateFlag]) {
                warnings.push({
                    code: `missing-${field}`,
                    detail: `${field} is missing; the previous valid limit was preserved.`
                });
            }
            return;
        }

        const numeric = toFiniteNumber(payload[field]);
        if (numeric === null) {
            warnings.push({
                code: `invalid-${field}`,
                detail: `${field} is not a finite number and was ignored.`
            });
            return;
        }

        const stateFlag = field === 'minimum' ? 'hasMinimum' : 'hasMaximum';
        if (!state[stateFlag] || !Object.is(state[field], numeric)) {
            values.push({
                name: `${attribute}_${field}`,
                type: NUMBER_TYPE,
                value: numeric
            });
            state[stateFlag] = true;
            state[field] = numeric;
        }
    }

    function normalize({ deviceId = '', attribute = '', value, provisionedType = 'Text' }) {
        const warnings = [];
        const key = metricKey(deviceId, attribute);
        const knownState = peekState(key);
        const plainObject = isPlainObject(value);
        const hasValue = plainObject && Object.prototype.hasOwnProperty.call(value, 'value');
        const hasLimitKey =
            plainObject &&
            (Object.prototype.hasOwnProperty.call(value, 'minimum') ||
                Object.prototype.hasOwnProperty.call(value, 'maximum'));
        const boundedPayload = Boolean(knownState) || hasLimitKey;

        if (!boundedPayload) {
            return {
                values: [{ name: attribute, type: provisionedType, value }],
                warnings,
                bounded: false
            };
        }

        const state = knownState || getOrCreateState(key, warnings);
        if (!plainObject || !hasValue) {
            warnings.push({
                code: 'invalid-value',
                detail: 'A bounded telemetry payload is missing a valid value field.'
            });
            return { values: [], warnings, bounded: true };
        }

        const extraFields = Object.keys(value).filter((field) => !KNOWN_BOUNDED_KEYS.has(field));
        if (extraFields.length) {
            warnings.push({
                code: 'ignored-fields',
                detail: `Unsupported fields were ignored: ${extraFields.sort().join(', ')}.`
            });
        }

        const numericValue = toFiniteNumber(value.value);
        if (numericValue === null) {
            warnings.push({
                code: 'invalid-value',
                detail: 'value is not a finite number and the metric update was ignored.'
            });
            return { values: [], warnings, bounded: true };
        }

        const values = [{ name: attribute, type: NUMBER_TYPE, value: numericValue }];
        normalizeLimit({ payload: value, field: 'minimum', attribute, state, values, warnings });
        normalizeLimit({ payload: value, field: 'maximum', attribute, state, values, warnings });

        return { values, warnings, bounded: true };
    }

    function reset() {
        stateByMetric.clear();
    }

    function getStats() {
        return {
            entries: stateByMetric.size,
            maxEntries
        };
    }

    return {
        normalize,
        reset,
        getStats
    };
}

module.exports = {
    createTelemetryNormalizer,
    isPlainObject,
    toFiniteNumber
};
