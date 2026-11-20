package main

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestProtectedFlowRejectsUnattributedConnection(t *testing.T) {
	r := &router{policy: &androidPolicy{Secret: "private-listener-key", Apps: map[string]string{"12400": "any"}}}
	for _, test := range []struct {
		user, password, want string
		allowed              bool
	}{
		{"u12400", "private-listener-key", "any", true},
		{"u12401", "private-listener-key", "", true},
		{"unknown", "private-listener-key", "", false},
		{"u12400", "wrong", "", false},
	} {
		server, client := net.Pipe()
		defer server.Close()
		defer client.Close()
		_ = client.SetDeadline(time.Now().Add(time.Second))
		out := make(chan bool, 1)
		go func() {
			binding, ok := r.authorizeFlow(server, []byte{0, 2})
			out <- ok == test.allowed && binding == test.want
		}()
		var greeting [2]byte
		if _, err := io.ReadFull(client, greeting[:]); err != nil || greeting != [2]byte{5, 2} {
			t.Fatalf("expected authenticated method, got %v (%v)", greeting, err)
		}
		if err := socksClientAuth(client, test.user, test.password); (err == nil) != test.allowed {
			t.Fatalf("unexpected authentication result for %s: %v", test.user, err)
		}
		if !<-out {
			t.Fatalf("incorrect rule assignment for %s", test.user)
		}
	}
}

func TestPinnedApplicationCannotFallBackToDirectOrAnotherServer(t *testing.T) {
	r := router{
		profiles: []profile{{ID: "other", Kind: "external", Port: 65534}},
		health:   map[string]health{"other": {Telegram: true, Chat: true}},
		servers:  map[string]string{"other": "203.0.113.18"}, selected: [3]string{"other", "other", "other"}, ready: true,
	}
	// The destination ordinarily takes the direct branch. Binding must reject it instead.
	conn, err := r.dialPolicy(context.Background(), "127.0.0.1:22", "192.0.2.25")
	if conn != nil || err == nil || err.Error() != "no reachable upstream" {
		t.Fatalf("unexpected fallback result: %v", err)
	}
}
