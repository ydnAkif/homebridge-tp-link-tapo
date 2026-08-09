# Homebridge TP-Link Tapo

## ydnAkif resilience build

This fork keeps physically switched Tapo lights responsive without overloading
low-powered Homebridge hosts. Offline devices receive a lightweight TCP probe
every 10 seconds. The encrypted Tapo handshake only starts after the device is
reachable, so a powered-on bulb normally returns to HomeKit shortly after its
network stack finishes booting. Repeated offline log messages are throttled for
10 minutes without slowing the reachability probes.

## This plugin has been archived and it will no longer receive updates

[![Build and Lint](https://github.com/RaresAil/homebridge-tp-link-tapo/actions/workflows/build.yml/badge.svg)](https://github.com/RaresAil/homebridge-tp-link-tapo/actions/workflows/build.yml)
[![CodeQL](https://github.com/RaresAil/homebridge-tp-link-tapo/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/RaresAil/homebridge-tp-link-tapo/actions/workflows/codeql-analysis.yml)

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
![Snyk Vulnerabilities for npm package](https://img.shields.io/snyk/vulnerabilities/npm/homebridge-tp-link-tapo)
![npm](https://img.shields.io/npm/dm/homebridge-tp-link-tapo)

I recommend to use the platform as a Child Bridge for the best performance.

Most of the time the response time between the app and the device is 80ms.
With the official app i measured around 1s to 2s as a response time.

### Migrate to V3

The platform name was changed to `HomebridgeTPLinkTapo` from HomebridgeTPLinkLights

Package was renamed from `homebridge-tplink-smart-light` to `homebridge-tp-link-tapo`

### Current device types

- Socket/Outlet (For devices with power measurement, they have a contact sensor, open means the current is > 0 and closed is 0)
- Hub (As alarm)
- Button S200
- Contact Sensor (T110)
- Light Bulb
- LED Strip

For other device type just open a issue.

### Config

You can add multiple devices bulbs with a single platform.

```json
{
  "platforms": [
    {
      "platform": "HomebridgeTPLinkTapo",
      "name": "TPLink Tapo Platform",
      "email": "tplink-email",
      "password": "tplink-password",
      "addresses": ["192.168.x.x (the ip address of the device)"]
    }
  ]
}
```
