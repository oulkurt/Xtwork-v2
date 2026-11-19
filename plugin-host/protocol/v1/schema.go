package v1

import "embed"

//go:embed *.schema.json
var Schemas embed.FS
