<p align="center">
  <img src="packaging/HydroCalc.png" width="112" alt="HydroCalc Neo logo">
</p>

<h1 align="center">HydroCalc Neo</h1>

<p align="center">A desktop app for analyzing preferential flow in stained soil profiles.</p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

## Run from source

Requires Node.js 24, CMake 3.24+, and a C++17 toolchain. On macOS, install the Xcode Command Line Tools and Ninja. On Windows, install Visual Studio 2022 with the Desktop development with C++ workload.

Clone this repository and run these commands from its root:

```sh
npm ci
npm run build:native
npm run dev
```

## Analyze a soil profile

1. Set the physical width and depth of the profile and import a stained photo or a black-on-white mask. You can also import a folder for batch analysis.
2. Inspect the stained area, preferential-flow metrics, and depth profile. In the wetting-layer view, drag the depth line or enter a value. Confirming a new depth runs the analysis again and saves a separate history entry.
3. Export images, CSV tables, an Excel pixel matrix, or a ZIP archive from the results.

Settings, history, and images stay on your computer. HydroCalc Neo reuses the previous desktop app’s data directory.

See the [metric definitions](docs/METRICS.md) for calculation details.
