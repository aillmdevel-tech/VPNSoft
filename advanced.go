package main

import (
	"encoding/json"
	"errors"
	"strings"
)

// Zero values inherit the imported Xray configuration and the router defaults.
type advancedOptions struct {
	EngineDNS string `json:"engineDNS"`
	HTTP      int    `json:"http"`
	WiFi      string `json:"wifi,omitempty"`
	Sniff     string `json:"sniff"`
	Mux       string `json:"mux"`
	IP        string `json:"ip"`
	Fragment  string `json:"fragment"`
	Method    string `json:"method"`
	Timeout   int    `json:"timeout"`
	Interval  int    `json:"interval"`
	Socks     int    `json:"socks"`
}

func parseAdvanced(s string) (advancedOptions, error) {
	var o advancedOptions
	if err := json.Unmarshal([]byte(s), &o); err != nil {
		return o, err
	}
	allowed := func(value, choices string) bool {
		for _, c := range strings.Split(choices, ",") {
			if c == value {
				return true
			}
		}
		return false
	}
	if !allowed(o.EngineDNS, ",profile,cloudflare,google,quad9") || (o.HTTP != 0 && o.HTTP != 10809 && o.HTTP != 8080) || !allowed(o.Sniff, ",profile,on,off") || !allowed(o.Mux, ",profile,off,4,8,16") || !allowed(o.IP, ",profile,UseIPv4,UseIPv6") || !allowed(o.Fragment, ",profile,tlshello") || !allowed(o.Method, ",GET,HEAD") || (o.Timeout != 0 && (o.Timeout < 5 || o.Timeout > 15)) || (o.Interval != 0 && o.Interval != 15 && o.Interval != 30 && o.Interval != 60) || (o.Socks != 0 && (o.Socks < 1024 || o.Socks > 65535)) {
		return o, errors.New("invalid advanced settings")
	}
	if o.Method == "" {
		o.Method = "GET"
	}
	if o.Timeout == 0 {
		o.Timeout = 6
	}
	if o.Interval == 0 {
		o.Interval = 15
	}
	return o, nil
}
func override(s string) bool { return s != "" && s != "profile" }
func (o advancedOptions) modifiesXray() bool {
	return override(o.EngineDNS) || override(o.Sniff) || override(o.Mux) || override(o.IP) || override(o.Fragment)
}

type configMap = map[string]any

func section(m configMap, k string) configMap {
	v, _ := m[k].(map[string]any)
	if v == nil {
		v = configMap{}
		m[k] = v
	}
	return v
}

func (o advancedOptions) xrayConfig(raw []byte) ([]byte, error) {
	var doc configMap
	// Preserve integer precision in imported engine-specific fields.
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, errors.New("empty Xray configuration")
	}
	if override(o.EngineDNS) {
		resolver := map[string]string{"cloudflare": "https://1.1.1.1/dns-query", "google": "https://8.8.8.8/dns-query", "quad9": "https://9.9.9.9/dns-query"}[o.EngineDNS]
		section(doc, "dns")["servers"] = []string{resolver}
	}
	inbounds, _ := doc["inbounds"].([]any)
	if override(o.Sniff) {
		for _, v := range inbounds {
			in, _ := v.(map[string]any)
			if in["protocol"] != "socks" {
				continue
			}
			sn := section(in, "sniffing")
			sn["enabled"] = o.Sniff == "on"
			if o.Sniff == "on" {
				sn["destOverride"] = []string{"http", "tls", "quic"}
				sn["routeOnly"] = true
			}
		}
	}
	outs, _ := doc["outbounds"].([]any)
	tag := "route-tls-fragment"
	for {
		found := false
		for _, v := range outs {
			out, _ := v.(map[string]any)
			if out["tag"] == tag {
				found = true
				break
			}
		}
		if !found {
			break
		}
		tag += "x"
	}
	used := false
	for _, v := range outs {
		out, _ := v.(map[string]any)
		switch out["protocol"] {
		case "vless", "vmess", "trojan", "shadowsocks":
		default:
			continue
		}
		if override(o.Mux) {
			if o.Mux == "off" {
				section(out, "mux")["enabled"] = false
			} else if out["protocol"] != "shadowsocks" && !usesVision(out) {
				mux := section(out, "mux")
				mux["enabled"] = true
				mux["concurrency"] = map[string]int{"4": 4, "8": 8, "16": 16}[o.Mux]
			}
		}
		if override(o.IP) {
			section(section(out, "streamSettings"), "sockopt")["domainStrategy"] = o.IP
		}
		if o.Fragment == "tlshello" {
			s, _ := out["streamSettings"].(map[string]any)
			if s == nil || s["security"] != "tls" {
				continue
			}
			switch s["network"] {
			case nil, "", "tcp", "raw", "ws", "httpupgrade", "grpc":
			default:
				continue
			}
			if proxy, _ := out["proxySettings"].(map[string]any); len(proxy) > 0 {
				continue
			}
			sock := section(s, "sockopt")
			if existing, _ := sock["dialerProxy"].(string); existing != "" {
				continue
			}
			sock["dialerProxy"] = tag
			used = true
		}
	}
	if used {
		doc["outbounds"] = append(outs, configMap{"tag": tag, "protocol": "freedom", "settings": configMap{"fragment": configMap{"packets": "tlshello", "length": "100-200", "interval": "10-20"}}})
	}
	return json.Marshal(doc)
}
func usesVision(out configMap) bool {
	settings, _ := out["settings"].(map[string]any)
	if flow, _ := settings["flow"].(string); flow != "" {
		return true
	}
	vs, _ := settings["vnext"].([]any)
	for _, v := range vs {
		node, _ := v.(map[string]any)
		users, _ := node["users"].([]any)
		for _, u := range users {
			user, _ := u.(map[string]any)
			if flow, _ := user["flow"].(string); flow != "" {
				return true
			}
		}
	}
	return false
}
