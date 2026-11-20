package main

import (
	"archive/zip"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

const example = "vless://00000000-0000-4000-a000-000000000004@192.0.2.1:443?type=xhttp&security=tls&sni=example.org&alpn=h3#Test"

func TestOwnProfileLifecycle(t *testing.T) {
	dir, refreshed := t.TempDir(), t.TempDir()
	rows, e := parseInput(example)
	if e != nil {
		t.Fatal(e)
	}
	var writes sync.WaitGroup
	for i := 0; i < 4; i++ {
		writes.Add(1)
		go func() {
			defer writes.Done()
			r, e := parseInput(example)
			if e != nil {
				t.Error(e)
				return
			}
			if _, e = insert(dir, r); e != nil {
				t.Error(e)
			}
		}()
	}
	writes.Wait()
	m, e := load(dir)
	if e != nil || len(m.Profiles) != 1 {
		t.Fatalf("duplicate or missing profile: %v", e)
	}
	if field[string](m.Profiles[0]["name"]) != "Test" {
		t.Fatal("name lost")
	}
	if e = os.WriteFile(filepath.Join(refreshed, "profiles.json"), []byte(`{"profiles":[{"id":"existing","kind":"naive","port":23400}]}`), 0600); e != nil {
		t.Fatal(e)
	}
	if e = preserve(dir, refreshed); e != nil {
		t.Fatal(e)
	}
	after, e := load(refreshed)
	if e != nil || len(after.Profiles) != 2 {
		t.Fatalf("merge failed: %v", e)
	}
	port := field[int](after.Profiles[1]["port"])
	if port == 23400 {
		t.Fatal("duplicate port")
	}
	data, e := os.ReadFile(filepath.Join(refreshed, rows[0].id+".json"))
	if e != nil {
		t.Fatal(e)
	}
	var c struct {
		Inbounds []struct {
			Port   int
			Listen string
		}
	}
	if json.Unmarshal(data, &c) != nil || len(c.Inbounds) != 1 || c.Inbounds[0].Port != port || c.Inbounds[0].Listen != "127.0.0.1" {
		t.Fatal("invalid local listener")
	}
}
func TestInvalidRouteHasNoSideEffects(t *testing.T) {
	for _, link := range []string{"vless://garbage", "vless://00000000-0000-4000-a000-000000000004@example.org:443?type=xhttp&security=reality&pbk=invalid"} {
		if _, e := parse(link); e == nil {
			t.Error("invalid profile accepted")
		}
	}
}

func TestManageOnlySelectedProfiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"first.json", "first.pem", "other.conf"} {
		if e := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	entries := manifest{Profiles: []map[string]json.RawMessage{
		{"id": raw("first"), "kind": raw("naive"), "port": raw(23400)},
		{"id": raw("other"), "kind": raw("amneziawg"), "port": raw(23401)},
	}}
	if e := storeManifest(dir, entries); e != nil {
		t.Fatal(e)
	}
	out := filepath.Join(t.TempDir(), "share.zip")
	if e := manage(dir, out, []string{"first"}); e != nil {
		t.Fatal(e)
	}
	z, e := zip.OpenReader(out)
	if e != nil {
		t.Fatal(e)
	}
	defer z.Close()
	if len(z.File) != 3 {
		t.Fatal("unexpected ZIP contents")
	}
	for _, name := range []string{"profiles.json", "first.json", "first.pem"} {
		if _, e := z.Open(name); e != nil {
			t.Fatal(e)
		}
	}
	file, e := z.Open("profiles.json")
	if e != nil {
		t.Fatal(e)
	}
	defer file.Close()
	var shared manifest
	if e = json.NewDecoder(file).Decode(&shared); e != nil || len(shared.Profiles) != 1 || field[string](shared.Profiles[0]["id"]) != "first" {
		t.Fatal("incorrect export scope")
	}
	if e := manage(dir, "", []string{"first", "absent"}); e == nil {
		t.Fatal("stale selection accepted")
	}
	if e := manage(dir, "", []string{"first"}); e != nil {
		t.Fatal(e)
	}
	m, e := load(dir)
	if e != nil || len(m.Profiles) != 1 || field[string](m.Profiles[0]["id"]) != "other" {
		t.Fatal("unrelated entry changed")
	}
	for _, name := range []string{"first.json", "first.pem"} {
		if _, e := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(e) {
			t.Fatal("removed profile files survived")
		}
	}
	if _, e = os.Stat(filepath.Join(dir, "other.conf")); e != nil {
		t.Fatal(e)
	}
}
