import {
    AccessoryPlugin,
    API, Characteristic,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicValue,
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
    callback: (successful: boolean) => void
}

interface AcCommand extends Command {
    state: State
}

interface GenericCommand extends Command {
    buffer: Buffer
}

class AirConditionerInfraredRemote implements AccessoryPlugin {
    private readonly name: string;
    private readonly informationService: Service;
    private readonly timeout: number;
    private readonly thermostatService: Service;
    private readonly extraServices: Service[] = [];

    private readonly acCommandQueue: AcCommand[] = [{
        state: {mode: "off"}, callback: () => {
        }
    }];
    private readonly genericCommandQueue: GenericCommand[] = [];

    private readonly udp_server: dgram.Socket;
    private desiredState: State = {mode: "off"};
    private actualState: State = {mode: "off"};
    private readonly metrics: Metrics = {temperature: 25, humidity: 45};
    private last_updated = 0;

    constructor(private readonly log: Logging, private readonly config: Config, api: API) {
        this.name = config.name;

        this.informationService = new hap.Service.AccessoryInformation()
            .setCharacteristic(hap.Characteristic.Manufacturer, "ACME Pty Ltd");
        this.thermostatService = new hap.Service.Thermostat(this.name);
        this.implementThermostat();
        this.implementExtraServices();
        if(config.enable_repeat) {
            this.implementRepeat();
        }

        this.timeout = (config.timeout ?? 30) * 1e3;

        this.udp_server = dgram.createSocket("udp4");
        this.udp_server.bind(config.beacon_port);
        this.udp_server.on("listening", () => {
            log.info("Listening on port %d", config.beacon_port);
        });
        this.udp_server.on("message", this.messageHandler);

        log.info(`${this.config.name} finished initializing!`);
    }

    private implementThermostat() {
        this.thermostatService.setCharacteristic(hap.Characteristic.TemperatureDisplayUnits, hap.Characteristic.TemperatureDisplayUnits.CELSIUS)
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

                this.acCommandQueue.push({
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

                this.acCommandQueue.push({
                    state: {...this.desiredState},
                    callback: () => {
                        cb(HAPStatus.SUCCESS);
                    }
                })
            });
    }

    private implementExtraServices() {
        for (let extra of this.config.extras ?? []) {
            let service = new hap.Service.Switch(extra.name);

            service.getCharacteristic(hap.Characteristic.On)
                .on("get", this.getCharacteristic(false))
                .on("set", (on, cb) => {
                    if (!on) {
                        cb(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
                        return;
                    }

                    const buffer = Buffer.alloc((extra.hex.length / 2) + 2);
                    buffer.writeUint16LE(extra.tx_freq);
                    buffer.write(extra.hex, 2, "hex");

                    this.genericCommandQueue.push({
                        callback: () => {
                            cb(HAPStatus.SUCCESS);
                            service.setCharacteristic(hap.Characteristic.On, false);
                        },
                        buffer
                    });
                })

            this.extraServices.push(service);
        }
    }

    private implementRepeat() {
        let service = new hap.Service.Switch("Repeat AC Command");
        service.getCharacteristic(hap.Characteristic.On)
            .on("get", this.getCharacteristic(false))
            .on("set", (on, cb) => {
                if(!on || this.acCommandQueue.length !== 0){
                    cb(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
                    return;
                }

                this.acCommandQueue.push({
                    state: {...this.desiredState},
                    callback: () => {
                        cb(HAPStatus.SUCCESS);
                        service.setCharacteristic(hap.Characteristic.On, false);
                    }
                })
            });
        this.extraServices.push(service);
    }

    private messageHandler = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        this.log(`Received message from ${rinfo.address}:${rinfo.port}`);
        this.last_updated = Date.now();

        if (this.acCommandQueue.length === 0) {
            this.executeGenericCommand(rinfo);
        } else {
            this.executeAcCommand(rinfo);
        }
    }

    private executeGenericCommand(rinfo: dgram.RemoteInfo) {
        if (this.genericCommandQueue.length > 0) {
            const cmd = this.genericCommandQueue.shift();
            this.udp_server.send(cmd.buffer, rinfo.port, rinfo.address);
            cmd.callback(true);
        }
    }

    private executeAcCommand(rinfo: dgram.RemoteInfo) {
        this.acCommandQueue.reverse();
        while (this.acCommandQueue.length > 1) {
            this.acCommandQueue.pop().callback(false);
        }

        if (this.acCommandQueue.length >= 1) {
            const cmd = this.acCommandQueue[0];

            let [signal, state] = this.selectClosestTemperature(cmd);
            let buf = Buffer.alloc(2 + (signal.length / 2));
            buf.writeUint16LE(this.config.tx_freq);
            buf.write(signal, 2, "hex");

            this.udp_server.send(buf, rinfo.port, rinfo.address);
            cmd.callback(true);
        }
    }

    private selectClosestTemperature(cmd: AcCommand): [string, State] {
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
            this.thermostatService,
            ...this.extraServices
        ];
    }
}
