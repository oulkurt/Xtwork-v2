package plugins

import (
	"errors"
	"testing"
	"testing/fstest"
)

func TestValidateV2FunctionalManifest(t *testing.T) {
	manifest, err := Validate(fstest.MapFS{
		"plugin.json": {Data: []byte(`{
			"id":"sample-tools",
			"name":"Sample tools",
			"version":"1.0.0",
			"api":2,
			"kind":"functional",
			"description":"Sample tools",
			"icon":"plugin-addon-puzzle",
			"worker":"worker.js",
			"capabilities":["agent.tools"],
			"contributes":{"tools":[],"views":[]}
		}`)},
		"worker.js": {Data: []byte("export const tools = {};\n")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.API != 2 || manifest.Kind != "functional" || manifest.Worker != "worker.js" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
}

func TestValidateV2AppearanceManifest(t *testing.T) {
	manifest, err := Validate(fstest.MapFS{
		"plugin.json": {Data: []byte(`{
			"id":"paper-dark",
			"name":"Paper dark",
			"version":"1.0.0",
			"api":2,
			"kind":"appearance",
			"description":"A static theme",
			"icon":"palette",
			"contributes":{"theme":{"id":"paper-dark","tokens":{"background":"#101010","foreground":"#f7f7f7"}}}
		}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Kind != "appearance" || manifest.Contributes.Theme == nil {
		t.Fatalf("unexpected appearance manifest: %+v", manifest)
	}
	if manifest.Contributes.Theme.Tokens["background"] != "#101010" {
		t.Fatalf("unexpected theme tokens: %+v", manifest.Contributes.Theme.Tokens)
	}
}

func TestValidateV2RejectsMixedManifest(t *testing.T) {
	_, err := Validate(fstest.MapFS{
		"plugin.json": {Data: []byte(`{
			"id":"bad-theme",
			"name":"Bad theme",
			"version":"1.0.0",
			"api":2,
			"kind":"appearance",
			"description":"Not static",
			"icon":"palette",
			"worker":"worker.js",
			"contributes":{"theme":{"id":"bad-theme","tokens":{"background":"#101010"}}}
		}`)},
		"worker.js": {Data: []byte("export const tools = {};\n")},
	})
	var diagnostics *DiagnosticError
	if !errors.As(err, &diagnostics) {
		t.Fatalf("expected diagnostics, got %v", err)
	}
	if len(diagnostics.Diagnostics) == 0 {
		t.Fatal("expected at least one diagnostic")
	}
}

func TestValidateV1DefaultsFunctionalKind(t *testing.T) {
	manifest, err := Validate(fstest.MapFS{
		"plugin.json": {Data: []byte(`{
			"id":"legacy",
			"name":"Legacy",
			"version":"1.0.0",
			"api":1,
			"description":"Legacy plugin",
			"icon":"plugin-addon-puzzle",
			"worker":"worker.js",
			"capabilities":[],
			"contributes":{"tools":[]}
		}`)},
		"worker.js": {Data: []byte("export const tools = {};\n")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Kind != "functional" {
		t.Fatalf("expected legacy functional kind, got %q", manifest.Kind)
	}
}
