Tapo stability 4.1.4-ydnakif.1

Concurrent HomeKit reads share one device request and a 500 ms cache. Reads return a HomeKit communication error within 1.5 seconds when a device is unavailable. Failed reads retry after 30 seconds and never synthesize off/100% values. An outstanding transport request remains shared until it finishes. Legacy and KLAP HTTP requests time out after 2.5 seconds. Successful writes invalidate the read cache.

Validation: npm test (5 regression tests). Runtime dependencies are unchanged.
