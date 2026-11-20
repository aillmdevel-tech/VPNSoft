// Local client profile import. Secrets arrive on standard input and are never logged.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

type object = map[string]any
type manifest struct {
	Profiles []map[string]json.RawMessage `json:"profiles"`
}
type item struct {
	id, kind, name string
	config         object
}

var uuid = regexp.MustCompile("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
var ownID = regexp.MustCompile("^own-[0-9a-f]{20}$")
var hostname = regexp.MustCompile("^[a-zA-Z0-9.-]+$")
var badLink = errors.New("Проверьте параметры ссылки VLESS XHTTP")

const limit = 1024 * 1024

func validHost(s string) bool {
	if net.ParseIP(s) != nil {
		return true
	}
	if s == "" || len(s) > 253 || !hostname.MatchString(s) {
		return false
	}
	for _, label := range strings.Split(s, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
	}
	return true
}
func raw(v any) json.RawMessage            { b, _ := json.Marshal(v); return b }
func field[T any](value json.RawMessage) T { var v T; _ = json.Unmarshal(value, &v); return v }
func parse(line string) (item, error) {
	var empty item
	u, err := url.Parse(line)
	if err != nil || u.Scheme != "vless" || u.User == nil || !uuid.MatchString(u.User.Username()) || !validHost(u.Hostname()) {
		return empty, badLink
	}
	if _, ok := u.User.Password(); ok {
		return empty, badLink
	}
	port := 443
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return empty, badLink
		}
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return empty, badLink
	}
	if q.Get("type") != "xhttp" && q.Get("type") != "splithttp" {
		return empty, errors.New("Поддерживаются ссылки VLESS с транспортом XHTTP")
	}
	if q.Get("encryption") != "" && q.Get("encryption") != "none" {
		return empty, badLink
	}
	for k, v := range q {
		if len(v) != 1 {
			return empty, badLink
		}
		switch k {
		case "type", "encryption", "security", "sni", "fp", "path", "mode", "host", "alpn", "pbk", "sid", "spx", "flow", "headerType", "allowInsecure":
		default:
			return empty, errors.New("Дополнительные параметры этой ссылки можно импортировать комплектом ZIP")
		}
	}
	if q.Get("flow") != "" || q.Get("allowInsecure") != "" && q.Get("allowInsecure") != "0" && q.Get("allowInsecure") != "false" {
		return empty, badLink
	}
	sec := q.Get("security")
	if sec != "tls" && sec != "reality" {
		return empty, badLink
	}
	sni := q.Get("sni")
	if sni == "" {
		sni = u.Hostname()
	}
	if !validHost(sni) {
		return empty, badLink
	}
	path := q.Get("path")
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\r\n") {
		return empty, badLink
	}
	mode := q.Get("mode")
	switch mode {
	case "":
		mode = "auto"
	case "auto", "packet-up", "stream-up", "stream-one":
	default:
		return empty, badLink
	}
	xhttp := object{"path": path, "mode": mode}
	if h := q.Get("host"); h != "" {
		if !validHost(h) {
			return empty, badLink
		}
		xhttp["host"] = h
	}
	stream := object{"network": "xhttp", "security": sec, "xhttpSettings": xhttp}
	settings := object{"serverName": sni}
	if fp := q.Get("fp"); fp != "" {
		settings["fingerprint"] = fp
	}
	if sec == "tls" {
		if alpn := q.Get("alpn"); alpn != "" {
			a := strings.Split(alpn, ",")
			for _, s := range a {
				switch s {
				case "h3", "h2", "http/1.1":
				default:
					return empty, badLink
				}
			}
			settings["alpn"] = a
		}
		stream["tlsSettings"] = settings
	} else {
		pk, e := base64.RawURLEncoding.DecodeString(q.Get("pbk"))
		sid, e2 := hex.DecodeString(q.Get("sid"))
		if e != nil || len(pk) != 32 || e2 != nil || len(sid) > 8 {
			return empty, badLink
		}
		if _, ok := settings["fingerprint"]; !ok {
			settings["fingerprint"] = "chrome"
		}
		settings["publicKey"] = q.Get("pbk")
		settings["shortId"] = q.Get("sid")
		if sp := q.Get("spx"); sp != "" {
			settings["spiderX"] = sp
		}
		stream["realitySettings"] = settings
	}
	out := object{"protocol": "vless", "settings": object{"vnext": []object{{"address": u.Hostname(), "port": port, "users": []object{{"id": u.User.Username(), "encryption": "none"}}}}}, "streamSettings": stream}
	digest := sha256.Sum256(raw(out))
	name := strings.TrimSpace(u.Fragment)
	if name == "" {
		name = u.Hostname()
	}
	if utf8.RuneCountInString(name) > 80 {
		name = string([]rune(name)[:80])
	}
	return item{"own-" + hex.EncodeToString(digest[:10]), "xhttp-" + sec, name, object{"log": object{"loglevel": "warning"}, "outbounds": []object{out}}}, nil
}
func parseInput(s string) ([]item, error) { return parseWithOptions(s, subscription{}) }
func parseWithOptions(s string, opts subscription) ([]item, error) {
	s = strings.TrimPrefix(s, "happ://add/")
	if strings.HasPrefix(strings.ToLower(s), "https://") || strings.HasPrefix(strings.ToLower(s), "http://") {
		client := http.Client{Timeout: 12 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
		if strings.HasPrefix(strings.ToLower(s), "http://") && !opts.AllowInsecure {
			return nil, errors.New("Для HTTP включите «Разрешать небезопасные» в форме подписки")
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		defer transport.CloseIdleConnections()
		if opts.AllowInsecure {
			transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		}
		client.Transport = transport
		req, err := http.NewRequest(http.MethodGet, s, nil)
		if err != nil {
			return nil, errors.New("Некорректный адрес подписки")
		}
		if opts.SendCookie && opts.Cookie != "" {
			req.AddCookie(&http.Cookie{Name: "HWID", Value: opts.Cookie})
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, errors.New("Не удалось получить подписку")
		}
		defer resp.Body.Close()
		b, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if e != nil || len(b) > limit || resp.StatusCode != 200 {
			return nil, errors.New("Не удалось прочитать подписку")
		}
		s = strings.TrimSpace(string(b))
		if !strings.HasPrefix(s, "[") && !strings.HasPrefix(s, "{") && !strings.Contains(s, "://") {
			compact := strings.Join(strings.Fields(s), "")
			for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
				if d, e := enc.DecodeString(compact); e == nil {
					s = string(d)
					break
				}
			}
		}
	}
	if strings.HasPrefix(strings.TrimSpace(s), "[") {
		var docs []json.RawMessage
		if json.Unmarshal([]byte(s), &docs) != nil || len(docs) == 0 || len(docs) > 32 {
			return nil, errors.New("Некорректный список конфигураций")
		}
		var items []item
		for _, doc := range docs {
			it, err := clientDocument(doc)
			if err != nil {
				return nil, err
			}
			items = append(items, it)
		}
		return items, nil
	}
	if strings.HasPrefix(strings.TrimSpace(s), "{") {
		entry, err := clientDocument([]byte(s))
		return []item{entry}, err
	}
	var result []item
	seen := map[string]bool{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		record, err := compatibleLink(line)
		if err != nil {
			return nil, err
		}
		if !seen[record.id] {
			result = append(result, record)
			seen[record.id] = true
		}
		if len(result) > 32 {
			return nil, errors.New("В комплекте допустимо до 32 профилей")
		}
	}
	if len(result) == 0 {
		return nil, errors.New("Нет поддерживаемых профилей")
	}
	return result, nil
}
func load(dir string) (manifest, error) {
	var m manifest
	b, e := os.ReadFile(filepath.Join(dir, "profiles.json"))
	if os.IsNotExist(e) {
		return m, nil
	}
	if e != nil || json.Unmarshal(b, &m) != nil || m.Profiles == nil {
		return m, errors.New("Не удалось прочитать список профилей")
	}
	return m, nil
}
func insert(dir string, items []item) (int, error) { return insertSource(dir, items, nil) }
func insertSource(dir string, items []item, sub *subscription) (int, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return 0, err
	}
	lock, err := os.Open(dir)
	if err != nil {
		return 0, err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return 0, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	m, err := load(dir)
	if err != nil {
		return 0, err
	}
	var removed []string
	if sub != nil {
		current := map[string]bool{}
		for _, v := range items {
			current[v.id] = true
		}
		kept := m.Profiles[:0]
		for _, p := range m.Profiles {
			if field[string](p["subscriptionID"]) == sub.ID {
				id := field[string](p["id"])
				if !current[id] && ownID.MatchString(id) {
					removed = append(removed, id)
					continue
				}
				p["source"] = raw(sub)
				p["subscriptionName"] = raw(sub.Name)
				p["hidden"] = raw(sub.Hidden)
			}
			kept = append(kept, p)
		}
		m.Profiles = kept
	}
	ids := map[string]bool{}
	ports := map[int]bool{17680: true}
	for _, p := range m.Profiles {
		ids[field[string](p["id"])] = true
		ports[field[int](p["port"])] = true
	}
	var created []string
	committed := false
	defer func() {
		if !committed {
			for _, f := range created {
				os.Remove(f)
			}
		}
	}()
	for _, it := range items {
		if ids[it.id] {
			continue
		}
		if len(m.Profiles) >= 32 {
			return 0, errors.New("Уже заняты все 32 места для профилей")
		}
		port := 23400
		for ports[port] {
			port++
		}
		ports[port] = true
		ids[it.id] = true
		it.config["inbounds"] = []object{{"listen": "127.0.0.1", "port": port, "protocol": "socks", "settings": object{"auth": "noauth", "udp": true}}}
		f := filepath.Join(dir, it.id+".json")
		if err = os.WriteFile(f, raw(it.config), 0600); err != nil {
			return 0, err
		}
		created = append(created, f)
		row := map[string]json.RawMessage{"id": raw(it.id), "kind": raw(it.kind), "port": raw(port), "name": raw(it.name)}
		if sub != nil {
			row["source"] = raw(sub)
			row["subscriptionID"] = raw(sub.ID)
			row["subscriptionName"] = raw(sub.Name)
			row["hidden"] = raw(sub.Hidden)
		}
		m.Profiles = append(m.Profiles, row)
	}
	if len(created) == 0 && sub == nil {
		return 0, nil
	}
	if e := storeManifest(dir, m); e != nil {
		return 0, e
	}
	committed = true
	for _, id := range removed {
		os.Remove(filepath.Join(dir, id+".json"))
	}
	if sub != nil {
		return len(items), nil
	}
	return len(created), nil
}
func storeManifest(dir string, m manifest) error {
	tmp, e := os.CreateTemp(dir, ".manifest-")
	if e != nil {
		return e
	}
	defer os.Remove(tmp.Name())
	if _, e = tmp.Write(raw(m)); e == nil {
		e = tmp.Sync()
	}
	closeErr := tmp.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp.Name(), filepath.Join(dir, "profiles.json")); e != nil {
		return e
	}
	return nil
}
func preserve(old, newDir string) error {
	m, e := load(old)
	if e != nil {
		return e
	}
	var all []item
	for _, p := range m.Profiles {
		id := field[string](p["id"])
		if strings.HasPrefix(id, "qr-") && nativeExt[field[string](p["kind"])] != "" {
			t, err := readTransfer(old, id)
			if err != nil {
				return err
			}
			if _, err = importTransfer(newDir, t); err != nil {
				return err
			}
			continue
		}
		if !ownID.MatchString(id) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(old, id+".json"))
		if err != nil {
			return err
		}
		var c object
		if json.Unmarshal(b, &c) != nil || c == nil {
			return badLink
		}
		all = append(all, item{id, field[string](p["kind"]), field[string](p["name"]), c})
	}
	if len(all) == 0 {
		return nil
	}
	_, e = insert(newDir, all)
	if e != nil {
		return e
	}
	fresh, e := load(newDir)
	if e != nil {
		return e
	}
	metadata := map[string]map[string]json.RawMessage{}
	for _, p := range m.Profiles {
		if len(p["source"]) != 0 {
			metadata[field[string](p["id"])] = p
		}
	}
	if len(metadata) == 0 {
		return nil
	}
	for _, p := range fresh.Profiles {
		if old := metadata[field[string](p["id"])]; old != nil {
			for _, k := range []string{"source", "subscriptionID", "subscriptionName", "hidden"} {
				p[k] = old[k]
			}
		}
	}
	return storeManifest(newDir, fresh)
}

var profileID = regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")

func manage(dir, destination string, ids []string) error {
	wanted := make(map[string]bool)
	for _, id := range ids {
		if !profileID.MatchString(id) || id == "profiles" || wanted[id] {
			return errors.New("Недопустимый профиль")
		}
		wanted[id] = true
	}
	if len(ids) == 0 || len(ids) > 32 {
		return errors.New("Выберите профили")
	}
	lock, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); e != nil {
		return e
	}
	m, e := load(dir)
	if e != nil {
		return e
	}
	selected, kept := manifest{Profiles: make([]map[string]json.RawMessage, 0)}, manifest{Profiles: make([]map[string]json.RawMessage, 0)}
	var names []string
	extensions := map[string]string{"xray": ".json", "vless": ".json", "vmess": ".json", "socks": ".json", "shadowsocks": ".json", "trojan": ".json", "wireguard": ".json", "hysteria": ".json", "trusttunnel": ".toml", "amneziawg": ".conf", "naive": ".json", "mieru": ".json", "xhttp-tls": ".json", "xhttp-reality": ".json"}
	for _, p := range m.Profiles {
		id := field[string](p["id"])
		if !wanted[id] {
			kept.Profiles = append(kept.Profiles, p)
			continue
		}
		delete(wanted, id)
		ext := extensions[field[string](p["kind"])]
		if ext == "" {
			return errors.New("Неизвестный тип профиля")
		}
		names = append(names, id+ext)
		if _, err := os.Stat(filepath.Join(dir, id+".pem")); err == nil {
			names = append(names, id+".pem")
		} else if !os.IsNotExist(err) {
			return err
		}
		if destination != "" && field[bool](p["hidden"]) {
			return errors.New("Экспорт этого профиля скрыт")
		}
		selected.Profiles = append(selected.Profiles, publicRow(p))
	}
	if len(wanted) > 0 {
		return errors.New("Список профилей изменился")
	}
	if destination == "" {
		if e = storeManifest(dir, kept); e != nil {
			return e
		}
		for _, name := range names {
			if e = os.Remove(filepath.Join(dir, name)); e != nil && !os.IsNotExist(e) {
				return e
			}
		}
		return nil
	}
	out, e := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	success := false
	defer func() {
		out.Close()
		if !success {
			os.Remove(destination)
		}
	}()
	w := zip.NewWriter(out)
	add := func(name string, b []byte) error {
		entry, e := w.Create(name)
		if e != nil {
			return e
		}
		_, e = entry.Write(b)
		return e
	}
	if e = add("profiles.json", raw(selected)); e != nil {
		return e
	}
	for _, name := range names {
		b, e := os.ReadFile(filepath.Join(dir, name))
		if e != nil {
			return e
		}
		if e = add(name, b); e != nil {
			return e
		}
	}
	if e = w.Close(); e != nil {
		return e
	}
	if e = out.Close(); e != nil {
		return e
	}
	success = true
	return nil
}
func run(args []string) error {
	if len(args) == 3 && args[0] == "qr" {
		return makeQR(args[1], args[2])
	}
	if len(args) == 3 && args[0] == "copy-json" {
		return copyProfile(args[1], args[2])
	}
	if len(args) >= 3 && args[0] == "delete" {
		return manage(args[1], "", args[2:])
	}
	if len(args) >= 4 && args[0] == "export" {
		return manage(args[1], args[2], args[3:])
	}
	if len(args) == 3 && args[0] == "preserve" {
		return preserve(args[1], args[2])
	}
	if len(args) != 2 || (args[0] != "add" && args[0] != "subscribe") {
		return errors.New("Неверная команда")
	}
	b, e := io.ReadAll(io.LimitReader(os.Stdin, limit+1))
	if e != nil || len(b) > limit {
		return badLink
	}
	value := string(bytes.TrimSpace(b))
	if args[0] == "add" && strings.HasPrefix(value, qrPrefix) {
		t, e := decodeTransfer(value)
		if e != nil {
			return e
		}
		n, e := importTransfer(args[1], t)
		if e == nil {
			fmt.Println(n)
		}
		return e
	}
	if args[0] == "subscribe" || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "happ://add/") {
		sub := subscription{URL: value}
		if args[0] == "subscribe" {
			sub = subscription{}
			if json.Unmarshal(b, &sub) != nil {
				return errors.New("Неверная подписка")
			}
		}
		n, err := subscribe(args[1], sub)
		if err == nil {
			fmt.Println(n)
		}
		return err
	}
	items, e := parseInput(value)
	if e != nil {
		return e
	}
	n, e := insert(args[1], items)
	if e == nil {
		fmt.Println(n)
	}
	return e
}
func main() {
	if e := run(os.Args[1:]); e != nil {
		if _, ok := e.(*os.PathError); ok {
			fmt.Fprintln(os.Stderr, "Ошибка хранилища профилей")
		} else {
			fmt.Fprintln(os.Stderr, e)
		}
		os.Exit(1)
	}
}
