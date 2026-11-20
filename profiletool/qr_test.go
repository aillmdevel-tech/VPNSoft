package main

import (
	"encoding/json"
	"testing"
)

func TestNativeQRMergeAndPreserve(t *testing.T) {
	dir := t.TempDir()
	if err := storeManifest(dir, manifest{Profiles: []map[string]json.RawMessage{{"id": raw("existing"), "port": raw(23400)}}}); err != nil {
		t.Fatal(err)
	}
	original := transfer{Kind: "mieru", Name: "Проверка", Config: `{"profiles":[],"socks5Port":23400,"socks5ListenLAN":true}`}
	text, e := qrText(original)
	if e != nil {
		t.Fatal(e)
	}
	profile, e := decodeTransfer(text)
	if e != nil {
		t.Fatal(e)
	}
	for _, want := range []int{1, 0} {
		n, e := importTransfer(dir, profile)
		if e != nil || n != want {
			t.Fatalf("count %d: %v", n, e)
		}
	}
	m, e := load(dir)
	if e != nil || len(m.Profiles) != 2 || field[int](m.Profiles[1]["port"]) != 23401 {
		t.Fatal("merge or port allocation failed")
	}
	stage := t.TempDir()
	if e = preserve(dir, stage); e != nil {
		t.Fatal(e)
	}
	restored, e := load(stage)
	if e != nil || len(restored.Profiles) != 1 || field[string](restored.Profiles[0]["name"]) != "Проверка" {
		t.Fatal("shared profile lost after refresh")
	}
}

func TestQRHonorsHiddenProfiles(t *testing.T) {
	dir := t.TempDir()
	e := storeManifest(dir, manifest{Profiles: []map[string]json.RawMessage{{"id": raw("private"), "hidden": raw(true)}}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = readTransfer(dir, "private"); e == nil {
		t.Fatal("hidden profile exported")
	}
	if _, e = decodeTransfer(qrPrefix + "bad"); e == nil {
		t.Fatal("invalid transfer accepted")
	}
}
