package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestEffectiveXrayOptions(t *testing.T) {
	defaults, e := parseAdvanced("{}")
	if e != nil || defaults.modifiesXray() || defaults.Interval != 15 || defaults.Timeout != 6 {
		t.Fatal("default behavior changed")
	}
	if _, e = parseAdvanced(`{"method":"DELETE"}`); e == nil {
		t.Fatal("accepted invalid check method")
	}
	o, e := parseAdvanced(`{"sniff":"on","mux":"8","fragment":"tlshello","ip":"UseIPv4","engineDNS":"google"}`)
	if e != nil {
		t.Fatal(e)
	}
	fixture := []byte(`{"inbounds":[{"port":23400,"listen":"127.0.0.1","protocol":"socks","settings":{"auth":"noauth"}}],"outbounds":[{"protocol":"trojan","settings":{"servers":[{"address":"example.org","port":443,"password":"example"}]},"streamSettings":{"network":"tcp","security":"tls"}}]}`)
	b, e := o.xrayConfig(fixture)
	if e != nil {
		t.Fatal(e)
	}
	var cfg configMap
	if json.Unmarshal(b, &cfg) != nil {
		t.Fatal("invalid JSON")
	}
	out := cfg["outbounds"].([]any)
	if len(out) != 2 || section(out[0].(map[string]any), "mux")["concurrency"] != float64(8) {
		t.Fatal("fragment or mux missing")
	}
	for _, s := range []string{"UseIPv4", "dns-query", "routeOnly", "tlshello"} {
		if !bytes.Contains(b, []byte(s)) {
			t.Fatalf("missing %s", s)
		}
	}
	if !usesVision(configMap{"settings": configMap{"vnext": []any{configMap{"users": []any{configMap{"flow": "xtls-rprx-vision"}}}}}}) {
		t.Fatal("Vision mux guard missing")
	}
	if binary := os.Getenv("ROUTE_TEST_XRAY"); binary != "" {
		cmd := exec.Command(binary, "run", "-test", "-format", "json", "-c", "stdin:")
		cmd.Stdin = bytes.NewReader(b)
		if msg, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("Xray validation: %v %s", err, msg)
		}
	}
}

func TestHTTPInboundHandlesHTTPAndCONNECT(t *testing.T) {
	target := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "served via proxy") })
	plain := httptest.NewServer(target)
	defer plain.Close()
	secure := httptest.NewTLSServer(target)
	defer secure.Close()
	r := new(router)
	proxy := httptest.NewServer(r.httpProxy(false).Handler)
	defer proxy.Close()
	addr, _ := url.Parse(proxy.URL)
	tr := secure.Client().Transport.(*http.Transport).Clone()
	tr.Proxy = http.ProxyURL(addr)
	defer tr.CloseIdleConnections()
	client := http.Client{Transport: tr, Timeout: 3 * time.Second}
	for _, u := range []string{plain.URL, secure.URL} {
		resp, e := client.Get(u)
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(resp.Body)
		resp.Body.Close()
		if e != nil || string(b) != "served via proxy" {
			t.Fatal("proxy transfer failed")
		}
	}
	lan := httptest.NewServer(r.httpProxy(true).Handler)
	defer lan.Close()
	addr, _ = url.Parse(lan.URL)
	tr = tr.Clone()
	tr.Proxy = http.ProxyURL(addr)
	client.Transport = tr
	defer tr.CloseIdleConnections()
	resp, e := client.Get(plain.URL)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 502 {
		t.Fatal("LAN request escaped directly")
	}
}
