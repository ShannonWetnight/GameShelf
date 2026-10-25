// Collect notices for the actual connector modules, without vendoring their code.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) != 2 {
		panic("output directory required")
	}
	output := os.Args[1]
	if err := os.MkdirAll(output, 0755); err != nil {
		panic(err)
	}
	command := exec.Command("go", "list", "-mod=readonly", "-deps", "-json", ".")
	command.Stderr = os.Stderr
	pipe, err := command.StdoutPipe()
	if err != nil {
		panic(err)
	}
	if err = command.Start(); err != nil {
		panic(err)
	}
	decoder := json.NewDecoder(pipe)
	seen := map[string]bool{}
	var index strings.Builder
	for {
		var pkg struct {
			Module *struct {
				Path, Version, Dir string
				Main               bool
			}
		}
		err = decoder.Decode(&pkg)
		if err == io.EOF {
			break
		}
		if err != nil {
			panic(err)
		}
		module := pkg.Module
		if module == nil || module.Main || seen[module.Path] {
			continue
		}
		seen[module.Path] = true
		fmt.Fprintf(&index, "%s %s\n", module.Path, module.Version)
		files, err := os.ReadDir(module.Dir)
		if err != nil {
			panic(err)
		}
		for _, file := range files {
			name := strings.ToLower(file.Name())
			if file.IsDir() || !(strings.HasPrefix(name, "license") || strings.HasPrefix(name, "licence") || strings.HasPrefix(name, "copying") || strings.HasPrefix(name, "notice") || strings.HasPrefix(name, "copyright")) {
				continue
			}
			contents, err := os.ReadFile(filepath.Join(module.Dir, file.Name()))
			if err != nil {
				panic(err)
			}
			sum := sha256.Sum256([]byte(module.Path))
			destination := fmt.Sprintf("%x-%s", sum[:8], file.Name())
			if err = os.WriteFile(filepath.Join(output, destination), contents, 0644); err != nil {
				panic(err)
			}
			fmt.Fprintf(&index, "  %s\n", destination)
		}
	}
	if err = command.Wait(); err != nil {
		panic(err)
	}
	if err = os.WriteFile(filepath.Join(output, "INDEX.txt"), []byte(index.String()), 0644); err != nil {
		panic(err)
	}
}
