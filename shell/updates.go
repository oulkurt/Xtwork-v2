package main

import (
	"context"
	"runtime"
	"time"

	"github.com/egoist/mygo"
)

type updateReleaseNote struct {
	Version    string   `json:"version"`
	Items      []string `json:"items"`
	TotalItems int      `json:"totalItems"`
	Intro      string   `json:"intro,omitempty"`
	ReleasedAt string   `json:"releasedAt,omitempty"`
}

type updateState struct {
	Enabled             bool                `json:"enabled"`
	Status              string              `json:"status"`
	Channel             string              `json:"channel"`
	CurrentVersion      string              `json:"currentVersion"`
	HostArch            string              `json:"hostArch"`
	AppArch             string              `json:"appArch"`
	Translated          bool                `json:"runningUnderArm64Translation"`
	AvailableVersion    *string             `json:"availableVersion"`
	DownloadedVersion   *string             `json:"downloadedVersion"`
	ReleaseNotes        []updateReleaseNote `json:"releaseNotes"`
	OmittedReleaseCount int                 `json:"omittedReleaseCount"`
	DownloadPercent     *int                `json:"downloadPercent"`
	CheckedAt           *string             `json:"checkedAt"`
	Message             *string             `json:"message"`
	ErrorContext        *string             `json:"errorContext"`
	CanRetry            bool                `json:"canRetry"`
}

type updateCheckResult struct {
	Checked bool        `json:"checked"`
	State   updateState `json:"state"`
}

type updateActionResult struct {
	Accepted  bool        `json:"accepted"`
	Completed bool        `json:"completed"`
	State     updateState `json:"state"`
}

func initialUpdateState(version string) updateState {
	arch := map[string]string{"arm64": "arm64", "amd64": "x64"}[runtime.GOARCH]
	if arch == "" {
		arch = "other"
	}
	enabled := mygo.Updater.Enabled()
	status := "disabled"
	if enabled {
		status = "idle"
	}
	return updateState{
		Enabled: enabled, Status: status, Channel: "latest", CurrentVersion: version,
		HostArch: arch, AppArch: arch, ReleaseNotes: []updateReleaseNote{},
	}
}

func (d *Desktop) GetUpdateState() updateState {
	d.updateMu.Lock()
	defer d.updateMu.Unlock()
	return d.updates
}

func (d *Desktop) CheckForUpdate(ctx context.Context) updateCheckResult {
	d.updateMu.Lock()
	state := d.updates
	if !state.Enabled || state.Status == "checking" || state.Status == "downloading" || state.Status == "downloaded" {
		d.updateMu.Unlock()
		return updateCheckResult{false, state}
	}
	d.candidate = nil
	d.updates.Status = "checking"
	d.updates.AvailableVersion = nil
	d.updates.ReleaseNotes = []updateReleaseNote{}
	d.updates.DownloadPercent = nil
	d.updates.Message, d.updates.ErrorContext, d.updates.CanRetry = nil, nil, false
	state = d.updates
	d.updateMu.Unlock()
	d.emitUpdateState(state)
	check, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	up, err := mygo.Updater.Check(check)
	checkedAt := time.Now().UTC().Format(time.RFC3339)
	d.updateMu.Lock()
	d.updates.CheckedAt = &checkedAt
	switch {
	case err != nil:
		setUpdateError(&d.updates, "check", err)
	case up == nil:
		d.updates.Status = "up-to-date"
	default:
		d.candidate = up
		d.updates.Status = "available"
		d.updates.AvailableVersion = &up.Version
		note := updateReleaseNote{Version: up.Version, Items: []string{}, Intro: up.Notes}
		if !up.Date.IsZero() {
			note.ReleasedAt = up.Date.Format(time.RFC3339)
		}
		d.updates.ReleaseNotes = []updateReleaseNote{note}
	}
	state = d.updates
	d.updateMu.Unlock()
	d.emitUpdateState(state)
	return updateCheckResult{true, state}
}

func (d *Desktop) DownloadUpdate(ctx context.Context) updateActionResult {
	d.updateMu.Lock()
	state, up := d.updates, d.candidate
	if up == nil || (state.Status != "available" && state.Status != "error") {
		d.updateMu.Unlock()
		return updateActionResult{State: state}
	}
	d.updates.Status = "downloading"
	d.updates.Message, d.updates.ErrorContext, d.updates.CanRetry = nil, nil, false
	state = d.updates
	d.updateMu.Unlock()
	d.emitUpdateState(state)
	// On macOS MyGo verifies and stages the new bundle, then swaps it on relaunch.
	err := up.Install(ctx, func(downloaded, total int64) {
		if total <= 0 {
			return
		}
		percent := int(100 * downloaded / total)
		d.updateMu.Lock()
		if current := d.updates.DownloadPercent; current != nil && *current == percent {
			d.updateMu.Unlock()
			return
		}
		d.updates.DownloadPercent = &percent
		progress := d.updates
		d.updateMu.Unlock()
		d.emitUpdateState(progress)
	})
	d.updateMu.Lock()
	if err == nil {
		d.updates.Status = "downloaded"
		d.updates.DownloadedVersion = &up.Version
	} else {
		setUpdateError(&d.updates, "download", err)
	}
	state = d.updates
	d.updateMu.Unlock()
	d.emitUpdateState(state)
	return updateActionResult{true, err == nil, state}
}

func (d *Desktop) InstallUpdate(expectedVersion string) updateActionResult {
	state := d.GetUpdateState()
	if state.DownloadedVersion == nil || (expectedVersion != "" && *state.DownloadedVersion != expectedVersion) {
		return updateActionResult{State: state}
	}
	mygo.App.Relaunch()
	return updateActionResult{true, true, state}
}

func (d *Desktop) emitUpdateState(state updateState) {
	if d.window != nil {
		_ = updateEvent.Emit(d.window, state)
	}
}

func setUpdateError(state *updateState, operation string, err error) {
	message := err.Error()
	state.Status = "error"
	state.Message, state.ErrorContext, state.CanRetry = &message, &operation, true
}
