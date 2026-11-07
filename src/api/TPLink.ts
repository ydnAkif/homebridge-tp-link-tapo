import AsyncLock from 'async-lock';

import { ChildInfo } from './@types/ChildListInfo';
import DeviceInfo from './@types/DeviceInfo';
import Protocol from './@types/Protocol';
import { Logger } from 'homebridge';
import LegacyAPI from './LegacyAPI';
import commands from './commands';
import KlapAPI from './KlapAPI';
import API from './@types/API';

export interface HandshakeData {
  cookie?: string;
  expire: number;
}

type Commands = typeof commands;
type Command = keyof Commands;
type CommandReturnType<T extends Command> = ReturnType<Commands[T]>;

export default class TPLink {
  public get protocol(): Protocol {
    return this._protocol;
  }

  private _protocol: Protocol = Protocol.Legacy;

  private readonly lock: AsyncLock;

  private api: API;

  private classSetup = false;

  private tryResendCommand = false;
  private readonly NETWORK_ERROR_LOG_THROTTLE_MS = 10 * 60 * 1000;
  private readonly transientNetworkErrorCodes = new Set([
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EHOSTDOWN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT'
  ]);
  private readonly lastTransientNetworkLogAt: Record<string, number> = {};

  private _prevPowerState: boolean | undefined;
  private _unsentData: any = {};

  private commandCache: Record<
    string,
    {
      data: any;
      setAt: number;
    }
  > = {};

  private infoInFlight?: Promise<DeviceInfo>;
  private infoRetryAfter = 0;

  private infoCache?: {
    data: DeviceInfo;
    setAt: number;
  };

  private childInfoCache: Record<
    string,
    {
      data: ChildInfo;
      setAt: number;
    }
  > = {};

  constructor(
    private readonly ip: string,
    private readonly email: string,
    private readonly password: string,
    private readonly log: Logger,
    private readonly unavailableError: () => Error = () => new Error("Tapo device unavailable")
  ) {
    this.lock = new AsyncLock({ timeout: 10000, maxPending: 20 });
    this.api = new LegacyAPI(ip, email, password, log);
  }

  public async setup(): Promise<TPLink> {
    try {
      if (this.classSetup) {
        return this;
      }

      await this.api.setup();

      this._protocol = await this.checkProtocol();
      if (this._protocol === Protocol.KLAP) {
        this.api = new KlapAPI(this.ip, this.email, this.password, this.log);
        await this.api.setup();
      }

      this.classSetup = true;
    } catch (e) {
      if (!this.isOfflineSuppressionError(e)) {
        this.log.error('Error setting up TPLink class:', e);
      }
    }

    return this;
  }

  public async cacheSendCommand<T extends Command>(
    deviceId: string,
    command: T,
    ...args: Parameters<Commands[T]>
  ): Promise<ReturnType<Commands[T]>> {
    const cacheKey = `${deviceId}-${command}`;
    return this.lock.acquire<ReturnType<Commands[T]>>(
      `cache-${cacheKey}`,
      async () => {
        if (
          this.commandCache[cacheKey.toString()] &&
          Date.now() - this.commandCache[cacheKey.toString()].setAt < 100
        ) {
          return this.commandCache[cacheKey.toString()].data;
        }

        const response = await this.sendCommand(command, ...args);
        if (response === null || response === undefined || response === false) throw this.unavailableError();
        this.commandCache[cacheKey.toString()] = {
          data: response,
          setAt: Date.now()
        };

        return response;
      }
    );
  }

  public getInfo(): Promise<DeviceInfo> {
    if (this.infoCache && Date.now() - this.infoCache.setAt < 500) {
      return Promise.resolve(this.infoCache.data);
    }
    if (this.infoInFlight) return this.infoInFlight;
    if (Date.now() < this.infoRetryAfter) return Promise.reject(this.unavailableError());

    const request = this.sendCommand('deviceInfo').then(deviceInfo => {
      if (!deviceInfo || typeof deviceInfo !== 'object' || !deviceInfo.device_id) throw this.unavailableError();
      this.infoCache = { data: deviceInfo, setAt: Date.now() };
      this.infoRetryAfter = 0;
      this._prevPowerState = deviceInfo.device_on;
      return deviceInfo;
    });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(this.unavailableError()), 1500);
    });
    const pending = Promise.race([request, deadline]).then((deviceInfo) => {
      if (!deviceInfo || typeof deviceInfo !== 'object' || !deviceInfo.device_id) {
        throw this.unavailableError();
      }
      this.infoCache = { data: deviceInfo, setAt: Date.now() };
      this.infoRetryAfter = 0;
      this._prevPowerState = deviceInfo.device_on ?? false;
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
        if (this.infoInFlight === pending) this.infoInFlight = undefined;
      };
      void pending.then(clear, clear);
    };
    void request.then(release, release);
    return pending;
  }

  public async getChildInfo(childId: string): Promise<ChildInfo> {
    return this.lock.acquire('get-child-info-cache', async () => {
      if (
        this.childInfoCache[childId.toString()] &&
        Date.now() - this.childInfoCache[childId.toString()].setAt < 10000
      ) {
        return this.childInfoCache[childId.toString()].data;
      }

      const rawInfo = await this.sendCommand('childDeviceInfo', childId);
      const deviceInfo = rawInfo?.responseData?.result;
      if (!deviceInfo || typeof deviceInfo !== 'object' || Object.keys(deviceInfo).length === 0) throw this.unavailableError();

      this.childInfoCache[childId.toString()] = {
        data: deviceInfo,
        setAt: Date.now()
      };

      return deviceInfo;
    });
  }

  public async sendCommand<T extends Command>(
    command: T,
    ...args: Parameters<Commands[T]>
  ): Promise<CommandReturnType<T>> {
    return this.lock.acquire(
      'send-command',
      async (): Promise<CommandReturnType<T>> => {
        const desiredPower = command === 'power' ? args[0] as boolean : this._prevPowerState;
        const response = await this.sendCommandWithNoLock(command, args, desiredPower);
        if (response === null || response === false || response === undefined) throw this.unavailableError();
        if (command === 'power') this._prevPowerState = desiredPower;
        return response;
      }
    );
  }

  public async sendHubCommand<T extends Command>(
    command: T,
    childId: string,
    ...args: Parameters<Commands[T]>
  ): Promise<CommandReturnType<T>> {
    return this.lock.acquire(
      `send-hub-command-${childId}`,
      (): Promise<CommandReturnType<T>> => {
        return this.sendCommandWithNoLock(command, args, false);
      }
    );
  }

  private async sendCommandWithNoLock<T extends Command>(
    command: T,
    args: Parameters<Commands[T]>,
    isDeviceOn = false
  ): Promise<CommandReturnType<T>> {
    try {
      if (!commands[command.toString()]) {
        return false as CommandReturnType<T>;
      }

      if (this.api.needsNewHandshake() || this.tryResendCommand) {
        if (this.tryResendCommand) {
          this.log.info('Trying to login again.');
        }

        await this.api.login();
      }

      const { __method__, ...params } = commands[command.toString()](...args);
      const validMethod = __method__ ?? 'set_device_info';

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
          return true as CommandReturnType<T>;
        }
      }

      const extraData =
        isDeviceOn && validMethod === 'set_device_info'
          ? { ...this._unsentData }
          : {};

      const { body } = await this.api.sendSecureRequest(
        validMethod,
        {
          ...extraData,
          ...params
        },
        true,
        false
      );

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

      if (isDeviceOn) this._unsentData = {};
      if (validMethod === 'set_device_info') {
        this.infoCache = undefined;
        this.infoRetryAfter = 0;
      }
      this.tryResendCommand = false;
      return (body?.result ?? body?.error_code === 0) as CommandReturnType<T>;
    } catch (e: any) {
      if (this.isTransientNetworkError(e)) {
        this.logTransientNetworkError(command.toString(), e);
      } else if (this.isOfflineSuppressionError(e)) {
        // Intentionally silent: platform-level offline logger handles suppression and messaging.
      } else {
        this.log.error('Error sending command:', command, e);
      }

      this.tryResendCommand = false;
      return null as CommandReturnType<T>;
    }
  }

  private getNetworkErrorCode(error: any): string {
    return (
      error?.code ||
      error?.errno ||
      error?.cause?.code ||
      error?.cause?.errno ||
      ''
    );
  }

  private isTransientNetworkError(error: any): boolean {
    const code = this.getNetworkErrorCode(error);
    return this.transientNetworkErrorCodes.has(code);
  }

  private getErrorText(error: any): string {
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

  private isOfflineSuppressionError(error: any): boolean {
    const text = this.getErrorText(error);

    return (
      this.isTransientNetworkError(error) ||
      text.includes('KLAP session not initialized') ||
      text.includes('Second handshake failed') ||
      text.includes("Cannot read properties of undefined (reading 'cipher')") ||
      text.includes('Request failed')
    );
  }

  private logTransientNetworkError(command: string, error: any) {
    const code = this.getNetworkErrorCode(error) || 'UNKNOWN';
    const key = `${command}-${code}`;
    const now = Date.now();
    const last = this.lastTransientNetworkLogAt[key] ?? 0;

    if (now - last >= this.NETWORK_ERROR_LOG_THROTTLE_MS) {
      this.lastTransientNetworkLogAt[key] = now;
      this.log.debug(
        'Transient network error:',
        command,
        `(${code})`,
        `on ${this.ip}`
      );
      return;
    }

    this.log.debug('Suppressed network error:', command, code);
  }

  private async checkProtocol(): Promise<Protocol> {
    try {
      this.log.debug('Checking protocol');
      const response = await this.api.sendRequest('component_nego', {}, false);
      if (response.data.error_code === 1003) {
        this.log.debug(`Using KLAP protocol for ${this.ip}`);
        return Protocol.KLAP;
      }
    } catch (e: any) {
      this.log.debug(
        'Protocol error response:',
        JSON.stringify(e?.response?.data || e?.response || e)
      );
    }

    this.log.debug(`Using legacy protocol for ${this.ip}`);
    return Protocol.Legacy;
  }
}
