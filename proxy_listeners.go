package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

// Bind Wi-Fi listeners to the actual Wi-Fi address and accept only on-link peers.
type subnetListener struct {
	net.Listener
	subnet netip.Prefix
}

func (l subnetListener) Accept() (net.Conn, error) {
	for {
		c, e := l.Listener.Accept()
		if e != nil {
			return nil, e
		}
		addr, ok := c.RemoteAddr().(*net.TCPAddr)
		if ok && l.subnet.Contains(addr.AddrPort().Addr().Unmap()) {
			return c, nil
		}
		c.Close()
	}
}
func stripHopHeaders(h http.Header) {
	for _, v := range h.Values("Connection") {
		for _, k := range strings.Split(v, ",") {
			h.Del(strings.TrimSpace(k))
		}
	}
	for _, k := range []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
		h.Del(k)
	}
}
func (r *router) httpProxy(viaVPN bool) *http.Server {
	binding := ""
	if viaVPN {
		binding = "any"
	}
	dial := func(ctx context.Context, _, target string) (net.Conn, error) {
		return r.dialPolicy(ctx, target, binding)
	}
	transport := &http.Transport{DialContext: dial, DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second}
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodConnect {
			if _, _, e := net.SplitHostPort(req.Host); e != nil {
				http.Error(w, "Expected host:port", 400)
				return
			}
			ctx, cancel := context.WithTimeout(req.Context(), 16*time.Second)
			defer cancel()
			remote, e := dial(ctx, "tcp", req.Host)
			if e != nil {
				http.Error(w, "Upstream unavailable", 502)
				return
			}
			defer remote.Close()
			client, rw, e := w.(http.Hijacker).Hijack()
			if e != nil {
				return
			}
			defer client.Close()
			if _, e = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); e != nil {
				return
			}
			if rw.Flush() != nil {
				return
			}
			relay(bufferedConn{client, rw.Reader}, remote)
			return
		}
		if req.URL.Scheme != "http" || req.URL.Host == "" {
			http.Error(w, "Expected HTTP proxy request", 400)
			return
		}
		out := req.Clone(req.Context())
		out.RequestURI = ""
		out.Host = req.URL.Host
		stripHopHeaders(out.Header)
		resp, e := transport.RoundTrip(out)
		if e != nil {
			http.Error(w, "Upstream unavailable", 502)
			return
		}
		defer resp.Body.Close()
		stripHopHeaders(resp.Header)
		for k, v := range resp.Header {
			w.Header()[k] = v
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})
	return &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
}
func (r *router) extraListeners(wifi string, socksPort, httpPort int) (func(), error) {
	var listeners []net.Listener
	closeAll := func() {
		for _, l := range listeners {
			l.Close()
		}
	}
	start := func(host string, port int, httpMode bool, subnet netip.Prefix) error {
		ln, e := net.Listen("tcp4", net.JoinHostPort(host, strconv.Itoa(port)))
		if e != nil {
			return e
		}
		lan := subnet.IsValid()
		if lan {
			ln = subnetListener{ln, subnet}
		}
		listeners = append(listeners, ln)
		if httpMode {
			s := r.httpProxy(lan)
			go s.Serve(ln)
		} else {
			go func() {
				for {
					c, e := ln.Accept()
					if e != nil {
						return
					}
					go r.acceptFrom(c, true)
				}
			}()
		}
		return nil
	}
	if httpPort != 0 {
		if e := start("127.0.0.1", httpPort, true, netip.Prefix{}); e != nil {
			return nil, e
		}
	}
	if wifi != "" && !r.vpnOnly && r.policy == nil {
		prefix, e := netip.ParsePrefix(wifi)
		if e != nil || !prefix.Addr().Is4() || !prefix.Addr().IsPrivate() || prefix.Bits() < 8 {
			closeAll()
			return nil, errors.New("invalid Wi-Fi address")
		}
		for _, port := range []int{socksPort, httpPort} {
			if port != 0 {
				if e = start(prefix.Addr().String(), port, port == httpPort, prefix.Masked()); e != nil {
					closeAll()
					return nil, e
				}
			}
		}
	}
	return closeAll, nil
}
