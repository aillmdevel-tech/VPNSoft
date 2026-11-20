// Offline profile transfer. The QR carries one profile and never a subscription URL.
package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/pelletier/go-toml/v2"
	qrcode "github.com/skip2/go-qrcode"
)

const qrPrefix = "route-profile:1:"

var nativeExt = map[string]string{"amneziawg": ".conf", "trusttunnel": ".toml", "mieru": ".json", "naive": ".json"}
var invalidQR = errors.New("Некорректный или неподдерживаемый профиль QR")

type transfer struct {
	Kind   string `json:"k"`
	Name   string `json:"n,omitempty"`
	Config string `json:"c"`
	CA     string `json:"ca,omitempty"`
}

func readTransfer(dir, id string) (transfer, error) {
	var t transfer
	if !profileID.MatchString(id) || id == "profiles" {
		return t, invalidQR
	}
	m, e := load(dir)
	if e != nil {
		return t, e
	}
	for _, p := range m.Profiles {
		if field[string](p["id"]) != id {
			continue
		}
		if field[bool](p["hidden"]) {
			return t, errors.New("Экспорт этого профиля скрыт")
		}
		t.Kind = field[string](p["kind"])
		t.Name = field[string](p["name"])
		ext := nativeExt[t.Kind]
		if ext == "" {
			if !xrayKind(t.Kind) && t.Kind != "xhttp-reality" && t.Kind != "xhttp-tls" {
				return t, invalidQR
			}
			ext = ".json"
		}
		b, e := os.ReadFile(filepath.Join(dir, id+ext))
		if e != nil {
			return t, e
		}
		t.Config = string(b)
		if t.Kind == "naive" {
			var c struct {
				Proxy     string
				Outbounds []struct {
					Type, Username, Password, Server string
					Port                             int `json:"server_port"`
					QUIC                             bool
					TLS                              struct {
						Certificate []string
						Name        string `json:"server_name"`
					}
				}
			}
			if json.Unmarshal(b, &c) != nil {
				return t, invalidQR
			}
			if c.Proxy != "" {
				cert, e := os.ReadFile(filepath.Join(dir, id+".pem"))
				if e != nil && !os.IsNotExist(e) {
					return t, e
				}
				t.Config = c.Proxy
				t.CA = string(cert)
			} else if len(c.Outbounds) == 1 && c.Outbounds[0].Type == "naive" {
				o := c.Outbounds[0]
				if o.TLS.Name != "" && o.TLS.Name != o.Server {
					return t, errors.New("Для отдельного SNI используйте ZIP")
				}
				scheme := "https"
				if o.QUIC {
					scheme = "quic"
				}
				u := url.URL{Scheme: scheme, Host: net.JoinHostPort(o.Server, strconv.Itoa(o.Port)), User: url.UserPassword(o.Username, o.Password)}
				t.Config = u.String()
				t.CA = strings.Join(o.TLS.Certificate, "\n")
			} else {
				return t, invalidQR
			}
		}
		return t, nil
	}
	return t, errors.New("Профиль отсутствует")
}
func qrText(t transfer) (string, error) {
	if nativeExt[t.Kind] == "" {
		var c object
		if json.Unmarshal([]byte(t.Config), &c) != nil || c == nil {
			return "", invalidQR
		}
		delete(c, "inbounds")
		if t.Name != "" {
			c["remarks"] = t.Name
		}
		// Interface names are device-specific.
		if outs, ok := c["outbounds"].([]any); ok {
			for _, o := range outs {
				v, _ := o.(map[string]any)
				s, _ := v["streamSettings"].(map[string]any)
				sock, _ := s["sockopt"].(map[string]any)
				delete(sock, "interface")
			}
		}
		t.Config = string(raw(c))
		if len(t.Config) < 1600 {
			return t.Config, nil
		}
	}
	var b bytes.Buffer
	z := zlib.NewWriter(&b)
	if _, e := z.Write(raw(t)); e != nil {
		return "", e
	}
	if e := z.Close(); e != nil {
		return "", e
	}
	return qrPrefix + base64.RawURLEncoding.EncodeToString(b.Bytes()), nil
}
func makeQR(dir, id string) error {
	t, e := readTransfer(dir, id)
	if e != nil {
		return e
	}
	s, e := qrText(t)
	if e != nil {
		return e
	}
	code, e := qrcode.New(s, qrcode.Medium)
	if e != nil {
		return errors.New("Профиль слишком велик для одного QR-кода. Используйте ZIP.")
	}
	b, e := code.PNG(-6)
	if e == nil {
		fmt.Print(base64.StdEncoding.EncodeToString(b))
	}
	return e
}
func decodeTransfer(s string) (transfer, error) {
	var t transfer
	if len(s) > 4096 {
		return t, invalidQR
	}
	b, e := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(s, qrPrefix))
	if e != nil {
		return t, invalidQR
	}
	z, e := zlib.NewReader(bytes.NewReader(b))
	if e != nil {
		return t, invalidQR
	}
	defer z.Close()
	b, e = io.ReadAll(io.LimitReader(z, 65537))
	if e != nil || len(b) > 65536 || json.Unmarshal(b, &t) != nil || len(t.Name) > 512 {
		return t, invalidQR
	}
	return t, nil
}
func onlyKeys(m map[string]any, keys string) bool {
	for k := range m {
		if !strings.Contains(" "+keys+" ", " "+k+" ") || strings.Contains(k, " ") {
			return false
		}
	}
	return true
}
func (t transfer) nativeConfig(port int) ([]byte, error) {
	bind := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	switch t.Kind {
	case "amneziawg":
		for _, line := range strings.Split(t.Config, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") || line == "[Interface]" || line == "[Peer]" {
				continue
			}
			k, _, ok := strings.Cut(line, "=")
			k = strings.TrimSpace(k)
			if !ok || k == "" || strings.ContainsAny(k, " \t") || !strings.Contains(" PrivateKey Address DNS MTU Jc Jmin Jmax S1 S2 S3 S4 H1 H2 H3 H4 I1 I2 I3 I4 I5 HeaderProtectionKey RandomTrailers PublicKey PresharedKey AllowedIPs Endpoint PersistentKeepalive ", " "+k+" ") {
				return nil, invalidQR
			}
		}
		if !strings.Contains(t.Config, "[Peer]") || !strings.Contains(t.Config, "[Interface]") {
			return nil, invalidQR
		}
		return []byte(t.Config), nil
	case "trusttunnel":
		var c map[string]any
		if toml.Unmarshal([]byte(t.Config), &c) != nil || !onlyKeys(c, "loglevel vpn_mode killswitch_enabled endpoint listener") {
			return nil, invalidQR
		}
		ep, _ := c["endpoint"].(map[string]any)
		if len(ep) == 0 || !onlyKeys(ep, "name hostname addresses has_ipv6 username password skip_verification certificate upstream_protocol dns_upstreams") {
			return nil, invalidQR
		}
		c["listener"] = object{"socks": object{"address": bind}}
		return toml.Marshal(c)
	case "mieru":
		var c object
		if json.Unmarshal([]byte(t.Config), &c) != nil || c == nil || !onlyKeys(c, "profiles activeProfile socks5Port socks5ListenLAN httpProxyListenLAN loggingLevel advancedSettings") {
			return nil, invalidQR
		}
		c["socks5Port"] = port
		c["socks5ListenLAN"] = false
		c["httpProxyListenLAN"] = false
		return raw(c), nil
	case "naive":
		u, e := url.Parse(t.Config)
		if e != nil || u.User == nil || (u.Scheme != "https" && u.Scheme != "quic") || !validHost(u.Hostname()) || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
			return nil, invalidQR
		}
		remote, e := strconv.Atoi(u.Port())
		if e != nil || remote < 1 || remote > 65535 {
			return nil, invalidQR
		}
		if runtime.GOOS == "android" {
			return raw(object{"listen": "socks://" + bind, "proxy": u.String()}), nil
		}
		pass, _ := u.User.Password()
		tls := object{"enabled": true, "server_name": u.Hostname()}
		if t.CA != "" {
			tls["certificate"] = strings.Split(strings.TrimSpace(t.CA), "\n")
		}
		return raw(object{"inbounds": []object{{"type": "socks", "listen": "127.0.0.1", "listen_port": port}}, "outbounds": []object{{"type": "naive", "server": u.Hostname(), "server_port": remote, "username": u.User.Username(), "password": pass, "quic": u.Scheme == "quic", "tls": tls}}}), nil
	}
	return nil, invalidQR
}
func importTransfer(dir string, t transfer) (int, error) {
	if nativeExt[t.Kind] == "" {
		if !xrayKind(t.Kind) && t.Kind != "xhttp-tls" && t.Kind != "xhttp-reality" {
			return 0, invalidQR
		}
		it, e := clientDocument([]byte(t.Config))
		if e != nil {
			return 0, e
		}
		return insert(dir, []item{it})
	}
	norm, e := t.nativeConfig(23400)
	if e != nil {
		return 0, e
	}
	digest := sha256.Sum256(raw([]string{t.Kind, string(norm), strings.TrimSpace(t.CA)}))
	id := fmt.Sprintf("qr-%x", digest[:10])
	if e = os.MkdirAll(dir, 0700); e != nil {
		return 0, e
	}
	lock, e := os.Open(dir)
	if e != nil {
		return 0, e
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); e != nil {
		return 0, e
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	m, e := load(dir)
	if e != nil {
		return 0, e
	}
	ports := map[int]bool{}
	for _, p := range m.Profiles {
		if field[string](p["id"]) == id {
			return 0, nil
		}
		ports[field[int](p["port"])] = true
	}
	if len(m.Profiles) >= 32 {
		return 0, errors.New("Уже заняты все 32 места для профилей")
	}
	port := 23400
	for ports[port] {
		port++
	}
	data, e := t.nativeConfig(port)
	if e != nil {
		return 0, e
	}
	f := filepath.Join(dir, id+nativeExt[t.Kind])
	if e = os.WriteFile(f, data, 0600); e != nil {
		return 0, e
	}
	cert := filepath.Join(dir, id+".pem")
	if t.Kind == "naive" && t.CA != "" && runtime.GOOS == "android" {
		if e = os.WriteFile(cert, []byte(t.CA), 0600); e != nil {
			os.Remove(f)
			return 0, e
		}
	}
	m.Profiles = append(m.Profiles, map[string]json.RawMessage{"id": raw(id), "port": raw(port), "kind": raw(t.Kind), "name": raw(t.Name)})
	if e = storeManifest(dir, m); e != nil {
		os.Remove(f)
		os.Remove(cert)
		return 0, e
	}
	return 1, nil
}
