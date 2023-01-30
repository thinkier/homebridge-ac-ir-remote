import {AccessoryConfig} from "homebridge";

export interface Config extends AccessoryConfig {
    name: string;
    timeout: number;
    beacon_port: number;
    tx_freq: number;
    captures: {
        off: string;
        cool: string;
        heat: string;
        auto: string;
    }
}
