package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
)

type subscription struct {
	AllowInsecure bool   `json:"allowInsecure,omitempty"`
	SendCookie    bool   `json:"sendCookie,omitempty"`
	Cookie        string `json:"cookie,omitempty"`
	URL           string `json:"url"`
	Name          string `json:"name"`
	Hidden        bool   `json:"hidden"`
	ID            string `json:"id"`
}

func subscribe(dir string, sub subscription) (int, error) {
	if sub.URL == "" && sub.ID != "" {
		m, e := load(dir)
		if e != nil {
			return 0, e
		}
		found := false
		for _, p := range m.Profiles {
			if field[string](p["subscriptionID"]) == sub.ID {
				sub = field[subscription](p["source"])
				found = true
				break
			}
		}
		if !found {
			return 0, errors.New("Подписка отсутствует")
		}
	}
	sub.URL = strings.TrimPrefix(strings.TrimSpace(sub.URL), "happ://add/")
	address, e := url.Parse(sub.URL)
	if e != nil || (address.Scheme != "https" && address.Scheme != "http") || address.Hostname() == "" {
		return 0, errors.New("Проверьте адрес подписки")
	}
	hash := sha256.Sum256([]byte(sub.URL))
	sub.ID = hex.EncodeToString(hash[:10])
	if sub.Name == "" {
		sub.Name = address.Hostname()
	}
	if len([]rune(sub.Name)) > 80 {
		return 0, errors.New("Название слишком длинное")
	}
	if sub.SendCookie && sub.Cookie == "" {
		manifest, err := load(dir)
		if err != nil {
			return 0, err
		}
		for _, p := range manifest.Profiles {
			if field[string](p["subscriptionID"]) == sub.ID {
				sub.Cookie = field[subscription](p["source"]).Cookie
				break
			}
		}
		if sub.Cookie == "" {
			var id [16]byte
			if _, err := rand.Read(id[:]); err != nil {
				return 0, err
			}
			sub.Cookie = hex.EncodeToString(id[:])
		}
	}
	records, e := parseWithOptions(sub.URL, sub)
	if e != nil {
		return 0, e
	}
	for i := range records {
		id := sha256.Sum256([]byte(sub.ID + "/" + records[i].id))
		records[i].id = "own-" + hex.EncodeToString(id[:10])
	}
	return insertSource(dir, records, &sub)
}

func publicRow(row map[string]json.RawMessage) map[string]json.RawMessage {
	clean := make(map[string]json.RawMessage, len(row))
	for k, v := range row {
		if k != "source" && k != "subscriptionID" && k != "subscriptionName" && k != "hidden" {
			clean[k] = v
		}
	}
	return clean
}
