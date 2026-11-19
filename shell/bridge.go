package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
)

// Desktop is the native bridge. MyGo allows calls from the T3 loopback origin.
type Desktop struct {
	server  *backend
	window  *mygo.Window
	dataDir string

	updateMu  sync.Mutex
	updates   updateState
	candidate *mygo.Update
}

func (d *Desktop) GetLocalEnvironmentBearerToken(ctx context.Context) (string, error) {
	return d.server.bearerToken(ctx)
}

func (d *Desktop) RevealWindow() {
	if d.window != nil {
		d.window.Show()
		d.window.Focus()
	}
}

func (d *Desktop) SetTheme(theme string) {
	mygo.Theme.SetSource(mygo.ThemeSource(theme))
}

func (d *Desktop) GiveBadgeCount(count int) {
	mygo.App.SetBadgeCount(count)
}

func (d *Desktop) OpenExternal(rawURL string) bool {
	return externalURL(rawURL) == nil && mygo.Shell.OpenExternal(rawURL) == nil
}

type folderOptions struct {
	InitialPath         string `json:"initialPath"`
	TargetEnvironmentID string `json:"targetEnvironmentId"`
}

func (d *Desktop) PickFolder(opts folderOptions) (*string, error) {
	if opts.TargetEnvironmentID != "" && opts.TargetEnvironmentID != "primary" {
		// T3's local folder chooser is only available for this process's machine.
		return nil, nil
	}
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent: d.window, DefaultPath: opts.InitialPath, Directory: true, CreateDirectories: true,
	})
	if err != nil || len(paths) == 0 {
		return nil, err
	}
	return &paths[0], nil
}

type contextMenuItem struct {
	ID              string            `json:"id"`
	Label           string            `json:"label"`
	Detail          string            `json:"detail"`
	Disabled        bool              `json:"disabled"`
	Header          bool              `json:"header"`
	SeparatorBefore bool              `json:"separatorBefore"`
	Checked         *bool             `json:"checked"`
	Children        []contextMenuItem `json:"children"`
}

func (d *Desktop) ShowContextMenu(items []contextMenuItem, point *mygo.Point) *string {
	var selected *string
	menu := mygo.NewMenu(nativeMenuItems(items, func(id string) { selected = &id }))
	if point == nil {
		menu.Popup(d.window)
	} else {
		menu.PopupAt(d.window, point.X, point.Y)
	}
	return selected
}

func nativeMenuItems(items []contextMenuItem, selectItem func(string)) []*mygo.MenuItem {
	native := make([]*mygo.MenuItem, 0, len(items))
	for _, item := range items {
		if item.SeparatorBefore {
			native = append(native, mygo.Separator())
		}
		row := &mygo.MenuItem{
			ID: item.ID, Label: item.Label, Subtitle: item.Detail, Disabled: item.Disabled || item.Header,
			Click: func(*mygo.MenuItem, *mygo.Window) { selectItem(item.ID) },
		}
		if len(item.Children) != 0 {
			row.Submenu = nativeMenuItems(item.Children, selectItem)
		}
		if item.Checked != nil {
			row.Type, row.Checked = mygo.MenuItemCheckbox, *item.Checked
		}
		native = append(native, row)
	}
	return native
}

func (d *Desktop) ReadClientState(kind string) (*string, error) {
	path, err := d.clientStatePath(kind)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value := string(data)
	return &value, nil
}

func (d *Desktop) WriteClientState(kind, value string) error {
	path, err := d.clientStatePath(kind)
	if err != nil {
		return err
	}
	if !json.Valid([]byte(value)) {
		return errors.New("desktop state must be JSON")
	}
	file, err := os.CreateTemp(d.dataDir, ".desktop-state-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.WriteString(value)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func (d *Desktop) clientStatePath(kind string) (string, error) {
	switch kind {
	case "client-settings", "connection-catalog":
		return filepath.Join(d.dataDir, kind+".json"), nil
	default:
		return "", errors.New("unknown desktop state file")
	}
}
