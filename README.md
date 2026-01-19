# API Test Suite

> **⚠️ IMPORTANT**: This mod only works with Subway Builder **0.12.0-rc beta**

A WIP testing framework for the Subway Builder Modding API that validates hooks, UI components, and lifecycle management.

## Features

- Tests  API lifecycle hooks (game init, city load, day change, route/train events, etc.)
- Validates UI component registration and cleanup
- Tracks hook execution order and duplicate calls
- Console-based test reporting with pass/fail status

## Installation

1. Download or clone this repository
2. Place the `api-test-suite` folder in your Subway Builder mods directory
3. Enable the mod in Settings > Mods
4. Open developer console to view test results

## Purpose

This mod is designed to help mod developers understand API behavior and identify issues with the modding system. It deliberately exposes edge cases like duplicate hook calls during saved game loading.

## Test Coverage

- ✅ Lifecycle hooks (onGameInit, onCityLoad, onMapReady, etc.)
- ✅ UI primitives (addButton, addToggle, addSlider, etc.)
- ✅ Component cleanup on hot reload
- ✅ Hook execution timing and ordering

---

*For detailed API documentation, see [MODDING.md](https://github.com/yourrepo/subway-builder-mods)*
