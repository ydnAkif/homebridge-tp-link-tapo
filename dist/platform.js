"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Accessory_1 = __importStar(require("./@types/Accessory"));
const settings_1 = require("./settings");
const TPLink_1 = __importDefault(require("./api/TPLink"));
const Hub_1 = __importDefault(require("./accessories/Hub"));
const LightBulb_1 = __importDefault(require("./accessories/LightBulb"));
const Outlet_1 = __importDefault(require("./accessories/Outlet"));
const Button_1 = __importDefault(require("./accessories/Button"));
const Contact_1 = __importDefault(require("./accessories/Contact"));
const MotionSensor_1 = __importDefault(require("./accessories/MotionSensor"));
class Platform {
    getConfiguredAddresses() {
        var _a;
        const rawAddresses = (_a = this.config) === null || _a === void 0 ? void 0 : _a.addresses;
        if (!Array.isArray(rawAddresses)) {
            return [];
        }
        return rawAddresses
            .map((entry) => {
            var _a, _b, _c, _d;
            if (typeof entry === 'string') {
                return {
                    ip: entry.trim()
                };
            }
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            const ip = String((_b = (_a = entry.ip) !== null && _a !== void 0 ? _a : entry.address) !== null && _b !== void 0 ? _b : '').trim();
            const configuredName = String((_d = (_c = entry.alias) !== null && _c !== void 0 ? _c : entry.name) !== null && _d !== void 0 ? _d : '').trim();
            if (!ip) {
                return null;
            }
            return {
                ip,
                ...(configuredName ? { configuredName } : {})
            };
        })
            .filter((item) => Boolean(item === null || item === void 0 ? void 0 : item.ip));
    }
    decodeNickname(nickname) {
        if (!nickname) {
            return '';
        }
        try {
            const decoded = Buffer.from(nickname, 'base64').toString('utf-8').trim();
            return decoded === 'No Name' ? '' : decoded;
        }
        catch (_a) {
            return '';
        }
    }
    getDeviceLabel(ip, configuredName, deviceInfo) {
        var _a;
        const name = (configuredName === null || configuredName === void 0 ? void 0 : configuredName.trim()) ||
            this.decodeNickname(deviceInfo === null || deviceInfo === void 0 ? void 0 : deviceInfo.nickname) ||
            ((_a = deviceInfo === null || deviceInfo === void 0 ? void 0 : deviceInfo.model) === null || _a === void 0 ? void 0 : _a.trim()) ||
            '';
        return name ? `${name} (${ip})` : ip;
    }
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.TIMEOUT_TRIES = 20;
        this.REDISCOVER_INTERVAL_MS = 30 * 1000;
        this.OFFLINE_LOG_THROTTLE_MS = 10 * 60 * 1000;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.accessories = [];
        this.loadedChildUUIDs = {};
        this.registeredDevices = [];
        this.hubs = [];
        this.inFlightDeviceLoads = {};
        this.lastOfflineLogAt = {};
        this.offlineDevices = {};
        this.deviceRetry = {};
        this.accessoryClasses = {
            [Accessory_1.AccessoryType.LightBulb]: LightBulb_1.default,
            [Accessory_1.AccessoryType.Outlet]: Outlet_1.default,
            [Accessory_1.AccessoryType.Hub]: Hub_1.default
        };
        this.childClasses = {
            [Accessory_1.ChildType.Button]: Button_1.default,
            [Accessory_1.ChildType.Contact]: Contact_1.default,
            [Accessory_1.ChildType.MotionSensor]: MotionSensor_1.default
        };
        this.log.debug('Finished initializing platform:', this.config.name);
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            this.discoverDevices();
        });
    }
    configureAccessory(accessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        this.accessories.push(accessory);
        for (const service of accessory.services) {
            if (service.UUID === this.api.hap.Service.AccessoryInformation.UUID)
                continue;
            for (const characteristic of service.characteristics) {
                const liveTypes = [this.api.hap.Characteristic.On, this.api.hap.Characteristic.Brightness, this.api.hap.Characteristic.Hue, this.api.hap.Characteristic.Saturation, this.api.hap.Characteristic.ColorTemperature, this.api.hap.Characteristic.CurrentTemperature, this.api.hap.Characteristic.CurrentRelativeHumidity, this.api.hap.Characteristic.BatteryLevel, this.api.hap.Characteristic.OutletInUse];
                if (liveTypes.some(type => type.UUID === characteristic.UUID)) {
                    characteristic.onGet(() => { throw new this.api.hap.HapStatusError(-70402 /* this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */); });
                }
            }
        }
    }
    async discoverDevices() {
        var _a;
        try {
            const { email, password } = (_a = this.config) !== null && _a !== void 0 ? _a : {};
            const addresses = this.getConfiguredAddresses();
            if (!email ||
                !password ||
                !addresses ||
                !Array.isArray(addresses) ||
                addresses.length <= 0) {
                if (this.accessories.length > 0) {
                    this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, this.accessories);
                }
                return;
            }
            await Promise.all(addresses.map((address) => this.loadDevice(address, email, password)));
            await Promise.all(this.hubs.map(async (hub) => {
                const devices = await hub.getChildDevices();
                await Promise.all(devices.map((device) => {
                    if (Object.keys(device || {}).length === 0) {
                        return Promise.resolve();
                    }
                    this.loadedChildUUIDs[this.api.hap.uuid.generate(device.device_id)] = true;
                    return this.loadChildDevice(device.device_id, device, hub);
                }));
            }));
            this.checkOldDevices();
            this.startRediscovery(addresses, email, password);
        }
        catch (err) {
            this.log.error('Failed to discover devices:', err.message);
        }
    }
    startRediscovery(addresses, email, password) {
        if (this.rediscoverTimer) {
            return;
        }
        this.rediscoverTimer = setInterval(() => {
            var _a;
            for (const { ip, configuredName } of addresses) {
                const uuid = this.api.hap.uuid.generate(ip);
                const isRegistered = this.registeredDevices.some((device) => device.UUID === uuid);
                if (isRegistered) {
                    continue;
                }
                if (((_a = this.deviceRetry[uuid]) !== null && _a !== void 0 ? _a : 0) <= 0) {
                    // Reset retry budget for long-running bridge sessions.
                    this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
                }
                void this.loadDevice({ ip, configuredName }, email, password);
            }
        }, this.REDISCOVER_INTERVAL_MS);
    }
    logOfflineDevice(suppressionKey, deviceLabel, error) {
        var _a;
        const now = Date.now();
        const last = (_a = this.lastOfflineLogAt[suppressionKey]) !== null && _a !== void 0 ? _a : 0;
        const errorMessage = (error === null || error === void 0 ? void 0 : error.message) || error;
        this.offlineDevices[suppressionKey] = true;
        if (now - last >= this.OFFLINE_LOG_THROTTLE_MS) {
            this.lastOfflineLogAt[suppressionKey] = now;
            const baseMessage = `${deviceLabel} unreachable; suppressing repeated logs for 10 minutes.`;
            this.log.warn(baseMessage);
            return;
        }
        this.log.debug('[Offline/Suppressed]', deviceLabel, errorMessage || '');
    }
    logDeviceOnlineAgain(suppressionKey, deviceLabel) {
        if (!this.offlineDevices[suppressionKey]) {
            return;
        }
        delete this.offlineDevices[suppressionKey];
        this.log.info(`${deviceLabel} online again.`);
    }
    async loadDevice(address, email, password) {
        const { ip, configuredName } = address;
        const uuid = this.api.hap.uuid.generate(ip);
        if (this.inFlightDeviceLoads[uuid]) {
            return;
        }
        this.inFlightDeviceLoads[uuid] = true;
        if (this.deviceRetry[uuid] === undefined) {
            this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
        }
        else if (this.deviceRetry[uuid] <= 0) {
            this.log.debug('Retry budget reached for now:', ip);
            delete this.inFlightDeviceLoads[uuid];
            return;
        }
        try {
            const tpLink = await new TPLink_1.default(ip, email, password, this.log, () => new this.api.hap.HapStatusError(-70402 /* this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */)).setup();
            const deviceInfo = await tpLink.getInfo();
            if (Object.keys(deviceInfo || {}).length === 0) {
                this.deviceRetry[uuid] -= 1;
                const deviceLabel = this.getDeviceLabel(ip, configuredName);
                this.logOfflineDevice(ip, deviceLabel);
                delete this.inFlightDeviceLoads[uuid];
                return;
            }
            this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
            const deviceLabel = this.getDeviceLabel(ip, configuredName, deviceInfo);
            this.logDeviceOnlineAgain(ip, deviceLabel);
            const deviceName = Buffer.from((deviceInfo === null || deviceInfo === void 0 ? void 0 : deviceInfo.nickname) || 'Tm8gTmFtZQ==', 'base64').toString('utf-8');
            const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
            if (existingAccessory) {
                this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
                existingAccessory.context = {
                    name: deviceName,
                    tpLink,
                    child: false
                };
                const registeredAccessory = this.registerAccessory(existingAccessory, deviceInfo);
                if (!registeredAccessory) {
                    this.log.error('Failed to register accessory "%s" of type "%s" (%s)', deviceName, Accessory_1.default.GetType(deviceInfo), deviceInfo === null || deviceInfo === void 0 ? void 0 : deviceInfo.type);
                    delete this.inFlightDeviceLoads[uuid];
                    return;
                }
                this.registeredDevices.push(registeredAccessory);
                delete this.inFlightDeviceLoads[uuid];
                return;
            }
            this.log.info('Adding new accessory:', deviceName);
            const accessory = new this.api.platformAccessory(deviceName, uuid);
            accessory.context = {
                name: deviceName,
                tpLink,
                child: false
            };
            const registeredAccessory = this.registerAccessory(accessory, deviceInfo);
            if (!registeredAccessory) {
                this.log.error('Failed to register accessory "%s" of type "%s" (%s)', deviceName, Accessory_1.default.GetType(deviceInfo), deviceInfo === null || deviceInfo === void 0 ? void 0 : deviceInfo.type);
                delete this.inFlightDeviceLoads[uuid];
                return;
            }
            this.registeredDevices.push(registeredAccessory);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                accessory
            ]);
            delete this.inFlightDeviceLoads[uuid];
            return;
        }
        catch (err) {
            this.deviceRetry[uuid] -= 1;
            const deviceLabel = this.getDeviceLabel(ip, configuredName);
            this.logOfflineDevice(ip, deviceLabel, err);
            delete this.inFlightDeviceLoads[uuid];
            return;
        }
    }
    async loadChildDevice(id, deviceInfo, parent) {
        const uuid = this.api.hap.uuid.generate(id);
        if (this.deviceRetry[uuid] === undefined) {
            this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
        }
        else if (this.deviceRetry[uuid] <= 0) {
            this.log.debug('Retry budget reached for child:', id);
            return;
        }
        try {
            const deviceName = Buffer.from(deviceInfo.nickname || 'Tm8gTmFtZQ==', 'base64').toString('utf-8');
            const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
            if (existingAccessory) {
                this.log.info('Restoring existing child accessory from cache:', existingAccessory.displayName);
                existingAccessory.context = {
                    name: deviceName,
                    child: true,
                    parent: parent.UUID
                };
                const registeredAccessory = this.registerChild(existingAccessory, deviceInfo, parent);
                if (!registeredAccessory) {
                    this.log.error('Failed to register child accessory "%s" of type "%s" (%s)', deviceName, Accessory_1.default.GetChildType(deviceInfo), deviceInfo === null || deviceInfo === void 0 ? void 0 : deviceInfo.type);
                    return;
                }
                this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
                this.registeredDevices.push(registeredAccessory);
                return;
            }
            this.log.info('Adding new child accessory:', deviceName);
            const accessory = new this.api.platformAccessory(deviceName, uuid);
            accessory.context = {
                name: deviceName,
                child: true,
                parent: parent.UUID
            };
            const registeredAccessory = this.registerChild(accessory, deviceInfo, parent);
            if (!registeredAccessory) {
                this.log.error('Failed to register child accessory "%s" of type "%s" (%s)', deviceName, Accessory_1.default.GetChildType(deviceInfo), deviceInfo === null || deviceInfo === void 0 ? void 0 : deviceInfo.type);
                return;
            }
            this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
            this.registeredDevices.push(registeredAccessory);
            return this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                accessory
            ]);
        }
        catch (err) {
            this.deviceRetry[uuid] -= 1;
            this.logOfflineDevice(id, id, err);
            return;
        }
    }
    checkOldDevices() {
        const addressesByUUID = this.getConfiguredAddresses().reduce((acc, ip) => ({
            ...acc,
            [this.api.hap.uuid.generate(ip.ip)]: ip.ip
        }), {});
        this.accessories.map((accessory) => {
            const deleteDevice = (!accessory.context.child &&
                !addressesByUUID[accessory.UUID.toString()]) ||
                (accessory.context.child &&
                    !addressesByUUID[accessory.context.parent]) ||
                (accessory.context.child &&
                    addressesByUUID[accessory.context.parent] &&
                    !this.loadedChildUUIDs[accessory.UUID.toString()]);
            if (deleteDevice) {
                this.log.info('Remove cached accessory:', accessory.displayName);
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                    accessory
                ]);
            }
        });
    }
    registerAccessory(accessory, deviceInfo) {
        const AccessoryClass = this.accessoryClasses[Accessory_1.default.GetType(deviceInfo)];
        if (!AccessoryClass) {
            return null;
        }
        const acc = new AccessoryClass(this, accessory, this.log, deviceInfo);
        if (acc instanceof Hub_1.default) {
            this.hubs.push(acc);
        }
        return acc;
    }
    registerChild(accessory, deviceInfo, parent) {
        const ChildClass = this.childClasses[Accessory_1.default.GetChildType(deviceInfo)];
        if (!ChildClass) {
            return null;
        }
        return new ChildClass(parent, this, accessory, this.log, deviceInfo);
    }
}
exports.default = Platform;
//# sourceMappingURL=platform.js.map