import {
    AccessoryPlugin,
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    HAP,
    HAPStatus,
    Logging,
    Service
} from "homebridge";
import {Config} from "./config";
import dgram from "node:dgram";

let hap: HAP;

export = (api: API) => {
    hap = api.hap;
    api.registerAccessory("AirConditionerInfraredRemote", AirConditionerInfraredRemote);
};

class AirConditionerInfraredRemote implements AccessoryPlugin {
    private readonly name: string;
    private readonly informationService: Service;
    private readonly timeout: number;
    private readonly airconService: Service;

    private readonly commandQueue: ["off" | "cool" | "heat" | "auto", (successful: boolean) => void][] = [];
    private readonly udp_server: dgram.Socket;
    private last_updated = 0;

    constructor(private readonly log: Logging, private readonly config: Config, api: API) {
        this.name = config.name;

        this.informationService = new hap.Service.AccessoryInformation()
            .setCharacteristic(hap.Characteristic.Manufacturer, "ACME Pty Ltd");
        this.airconService = new hap.Service.Thermostat(this.name);

        this.timeout = (config.timeout ?? 30) * 1e3;

        this.udp_server = dgram.createSocket("udp4");
        this.udp_server.bind(config.beacon_port);
        this.udp_server.on("listening", () => {
            log.info("Listening on port %d", config.beacon_port);
        });
        this.udp_server.on("message", this.messageHandler);

        log.info(`${this.config.name} finished initializing!`);
    }

    private messageHandler = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        this.log(`Received message from ${rinfo.address}:${rinfo.port}`);
    }

    getCharacteristic = (value: any) => (cb: CharacteristicGetCallback) => {
        if (Date.now() - this.last_updated > this.timeout) {
            cb(HAPStatus.OPERATION_TIMED_OUT)
        } else if (value === undefined) {
            cb(HAPStatus.RESOURCE_DOES_NOT_EXIST);
        } else {
            cb(HAPStatus.SUCCESS, value);
        }
    }

    getServices(): Service[] {
        return [
            this.informationService,
            this.airconService
        ];
    }
}
