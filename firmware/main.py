import time
import gpio_pulser
import network

from socket import socket, AF_INET, SOCK_STREAM, SOCK_DGRAM
# enable station interface and connect to WiFi access point
from secrets import WIFI_SSID, WIFI_PASS

def wifi_connect():
    rp2.country('AU')
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    wlan.connect(WIFI_SSID, WIFI_PASS)

    # WiFi Connection code from https://datasheets.raspberrypi.com/picow/connecting-to-the-internet-with-pico-w.pdf
    max_wait = 10
    for _ in range(max_wait):
        status = wlan.status()
        if status < 0 or status >= 3:
            break
        time.sleep(1)

    if wlan.status() != 3:
        print('wifi connection failed')
        wlan.active(False)

    ip = wlan.ifconfig()[0]
    print('WiFi connected; ip = ' + ip)
    return wlan


wifi_connect()

s = socket(AF_INET, SOCK_STREAM)
s.bind(('0.0.0.0', 3456))
s.listen()

gpio_pulser.init(2)
gpio_pulser.write(38e3, [0])

