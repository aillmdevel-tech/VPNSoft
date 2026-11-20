package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type androidPolicy struct {
	Secret string            `json:"secret"`
	Apps   map[string]string `json:"apps"`
}

func readAndroidPolicy(path string) (*androidPolicy, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("protected application policy unavailable")
	}
	var policy androidPolicy
	if json.Unmarshal(raw, &policy) != nil || len(policy.Secret) != 64 {
		return nil, errors.New("invalid protected application policy")
	}
	if _, err := hex.DecodeString(policy.Secret); err != nil {
		return nil, errors.New("invalid private listener credential")
	}
	for uid, binding := range policy.Apps {
		n, err := strconv.Atoi(uid)
		if err != nil || n <= 0 {
			return nil, errors.New("invalid protected application UID")
		}
		if binding != "any" {
			ip, err := netip.ParseAddr(binding)
			if err != nil || ip.String() != binding {
				return nil, errors.New("invalid protected application server")
			}
		}
	}
	return &policy, nil
}

func serviceClass(host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, name := range []string{"t.me", "telegram.org"} {
		if host == name || strings.HasSuffix(host, "."+name) {
			return "telegram"
		}
	}
	for _, name := range []string{"chatgpt.com", "openai.com"} {
		if host == name || strings.HasSuffix(host, "."+name) {
			return "chat"
		}
	}
	return "proxy"
}

func socksString(r io.Reader) (string, error) {
	var size [1]byte
	if _, err := io.ReadFull(r, size[:]); err != nil {
		return "", err
	}
	value := make([]byte, int(size[0]))
	_, err := io.ReadFull(r, value)
	return string(value), err
}

func socksClientAuth(conn net.Conn, user, password string) error {
	message := append([]byte{1, byte(len(user))}, user...)
	message = append(append(message, byte(len(password))), password...)
	if _, err := conn.Write(message); err != nil {
		return err
	}
	var response [2]byte
	if _, err := io.ReadFull(conn, response[:]); err != nil {
		return err
	}
	if response != [2]byte{1, 0} {
		return errors.New("local proxy refused authentication")
	}
	return nil
}

func (r *router) authorizeFlow(conn net.Conn, methods []byte) (string, bool) {
	if r.policy == nil {
		if !bytes.Contains(methods, []byte{0}) {
			_, _ = conn.Write([]byte{5, 255})
			return "", false
		}
		_, err := conn.Write([]byte{5, 0})
		return "", err == nil
	}
	if !bytes.Contains(methods, []byte{2}) {
		_, _ = conn.Write([]byte{5, 255})
		return "", false
	}
	if _, err := conn.Write([]byte{5, 2}); err != nil {
		return "", false
	}
	var version [1]byte
	if _, err := io.ReadFull(conn, version[:]); err != nil || version[0] != 1 {
		return "", false
	}
	owner, err := socksString(conn)
	if err != nil {
		return "", false
	}
	password, err := socksString(conn)
	if err != nil {
		return "", false
	}
	uid, ok := strings.CutPrefix(owner, "u")
	n, uidErr := strconv.Atoi(uid)
	if subtle.ConstantTimeCompare([]byte(password), []byte(r.policy.Secret)) != 1 || !ok || uidErr != nil || n <= 0 {
		_, _ = conn.Write([]byte{1, 1})
		return "", false
	}
	_, err = conn.Write([]byte{1, 0})
	return r.policy.Apps[uid], err == nil
}

func (r *router) dialUpstream(ctx context.Context, p profile, target string) (net.Conn, error) {
	if r.policy != nil {
		return p.dialAuthenticated(ctx, target, r.policy.Secret)
	}
	return p.dial(ctx, target)
}

type fixedOutbound struct {
	Protocol string `json:"protocol"`
	Settings struct {
		VNext []struct {
			Address string            `json:"address"`
			Port    int               `json:"port"`
			Users   []json.RawMessage `json:"users"`
		} `json:"vnext"`
	} `json:"settings"`
	Stream struct {
		Network  string          `json:"network"`
		Security string          `json:"security"`
		TLS      json.RawMessage `json:"tlsSettings,omitempty"`
		Reality  json.RawMessage `json:"realitySettings,omitempty"`
		XHTTP    struct {
			Path string `json:"path"`
			Host string `json:"host,omitempty"`
			Mode string `json:"mode,omitempty"`
		} `json:"xhttpSettings"`
	} `json:"streamSettings"`
}

func usableXray(dir string, p profile) (fixedOutbound, string, bool) {
	var empty fixedOutbound
	if !profileID.MatchString(p.ID) || p.Kind != "xhttp-tls" && p.Kind != "xhttp-reality" {
		return empty, "", false
	}
	raw, err := os.ReadFile(filepath.Join(dir, p.ID+".json"))
	if err != nil {
		return empty, "", false
	}
	var conf struct {
		Outbounds []fixedOutbound `json:"outbounds"`
	}
	if json.Unmarshal(raw, &conf) != nil || len(conf.Outbounds) != 1 {
		return empty, "", false
	}
	out := conf.Outbounds[0]
	if out.Protocol != "vless" || out.Stream.Network != "xhttp" || len(out.Settings.VNext) != 1 {
		return empty, "", false
	}
	endpoint := out.Settings.VNext[0]
	ip, err := netip.ParseAddr(endpoint.Address)
	if err != nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || endpoint.Port < 1 || endpoint.Port > 65535 || len(endpoint.Users) == 0 {
		return empty, "", false
	}
	if p.Kind == "xhttp-tls" {
		var tls struct {
			AllowInsecure bool `json:"allowInsecure"`
		}
		if out.Stream.Security != "tls" || json.Unmarshal(out.Stream.TLS, &tls) != nil || tls.AllowInsecure {
			return empty, "", false
		}
		out.Stream.Reality = nil
	} else {
		if out.Stream.Security != "reality" || len(out.Stream.Reality) == 0 {
			return empty, "", false
		}
		out.Stream.TLS = nil
	}
	return out, ip.String(), true
}

func printProtectedServers(manifest string) error {
	raw, err := os.ReadFile(manifest)
	if err != nil {
		return err
	}
	var cfg bundle
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return err
	}
	known := map[string]bool{}
	for _, p := range cfg.Profiles {
		if _, server, valid := usableXray(filepath.Dir(manifest), p); valid {
			known[server] = true
		}
	}
	names := make([]string, 0, len(known))
	for ip := range known {
		names = append(names, ip)
	}
	sort.Strings(names)
	return json.NewEncoder(os.Stdout).Encode(names)
}

func prepareProtectedProfiles(dir string, all []profile, secret string) ([]profile, map[string]string, string, error) {
	out, err := os.MkdirTemp(filepath.Dir(dir), "protected-engines-")
	if err != nil {
		return nil, nil, "", err
	}
	clean := true
	defer func() {
		if clean {
			_ = os.RemoveAll(out)
		}
	}()
	servers := map[string]string{}
	var supported []profile
	for _, p := range all {
		upstream, server, valid := usableXray(dir, p)
		if !valid {
			continue
		}
		config := map[string]any{
			"log": map[string]any{"loglevel": "warning"},
			"inbounds": []map[string]any{{
				"listen": "127.0.0.1", "port": p.Port, "protocol": "socks",
				"settings": map[string]any{"auth": "password", "accounts": []map[string]string{{"user": "route", "pass": secret}}},
			}},
			"outbounds": []fixedOutbound{upstream},
		}
		data, err := json.Marshal(config)
		if err != nil {
			return nil, nil, "", err
		}
		if err := os.WriteFile(filepath.Join(out, p.ID+".json"), data, 0600); err != nil {
			return nil, nil, "", fmt.Errorf("prepare private endpoint %s: %w", p.ID, err)
		}
		servers[p.ID] = server
		supported = append(supported, p)
	}
	if len(supported) == 0 {
		return nil, nil, "", errors.New("no compatible authenticated VPN routes")
	}
	clean = false
	return supported, servers, out, nil
}
