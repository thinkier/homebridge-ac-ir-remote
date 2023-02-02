import {
    AccessoryPlugin,
    API, Characteristic,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicValue,
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

type State = { mode: "off" } | {
    mode: "cool" | "heat" | "auto",
    temperature: number,
}

interface Metrics {
    temperature: number,
    humidity: number,
}

interface Command {
    state: State,
    callback: (successful: boolean) => void
}

class AirConditionerInfraredRemote implements AccessoryPlugin {
    private readonly name: string;
    private readonly informationService: Service;
    private readonly timeout: number;
    private readonly thermostatService: Service;

    private readonly commandQueue: Command[] = [{
        state: {mode: "off"}, callback: () => {
        }
    }];
    private readonly udp_server: dgram.Socket;
    private desiredState: State = {mode: "off"};
    private actualState: State = {mode: "off"};
    private readonly metrics: Metrics = {temperature: 25, humidity: 45};
    private last_updated = 0;

    constructor(private readonly log: Logging, private readonly config: Config, api: API) {
        this.name = config.name;

        this.informationService = new hap.Service.AccessoryInformation()
            .setCharacteristic(hap.Characteristic.Manufacturer, "ACME Pty Ltd");
        this.thermostatService = new hap.Service.Thermostat(this.name)
            .setCharacteristic(hap.Characteristic.TemperatureDisplayUnits, hap.Characteristic.TemperatureDisplayUnits.CELSIUS)
            .setCharacteristic(hap.Characteristic.CurrentTemperature, 22)
            .setCharacteristic(hap.Characteristic.CurrentRelativeHumidity, 50)
            .setCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, hap.Characteristic.CurrentHeatingCoolingState.OFF)
            .setCharacteristic(hap.Characteristic.TargetTemperature, 25)
            .setCharacteristic(hap.Characteristic.TargetHeatingCoolingState, hap.Characteristic.TargetHeatingCoolingState.OFF);

        this.thermostatService.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
            .on(CharacteristicEventTypes.GET, this.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits.CELSIUS))
            .on(CharacteristicEventTypes.SET, (_, cb) => cb(HAPStatus.READ_ONLY_CHARACTERISTIC));
        this.thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature)
            .on(CharacteristicEventTypes.GET, this.getCharacteristic(this.metrics.temperature));
        this.thermostatService.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
            .on(CharacteristicEventTypes.GET, this.getCharacteristic(this.metrics.humidity));
        this.thermostatService.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
            .on(CharacteristicEventTypes.GET, this.getCharacteristic(this.getHAPCurrentHeatingCoolingState()));

        this.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature)
            .on(CharacteristicEventTypes.GET, this.getCharacteristic(this.actualState.mode === "off" ? 25 : this.actualState.temperature))
            .on(CharacteristicEventTypes.SET, (t, cb) => {
                if (this.desiredState.mode === "off") {
                    this.desiredState = {
                        mode: "auto",
                        temperature: t as number
                    }
                } else {
                    this.desiredState.temperature = t as number;
                }

                this.commandQueue.push({
                    state: {...this.desiredState},
                    callback: () => {
                        cb(HAPStatus.SUCCESS);
                    }
                })
            });
        this.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
            .on(CharacteristicEventTypes.GET, this.getCharacteristic(this.getHAPTargetHeatingCoolingState()))
            .on(CharacteristicEventTypes.SET, (mode, cb) => {
                let desiredMode = this.getModeFromHAP(mode as number);

                if (desiredMode === "off") {
                    this.desiredState = {mode: desiredMode};
                } else if (this.desiredState.mode === "off") {
                    this.desiredState = {
                        mode: desiredMode,
                        temperature: 22
                    };
                } else {
                    this.desiredState.mode = desiredMode;
                }

                this.commandQueue.push({
                    state: {...this.desiredState},
                    callback: () => {
                        cb(HAPStatus.SUCCESS);
                    }
                })
            });

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
        this.last_updated = Date.now();

        this.commandQueue.reverse();
        while (this.commandQueue.length > 1) {
            this.commandQueue.pop().callback(false);
        }

        if (this.commandQueue.length >= 1) {
            const cmd = this.commandQueue[0];

            let [signal, state] = this.selectClosestTemperature(cmd);
            let buf = Buffer.alloc(0);
            buf.writeUint16LE(this.config.tx_freq);
            buf.write(signal, 2, "hex");

            this.udp_server.send(buf, rinfo.port, rinfo.address);
            cmd.callback(true);
        }
    }

    private selectClosestTemperature(cmd: Command): [string, State] {
        let signal, state;
        if (cmd.state.mode !== "off") {
            const {mode, temperature} = cmd.state;

            const temps = Object.keys(this.config.signals[mode]).map(Number);
            let i = temps.reduce((prev, curr) => Math.abs(curr - temperature) < Math.abs(prev - temperature) ? curr : prev);

            signal = this.config.signals[mode][i.toString()];
            state = {mode, temperature: i};
        } else {
            signal = this.config.signals.off;
            state = {mode: "off"};
        }

        return [signal, state]
    }

    private getHAPCurrentHeatingCoolingState(): CharacteristicValue {
        switch (this.actualState.mode) {
            case "off":
                return hap.Characteristic.CurrentHeatingCoolingState.OFF;
            case "cool":
                return hap.Characteristic.CurrentHeatingCoolingState.COOL;
            case "heat":
                return hap.Characteristic.CurrentHeatingCoolingState.HEAT;
            default: {
                if (this.metrics.temperature >= this.actualState.temperature) {
                    return hap.Characteristic.CurrentHeatingCoolingState.COOL;
                } else {
                    return hap.Characteristic.CurrentHeatingCoolingState.HEAT;
                }
            }
        }
    }

    private getHAPTargetHeatingCoolingState(): CharacteristicValue {
        switch (this.actualState.mode) {
            case "off":
                return hap.Characteristic.TargetHeatingCoolingState.OFF;
            case "cool":
                return hap.Characteristic.TargetHeatingCoolingState.COOL;
            case "heat":
                return hap.Characteristic.TargetHeatingCoolingState.HEAT;
            default:
                return hap.Characteristic.TargetHeatingCoolingState.AUTO;
        }
    }

    private getModeFromHAP(mode: CharacteristicValue): State["mode"] {
        switch (mode) {
            case hap.Characteristic.TargetHeatingCoolingState.OFF:
                return "off";
            case hap.Characteristic.TargetHeatingCoolingState.COOL:
                return "cool";
            case hap.Characteristic.TargetHeatingCoolingState.HEAT:
                return "heat";
            default:
                return "auto";
        }
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
            this.thermostatService
        ];
    }
}
