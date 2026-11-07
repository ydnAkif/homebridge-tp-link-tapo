"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const async_lock_1 = __importDefault(require("async-lock"));
const Protocol_1 = __importDefault(require("./@types/Protocol"));
const LegacyAPI_1 = __importDefault(require("./LegacyAPI"));
const commands_1 = __importDefault(require("./commands"));
const KlapAPI_1 = __importDefault(require("./KlapAPI"));
class TPLink {
    get protocol() {
        return this._protocol;
    }
    constructor(ip, email, password, log, unavailableError = () => new Error("Tapo device unavailable")) {
        this.ip = ip;
        this.email = email;
        this.password = password;
        this.log = log;
        this.unavailableError = unavailableError;
        this._protocol = Protocol_1.default.Legacy;
        this.classSetup = false;
        this.tryResendCommand = false;
        this.NETWORK_ERROR_LOG_THROTTLE_MS = 10 * 60 * 1000;
        this.transientNetworkErrorCodes = new Set([
            'EHOSTUNREACH',
            'ENETUNREACH',
            'EHOSTDOWN',
            'ECONNREFUSED',
            'ECONNRESET',
            'ECONNABORTED',
            'ETIMEDOUT',
            'ESOCKETTIMEDOUT'
        ]);
        this.lastTransientNetworkLogAt = {};
        this._unsentData = {};
        this.commandCache = {};
        this.infoRetryAfter = 0;
        this.childInfoCache = {};
        this.lock = new async_lock_1.default({ timeout: 10000, maxPending: 20 });
        this.api = new LegacyAPI_1.default(ip, email, password, log);
    }
    async setup() {
        try {
            if (this.classSetup) {
                return this;
            }
            await this.api.setup();
            this._protocol = await this.checkProtocol();
            if (this._protocol === Protocol_1.default.KLAP) {
                this.api = new KlapAPI_1.default(this.ip, this.email, this.password, this.log);
                await this.api.setup();
            }
            this.classSetup = true;
        }
        catch (e) {
            if (!this.isOfflineSuppressionError(e)) {
                this.log.error('Error setting up TPLink class:', e);
            }
        }
        return this;
    }
    async cacheSendCommand(deviceId, command, ...args) {
        const cacheKey = `${deviceId}-${command}`;
        return this.lock.acquire(`cache-${cacheKey}`, async () => {
            if (this.commandCache[cacheKey.toString()] &&
                Date.now() - this.commandCache[cacheKey.toString()].setAt < 100) {
                return this.commandCache[cacheKey.toString()].data;
            }
            const response = await this.sendCommand(command, ...args);
            if (response === null || response === undefined || response === false)
                throw this.unavailableError();
            this.commandCache[cacheKey.toString()] = {
                data: response,
                setAt: Date.now()
            };
            return response;
        });
    }
    getInfo() {
        if (this.infoCache && Date.now() - this.infoCache.setAt < 500) {
            return Promise.resolve(this.infoCache.data);
        }
        if (this.infoInFlight)
            return this.infoInFlight;
        if (Date.now() < this.infoRetryAfter)
            return Promise.reject(this.unavailableError());
        const request = this.sendCommand('deviceInfo').then(deviceInfo => {
            if (!deviceInfo || typeof deviceInfo !== 'object' || !deviceInfo.device_id)
                throw this.unavailableError();
            this.infoCache = { data: deviceInfo, setAt: Date.now() };
            this.infoRetryAfter = 0;
            this._prevPowerState = deviceInfo.device_on;
            return deviceInfo;
        });
        let timer;
        const deadline = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(this.unavailableError()), 1500);
        });
        const pending = Promise.race([request, deadline]).then((deviceInfo) => {
            var _a;
            if (!deviceInfo || typeof deviceInfo !== 'object' || !deviceInfo.device_id) {
                throw this.unavailableError();
            }
            this.infoCache = { data: deviceInfo, setAt: Date.now() };
            this.infoRetryAfter = 0;
            this._prevPowerState = (_a = deviceInfo.device_on) !== null && _a !== void 0 ? _a : false;
            return deviceInfo;
        }).catch(() => {
            this.infoRetryAfter = Date.now() + 30000;
            throw this.unavailableError();
        }).finally(() => clearTimeout(timer));
        this.infoInFlight = pending;
        // Keep sharing the same result until the actual I/O ends, even after the
        // HomeKit deadline. A hung request must not build an unbounded lock queue.
        const release = () => {
            const clear = () => {
                if (this.infoInFlight === pending)
                    this.infoInFlight = undefined;
            };
            void pending.then(clear, clear);
        };
        void request.then(release, release);
        return pending;
    }
    async getChildInfo(childId) {
        return this.lock.acquire('get-child-info-cache', async () => {
            var _a;
            if (this.childInfoCache[childId.toString()] &&
                Date.now() - this.childInfoCache[childId.toString()].setAt < 10000) {
                return this.childInfoCache[childId.toString()].data;
            }
            const rawInfo = await this.sendCommand('childDeviceInfo', childId);
            const deviceInfo = (_a = rawInfo === null || rawInfo === void 0 ? void 0 : rawInfo.responseData) === null || _a === void 0 ? void 0 : _a.result;
            if (!deviceInfo || typeof deviceInfo !== 'object' || Object.keys(deviceInfo).length === 0)
                throw this.unavailableError();
            this.childInfoCache[childId.toString()] = {
                data: deviceInfo,
                setAt: Date.now()
            };
            return deviceInfo;
        });
    }
    async sendCommand(command, ...args) {
        return this.lock.acquire('send-command', async () => {
            const desiredPower = command === 'power' ? args[0] : this._prevPowerState;
            const response = await this.sendCommandWithNoLock(command, args, desiredPower);
            if (response === null || response === false || response === undefined)
                throw this.unavailableError();
            if (command === 'power')
                this._prevPowerState = desiredPower;
            return response;
        });
    }
    async sendHubCommand(command, childId, ...args) {
        return this.lock.acquire(`send-hub-command-${childId}`, () => {
            return this.sendCommandWithNoLock(command, args, false);
        });
    }
    async sendCommandWithNoLock(command, args, isDeviceOn = false) {
        var _a;
        try {
            if (!commands_1.default[command.toString()]) {
                return false;
            }
            if (this.api.needsNewHandshake() || this.tryResendCommand) {
                if (this.tryResendCommand) {
                    this.log.info('Trying to login again.');
                }
                await this.api.login();
            }
            const { __method__, ...params } = commands_1.default[command.toString()](...args);
            const validMethod = __method__ !== null && __method__ !== void 0 ? __method__ : 'set_device_info';
            if (!isDeviceOn && validMethod === 'set_device_info') {
                const paramsToCache = { ...params };
                delete paramsToCache.device_on;
                if (command === 'colorTemp') {
                    delete this._unsentData.saturation;
                    delete this._unsentData.hue;
                }
                this._unsentData = {
                    ...this._unsentData,
                    ...paramsToCache
                };
                if (command !== 'power') {
                    this.tryResendCommand = false;
                    return true;
                }
            }
            const extraData = isDeviceOn && validMethod === 'set_device_info'
                ? { ...this._unsentData }
                : {};
            const { body } = await this.api.sendSecureRequest(validMethod, {
                ...extraData,
                ...params
            }, true, false);
            if (body.error_code && body.error_code !== 0) {
                if (!this.tryResendCommand) {
                    if (`${body.error_code}` === '9999') {
                        this.tryResendCommand = true;
                        this.log.info('Session expired');
                        return this.sendCommandWithNoLock(command, args, isDeviceOn);
                    }
                    if (`${body.error_code}` === '-1301') {
                        this.tryResendCommand = true;
                        this.log.info('Rate limit exceeded. Renewing session.');
                        return this.sendCommandWithNoLock(command, args, isDeviceOn);
                    }
                }
                throw this.unavailableError();
            }
            if (isDeviceOn)
                this._unsentData = {};
            if (validMethod === 'set_device_info') {
                this.infoCache = undefined;
                this.infoRetryAfter = 0;
            }
            this.tryResendCommand = false;
            return ((_a = body === null || body === void 0 ? void 0 : body.result) !== null && _a !== void 0 ? _a : (body === null || body === void 0 ? void 0 : body.error_code) === 0);
        }
        catch (e) {
            if (this.isTransientNetworkError(e)) {
                this.logTransientNetworkError(command.toString(), e);
            }
            else if (this.isOfflineSuppressionError(e)) {
                // Intentionally silent: platform-level offline logger handles suppression and messaging.
            }
            else {
                this.log.error('Error sending command:', command, e);
            }
            this.tryResendCommand = false;
            return null;
        }
    }
    getNetworkErrorCode(error) {
        var _a, _b;
        return ((error === null || error === void 0 ? void 0 : error.code) ||
            (error === null || error === void 0 ? void 0 : error.errno) ||
            ((_a = error === null || error === void 0 ? void 0 : error.cause) === null || _a === void 0 ? void 0 : _a.code) ||
            ((_b = error === null || error === void 0 ? void 0 : error.cause) === null || _b === void 0 ? void 0 : _b.errno) ||
            '');
    }
    isTransientNetworkError(error) {
        const code = this.getNetworkErrorCode(error);
        return this.transientNetworkErrorCodes.has(code);
    }
    getErrorText(error) {
        if (!error) {
            return '';
        }
        if (typeof error === 'string') {
            return error;
        }
        if (typeof error.message === 'string') {
            return error.message;
        }
        return String(error);
    }
    isOfflineSuppressionError(error) {
        const text = this.getErrorText(error);
        return (this.isTransientNetworkError(error) ||
            text.includes('KLAP session not initialized') ||
            text.includes('Second handshake failed') ||
            text.includes("Cannot read properties of undefined (reading 'cipher')") ||
            text.includes('Request failed'));
    }
    logTransientNetworkError(command, error) {
        var _a;
        const code = this.getNetworkErrorCode(error) || 'UNKNOWN';
        const key = `${command}-${code}`;
        const now = Date.now();
        const last = (_a = this.lastTransientNetworkLogAt[key]) !== null && _a !== void 0 ? _a : 0;
        if (now - last >= this.NETWORK_ERROR_LOG_THROTTLE_MS) {
            this.lastTransientNetworkLogAt[key] = now;
            this.log.debug('Transient network error:', command, `(${code})`, `on ${this.ip}`);
            return;
        }
        this.log.debug('Suppressed network error:', command, code);
    }
    async checkProtocol() {
        var _a;
        try {
            this.log.debug('Checking protocol');
            const response = await this.api.sendRequest('component_nego', {}, false);
            if (response.data.error_code === 1003) {
                this.log.debug(`Using KLAP protocol for ${this.ip}`);
                return Protocol_1.default.KLAP;
            }
        }
        catch (e) {
            this.log.debug('Protocol error response:', JSON.stringify(((_a = e === null || e === void 0 ? void 0 : e.response) === null || _a === void 0 ? void 0 : _a.data) || (e === null || e === void 0 ? void 0 : e.response) || e));
        }
        this.log.debug(`Using legacy protocol for ${this.ip}`);
        return Protocol_1.default.Legacy;
    }
}
exports.default = TPLink;
//# sourceMappingURL=TPLink.js.map