package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShareFamilies(t *testing.T) {
	const id = "00000000-0000-4000-a000-000000000004"
	cases := map[string]string{
		"vless":       "vless://" + id + "@example.org:443?type=ws&security=tls&path=%2Froute",
		"vmess":       "vmess://" + base64.StdEncoding.EncodeToString([]byte(`{"v":"2","ps":"test","add":"example.org","port":"443","id":"`+id+`","aid":"0","net":"ws","tls":"tls","path":"/"}`)),
		"socks":       "socks://example.org:1080",
		"trojan":      "trojan://sample@example.org:443?security=tls",
		"shadowsocks": "ss://" + base64.RawURLEncoding.EncodeToString([]byte("aes-128-gcm:sample")) + "@example.org:8388",
		"hysteria":    "hy2://sample@example.org:443?sni=example.org",
	}
	for kind, link := range cases {
		t.Run(kind, func(t *testing.T) {
			rows, err := parseInput(link)
			if err != nil || len(rows) != 1 || rows[0].kind != kind {
				t.Fatalf("kind %s: %v", kind, err)
			}
		})
	}
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	encoded := base64.StdEncoding.EncodeToString(key)
	for kind, doc := range map[string]string{"wireguard": fmt.Sprintf(`{"outbounds":[{"protocol":"wireguard","settings":{"secretKey":"%s","peers":[{"publicKey":"%s","endpoint":"192.0.2.1:51820"}]}}]}`, encoded, encoded), "xray": `{"outbounds":[{"protocol":"freedom"}]}`} {
		i, e := clientDocument([]byte(doc))
		if e != nil || i.kind != kind {
			t.Fatalf("%s validation: %v", kind, e)
		}
	}
}

func TestSubscriptionRefreshAndPrivacy(t *testing.T) {
	body := example
	var cookie string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, e := r.Cookie("HWID"); e == nil {
			cookie = c.Value
		}
		fmt.Fprint(w, body)
	}))
	defer server.Close()
	dir := t.TempDir()
	n, e := subscribe(dir, subscription{URL: server.URL, AllowInsecure: true, Name: "Local", Hidden: true, SendCookie: true})
	if n != 1 || e != nil || cookie == "" {
		t.Fatal(n, e)
	}
	first, _ := load(dir)
	id := field[string](first.Profiles[0]["id"])
	source := field[string](first.Profiles[0]["subscriptionID"])
	if copyProfile(dir, id) == nil {
		t.Fatal("hidden profile copied")
	}
	if manage(dir, filepath.Join(t.TempDir(), "test.zip"), []string{id}) == nil {
		t.Fatal("hidden profile exported")
	}
	saved := cookie
	body = "invalid"
	if _, e = subscribe(dir, subscription{ID: source}); e == nil {
		t.Fatal("invalid update accepted")
	}
	body = strings.Replace(example, "192.0.2.1", "192.0.2.2", 1)
	n, e = subscribe(dir, subscription{ID: source})
	if n != 1 || e != nil || cookie != saved {
		t.Fatal(n, e)
	}
	m, _ := load(dir)
	if len(m.Profiles) != 1 || id == field[string](m.Profiles[0]["id"]) {
		t.Fatal("old profile kept")
	}
	if _, e = os.Stat(filepath.Join(dir, id+".json")); !os.IsNotExist(e) {
		t.Fatal("obsolete config file kept")
	}
	sanitized, _ := json.Marshal(publicRow(m.Profiles[0]))
	if strings.Contains(string(sanitized), server.URL) || strings.Contains(string(sanitized), saved) {
		t.Fatal("private source exported")
	}
}
