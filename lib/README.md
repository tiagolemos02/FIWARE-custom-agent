# MTEXNS FIWARE Custom Agent changes

This directory contains the MQTT telemetry changes used by the MTEXNS Digital Twin deployment. The changes are intentionally implemented inside the existing FIWARE custom IoT Agent so the real machines can keep their current MQTT payload contract.

## Why this change exists

Some machine metrics are published as JSON objects instead of scalar values:

```json
{"value":"42","minimum":"0","maximum":"90"}
```

The operational value must be queryable as a numeric NGSI attribute, while the static limits must remain available for preventive and predictive maintenance. The previous generic object path treated the object as multiple measures and could create unbounded in-memory work under sustained MQTT traffic.

## Resulting NGSI attributes

For a provisioned telemetry attribute named `print_bar_time_since_last_pm`, the agent produces:

| NGSI attribute | Type | Source |
| --- | --- | --- |
| `print_bar_time_since_last_pm` | `Number` | `value` |
| `print_bar_time_since_last_pm_minimum` | `Number` | `minimum`, when supplied |
| `print_bar_time_since_last_pm_maximum` | `Number` | `maximum`, when supplied |

Numeric strings are converted to finite JavaScript numbers. The base attribute keeps its original name so existing dashboards and historical queries can use the operational value directly.

Objects and arrays that do not match this bounded metric shape continue to be sent as a single `StructuredValue`. Plain non-JSON MQTT payloads remain UTF-8 text.

## Validation rules

- A bounded metric requires a finite numeric `value`.
- `minimum` and `maximum` are optional, but must be finite numbers when present.
- An invalid `value` rejects that metric update and preserves the last Orion value.
- A missing or invalid previously known limit preserves the last valid limit and emits a rate-limited warning.
- Limits are sent on first observation and then only when their numeric value changes.
- Extra object fields, such as `unit`, are ignored and produce a rate-limited warning.
- Warning logs identify the device, attribute and rule, but never include the MQTT payload.

The bounded-metric recognition cache is a size-limited LRU cache. This prevents memory growth when many device/attribute combinations are observed.

## Backpressure and ordering

`bindings/MQTTBinding.js` uses `telemetryQueue.js` before invoking the Context Broker update path:

- pending telemetry is coalesced by `deviceId + attribute`, keeping only the newest pending value;
- updates for one machine are processed in order;
- different machines can be processed concurrently;
- global concurrency and pending unique metric pairs are bounded;
- oversize MQTT payloads are rejected before parsing;
- queue counters are logged periodically;
- shutdown stops accepting work and drains for a bounded interval.

Control messages (`config`, `cmd`, and `cmdexe`) are not coalesced.

## Files changed

- `commonBindings.js`: single-message parsing, bounded-metric normalization and one transaction completion path.
- `bindings/MQTTBinding.js`: bounded queue, coalescing, payload limit, warning throttling, statistics and graceful shutdown.
- `telemetryNormalizer.js`: pure bounded-metric conversion and limit cache.
- `telemetryQueue.js`: bounded per-machine work scheduler.
- `warningLimiter.js`: size-limited warning rate limiter.
- `deviceDiscovery.js`: bounded, service-group-neutral registry of Device IDs observed on MQTT.
- `configService.js`: environment configuration for the new limits.
- `constants.js`: safe defaults.
- `commandHandler.js`: optional completion callback so queue work has a reliable end signal.

## Configuration

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `IOTA_MQTT_UPDATE_CONCURRENCY` | `10` | Maximum Context Broker updates in progress globally |
| `IOTA_MQTT_MAX_PENDING` | `1000` | Maximum pending unique machine/attribute pairs |
| `IOTA_MQTT_MAX_PAYLOAD_BYTES` | `262144` | Maximum MQTT payload size, in bytes |
| `IOTA_MQTT_LIMIT_CACHE_MAX_ENTRIES` | `10000` | Maximum bounded-metric and warning-cache entries |
| `IOTA_MQTT_WARNING_INTERVAL_MS` | `300000` | Minimum interval between equal warnings |
| `IOTA_MQTT_QUEUE_LOG_INTERVAL_MS` | `60000` | Queue statistics log interval |
| `IOTA_MQTT_SHUTDOWN_TIMEOUT_MS` | `5000` | Maximum queue drain time during shutdown |
| `IOTA_MQTT_DISCOVERY_TTL_MS` | `3600000` | Time an unprovisioned MQTT Device ID remains discoverable |
| `IOTA_MQTT_DISCOVERY_MAX_ENTRIES` | `1000` | Maximum unprovisioned Device IDs retained in memory |

## Runtime configuration safety

The repository `config.js` now contains environment-neutral defaults: plain MQTT on `localhost:1883`, no embedded
broker credentials or certificate paths, and AMQP disabled. Docker deployments must supply environment-specific
connection details. The Digital Twin Compose file explicitly selects `mqtt` and disables AMQP because its Mosquitto
service listens on port `1883` without TLS and no AMQP broker is deployed.

MTEXNS state topics use `<deviceId>/state/<attribute>` and therefore contain no API key. An empty API key performs a
global lookup for exactly one Device ID. Existing devices keep their provisioned service, subservice, entity name,
attributes and types. Multiple global matches are rejected because a keyless topic cannot determine which FIWARE
context owns the Device ID.

Unknown IDs are recorded in a bounded, one-hour discovery registry instead of being auto-provisioned into an arbitrary
service group. The portal lists these neutral IDs under **Available Device IDs** for every service-group selection. The
operator chooses the correct group and explicitly saves the machine; only then does normal telemetry ingestion begin.
This supports `/iot/json` and any other registered resource without changing the machine topic contract.

## Docker build

`../docker/Dockerfile` now builds the checked-out repository instead of downloading a GitHub branch. It uses the explicit `node:16.20.2-bullseye` and `node:16.20.2-bullseye-slim` bases and pins `iotagent-node-lib` to commit `78ad1289f5b4b3c1b611cae07d295f091e04788b`. The same immutable tarball URL is stored in the repository `package.json`, so local development, GitHub Actions, and Docker resolve the compatible `4.7.0-next` library instead of the moving `master` branch. Installing the tarball does not require `git` or `apt-get`.

Run the Docker build only from the complete custom-agent repository root, using the Dockerfile in `docker/`. The partial copy in this project is a transfer workspace and does not contain the complete upstream repository.

The intended image tag is:

```text
lemostiago/custom-iotagent:3.7.1-mtexns
```

## Test gate

Unit tests for the normalizer and queue belong in the complete custom-agent repository and must be run there before publishing the image. The Digital Twin project must not recreate or integration-test the IoT Agent container until that image has been manually built and published by its owner.

This code only normalizes and transports telemetry. It does not calculate maintenance predictions.
