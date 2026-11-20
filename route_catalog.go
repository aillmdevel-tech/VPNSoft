package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type catalogEntry struct {
	SubscriptionID   string `json:"subscriptionID,omitempty"`
	SubscriptionName string `json:"subscriptionName,omitempty"`
	Hidden           bool   `json:"hidden,omitempty"`
	ID               string `json:"id"`
	Name             string `json:"name,omitempty"`
	Kind             string `json:"kind"`
	Endpoint         string `json:"endpoint,omitempty"`
	Location         string `json:"location,omitempty"`
	Protected        bool   `json:"protected"`
}

// Provider geofeed prefixes, ordered from more specific to less specific.
var locations = []struct {
	prefix netip.Prefix
	city   string
}{
	{netip.MustParsePrefix("131.123.37.0/24"), "sofia"},
	{netip.MustParsePrefix("132.243.161.0/24"), "zurich"},
	{netip.MustParsePrefix("176.123.5.0/24"), "chisinau"},
}

func profileLocation(host string) string {
	// Two public IP location records agree for this endpoint; adjacent IPs are unknown.
	if host == "185.216.44.33" {
		return "vilnius"
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return ""
	}
	for _, entry := range locations {
		if entry.prefix.Contains(ip.Unmap()) {
			return entry.city
		}
	}
	return ""
}

var hostPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.\-]{0,252}$`)
var trustAddress = regexp.MustCompile(`(?m)^addresses\s*=\s*\[\s*"([^"]+)"`)
var peerAddress = regexp.MustCompile(`(?mi)^\s*Endpoint\s*=\s*([^\s#;]+)`)

func catalogHost(raw string) string {
	raw = strings.ToLower(strings.TrimSuffix(raw, "."))
	if ip, err := netip.ParseAddr(raw); err == nil && ip.Zone() == "" {
		return ip.Unmap().String()
	}
	if hostPattern.MatchString(raw) {
		return raw
	}
	return ""
}

func profileHost(dir string, p profile) string {
	_, _, valid := p.command("")
	if !valid || p.Kind == "external" {
		return ""
	}
	path := filepath.Join(dir, p.ID+".json")
	switch p.Kind {
	case "trusttunnel":
		path = filepath.Join(dir, p.ID+".toml")
	case "amneziawg":
		path = filepath.Join(dir, p.ID+".conf")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	if p.Kind == "trusttunnel" || p.Kind == "amneziawg" {
		pattern := trustAddress
		if p.Kind == "amneziawg" {
			pattern = peerAddress
		}
		if match := pattern.FindStringSubmatch(string(raw)); len(match) > 0 {
			host, _, _ := net.SplitHostPort(match[1])
			return catalogHost(host)
		}
		return ""
	}
	var config struct {
		Proxy     string `json:"proxy"`
		Outbounds []struct {
			Protocol string `json:"protocol"`
			Type     string `json:"type"`
			Server   string `json:"server"`
			Settings struct {
				Address string
				Servers []struct{ Address string }
				Peers   []struct{ Endpoint string }
				VNext   []struct{ Address string } `json:"vnext"`
			}
		}
		ActiveProfile string
		Profiles      []struct {
			ProfileName string
			Servers     []struct{ IPAddress, DomainName string }
		}
	}
	if json.Unmarshal(raw, &config) != nil {
		return ""
	}
	switch p.Kind {
	case "naive":
		if proxy, err := url.Parse(config.Proxy); err == nil && proxy.Hostname() != "" {
			return catalogHost(proxy.Hostname())
		}
		for _, out := range config.Outbounds {
			if out.Type == "naive" {
				return catalogHost(out.Server)
			}
		}
	case "xhttp-tls", "xhttp-reality", "xray", "vmess", "vless", "shadowsocks", "socks", "trojan", "wireguard", "hysteria":
		for _, out := range config.Outbounds {
			if host := catalogHost(out.Settings.Address); host != "" {
				return host
			}
			if len(out.Settings.Servers) > 0 {
				return catalogHost(out.Settings.Servers[0].Address)
			}
			if len(out.Settings.Peers) > 0 {
				host, _, _ := net.SplitHostPort(out.Settings.Peers[0].Endpoint)
				return catalogHost(host)
			}
			if len(out.Settings.VNext) == 1 {
				return catalogHost(out.Settings.VNext[0].Address)
			}
		}
	case "mieru":
		for _, entry := range config.Profiles {
			if entry.ProfileName == config.ActiveProfile && len(entry.Servers) == 1 {
				server := entry.Servers[0]
				if host := catalogHost(server.IPAddress); host != "" {
					return host
				}
				return catalogHost(server.DomainName)
			}
		}
	}
	return ""
}

func printCatalog(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var spec bundle
	if err := json.Unmarshal(raw, &spec); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	items := make([]catalogEntry, 0, len(spec.Profiles))
	for _, p := range spec.Profiles {
		if !profileID.MatchString(p.ID) {
			continue
		}
		host := profileHost(dir, p)
		_, _, protected := usableXray(dir, p)
		if p.Hidden {
			host = ""
		}
		items = append(items, catalogEntry{p.SubscriptionID, p.SubscriptionName, p.Hidden, p.ID, p.Name, p.Kind, host, profileLocation(host), protected})
	}
	result, err := json.Marshal(items)
	if err == nil {
		fmt.Println(string(result))
	}
	return err
}
