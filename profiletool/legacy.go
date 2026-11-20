package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	xlog "github.com/xtls/xray-core/common/log"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// The CLI's stdout is a machine-readable response and stderr reaches the UI.
type quietCore struct{}

func (quietCore) Handle(xlog.Message) {}
func init()                           { xlog.RegisterHandler(quietCore{}) }

func legacyVMess(value string) (string, error) {
	for _, enc := range []*base64.Encoding{base64.RawStdEncoding, base64.StdEncoding, base64.RawURLEncoding, base64.URLEncoding} {
		b, err := enc.DecodeString(value)
		if err != nil {
			continue
		}
		var doc map[string]json.RawMessage
		if json.Unmarshal(b, &doc) != nil {
			continue
		}
		get := func(k string) string {
			var s string
			if json.Unmarshal(doc[k], &s) == nil {
				return s
			}
			return string(doc[k])
		}
		port, err := strconv.Atoi(get("port"))
		if !validHost(get("add")) || !uuid.MatchString(get("id")) || err != nil || port < 1 || port > 65535 {
			return "", badLink
		}
		if aid := get("aid"); aid != "" && aid != "0" {
			return "", errors.New("Устаревший режим VMess alterId не поддерживается ядром")
		}
		q := url.Values{}
		for src, dst := range map[string]string{"net": "type", "tls": "security", "sni": "sni", "host": "host", "path": "path", "alpn": "alpn", "fp": "fp", "scy": "encryption", "type": "headerType"} {
			if val := get(src); val != "" {
				q.Set(dst, val)
			}
		}
		if q.Get("type") == "grpc" {
			q.Set("serviceName", get("path"))
		}
		link := url.URL{Scheme: "vmess", User: url.User(get("id")), Host: net.JoinHostPort(get("add"), strconv.Itoa(port)), RawQuery: q.Encode(), Fragment: get("ps")}
		return link.String(), nil
	}
	return "", errors.New("Неверный профиль VMess")
}

func wireGuardLink(line string) (item, error) {
	link, err := url.Parse(line)
	if err != nil || link.User == nil || !validHost(link.Hostname()) {
		return item{}, badLink
	}
	port, err := strconv.Atoi(link.Port())
	if err != nil || port < 1 || port > 65535 {
		return item{}, badLink
	}
	q := link.Query()
	peer := object{"publicKey": q.Get("publickey"), "endpoint": link.Host}
	cfg := object{"secretKey": link.User.Username(), "peers": []object{peer}}
	for k := range q {
		switch strings.ToLower(k) {
		case "publickey":
			peer["publicKey"] = q.Get(k)
		case "presharedkey":
			peer["preSharedKey"] = q.Get(k)
		case "address":
			cfg["address"] = strings.Split(q.Get(k), ",")
		case "mtu":
			v, e := strconv.Atoi(q.Get(k))
			if e != nil || v < 576 || v > 65535 {
				return item{}, badLink
			}
			cfg["mtu"] = v
		case "reserved":
			var bytes []int
			for _, s := range strings.Split(q.Get(k), ",") {
				v, e := strconv.Atoi(s)
				if e != nil || v < 0 || v > 255 {
					return item{}, badLink
				}
				bytes = append(bytes, v)
			}
			if len(bytes) != 3 {
				return item{}, badLink
			}
			cfg["reserved"] = bytes
		case "keepalive":
			v, e := strconv.Atoi(q.Get(k))
			if e != nil || v < 0 || v > 65535 {
				return item{}, badLink
			}
			peer["keepAlive"] = v
		default:
			return item{}, errors.New("Неизвестный параметр ссылки WireGuard")
		}
	}
	return clientDocument(raw(object{"remarks": link.Fragment, "outbounds": []object{{"protocol": "wireguard", "settings": cfg}}}))
}
