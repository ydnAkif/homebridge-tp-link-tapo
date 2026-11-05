"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const async_lock_1 = __importDefault(require("async-lock"));
const crypto_1 = __importDefault(require("crypto"));
const http_1 = __importDefault(require("http"));
const KlapCipher_1 = __importDefault(require("./KlapCipher"));
const API_1 = __importDefault(require("./@types/API"));
class KlapAPI extends API_1.default {
    constructor(ip, email, password, log) {
        super(ip, email, password, log);
        this.ip = ip;
        this.email = email;
        this.password = password;
        this.log = log;
        this.lock = new async_lock_1.default();
    }
    async login() {
        this.log.debug('[KLAP] Legacy login that does nothing, ignore this');
    }
    async setup() {
        this.log.debug('[KLAP] Legacy setup that does nothing, ignore this');
    }
    async sendRequest() {
        throw new Error('[KLAP] Legacy Method should not be called');
    }
    async sendSecureRequest(method, params, _, forceHandshake = false) {
        var _a;
        await this.handshake(forceHandshake);
        const session = this.session;
        if (!(session === null || session === void 0 ? void 0 : session.cipher) || !session.Cookie) {
            throw new Error('KLAP session not initialized');
        }
        const rawRequest = JSON.stringify({
            method,
            params: (Object.keys(params).length > 0 && params) || null
        });
        this.log.debug('[KLAP] Sending request:', rawRequest);
        const requestData = session.cipher.encrypt(rawRequest);
        try {
            const response = await this.sessionPost('/request', requestData.encrypted, 'arraybuffer', session.Cookie, {
                seq: requestData.seq.toString()
            });
            if (response.status !== 200) {
                throw new Error('[KLAP] Request failed');
            }
            const data = JSON.parse(session.cipher.decrypt(response.data));
            return {
                response,
                body: data
            };
        }
        catch (error) {
            if (((_a = error.response) === null || _a === void 0 ? void 0 : _a.status) === 403 && !forceHandshake) {
                this.log.warn('[KLAP] Forbidden. Redoing the request with a token regeneration.');
                return this.sendSecureRequest(method, params, _, true);
            }
            throw new Error(`[KLAP] Request failed: ${error}`);
        }
    }
    needsNewHandshake() {
        if (!this.session) {
            return true;
        }
        if (!this.session.cipher) {
            return true;
        }
        if (this.session.IsExpired) {
            return true;
        }
        if (!this.session.Cookie) {
            return true;
        }
        return false;
    }
    async handshake(force = false) {
        return this.lock.acquire('handshake', async () => {
            if (!this.needsNewHandshake() && !force) {
                return;
            }
            const { localSeed, remoteSeed, authHash } = await this.firstHandshake();
            await this.secondHandshake(localSeed, remoteSeed, authHash);
        });
    }
    async firstHandshake(seed) {
        var _a;
        const localSeed = seed ? seed : crypto_1.default.randomBytes(16);
        const handshake1Result = await this.sessionPost('/handshake1', localSeed, 'arraybuffer');
        if (handshake1Result.status !== 200) {
            throw new Error('Handshake1 failed');
        }
        if (handshake1Result.headers['content-length'] !== '48') {
            throw new Error('Handshake1 failed due to invalid content length');
        }
        const cookie = (_a = handshake1Result.headers['set-cookie']) === null || _a === void 0 ? void 0 : _a[0];
        const data = handshake1Result.data;
        const [cookieValue, timeout] = cookie.split(';');
        const timeoutValue = timeout.split('=').pop();
        this.session = new Session(timeoutValue, cookieValue);
        const remoteSeed = data.subarray(0, 16);
        const serverHash = data.subarray(16);
        this.log.debug('[KLAP] First handshake decoded successfully:\nRemote Seed:', remoteSeed.toString('hex'), '\nServer Hash:', serverHash.toString('hex'), '\nCookie:', cookieValue);
        const localHash = this.hashAuth(this.rawEmail, this.rawPassword);
        const localAuthHash = this.sha256(Buffer.concat([localSeed, remoteSeed, localHash]));
        if (Buffer.compare(localAuthHash, serverHash) === 0) {
            this.log.debug('[KLAP] Local auth hash matches server hash');
            return {
                localSeed,
                remoteSeed,
                authHash: localHash
            };
        }
        const emptyHash = this.sha256(Buffer.concat([localSeed, remoteSeed, this.hashAuth('', '')]));
        if (Buffer.compare(emptyHash, serverHash) === 0) {
            this.log.debug('[KLAP] [WARN] Empty auth hash matches server hash');
            return {
                localSeed,
                remoteSeed,
                authHash: emptyHash
            };
        }
        const testHash = this.sha256(Buffer.concat([
            localSeed,
            remoteSeed,
            this.hashAuth(KlapAPI.TP_TEST_USER, KlapAPI.TP_TEST_PASSWORD)
        ]));
        if (Buffer.compare(testHash, serverHash) === 0) {
            this.log.debug('[KLAP] [WARN] Test auth hash matches server hash');
            return {
                localSeed,
                remoteSeed,
                authHash: testHash
            };
        }
        this.session = undefined;
        throw new Error('Failed to verify server hash');
    }
    async secondHandshake(localSeed, remoteSeed, authHash) {
        var _a;
        const localAuthHash = this.sha256(Buffer.concat([remoteSeed, localSeed, authHash]));
        try {
            const handshake2Result = await this.sessionPost('/handshake2', localAuthHash, 'text', this.session.Cookie);
            if (handshake2Result.status === 200) {
                this.log.debug('[KLAP] Second handshake successful');
                this.session = this.session.completeHandshake(new KlapCipher_1.default(localSeed, remoteSeed, authHash));
                return;
            }
        }
        catch (e) {
            this.log.debug('[KLAP] Handshake retry required', ((_a = e.response) === null || _a === void 0 ? void 0 : _a.data) || e.message);
        }
        this.session = undefined;
    }
    async sessionPost(path, payload, responseType, cookie, params) {
        return axios_1.default.post(`http://${this.ip}/app${path}`, payload, {
            timeout: 2500,
            responseType: responseType,
            params: params,
            headers: {
                Host: this.ip,
                Accept: '*/*',
                'Content-Type': 'application/octet-stream',
                ...(cookie && {
                    Cookie: cookie
                })
            },
            httpAgent: new http_1.default.Agent({
                keepAlive: false
            })
        });
    }
    sha256(data) {
        return crypto_1.default.createHash('sha256').update(data).digest();
    }
    sha1(data) {
        return crypto_1.default.createHash('sha1').update(data).digest();
    }
    hashAuth(email, password) {
        return this.sha256(Buffer.concat([
            this.sha1(Buffer.from(email.normalize('NFKC'))),
            this.sha1(Buffer.from(password.normalize('NFKC')))
        ]));
    }
}
KlapAPI.TP_TEST_USER = 'test@tp-link.net';
KlapAPI.TP_TEST_PASSWORD = 'test';
exports.default = KlapAPI;
class Session {
    constructor(timeout, cookie, cipher) {
        this.cookie = cookie;
        this.cipher = cipher;
        this.handshakeCompleted = false;
        this.rawTimeout = timeout;
        this.expireAt = new Date(Date.now() + parseInt(timeout) * 1000);
        if (cipher) {
            this.handshakeCompleted = true;
        }
    }
    get IsExpired() {
        return this.expireAt.getTime() - Date.now() <= 40 * 1000;
    }
    get Cookie() {
        return this.cookie;
    }
    completeHandshake(cipher) {
        return new Session(this.rawTimeout, this.cookie, cipher);
    }
}
//# sourceMappingURL=KlapAPI.js.map