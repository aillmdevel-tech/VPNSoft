#!/usr/bin/env python3
import argparse
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid
from contextlib import ExitStack
from pathlib import Path

args = argparse.ArgumentParser()
args.add_argument("work", type=Path)
args.add_argument("--profiles", type=Path)
options = args.parse_args()
c = options.work.resolve()
os.umask(0o077)
xray = c / "engines/macos/xray"
router = c / "route-client"


def write(path, value):
    path.write_text(json.dumps(value))


def curl(mode, port, url):
    r = subprocess.run(["/usr/bin/curl","--noproxy","","--proxy",f"{mode}://127.0.0.1:{port}",
                         "--max-time","7","--silent","--output","/dev/null","--write-out","%{http_code}",url],
                        capture_output=True,text=True,timeout=9)
    return (r.returncode,r.stdout.strip())


def start(stack, command, env=None, log=None):
    if log is None:
        process = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        with log.open("wb") as output:
            process = subprocess.Popen(command, env=env, stdout=output, stderr=subprocess.STDOUT)
    def stop():
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    stack.callback(stop)
    return process


with tempfile.TemporaryDirectory(dir=c) as tmp, ExitStack() as stack:
    d = Path(tmp)
    sample = options.profiles or c / "profiles-mac"
    config = d / "profiles"
    shutil.copytree(sample, config)
    manifest = json.loads((config / "profiles.json").read_text())
    profiles = manifest["profiles"]
    keypair = {}
    for line in subprocess.check_output([xray,"x25519"],text=True).splitlines():
        key,value = line.split(":",1)
        keypair[key]=value.strip()
    peer_id = str(uuid.uuid4())
    path = "/transport"
    cover = "www.cloudflare.com"
    sid = secrets.token_hex(4)
    write(d/"xray-server.json",{
        "log":{"loglevel":"warning"},
        "inbounds":[{"listen":"127.0.0.1","port":17742,"protocol":"vless",
            "settings":{"decryption":"none","clients":[{"id":peer_id}]},
            "streamSettings":{"network":"xhttp","security":"reality",
                "realitySettings":{"target":f"{cover}:443","serverNames":[cover],"privateKey":keypair["PrivateKey"],"shortIds":[sid]},
                "xhttpSettings":{"path":path,"mode":"auto"}}}],
        "outbounds":[{"protocol":"freedom"}],
    })
    write(config/"local-reality.json",{
        "log":{"loglevel":"warning"},
        "inbounds":[{"listen":"127.0.0.1","port":17695,"protocol":"socks","settings":{"auth":"noauth"}}],
        "outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"127.0.0.1","port":17742,
            "users":[{"id":peer_id,"encryption":"none"}]}]},
            "streamSettings":{"network":"xhttp","security":"reality",
                "realitySettings":{"serverName":cover,"password":keypair["Password (PublicKey)"],"shortId":sid,"fingerprint":"chrome"},
                "xhttpSettings":{"path":path,"mode":"auto"}}}],
    })
    user = {"name":"localtest","password":secrets.token_urlsafe(24)}
    bindings = [{"port":17743,"protocol":"TCP"}]
    write(d/"mieru-server.json",{"listenIPAddress":"127.0.0.1","portBindings":bindings,"users":[user],"loggingLevel":"INFO"})
    write(config/"local-mieru.json",{
        "profiles":[{"profileName":"localtest","user":user,"servers":[{"ipAddress":"127.0.0.1","portBindings":bindings}]}],
        "activeProfile":"localtest","socks5Port":17696,"socks5ListenLAN":False,
        "advancedSettings":{"noCheckUpdate":True},"loggingLevel":"INFO",
    })
    profiles[0:0] = [{"id":"local-reality","port":17695,"kind":"xhttp-reality"},
                     {"id":"local-mieru","port":17696,"kind":"mieru"}]
    write(config/"profiles.json",manifest)
    reality = start(stack,[xray,"run","-c",d/"xray-server.json"])
    mieru = start(stack,[c/"mita","run"],{
        **os.environ,"MITA_CONFIG_JSON_FILE":str(d/"mieru-server.json"),
        "MITA_UDS_PATH":str(c/"local-mita.sock")
    }, c/"mita-check.log")
    launcher = start(stack,[router,"-config",config/"profiles.json","-engines",c/"engines/macos","-status",d/"health.json","-underlay","en0"])
    time.sleep(3)
    if launcher.poll() is not None:
        raise SystemExit("router failed to launch")
    for p in profiles:
        code = curl("http" if p["kind"]=="amneziawg" else "socks5h",p["port"],"https://www.gstatic.com/generate_204")
        print(p["kind"],code,flush=True)
    def read_active():
        try:
            return json.loads((d/"health.json").read_text())["Active"]
        except (OSError, KeyError, json.JSONDecodeError):
            return ["","",""]
    for _ in range(20):
        time.sleep(1)
        before=read_active()
        if before[1] and before[2]:
            break
    print("before",before,flush=True)
    local_only = [p for p in profiles if p["id"].startswith("local-")]
    if before[0] in [p["id"] for p in local_only]:
        primary = reality if before[0]=="local-reality" else mieru
        primary.terminate()
        primary.wait(5)
        print("controlled interruption",before[0],flush=True)
        for _ in range(44):
            time.sleep(1)
            after=read_active()
            if after[0] and after[0]!=before[0]:
                break
        print("after",after,flush=True)
    print("router HTTPS",curl("socks5h",17680,"https://www.gstatic.com/generate_204"),flush=True)
    print("RU HTTPS",curl("socks5h",17680,"https://www.yandex.ru/"),flush=True)

