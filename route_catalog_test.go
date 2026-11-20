package main

import "testing"

func TestProfileLocationUsesProviderPrefixes(t *testing.T) {
	for host, expected := range map[string]string{
		"131.123.37.117":       "sofia",
		"132.243.161.102":      "zurich",
		"176.123.5.151":        "chisinau",
		"::ffff:132.243.161.7": "zurich",
		"132.243.160.102":      "",
		"185.216.44.33":        "vilnius",
		"185.216.44.34":        "",
		"example.com":          "",
	} {
		if got := profileLocation(host); got != expected {
			t.Errorf("%s: location %q, expected %q", host, got, expected)
		}
	}
}
