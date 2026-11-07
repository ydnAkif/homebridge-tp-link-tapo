Tapo stability 4.1.4-ydnakif.1

Concurrent HomeKit reads share one device request and a 500 ms cache. Reads return a HomeKit communication error within 1.5 seconds when a device is unavailable. Failed reads retry after 30 seconds and never synthesize off/100% values. An outstanding transport request remains shared until it finishes. Legacy and KLAP HTTP requests time out after 2.5 seconds. Successful writes invalidate the read cache.

Validation: npm test (5 regression tests). Runtime dependencies are unchanged.

## 2026-11-07 audit fixes

Power state is updated only after acknowledgment; identical power requests are transmitted again so an earlier failure cannot suppress recovery. Failed commands and missing child responses raise errors rather than fabricate data. Late successful reads refresh the cache and reset cooldown. Pending lock acquisition is bounded (10 seconds, 20 queued operations). Cached live characteristics report communication failure until the real handler is registered; static names and capabilities are preserved. Wall-switch-off bulbs remain expected offline devices.

Legacy handshake transport failures also use the existing platform offline warning instead of repeated stack dumps. Explicit authentication/protocol errors retain their normal diagnostic handling.
