package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

type branding struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	StageLabel  string `json:"stageLabel"`
	Version     string `json:"version"`
}

type config struct {
	brand       branding
	brandFile   string
	resources   string
	dataDir     string
	node        string
	serverEntry string
}

func loadConfig() (config, error) {
	resources, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return config{}, fmt.Errorf("find app resources: %w", err)
	}
	brandFile := environmentPath("XTWORK_BRAND_CONFIG", resources, "brand.json")
	data, err := os.ReadFile(brandFile)
	if err != nil {
		return config{}, fmt.Errorf("read desktop brand configuration: %w", err)
	}
	var brand branding
	if err := json.Unmarshal(data, &brand); err != nil {
		return config{}, fmt.Errorf("decode desktop brand configuration: %w", err)
	}
	if brand.Name == "" {
		return config{}, fmt.Errorf("desktop brand configuration requires name")
	}
	if brand.DisplayName == "" {
		brand.DisplayName = brand.Name
	}
	if brand.StageLabel == "" {
		brand.StageLabel = "Alpha"
	}
	if version := mygo.App.Version(); version != "" {
		brand.Version = version
	}
	dataDir := os.Getenv("XTWORK_DATA_DIR")
	if dataDir == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return config{}, fmt.Errorf("find application data directory: %w", err)
		}
		dataDir = filepath.Join(dir, "Xtwork-v2")
	}
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return config{}, fmt.Errorf("resolve application data directory: %w", err)
	}
	node, err := exec.LookPath(environmentPath("XTWORK_NODE", resources, "node", "bin", "node"))
	if err != nil {
		return config{}, fmt.Errorf("find Node executable: %w", err)
	}
	node, err = filepath.Abs(node)
	if err != nil {
		return config{}, err
	}
	entry, err := filepath.Abs(environmentPath("XTWORK_SERVER_ENTRY", resources, "server", "dist", "bin.mjs"))
	if err != nil {
		return config{}, err
	}
	if _, err := os.Stat(entry); err != nil {
		return config{}, fmt.Errorf("find packaged T3 server: %w", err)
	}
	brandFile, err = filepath.Abs(brandFile)
	if err != nil {
		return config{}, err
	}
	return config{brand, brandFile, resources, dataDir, node, entry}, nil
}

func environmentPath(key string, fallback ...string) string {
	if path := os.Getenv(key); path != "" {
		return path
	}
	return filepath.Join(fallback...)
}

func (cfg config) bundledNodeBinDir() string {
	if cfg.node != "" {
		return filepath.Dir(cfg.node)
	}
	if cfg.resources != "" {
		candidate := filepath.Join(cfg.resources, "node", "bin")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

func appendFallbackPath(currentPath, fallbackDir string) string {
	fallbackDir = strings.TrimSpace(fallbackDir)
	if fallbackDir == "" {
		return currentPath
	}
	cleanedFallback := filepath.Clean(fallbackDir)
	if strings.TrimSpace(currentPath) == "" {
		return cleanedFallback
	}
	entries := filepath.SplitList(currentPath)
	for _, entry := range entries {
		if entry != "" && filepath.Clean(entry) == cleanedFallback {
			return currentPath
		}
	}
	return currentPath + string(os.PathListSeparator) + cleanedFallback
}

func (cfg config) backendEnvironment() []string {
	nodeBinDir := cfg.bundledNodeBinDir()
	env := make([]string, 0, len(os.Environ())+12)
	var currentPath string
	pathKey := "PATH"
	hasPath := false
	for _, pair := range os.Environ() {
		key, value, _ := strings.Cut(pair, "=")
		switch key {
		case "XTWORK_IM_BRIDGE_ENTRY", "XTWORK_IM_DATA_DIR", "XTWORK_COMPANION_DIR", "XTWORK_BUNDLED_NODE_BIN":
		case "PATH":
			currentPath = value
			hasPath = true
		default:
			env = append(env, pair)
		}
	}
	if nodeBinDir != "" {
		env = append(env,
			pathKey+"="+appendFallbackPath(currentPath, nodeBinDir),
			"XTWORK_BUNDLED_NODE_BIN="+nodeBinDir,
		)
	} else if hasPath {
		env = append(env, pathKey+"="+currentPath)
	}
	env = append(env,
		"T3CODE_TELEMETRY_ENABLED=false",
		"XTWORK_DATA_DIR="+cfg.dataDir,
		"XTWORK_BRAND_CONFIG="+cfg.brandFile,
	)
	for key, path := range map[string]string{
		"XTWORK_PI_BINARY":       filepath.Join(cfg.resources, "runtime", "pi", "pi"),
		"XTWORK_PLUGIN_HOST_BIN": filepath.Join(cfg.resources, "plugin-host", "xtwork-plugin-host"),
		"XTWORK_PLUGINS_DIR":     filepath.Join(cfg.resources, "plugins"),
	} {
		if os.Getenv(key) == "" {
			if _, err := os.Stat(path); err == nil {
				env = append(env, key+"="+path)
			}
		}
	}
	entry := environmentPath("XTWORK_IM_BRIDGE_ENTRY", cfg.resources, "im-bridge", "dist", "main.js")
	if absolute, err := filepath.Abs(entry); err == nil {
		if info, err := os.Stat(absolute); err == nil && info.Mode().IsRegular() {
			imData, imErr := filepath.Abs(environmentPath("XTWORK_IM_DATA_DIR", cfg.dataDir, "im"))
			companion, companionErr := filepath.Abs(environmentPath("XTWORK_COMPANION_DIR", cfg.dataDir, "companion"))
			if imErr == nil && companionErr == nil {
				env = append(env, "XTWORK_IM_BRIDGE_ENTRY="+absolute, "XTWORK_IM_DATA_DIR="+imData, "XTWORK_COMPANION_DIR="+companion)
			}
		}
	}
	return env
}
