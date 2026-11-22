package main

import "testing"

func TestCheckExposure(t *testing.T) {
	cases := []struct {
		addr, url                  string
		tls, proxy, insecure, okay bool
	}{
		{"127.0.0.1:8080", "", false, false, false, true},              // local default
		{"localhost:8080", "", false, false, false, true},              // local
		{":8080", "", false, false, false, false},                      // exposed plain HTTP
		{":8080", "https://s.example.com", false, false, false, false}, // still plain HTTP
		{":443", "https://s.example.com", true, false, false, true},    // TLS
		{":443", "", true, false, false, false},                        // TLS but no public URL
		{":8080", "https://s.example.com", false, true, false, true},   // behind proxy
		{":8080", "http://100.64.0.2:8080", false, false, true, true},  // explicit private HTTP
		{":443", "https://s.example.com/$(id)", true, false, false, false},
	}
	for _, c := range cases {
		err := checkExposure(c.addr, c.url, c.tls, c.proxy, c.insecure)
		if (err == nil) != c.okay {
			t.Errorf("%+v: err=%v", c, err)
		}
	}
}
