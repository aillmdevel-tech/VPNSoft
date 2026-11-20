package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed ru.txt
var russianNetworks string

type profile struct {
	SubscriptionID   string `json:"subscriptionID,omitempty"`
	SubscriptionName string `json:"subscriptionName,omitempty"`
	Hidden           bool   `json:"hidden,omitempty"`
	ID               string `json:"id"`
	Name             string `json:"name,omitempty"`
	Kind             string `json:"kind"`
	Port             int    `json:"port"`
}
type bundle struct {
	Profiles []profile `json:"profiles"`
}
type health struct {
	Telegram, Chat bool
	Secs           float64
}
type router struct {
	advanced advancedOptions
	vpnOnly  bool
	profiles []profile
	ranges   []netip.Prefix
	resolver *net.Resolver
	ifindex  int
	mu       sync.RWMutex
	health   map[string]health
	selected [3]string
	ready    bool
	policy   *androidPolicy
	servers  map[string]string
	manual   string
	server   string
}

var profileID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$`)
var suffixes = []string{"ru", "su", "xn--p1ai", "рф", "local", "localhost", "lan", "home.arpa"}

func main() {
	config := flag.String("config", "profiles.json", "private profile manifest")
	engines := flag.String("engines", "engines", "trusted binaries directory")
	listen := flag.String("listen", "127.0.0.1:17680", "local SOCKS listener")
	dns := flag.String("dns", "", "system DNS IP for direct lookups")
	status := flag.String("status", "", "optional status file")
	underlay := flag.String("underlay", "", "optional Mac interface for direct traffic and AmneziaWG")
	vpnOnly := flag.Bool("vpn-only", false, "send every captured destination through the active VPN")
	policy := flag.String("android-policy", "", "private Android flow policy file")
	listServers := flag.Bool("list-servers", false, "list compatible servers in the profile manifest")
	manual := flag.String("profile", "", "optional fixed upstream profile ID")
	server := flag.String("server", "", "restrict automatic routes to an endpoint")
	order := flag.String("order", "", "preferred profile order within the endpoint")
	catalog := flag.Bool("list-profiles", false, "show safe metadata for installed profiles")
	originInterface := flag.String("origin-interface", "", "look up the physical network origin on macOS")
	advanced := flag.String("advanced", "{}", "client connection preferences")
	flag.Parse()
	if *originInterface != "" {
		if err := printOrigin(*originInterface); err != nil {
			os.Exit(1)
		}
		return
	}
	if *catalog {
		if err := printCatalog(*config); err != nil {
			fmt.Fprintln(os.Stderr, "Client: profile catalog unavailable")
			os.Exit(1)
		}
		return
	}
	if *listServers {
		if err := printProtectedServers(*config); err != nil {
			fmt.Fprintln(os.Stderr, "Client:", err)
			os.Exit(1)
		}
		return
	}
	options, err := parseAdvanced(*advanced)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Invalid advanced settings")
		os.Exit(1)
	}
	if options.Socks != 0 {
		*listen = net.JoinHostPort("127.0.0.1", strconv.Itoa(options.Socks))
	}
	if err := run(*config, *engines, *listen, *dns, *status, *underlay, *policy, *manual, *server, *order, *vpnOnly, options); err != nil {
		fmt.Fprintln(os.Stderr, "Client:", err)
		os.Exit(1)
	}
}

// Only emit the display point. The full IP lookup response stays in memory.
func printOrigin(name string) error {
	if runtime.GOOS != "darwin" || !strings.HasPrefix(name, "en") {
		return errors.New("physical interface required")
	}
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return err
	}
	r := router{ifindex: iface.Index, resolver: net.DefaultResolver}
	transport := &http.Transport{DialContext: func(ctx context.Context, _ string, addr string) (net.Conn, error) { return r.direct(ctx, addr) }}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 7 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get("https://ipinfo.io/json")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return errors.New("origin unavailable")
	}
	var data struct{ Country, Loc string }
	if err = json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&data); err != nil {
		return err
	}
	if data.Country != "RU" && data.Country != "GE" {
		fmt.Println("null")
		return nil
	}
	parts := strings.Split(data.Loc, ",")
	if len(parts) != 2 {
		return errors.New("missing coordinates")
	}
	lat, e := strconv.ParseFloat(parts[0], 64)
	lon, f := strconv.ParseFloat(parts[1], 64)
	if e != nil || f != nil || !(lat > -90 && lat < 90 && lon >= -180 && lon <= 180) {
		return errors.New("invalid coordinates")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"country": data.Country, "lat": lat, "lon": lon})
}

func run(config, engines, listen, dns, status, underlay, policyFile, manual, server, order string, vpnOnly bool, options advancedOptions) error {
	if !strings.HasPrefix(listen, "127.0.0.1:") {
		return errors.New("listener must use IPv4 loopback")
	}
	raw, err := os.ReadFile(config)
	if err != nil {
		return errors.New("profile manifest unavailable")
	}
	var spec bundle
	if json.Unmarshal(raw, &spec) != nil || len(spec.Profiles) == 0 || len(spec.Profiles) > 32 {
		return errors.New("invalid profile manifest")
	}
	ports := map[int]bool{}
	ids := map[string]bool{}
	for _, p := range spec.Profiles {
		if !profileID.MatchString(p.ID) || p.Port < 1024 || p.Port > 65535 || ports[p.Port] || ids[p.ID] {
			return errors.New("invalid or duplicate profile")
		}
		if _, _, ok := p.command(""); !ok {
			return errors.New("unsupported engine")
		}
		ports[p.Port], ids[p.ID] = true, true
	}
	if manual != "" && !profileID.MatchString(manual) {
		return errors.New("invalid manual profile")
	}
	var policy *androidPolicy
	var servers map[string]string
	profileDir := filepath.Dir(config)
	if policyFile != "" {
		var err error
		policy, err = readAndroidPolicy(policyFile)
		if err != nil {
			return err
		}
		var active []profile
		var runtimeDir string
		active, servers, runtimeDir, err = prepareProtectedProfiles(profileDir, spec.Profiles, policy.Secret)
		if err != nil {
			return err
		}
		defer os.RemoveAll(runtimeDir)
		profileDir, spec.Profiles = runtimeDir, active
	}
	if server != "" {
		if catalogHost(server) != server || manual != "" {
			return errors.New("invalid server selection")
		}
		if policy == nil {
			servers = make(map[string]string)
			var candidates []profile
			for _, p := range spec.Profiles {
				servers[p.ID] = profileHost(profileDir, p)
				if servers[p.ID] == server {
					candidates = append(candidates, p)
				}
			}
			spec.Profiles = candidates
		}
		ranks := make(map[string]int)
		for i, id := range strings.Split(order, ",") {
			ranks[id] = i + 1
		}
		sort.SliceStable(spec.Profiles, func(i, j int) bool {
			a, b := ranks[spec.Profiles[i].ID], ranks[spec.Profiles[j].ID]
			return a != 0 && (b == 0 || a < b)
		})
	}
	_, portText, _ := net.SplitHostPort(listen)
	listenPort, _ := strconv.Atoi(portText)
	if ports[listenPort] || options.HTTP != 0 && (options.HTTP == listenPort || ports[options.HTTP]) {
		return errors.New("SOCKS port conflicts with a profile")
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	defer ln.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	resolver := net.DefaultResolver
	if dns != "" {
		ip, err := netip.ParseAddr(dns)
		if err != nil {
			return errors.New("invalid system DNS address")
		}
		resolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.String(), "53"))
		}}
	}
	r := &router{advanced: options, vpnOnly: vpnOnly, profiles: spec.Profiles, resolver: resolver, health: map[string]health{}, policy: policy, servers: servers, manual: manual, server: server}
	if underlay != "" {
		if runtime.GOOS != "darwin" {
			return errors.New("underlay option is macOS-only")
		}
		iface, err := net.InterfaceByName(underlay)
		if err != nil {
			return errors.New("underlay interface unavailable")
		}
		r.ifindex = iface.Index
	}
	for _, line := range strings.Fields(russianNetworks) {
		if prefix, err := netip.ParsePrefix(line); err == nil {
			r.ranges = append(r.ranges, prefix)
		}
	}
	if len(r.ranges) == 0 {
		return errors.New("RU address rules unavailable")
	}
	closeExtras, err := r.extraListeners(options.WiFi, listenPort, options.HTTP)
	if err != nil {
		return err
	}
	defer closeExtras()
	var children sync.WaitGroup
	for _, p := range spec.Profiles {
		if p.Kind == "external" {
			continue
		}
		children.Add(1)
		go func(p profile) {
			defer children.Done()
			p.supervise(ctx, profileDir, engines, underlay, options)
		}(p)
	}
	defer func() { stop(); children.Wait() }()
	go func() { <-ctx.Done(); ln.Close() }()
	go r.monitor(ctx, status)
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go r.accept(conn)
	}
}

func (p profile) command(config string) (string, []string, bool) {
	switch p.Kind {
	case "xhttp-tls", "xhttp-reality", "xray", "vmess", "vless", "shadowsocks", "socks", "trojan", "wireguard", "hysteria":
		return "xray", []string{"run", "-c", config + ".json"}, true
	case "naive":
		return "naive", []string{config + ".json"}, true
	case "trusttunnel":
		return "trusttunnel", []string{"-c", config + ".toml"}, true
	case "amneziawg":
		return "awg", []string{"-config", config + ".conf", "-listen", p.endpoint()}, true
	case "mieru":
		return "mieru", []string{"run"}, true
	case "external":
		return "", nil, true
	default:
		return "", nil, false
	}
}
func (p profile) endpoint() string { return "127.0.0.1:" + strconv.Itoa(p.Port) }

var engineProcessAttributes *syscall.SysProcAttr

// Issued macOS Naive profiles have a single QUIC outbound. Keep its routing tag
// and TLS credentials while letting sing-box choose a reachable transport.
func naiveTransports(path string) []byte {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var config map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&config) != nil {
		return nil
	}
	outbounds, _ := config["outbounds"].([]any)
	if len(outbounds) != 1 {
		return nil
	}
	quic, _ := outbounds[0].(map[string]any)
	tag, _ := quic["tag"].(string)
	if quic["type"] != "naive" || quic["quic"] != true || tag == "" {
		return nil
	}
	tcp := make(map[string]any, len(quic))
	for key, value := range quic {
		tcp[key] = value
	}
	tcp["tag"], tcp["quic"] = tag+"-http2", false
	quic["tag"] = tag + "-http3"
	chooser := map[string]any{
		"type": "urltest", "tag": tag, "outbounds": []string{tag + "-http2", tag + "-http3"},
		"url": "https://api.telegram.org/", "interval": "30s",
	}
	config["outbounds"] = []any{chooser, tcp, quic}
	result, _ := json.Marshal(config)
	return result
}

func (p profile) supervise(ctx context.Context, dir, engines, underlay string, options advancedOptions) {
	path, err := filepath.Abs(filepath.Join(dir, p.ID))
	if err != nil {
		return
	}
	binary, args, _ := p.command(path)
	var effective []byte
	if runtime.GOOS == "darwin" && p.Kind == "naive" {
		effective = naiveTransports(path + ".json")
		if effective != nil {
			binary, args = "sing-box", []string{"run", "-c", "/dev/stdin"}
		}
	}
	if binary == "xray" && options.modifiesXray() {
		raw, e := os.ReadFile(path + ".json")
		if e != nil {
			return
		}
		effective, e = options.xrayConfig(raw)
		if e != nil {
			return
		}
		args = []string{"run", "-format", "json", "-c", "stdin:"}
	}
	if p.Kind == "amneziawg" && underlay != "" {
		args = append(args, "-underlay", underlay)
	}
	for ctx.Err() == nil {
		name := filepath.Join(engines, binary)
		if _, err := os.Stat(name); err != nil {
			name = filepath.Join(engines, "lib"+binary+".so")
		}
		cmd := exec.CommandContext(ctx, name, args...)
		if effective != nil {
			cmd.Stdin = bytes.NewReader(effective)
		}
		cmd.SysProcAttr = engineProcessAttributes
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "MIERU_CONFIG_JSON_FILE="+path+".json", "SSL_CERT_FILE="+path+".pem")
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		if err := cmd.Run(); ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "%s engine exited (%t), retrying\n", p.ID, err != nil)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func (r *router) ruIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		return true
	}
	for _, prefix := range r.ranges {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}
func (r *router) route(ctx context.Context, host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if ip, err := netip.ParseAddr(host); err == nil {
		if r.ruIP(ip) {
			return "direct"
		}
		return "proxy"
	}
	for _, suffix := range suffixes {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return "direct"
		}
	}
	if class := serviceClass(host); class != "proxy" {
		return class
	}
	lookup, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
	defer cancel()
	if addrs, err := r.resolver.LookupNetIP(lookup, "ip", host); err == nil && len(addrs) > 0 {
		for _, ip := range addrs {
			if r.ruIP(ip) {
				return "direct"
			}
		}
	}
	return "proxy"
}
func (r *router) direct(ctx context.Context, addr string) (net.Conn, error) {
	dialer := &net.Dialer{Resolver: r.resolver}
	if r.ifindex != 0 {
		dialer.Control = func(network, _ string, c syscall.RawConn) error {
			var result error
			if err := c.Control(func(fd uintptr) {
				// Darwin socket options for binding an IPv4 or IPv6 socket to its network interface.
				level, option := syscall.IPPROTO_IP, 25
				if network == "tcp6" {
					level, option = syscall.IPPROTO_IPV6, 125
				}
				result = syscall.SetsockoptInt(int(fd), level, option, r.ifindex)
			}); err != nil {
				return err
			}
			return result
		}
	}
	return dialer.DialContext(ctx, "tcp", addr)
}
func (r *router) dial(ctx context.Context, addr string) (net.Conn, error) {
	return r.dialPolicy(ctx, addr, "")
}

func (r *router) accepts(p profile) bool {
	return (r.manual == "" || r.manual == p.ID) && (r.server == "" || r.servers[p.ID] == r.server)
}
func (r *router) dialPolicy(ctx context.Context, addr, binding string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	class := serviceClass(host)
	if binding == "" && !r.vpnOnly {
		class = r.route(ctx, host)
	}
	if class == "direct" {
		return r.direct(ctx, addr)
	}
	idx := 0
	if class == "telegram" {
		idx = 1
	} else if class == "chat" {
		idx = 2
	}
	r.mu.RLock()
	chosen := r.selected[idx]
	ready := r.ready
	allowed := func(p profile) bool {
		if binding != "" && binding != "any" {
			return r.servers[p.ID] == binding
		}
		return r.accepts(p)
	}
	candidates := make([]profile, 0, len(r.profiles))
	for _, p := range r.profiles {
		if p.ID == chosen && allowed(p) {
			candidates = append(candidates, p)
		}
	}
	for _, p := range r.profiles {
		h := r.health[p.ID]
		if p.ID != chosen && allowed(p) && (!ready || p.ID == r.manual || score(h, idx) > 0) {
			candidates = append(candidates, p)
		}
	}
	// Warm-up or a stale health check may mark a recovered standby unavailable.
	if r.server != "" && ready {
		for _, p := range r.profiles {
			if p.ID != chosen && allowed(p) && score(r.health[p.ID], idx) == 0 {
				candidates = append(candidates, p)
			}
		}
	}
	r.mu.RUnlock()
	for _, p := range candidates {
		attempt, cancel := context.WithTimeout(ctx, 3*time.Second)
		c, err := r.dialUpstream(attempt, p, addr)
		cancel()
		if err == nil {
			if r.server != "" && p.ID != chosen && r.accepts(p) {
				r.mu.Lock()
				if r.selected[idx] == chosen {
					r.selected[idx] = p.ID
				}
				r.mu.Unlock()
			}
			return c, nil
		}
	}
	return nil, errors.New("no reachable upstream")
}

func score(h health, idx int) int {
	if idx == 1 && !h.Telegram || idx == 2 && !h.Chat {
		return 0
	}
	n := 0
	if h.Telegram {
		n++
	}
	if h.Chat {
		n++
	}
	return n
}
func (r *router) monitor(ctx context.Context, status string) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(900 * time.Millisecond):
	}
	for {
		var wg sync.WaitGroup
		for _, p := range r.profiles {
			wg.Add(1)
			go func(p profile) {
				defer wg.Done()
				start := time.Now()
				var h health
				var probes sync.WaitGroup
				probes.Add(2)
				go func() { defer probes.Done(); h.Telegram = r.probe(ctx, p, "https://api.telegram.org/") }()
				go func() { defer probes.Done(); h.Chat = r.probe(ctx, p, "https://chatgpt.com/cdn-cgi/trace") }()
				probes.Wait()
				h.Secs = time.Since(start).Seconds()
				r.mu.Lock()
				r.health[p.ID] = h
				r.mu.Unlock()
			}(p)
		}
		wg.Wait()
		r.mu.Lock()
		for idx := range r.selected {
			best := r.selected[idx]
			quality := score(r.health[best], idx)
			for _, p := range r.profiles {
				if !r.accepts(p) {
					continue
				}
				if s := score(r.health[p.ID], idx); s > quality {
					best, quality = p.ID, s
				}
			}
			if quality == 0 {
				best = ""
			}
			if best != r.selected[idx] {
				fmt.Printf("route[%d] = %s\n", idx, best)
			}
			r.selected[idx] = best
		}
		r.ready = true
		if status != "" {
			b, _ := json.Marshal(struct {
				Active   [3]string
				Profiles map[string]health
			}{r.selected, r.health})
			if os.WriteFile(status+".new", b, 0600) == nil {
				_ = os.Rename(status+".new", status)
			}
		}
		available := r.selected[0] != ""
		r.mu.Unlock()
		interval := time.Duration(r.advanced.Interval) * time.Second
		if !available {
			interval = 4 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}
func (r *router) probe(ctx context.Context, p profile, url string) bool {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(r.advanced.Timeout)*time.Second)
	defer cancel()
	t := &http.Transport{DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) { return r.dialUpstream(ctx, p, addr) }, DisableKeepAlives: true}
	defer t.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, r.advanced.Method, url, nil)
	if err != nil {
		return false
	}
	client := &http.Client{Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode >= 200 && response.StatusCode < 400
}

func connectHeader(host string, port int) ([]byte, error) {
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			return binary.BigEndian.AppendUint16(append([]byte{1}, v4...), uint16(port)), nil
		}
		return binary.BigEndian.AppendUint16(append([]byte{4}, ip.To16()...), uint16(port)), nil
	}
	if len(host) == 0 || len(host) > 255 {
		return nil, errors.New("bad host")
	}
	return binary.BigEndian.AppendUint16(append([]byte{3, byte(len(host))}, []byte(host)...), uint16(port)), nil
}
func readTarget(rd io.Reader, kind byte) (string, error) {
	n := 0
	switch kind {
	case 1:
		n = 4
	case 4:
		n = 16
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(rd, length[:]); err != nil {
			return "", err
		}
		n = int(length[0])
	default:
		return "", errors.New("bad address type")
	}
	body := make([]byte, n+2)
	if _, err := io.ReadFull(rd, body); err != nil {
		return "", err
	}
	host := string(body[:n])
	if kind != 3 {
		host = net.IP(body[:n]).String()
	}
	return net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(body[n:])))), nil
}
func (p profile) dial(ctx context.Context, addr string) (net.Conn, error) {
	return p.dialAuthenticated(ctx, addr, "")
}

func (p profile) dialAuthenticated(ctx context.Context, addr, password string) (net.Conn, error) {
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", p.endpoint())
	if err != nil {
		return nil, err
	}
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	c, err := p.handshake(conn, addr, password)
	if err != nil {
		conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return c, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }
func (p profile) handshake(conn net.Conn, addr, password string) (net.Conn, error) {
	if p.Kind == "amneziawg" {
		if _, err := io.WriteString(conn, "CONNECT "+addr+" HTTP/1.1\r\nHost: "+addr+"\r\n\r\n"); err != nil {
			return nil, err
		}
		r := bufio.NewReader(conn)
		resp, err := http.ReadResponse(r, &http.Request{Method: http.MethodConnect})
		if err != nil || resp.StatusCode != 200 {
			return nil, errors.New("CONNECT failed")
		}
		return bufferedConn{conn, r}, nil
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	num, err := strconv.Atoi(port)
	if err != nil || num < 1 || num > 65535 {
		return nil, errors.New("bad port")
	}
	head, err := connectHeader(host, num)
	if err != nil {
		return nil, err
	}
	method := byte(0)
	if password != "" {
		method = 2
	}
	if _, err = conn.Write([]byte{5, 1, method}); err != nil {
		return nil, err
	}
	var reply [4]byte
	if _, err = io.ReadFull(conn, reply[:2]); err != nil || reply[0] != 5 || reply[1] != method {
		return nil, errors.New("SOCKS auth unavailable")
	}
	if method == 2 {
		if err := socksClientAuth(conn, "route", password); err != nil {
			return nil, err
		}
	}
	if _, err = conn.Write(append([]byte{5, 1, 0}, head...)); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(conn, reply[:]); err != nil || reply[1] != 0 {
		return nil, errors.New("SOCKS connect failed")
	}
	if _, err = readTarget(conn, reply[3]); err != nil {
		return nil, err
	}
	return conn, nil
}
func (r *router) accept(client net.Conn) { r.acceptFrom(client, false) }
func (r *router) acceptFrom(client net.Conn, lan bool) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(18 * time.Second))
	var h [4]byte
	if _, err := io.ReadFull(client, h[:2]); err != nil || h[0] != 5 {
		return
	}
	methods := make([]byte, int(h[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return
	}
	binding, authorized := r.authorizeFlow(client, methods)
	if lan && authorized {
		binding = "any"
	}
	if !authorized {
		return
	}
	if _, err := io.ReadFull(client, h[:]); err != nil || h[0] != 5 {
		return
	}
	target, err := readTarget(client, h[3])
	if err != nil {
		return
	}
	reply := []byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}
	if h[1] != 1 {
		reply[1] = 7
		client.Write(reply)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 16*time.Second)
	defer cancel()
	remote, err := r.dialPolicy(ctx, target, binding)
	if err != nil {
		reply[1] = 4
		client.Write(reply)
		return
	}
	defer remote.Close()
	if _, err := client.Write(reply); err != nil {
		return
	}
	relay(client, remote)
}
func relay(client, remote net.Conn) {
	_ = client.SetDeadline(time.Time{})
	done := make(chan struct{})
	go func() {
		io.Copy(remote, client)
		if c, ok := remote.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
		close(done)
	}()
	io.Copy(client, remote)
	_ = client.SetDeadline(time.Now())
	_ = remote.SetDeadline(time.Now())
	<-done
}
