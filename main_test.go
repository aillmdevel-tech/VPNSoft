package main

import (
	"context"
	"io"
	"net"
	"net/netip"
	"strconv"
	"testing"
	"time"
)

func TestRouteForRussianAndServiceDestinations(t *testing.T) {
	r := router{ranges: []netip.Prefix{netip.MustParsePrefix("77.88.0.0/18"), netip.MustParsePrefix("2a02:6b8::/29")}}
	cases := map[string]string{
		"yandex.ru": "direct", "example.su": "direct", "www.xn--e1afmkfd.xn--p1ai.": "direct",
		"77.88.21.11": "direct", "2a02:6b8::1": "direct", "192.168.0.2": "direct",
		"api.telegram.org": "telegram", "t.me": "telegram", "chatgpt.com": "chat",
		"platform.openai.com": "chat", "8.8.8.8": "proxy",
	}
	for host, want := range cases {
		if got := r.route(context.Background(), host); got != want {
			t.Errorf("%s selected %s, want %s", host, got, want)
		}
	}
}

func TestActiveAndFixedProfileRouting(t *testing.T) {
	for _, scenario := range []struct {
		name, manual, binding string
		fallback              bool
	}{
		{"automatic uses standby", "", "", true},
		{"manual blocks standby", "primary", "", false},
		{"protected app stays on its server", "primary", "192.0.2.13", true},
		{"any VPN obeys manual choice", "primary", "any", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			checkStandby(t, scenario.manual, scenario.binding, "", scenario.fallback)
		})
	}
}

func TestCityFallback(t *testing.T) {
	t.Run("next protocol on selected endpoint", func(t *testing.T) { checkStandby(t, "", "", "192.0.2.13", true) })
	t.Run("other endpoint excluded", func(t *testing.T) { checkStandby(t, "", "", "192.0.2.12", false) })
}

func checkStandby(t *testing.T, manual, binding, server string, fallback bool) {
	t.Helper()
	closed, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedPort := closed.Addr().(*net.TCPAddr).Port
	closed.Close()
	standby, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer standby.Close()
	port := standby.Addr().(*net.TCPAddr).Port
	observed := make(chan string, 1)
	go func() {
		conn, err := standby.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		defer close(observed)
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		var header [4]byte
		if _, err := io.ReadFull(conn, header[:3]); err != nil {
			return
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			return
		}
		if _, err := io.ReadFull(conn, header[:]); err != nil {
			return
		}
		target, err := readTarget(conn, header[3])
		if err != nil {
			return
		}
		if _, err = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
			return
		}
		observed <- target
	}()
	r := router{
		profiles: []profile{{ID: "primary", Kind: "external", Port: closedPort}, {ID: "secondary", Kind: "external", Port: port}},
		health:   map[string]health{"primary": {Telegram: true}, "secondary": {Telegram: true}},
		selected: [3]string{"primary", "primary", ""}, ready: true,
		manual: manual, servers: map[string]string{"primary": "192.0.2.12", "secondary": "192.0.2.13"},
	}
	if server != "" {
		r.server = server
		r.servers["primary"] = server
		r.health["secondary"] = health{} // standby has recovered since the last probe
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	address := net.JoinHostPort("api.telegram.org", strconv.Itoa(443))
	conn, err := r.dialPolicy(ctx, address, binding)
	if !fallback {
		if conn != nil {
			conn.Close()
			t.Fatal("manual mode routed through standby")
		}
		if err == nil {
			t.Fatal("expected an unavailable selected profile")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if server != "" && r.selected[1] != "secondary" {
		t.Fatal("working protocol not retained")
	}
	if got := <-observed; got != address {
		t.Fatalf("standby received %q, want %q", got, address)
	}
}

func TestVpnOnlyForbidsDirectFallback(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ordinary := router{}
	conn, err := ordinary.dial(ctx, listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	protected := router{vpnOnly: true}
	conn, err = protected.dial(ctx, listener.Addr().String())
	if err == nil {
		conn.Close()
		t.Fatal("protected destination escaped through direct route")
	}
}
