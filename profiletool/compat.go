package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/xtls/libxray/share"
	"github.com/xtls/xray-core/infra/conf"
)

func xrayKind(protocol string) bool {
	switch protocol {
	case "vless", "vmess", "shadowsocks", "socks", "trojan", "wireguard", "hysteria", "xray":
		return true
	}
	return false
}

// Shared profiles must be portable. Never load local key files on behalf of a subscription.
func needsLocalFile(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		for k, child := range v {
			key := strings.ToLower(k)
			if key == "certificatefile" || key == "keyfile" || key == "masterkeylog" || key == "secretslog" || key == "echconfiglistfile" {
				return true
			}
			if needsLocalFile(child) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if needsLocalFile(child) {
				return true
			}
		}
	}
	return false
}

func clientDocument(data []byte) (item, error) {
	var config object
	if json.Unmarshal(data, &config) != nil {
		return item{}, errors.New("Некорректный JSON")
	}
	outs, ok := config["outbounds"].([]any)
	if !ok || len(outs) == 0 {
		return item{}, errors.New("В JSON отсутствуют outbounds")
	}
	first, ok := outs[0].(map[string]any)
	if !ok {
		return item{}, badLink
	}
	kind, _ := first["protocol"].(string)
	if !xrayKind(kind) {
		kind = "xray"
	}
	name, _ := config["remarks"].(string)
	if name == "" {
		name, _ = first["tag"].(string)
	}
	if name == "" {
		name = kind
	}
	// The VPN supplies its own loopback listener. Never expose imported listeners.
	delete(config, "inbounds")
	delete(config, "remarks")
	config["log"] = object{"loglevel": "warning"}
	for k := range config {
		switch k {
		case "outbounds", "log", "routing", "dns", "policy", "stats", "observatory", "burstObservatory", "fakedns", "metrics":
			if k == "metrics" {
				return item{}, errors.New("Конфигурация содержит дополнительный сетевой слушатель")
			}
		default:
			return item{}, errors.New("Неподдерживаемая секция конфигурации Xray")
		}
	}
	if needsLocalFile(config) {
		return item{}, errors.New("Используйте встроенные в профиль сертификаты и ключи")
	}
	var checked conf.Config
	payload := raw(config)
	if json.Unmarshal(payload, &checked) != nil {
		return item{}, errors.New("Некорректные параметры Xray")
	}
	if _, err := checked.Build(); err != nil {
		return item{}, errors.New("Ядро Xray отклонило параметры профиля")
	}
	digest := sha256.Sum256(payload)
	return item{"own-" + hex.EncodeToString(digest[:10]), kind, name, config}, nil
}

func compatibleLink(line string) (item, error) {
	if strings.HasPrefix(line, "wireguard://") || strings.HasPrefix(line, "wg://") {
		return wireGuardLink(line)
	}
	if strings.HasPrefix(line, "vmess://") && !strings.Contains(line, "@") {
		var err error
		line, err = legacyVMess(strings.TrimPrefix(line, "vmess://"))
		if err != nil {
			return item{}, err
		}
	}
	if strings.HasPrefix(line, "vless://") {
		if old, e := parse(line); e == nil {
			return old, nil
		}
	}
	if strings.HasPrefix(line, "socks5://") {
		line = "socks://" + strings.TrimPrefix(line, "socks5://")
	}
	data, e := share.ConvertShareLinksToXrayJson(line, "")
	if e != nil {
		return item{}, errors.New("Некорректная ссылка или неподдерживаемые параметры профиля")
	}
	return clientDocument(data)
}

func copyProfile(dir, id string) error {
	m, err := load(dir)
	if err != nil {
		return err
	}
	for _, p := range m.Profiles {
		if field[string](p["id"]) != id || filepath.Base(id) != id {
			continue
		}
		if field[bool](p["hidden"]) {
			return errors.New("Экспорт этого профиля скрыт")
		}
		kind := field[string](p["kind"])
		if !xrayKind(kind) && kind != "xhttp-tls" && kind != "xhttp-reality" {
			return errors.New("Для этого движка используется другой формат конфигурации")
		}
		data, err := os.ReadFile(filepath.Join(dir, id+".json"))
		if err != nil {
			return err
		}
		if !json.Valid(data) {
			return errors.New("Повреждённый JSON")
		}
		fmt.Print(string(data))
		return nil
	}
	return errors.New("Выберите профиль сервера")
}
