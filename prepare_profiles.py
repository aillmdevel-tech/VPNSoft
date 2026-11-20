#!/usr/bin/env python3
"""Assemble local test profiles without embedding their credentials in the app."""
import argparse
import json
import os
import re
import zipfile
from pathlib import Path
from urllib.parse import quote

parser = argparse.ArgumentParser()
parser.add_argument("archives", type=Path, help="directory containing the two archive folders")
parser.add_argument("output", type=Path)
parser.add_argument("--user", choices=[f"{i:02}" for i in range(1, 11)], required=True)
parser.add_argument("--platform", choices=["android", "macos"], required=True)
parser.add_argument("--reality", type=Path)
parser.add_argument("--mieru", type=Path)
parser.add_argument("--underlay", help="Optional physical interface for XHTTP/3 and NaiveProxy on Mac")
args = parser.parse_args()
if args.underlay and (args.platform != "macos" or not re.fullmatch(r"en\d+", args.underlay)):
    parser.error("--underlay requires a macOS en interface")
os.umask(0o077)
args.output.mkdir(mode=0o700, exist_ok=False)
archives = args.archives
tests = archives / "vpn-protocol-tests-20261119"
number = args.user
profiles = []


def member(path, name):
    with zipfile.ZipFile(path) as archive:
        return archive.read(name)


def add(kind, port, suffix, body):
    key = f"{kind}-{number}"
    profiles.append({"id": key, "kind": kind, "port": port})
    path = args.output / f"{key}.{suffix}"
    path.write_bytes(body if isinstance(body, bytes) else body.encode())
    return key


def json_body(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def xray_config(config, port, security):
    outbounds = config.get("outbounds", [])
    target = next((item for item in outbounds if item.get("protocol") == "vless"), None)
    if not target:
        raise SystemExit("VLESS outbound missing")
    stream = target.get("streamSettings", {})
    if stream.get("network") != "xhttp" or stream.get("security") != security:
        raise SystemExit("VLESS outbound must use XHTTP and the requested security")
    if security == "tls":
        tls = stream.get("tlsSettings", {})
        if "h3" not in tls.get("alpn", []) or tls.get("allowInsecure") is True:
            raise SystemExit("XHTTP archive must use authenticated HTTP/3")
        if args.underlay:
            stream.setdefault("sockopt", {})["interface"] = args.underlay
    return json_body({
        "log": {"loglevel": "warning"},
        "inbounds": [{"listen": "127.0.0.1", "port": port, "protocol": "socks", "settings": {"auth": "noauth"}}],
        "outbounds": [target],
    })


tls_data = member(archives / "happ-xhttp3-clients-20261119/Happ-185-XHTTP3-10-clients.zip",
                  f"Happ-185-XHTTP3-{number}.json")
add("xhttp-tls", 17691, "json", xray_config(json.loads(tls_data), 17691, "tls"))
naive = json.loads(member(tests / "NaiveProxy-10-macOS.zip", f"NaiveProxy/NaiveProxy-{number}.json"))
naive["inbounds"][0]["listen_port"] = 17692
if args.platform == "android":
    out = naive["outbounds"][0]
    if not out.get("quic") or out.get("tls", {}).get("insecure") is True:
        raise SystemExit("Naive profile must use authenticated QUIC")
    netloc = f"{out['server']}:{out['server_port']}"
    proxy = f"quic://{quote(out['username'], safe='')}:{quote(out['password'], safe='')}@{netloc}"
    key = add("naive", 17692, "json", json_body({"listen": "socks://127.0.0.1:17692", "proxy": proxy}))
    cert = out["tls"]["certificate"]
    (args.output / f"{key}.pem").write_text("\n".join(cert) if isinstance(cert, list) else cert)
else:
    if args.underlay:
        naive["outbounds"][0]["bind_interface"] = args.underlay
    add("naive", 17692, "json", json_body(naive))

trust = member(tests / "TrustTunnel-10-macOS.zip", f"trust-{number}.toml").decode()
trust, count = re.subn(r'(?m)^(address\s*=\s*)"127\.0\.0\.1:\d+"\s*$', r'\g<1>"127.0.0.1:17693"', trust)
if count != 1:
    raise SystemExit("TrustTunnel localhost SOCKS listener missing")
add("trusttunnel", 17693, "toml", trust)
awg = member(tests / "AmneziaWG/AmneziaWG-185-10-profiles.zip", f"AmneziaWG-185-{number}.conf")
add("amneziawg", 17694, "conf", awg)
if args.reality:
    add("xhttp-reality", 17695, "json", xray_config(json.loads(args.reality.read_bytes()), 17695, "reality"))
if args.mieru:
    mieru = json.loads(args.mieru.read_bytes())
    mieru["socks5Port"] = 17696
    mieru["socks5ListenLAN"] = False
    mieru["httpProxyListenLAN"] = False
    mieru.pop("httpProxyPort", None)
    mieru.pop("rpcPort", None)
    add("mieru", 17696, "json", json_body(mieru))
(args.output / "profiles.json").write_text(json_body({"profiles": profiles}))
print(f"Prepared {len(profiles)} private profiles.")

