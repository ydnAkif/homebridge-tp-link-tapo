import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic
} from 'homebridge';

import Accessory, { AccessoryType, ChildType } from './@types/Accessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import DeviceInfo from './api/@types/DeviceInfo';
import Context from './@types/Context';
import TPLink from './api/TPLink';

import HubAccessory, { HubContext } from './accessories/Hub';
import LightBulbAccessory from './accessories/LightBulb';
import OutletAccessory from './accessories/Outlet';
import { ChildInfo } from './api/@types/ChildListInfo';
import ButtonAccessory from './accessories/Button';
import ContactAccessory from './accessories/Contact';
import MotionSensorAccessory from './accessories/MotionSensor';

export default class Platform implements DynamicPlatformPlugin {
  private readonly TIMEOUT_TRIES = 20;
  private readonly REDISCOVER_INTERVAL_MS = 30 * 1000;
  private readonly OFFLINE_LOG_THROTTLE_MS = 10 * 60 * 1000;

  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory<Context | HubContext>[] = [];
  public readonly loadedChildUUIDs: Record<string, true> = {};
  public readonly registeredDevices: Accessory[] = [];
  public readonly hubs: HubAccessory[] = [];
  private rediscoverTimer?: NodeJS.Timeout;
  private readonly inFlightDeviceLoads: Record<string, true> = {};
  private readonly lastOfflineLogAt: Record<string, number> = {};
  private readonly offlineDevices: Record<string, true> = {};
  private readonly deviceRetry: {
    [key: string]: number;
  } = {};

  private getConfiguredAddresses(): Array<{
    ip: string;
    configuredName?: string;
  }> {
    const rawAddresses = this.config?.addresses;
    if (!Array.isArray(rawAddresses)) {
      return [];
    }

    return rawAddresses
      .map((entry: any) => {
        if (typeof entry === 'string') {
          return {
            ip: entry.trim()
          };
        }

        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const ip = String(entry.ip ?? entry.address ?? '').trim();
        const configuredName = String(entry.alias ?? entry.name ?? '').trim();

        if (!ip) {
          return null;
        }

        return {
          ip,
          ...(configuredName ? { configuredName } : {})
        };
      })
      .filter((item): item is { ip: string; configuredName?: string } =>
        Boolean(item?.ip)
      );
  }

  private decodeNickname(nickname?: string): string {
    if (!nickname) {
      return '';
    }

    try {
      const decoded = Buffer.from(nickname, 'base64').toString('utf-8').trim();
      return decoded === 'No Name' ? '' : decoded;
    } catch {
      return '';
    }
  }

  private getDeviceLabel(
    ip: string,
    configuredName?: string,
    deviceInfo?: DeviceInfo
  ): string {
    const name =
      configuredName?.trim() ||
      this.decodeNickname(deviceInfo?.nickname) ||
      deviceInfo?.model?.trim() ||
      '';

    return name ? `${name} (${ip})` : ip;
  }

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory<Context>) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private async discoverDevices() {
    try {
      const { email, password } = this.config ?? {};
      const addresses = this.getConfiguredAddresses();
      if (
        !email ||
        !password ||
        !addresses ||
        !Array.isArray(addresses) ||
        addresses.length <= 0
      ) {
        if (this.accessories.length > 0) {
          this.api.unregisterPlatformAccessories(
            PLUGIN_NAME,
            PLATFORM_NAME,
            this.accessories
          );
        }

        return;
      }

      await Promise.all(
        addresses.map((address) => this.loadDevice(address, email, password))
      );

      await Promise.all(
        this.hubs.map(async (hub) => {
          const devices = await hub.getChildDevices();
          await Promise.all(
            devices.map((device) => {
              if (Object.keys(device || {}).length === 0) {
                return Promise.resolve();
              }

              this.loadedChildUUIDs[
                this.api.hap.uuid.generate(device.device_id)
              ] = true;
              return this.loadChildDevice(device.device_id, device, hub);
            })
          );
        })
      );

      this.checkOldDevices();
      this.startRediscovery(addresses, email, password);
    } catch (err: any) {
      this.log.error('Failed to discover devices:', err.message);
    }
  }

  private startRediscovery(
    addresses: Array<{ ip: string; configuredName?: string }>,
    email: string,
    password: string
  ) {
    if (this.rediscoverTimer) {
      return;
    }

    this.rediscoverTimer = setInterval(() => {
      for (const { ip, configuredName } of addresses) {
        const uuid = this.api.hap.uuid.generate(ip);
        const isRegistered = this.registeredDevices.some(
          (device) => device.UUID === uuid
        );

        if (isRegistered) {
          continue;
        }

        if ((this.deviceRetry[uuid] ?? 0) <= 0) {
          // Reset retry budget for long-running bridge sessions.
          this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
        }

        void this.loadDevice({ ip, configuredName }, email, password);
      }
    }, this.REDISCOVER_INTERVAL_MS);
  }

  private logOfflineDevice(
    suppressionKey: string,
    deviceLabel: string,
    error?: any
  ) {
    const now = Date.now();
    const last = this.lastOfflineLogAt[suppressionKey] ?? 0;
    const errorMessage = error?.message || error;
    this.offlineDevices[suppressionKey] = true;

    if (now - last >= this.OFFLINE_LOG_THROTTLE_MS) {
      this.lastOfflineLogAt[suppressionKey] = now;
      const baseMessage = `${deviceLabel} unreachable; suppressing repeated logs for 10 minutes.`;
      if (errorMessage) {
        this.log.warn(baseMessage, '|', errorMessage);
      } else {
        this.log.warn(baseMessage);
      }
      return;
    }

    this.log.debug('[Offline/Suppressed]', deviceLabel, errorMessage || '');
  }

  private logDeviceOnlineAgain(suppressionKey: string, deviceLabel: string) {
    if (!this.offlineDevices[suppressionKey]) {
      return;
    }

    delete this.offlineDevices[suppressionKey];
    this.log.info(`${deviceLabel} online again.`);
  }

  private async loadDevice(
    address: { ip: string; configuredName?: string },
    email: string,
    password: string
  ) {
    const { ip, configuredName } = address;
    const uuid = this.api.hap.uuid.generate(ip);
    if (this.inFlightDeviceLoads[uuid]) {
      return;
    }

    this.inFlightDeviceLoads[uuid] = true;

    if (this.deviceRetry[uuid] === undefined) {
      this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
    } else if (this.deviceRetry[uuid] <= 0) {
      this.log.debug('Retry budget reached for now:', ip);
      delete this.inFlightDeviceLoads[uuid];
      return;
    }

    try {
      const tpLink = await new TPLink(ip, email, password, this.log).setup();
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

      const deviceName = Buffer.from(
        deviceInfo?.nickname || 'Tm8gTmFtZQ==',
        'base64'
      ).toString('utf-8');

      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid
      );

      if (existingAccessory) {
        this.log.info(
          'Restoring existing accessory from cache:',
          existingAccessory.displayName
        );
        existingAccessory.context = {
          name: deviceName,
          tpLink,
          child: false
        };

        const registeredAccessory = this.registerAccessory(
          existingAccessory,
          deviceInfo
        );
        if (!registeredAccessory) {
          this.log.error(
            'Failed to register accessory "%s" of type "%s" (%s)',
            deviceName,
            Accessory.GetType(deviceInfo),
            deviceInfo?.type
          );
          delete this.inFlightDeviceLoads[uuid];
          return;
        }

        this.registeredDevices.push(registeredAccessory);
        delete this.inFlightDeviceLoads[uuid];
        return;
      }

      this.log.info('Adding new accessory:', deviceName);
      const accessory = new this.api.platformAccessory<Context>(
        deviceName,
        uuid
      );
      accessory.context = {
        name: deviceName,
        tpLink,
        child: false
      };

      const registeredAccessory = this.registerAccessory(accessory, deviceInfo);
      if (!registeredAccessory) {
        this.log.error(
          'Failed to register accessory "%s" of type "%s" (%s)',
          deviceName,
          Accessory.GetType(deviceInfo),
          deviceInfo?.type
        );
        delete this.inFlightDeviceLoads[uuid];
        return;
      }

      this.registeredDevices.push(registeredAccessory);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory
      ]);
      delete this.inFlightDeviceLoads[uuid];
      return;
    } catch (err: any) {
      this.deviceRetry[uuid] -= 1;
      const deviceLabel = this.getDeviceLabel(ip, configuredName);
      this.logOfflineDevice(ip, deviceLabel, err);
      delete this.inFlightDeviceLoads[uuid];
      return;
    }
  }

  private async loadChildDevice(
    id: string,
    deviceInfo: ChildInfo,
    parent: HubAccessory
  ) {
    const uuid = this.api.hap.uuid.generate(id);
    if (this.deviceRetry[uuid] === undefined) {
      this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
    } else if (this.deviceRetry[uuid] <= 0) {
      this.log.debug('Retry budget reached for child:', id);
      return;
    }

    try {
      const deviceName = Buffer.from(
        deviceInfo.nickname || 'Tm8gTmFtZQ==',
        'base64'
      ).toString('utf-8');

      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid
      );

      if (existingAccessory) {
        this.log.info(
          'Restoring existing child accessory from cache:',
          existingAccessory.displayName
        );
        existingAccessory.context = {
          name: deviceName,
          child: true,
          parent: parent.UUID
        };

        const registeredAccessory = this.registerChild(
          existingAccessory,
          deviceInfo,
          parent
        );

        if (!registeredAccessory) {
          this.log.error(
            'Failed to register child accessory "%s" of type "%s" (%s)',
            deviceName,
            Accessory.GetChildType(deviceInfo),
            deviceInfo?.type
          );
          return;
        }

        this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
        this.registeredDevices.push(registeredAccessory);
        return;
      }

      this.log.info('Adding new child accessory:', deviceName);
      const accessory = new this.api.platformAccessory<HubContext>(
        deviceName,
        uuid
      );
      accessory.context = {
        name: deviceName,
        child: true,
        parent: parent.UUID
      };

      const registeredAccessory = this.registerChild(
        accessory,
        deviceInfo,
        parent
      );
      if (!registeredAccessory) {
        this.log.error(
          'Failed to register child accessory "%s" of type "%s" (%s)',
          deviceName,
          Accessory.GetChildType(deviceInfo),
          deviceInfo?.type
        );
        return;
      }

      this.deviceRetry[uuid] = this.TIMEOUT_TRIES;
      this.registeredDevices.push(registeredAccessory);

      return this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory
      ]);
    } catch (err: any) {
      this.deviceRetry[uuid] -= 1;
      this.logOfflineDevice(id, id, err);
      return;
    }
  }

  private checkOldDevices() {
    const addressesByUUID: Record<string, string> =
      this.getConfiguredAddresses().reduce(
        (acc, ip) => ({
          ...acc,
          [this.api.hap.uuid.generate(ip.ip)]: ip.ip
        }),
        {}
      );

    this.accessories.map((accessory) => {
      const deleteDevice =
        (!accessory.context.child &&
          !addressesByUUID[accessory.UUID.toString()]) ||
        (accessory.context.child &&
          !addressesByUUID[accessory.context.parent]) ||
        (accessory.context.child &&
          addressesByUUID[accessory.context.parent] &&
          !this.loadedChildUUIDs[accessory.UUID.toString()]);

      if (deleteDevice) {
        this.log.info('Remove cached accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory
        ]);
      }
    });
  }

  private readonly accessoryClasses = {
    [AccessoryType.LightBulb]: LightBulbAccessory,
    [AccessoryType.Outlet]: OutletAccessory,
    [AccessoryType.Hub]: HubAccessory
  };

  private registerAccessory(
    accessory: PlatformAccessory<Context | HubContext>,
    deviceInfo: DeviceInfo
  ): Accessory | null {
    const AccessoryClass = this.accessoryClasses[Accessory.GetType(deviceInfo)];
    if (!AccessoryClass) {
      return null;
    }

    const acc = new AccessoryClass(this, accessory, this.log, deviceInfo);

    if (acc instanceof HubAccessory) {
      this.hubs.push(acc);
    }

    return acc;
  }

  private readonly childClasses = {
    [ChildType.Button]: ButtonAccessory,
    [ChildType.Contact]: ContactAccessory,
    [ChildType.MotionSensor]: MotionSensorAccessory
  };

  private registerChild(
    accessory: PlatformAccessory<Context | HubContext>,
    deviceInfo: ChildInfo,
    parent: HubAccessory
  ): Accessory | null {
    const ChildClass = this.childClasses[Accessory.GetChildType(deviceInfo)];
    if (!ChildClass) {
      return null;
    }

    return new ChildClass(parent, this, accessory, this.log, deviceInfo);
  }
}
