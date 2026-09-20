#!/usr/bin/env python3
"""Enumerate the watch's GATT table from the Mac.

The HCI snoop gives you ATT *handles*; to talk to the watch from your own code
you need the *UUIDs* behind them. This prints both, so handles seen in a capture
can be resolved to something addressable.

Turn Bluetooth off on the phone first — the watch accepts one connection and the
companion app will be holding it.

    python3 -m venv .venv && . .venv/bin/activate && pip install bleak
    python3 tools/gatt-dump.py --scan
    python3 tools/gatt-dump.py --address <ADDR>
"""

import argparse
import asyncio
import sys

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("bleak not installed:  pip install bleak")


async def scan(seconds: float) -> None:
    print(f"Scanning {seconds:.0f}s — the watch usually advertises as 'CMF Watch Pro 2'\n")
    devices = await BleakScanner.discover(timeout=seconds)
    if not devices:
        print("Nothing found. Is the watch already connected to the phone?")
        return
    for d in sorted(devices, key=lambda x: x.name or "￿"):
        print(f"  {d.address}   {d.name or '(unnamed)'}")


async def dump(address: str) -> None:
    async with BleakClient(address) as client:
        print(f"Connected to {address}\n")
        for service in client.services:
            print(f"service  {service.uuid}   {service.description}")
            for char in service.characteristics:
                props = ",".join(char.properties)
                # handle is what you'll match against the snoop capture
                print(f"  char   {char.uuid}  handle=0x{char.handle:04x}  [{props}]")
                for desc in char.descriptors:
                    print(f"    desc {desc.uuid}  handle=0x{desc.handle:04x}")
            print()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scan", action="store_true", help="list nearby BLE devices")
    ap.add_argument("--seconds", type=float, default=10.0, help="scan duration")
    ap.add_argument("--address", help="device address to dump the GATT table of")
    args = ap.parse_args()

    if args.scan:
        asyncio.run(scan(args.seconds))
    elif args.address:
        asyncio.run(dump(args.address))
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
