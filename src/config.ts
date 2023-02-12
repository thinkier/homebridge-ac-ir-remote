import {AccessoryConfig} from "homebridge";

export interface Config extends AccessoryConfig {
    name: string;
    timeout: number;
    beacon_port: number;
    tx_freq: number;
    signals: {
        off: string;
        cool: Record<string, string>;
        heat: Record<string, string>;
        auto: Record<string, string>;
    };
    enable_repeat: boolean;
    extras: {
        name: string,
        tx_freq: number,
        hex: string
    }[];
}
