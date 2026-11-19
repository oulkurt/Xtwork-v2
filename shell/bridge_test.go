package main

import (
	"encoding/json/v2"
	"testing"
)

func TestContextMenuPointDecodesWebCoordinates(t *testing.T) {
	var point *contextMenuPoint
	if err := json.Unmarshal([]byte(`{"x":68.5,"y":214.25}`), &point); err != nil {
		t.Fatal(err)
	}
	if point == nil || point.X != 68.5 || point.Y != 214.25 {
		t.Fatalf("unexpected popup coordinates: %+v", point)
	}
}
