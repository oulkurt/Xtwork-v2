package plugins

import (
	"bytes"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"strings"
	"unicode"

	v1 "github.com/oulkurt/Xtwork-v2/plugin-host/protocol/v1"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

var ErrInvalid = errors.New("plugin manifest invalid")

const maxFiles = 512
const maxBytes = 16 << 20

type Manifest struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Version      string        `json:"version"`
	API          int           `json:"api"`
	Description  string        `json:"description"`
	Icon         string        `json:"icon"`
	Worker       string        `json:"worker"`
	Capabilities []string      `json:"capabilities"`
	Contributes  Contributions `json:"contributes"`
}
type Contributions struct {
	Tools []Tool `json:"tools"`
	Views []View `json:"views"`
}
type Tool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Confirm     bool            `json:"confirm"`
}
type View struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Placement string `json:"placement"`
	Entry     string `json:"entry"`
}

type noNetwork struct{}

func (noNetwork) Load(string) (any, error) { return nil, ErrInvalid }

func newManifestSchema() (*jsonschema.Schema, error) {
	schemaData, err := v1.Schemas.ReadFile("plugin-manifest.schema.json")
	if err != nil {
		return nil, err
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaData))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.UseLoader(noNetwork{})
	if err = compiler.AddResource("urn:xtwork:protocol:v1:plugin-manifest", doc); err != nil {
		return nil, err
	}
	return compiler.Compile("urn:xtwork:protocol:v1:plugin-manifest")
}

// Validate 校验整个目录和 manifest；调用方仅使用经过校验的副本。
func Validate(files fs.FS) (Manifest, error) {
	schema, err := newManifestSchema()
	if err != nil {
		return Manifest{}, err
	}
	return validateManifest(files, schema)
}

type Diagnostic struct {
	File    string `json:"file"`
	Pointer string `json:"pointer"`
	Message string `json:"message"`
}

type DiagnosticError struct{ Diagnostics []Diagnostic }

func (e *DiagnosticError) Error() string {
	return fmt.Sprintf("%s (%d diagnostics)", ErrInvalid, len(e.Diagnostics))
}
func (e *DiagnosticError) Unwrap() error { return ErrInvalid }

type diagnostics struct {
	items []Diagnostic
	count int
}

func (d *diagnostics) add(file, pointer, message string) {
	if runes := []rune(message); len(runes) > 500 {
		message = string(runes[:500])
	}
	d.count++
	if len(d.items) < 50 {
		d.items = append(d.items, Diagnostic{File: file, Pointer: pointer, Message: message})
	}
}
func (d *diagnostics) err() error {
	if d.count == 0 {
		return nil
	}
	if d.count > 50 {
		d.items[49] = Diagnostic{Message: fmt.Sprintf("%d more diagnostics omitted.", d.count-49)}
	}
	return &DiagnosticError{Diagnostics: d.items}
}
func invalidDiagnostic(file, pointer, message string) error {
	return &DiagnosticError{Diagnostics: []Diagnostic{{File: file, Pointer: pointer, Message: message}}}
}

func validateManifest(files fs.FS, schema *jsonschema.Schema) (Manifest, error) {
	var result Manifest
	var problems diagnostics
	count, total := 0, int64(0)
	walkErr := fs.WalkDir(files, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			problems.add(name, "", "Cannot read directory entry.")
			return nil
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			problems.add(name, "", "Symbolic links are not allowed.")
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			problems.add(name, "", "Cannot read file information.")
			return nil
		}
		if !info.Mode().IsRegular() {
			problems.add(name, "", "Only regular files are allowed.")
			return nil
		}
		count++
		total += info.Size()
		return nil
	})
	if walkErr != nil {
		problems.add(".", "", "Cannot read plugin directory.")
	}
	if count > maxFiles {
		problems.add(".", "", "Plugin exceeds the 512 file limit.")
	}
	if total > maxBytes {
		problems.add(".", "", "Plugin exceeds the 16 MiB limit.")
	}
	manifest, err := files.Open("plugin.json")
	if err != nil {
		problems.add("plugin.json", "", "Cannot read plugin.json.")
		return Manifest{}, problems.err()
	}
	raw, err := readBounded(manifest, maxBytes)
	closeErr := manifest.Close()
	if err != nil || closeErr != nil {
		problems.add("plugin.json", "", "Cannot read manifest within the size limit.")
		return Manifest{}, problems.err()
	}
	var syntax any
	if err = json.Unmarshal(raw, &syntax); err != nil {
		var se *json.SyntaxError
		if errors.As(err, &se) {
			offset := int(se.Offset) - 1
			if offset < 0 {
				offset = 0
			}
			if offset > len(raw) {
				offset = len(raw)
			}
			line := bytes.Count(raw[:offset], []byte("\n")) + 1
			last := bytes.LastIndexByte(raw[:offset], '\n')
			problems.add("plugin.json", "", fmt.Sprintf("Invalid JSON at line %d, column %d: %s", line, offset-last, se.Error()))
		} else {
			problems.add("plugin.json", "", "Invalid JSON: "+err.Error())
		}
		return Manifest{}, problems.err()
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		problems.add("plugin.json", "", "Invalid JSON: "+err.Error())
		return Manifest{}, problems.err()
	}
	if err = schema.Validate(value); err != nil {
		var validation *jsonschema.ValidationError
		if errors.As(err, &validation) {
			output := validation.BasicOutput()
			for _, unit := range output.Errors {
				if unit.Error != nil {
					problems.add("plugin.json", unit.InstanceLocation, unit.Error.String())
				}
			}
		} else {
			problems.add("plugin.json", "", err.Error())
		}
	}
	if err = jsonv2.Unmarshal(raw, &result, jsonv2.RejectUnknownMembers(true)); err != nil {
		problems.add("plugin.json", "", "Manifest structure is invalid: "+err.Error())
		return Manifest{}, problems.err()
	}
	if result.Worker != "" && requireFile(files, result.Worker) != nil {
		problems.add("plugin.json", "/worker", "Worker file is missing or invalid.")
	}
	toolNames, viewIDs := map[string]bool{}, map[string]bool{}
	for i, tool := range result.Contributes.Tools {
		base := fmt.Sprintf("/contributes/tools/%d", i)
		if len(tool.InputSchema) > 16*1024 {
			problems.add("plugin.json", base+"/inputSchema", "Input schema exceeds 16 KiB.")
		}
		if len(result.ID)+2+len(tool.Name) > 64 {
			problems.add("plugin.json", base+"/name", "Model tool name exceeds 64 characters.")
		}
		if toolNames[tool.Name] {
			problems.add("plugin.json", base+"/name", "Duplicate tool name.")
		}
		toolNames[tool.Name] = true
		if !englishDescription(tool.Description) {
			problems.add("plugin.json", base+"/description", "Description must not contain non-ASCII letters.")
		}
	}
	if len(result.Contributes.Tools) > 0 && !contains(result.Capabilities, "agent.tools") {
		problems.add("plugin.json", "/capabilities", "Tools require agent.tools capability.")
	}
	for i, view := range result.Contributes.Views {
		base := fmt.Sprintf("/contributes/views/%d", i)
		if viewIDs[view.ID] {
			problems.add("plugin.json", base+"/id", "Duplicate view id.")
		}
		viewIDs[view.ID] = true
		if view.Entry != "" && requireFile(files, view.Entry) != nil {
			problems.add("plugin.json", base+"/entry", "View entry file is missing or invalid.")
		}
	}
	if err := problems.err(); err != nil {
		return Manifest{}, err
	}
	return result, nil
}
func requireFile(fsys fs.FS, name string) error {
	if !fs.ValidPath(name) || strings.Contains(name, "\\") || path.Clean(name) != name {
		return ErrInvalid
	}
	file, err := fsys.Open(name)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return ErrInvalid
	}
	return nil
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func readBounded(r io.Reader, max int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil || int64(len(b)) > max {
		return nil, fmt.Errorf("%w: size", ErrInvalid)
	}
	return b, nil
}

func englishDescription(text string) bool {
	for _, r := range text {
		if r > unicode.MaxASCII && unicode.IsLetter(r) {
			return false
		}
	}
	return true
}
